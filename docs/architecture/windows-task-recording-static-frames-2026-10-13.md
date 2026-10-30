# Windows 任务录制：静止画面黑帧定位与修复方案

## 基线与问题

2026-10-13 先将已验证的 Windows 编译、PNG 帧导出与全局录制控制栏修复推送到 `pxlin/dev`，基线提交为 `ade09f1e2786b31894371221860d376618161516`。

真实 Windows 11 桌面的测试录制持续约 10.39 秒，索引包含 135 帧，其中只有 22 帧不是黑色占位帧。缺口累计约 8.05 秒，其中暂停约 1.62 秒，其余主要标为 `unavailable`。受控窗口每 500 ms 更新一次时能短暂显示；停止更新后画面反复变黑。MP4 可正常解码、播放和倍速，因此问题位于采集/补帧路径，而非播放器。

原始本地证据：`.tmp/electron-test/windows-recording-evidence.json`，录制 ID `24b49e3c-f935-4379-9200-6be8f6aaad3f`。证据文件不提交账号配置、会话数据库或凭据。

## 定位思路

1. 检查原生采集结果与 `frames.jsonl` / `gaps.jsonl`，区分采集黑帧和播放解码异常。
2. 在同一个受控前台窗口依次测试更新画面、完全静止、暂停、恢复、切换到未授权窗口、返回及撤销/恢复授权。
3. 先在旧采集实现上运行新集成测试，记录失败和每个阶段的黑帧数量，再修改实现。

基线的 `WindowCapture::Frame()` 把 `TryGetNextFrame()` 返回空和窗口尺寸等校验失败合并为 `false`。录制循环遇到 `false` 就清空画布并写入 `unavailable`。Microsoft 的 [TryGetNextFrame 文档](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.trygetnextframe)说明：帧池为空时返回 null；空池本身不表示采集失效。静止回归失败、修复后空池分支持续复用同一来源时间戳，确认根因为“没有新的图像”被当成“没有可播放的图像”。

既有集成测试持续修改窗口文本，只要求采到十张以上真实画面，因此未覆盖静止区间的连续性。macOS 已保留 `sourceTicks` 和 `repeated` 来区分显示重复帧与新采集帧，可复用这一已有协议约定。

## 大致修复方案

- 让采集结果明确区分新帧、空池和不可用窗口。只有空池允许复用最近一次验证通过的像素。
- 缓存绑定窗口实例、前台/焦点代次、位置、DPI、授权策略和原始采集 QPC。每次复用仍检查授权、前后台状态与 hooks barrier。
- 暂停、授权撤销/损坏、实例/窗口/位置/DPI/代次变化或采集异常时清空缓存。恢复后先取得新的有效帧，再继续显示。
- 视频的显示时间持续前进；重复画面保留原始 `sourceTicks` 并标记 `repeated: true`。不能把补帧伪装成新采集截图。
- OpenAdapt 已排除 `repeated` 帧；Windows 原生帧导出也应拒绝直接请求重复帧，并校验来源时钟。
- 保持现有暂停与未授权区域的黑帧、缺口、20 分钟限制、无音频和仅本地存储行为。

## 验证与结果

旧实现真实桌面回归已失败（退出码 1，Windows 会话 1），错误为“static authorized window keeps its visible image instead of black frames”。2026-10-13 22:18（UTC+8）的失败与 22:25 的修复后对照：

| 阶段 | 修复前：黑帧/总帧 | 修复后：黑帧/总帧 |
| --- | ---: | ---: |
| 授权窗口静止 | 27/27 | 0/26 |
| 暂停 | 11/11 | 11/11 |
| 恢复后静止 | 20/20 | 0/21 |
| 未授权窗口 | 11/11 | 11/11 |
| 返回授权窗口后静止 | 17/17 | 0/17 |
| 撤销授权 | 11/11 | 11/11 |
| 恢复授权后静止 | 21/21 | 0/20 |

本地证据目录：Windows 测试检出的 `.tmp/windows-test/native-static-before/`；详细结果为 `task_video_static_frames/20261013T141835Z-10792/static-frame-summary.json`。

修复后同场景退出码 0。返回窗口和恢复授权后的画面来源时间都晚于对应恢复边界，证明没有沿用旧授权区间的缓存。

原生媒体回归通过：真实 MF 编码、无重编码合并、PNG 方向与提取、损坏尾片恢复；新增的直接请求重复帧导出被拒绝，未产生 PNG。原有 `task_video_lifecycle` 通过，仍要求十张以上真正新采集的画面，重复帧不计入该断言。录制相关 TypeScript 测试 57 项通过，macOS 原生测试在 Linux 上按预期跳过 1 项；类型检查和 Windows 后端构建通过。

重启后的 Windows Electron 界面完成静止录制、暂停、继续、停止和回看。1.5–4.5 秒的稳定区间共 40 帧，黑帧 0，重复显示帧 40；1920×1080 视频约 10.76 秒。完成视频跳转后检查 2、3、4 秒处的解码截图，均能看到同一个静止测试窗口，播放时间也正常推进。该录制已在测试实例中保留。

本地汇总证据位于仓库的 `.tmp/electron-test/static-frame-fix/`：`before-frames.json`、`after-frames.json`、`ui-result.json`、`static-recording.mp4` 和三张解码截图。Windows 原生结果位于测试检出的 `.tmp/windows-test/native-static-after/` 与 `native-lifecycle-after/`。

## 实施要点与边界

- 采集结果改为 `Frame / Empty / Unavailable`，只有 `Empty` 且缓存身份仍有效时补帧；真正的不可用和异常仍写黑帧。
- 每次补帧复核同一窗口实例、位置、DPI、前台/焦点代次和策略 SHA-256，并经过 hooks barrier；缓存仅保留最近一张已验证的源图像。
- 显示 QPC 与源 QPC 分开记录。新样本到达时若源时间早于已写入的显示时间，也标记为派生重复帧，避免时间轴倒退和错误的“新截图”证据。
- Windows 驱动校验 `sourceTicks` 的范围及新帧的时钟一致性；旧版本缺少该字段的录制仍可读取。OpenAdapt 和原生帧提取均拒绝把重复显示帧作为新采集证据。
- 启动、窗口变化或恢复授权时仍须等待新的有效首帧，因此这些过渡区间可能存在真实缺口。未运行两次 20 分钟耐久测试、设备故障注入或干净安装验收；本次结果针对静止黑帧问题及已列出的回归场景。
