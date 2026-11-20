# Windows / macOS 任务录制与视频回看

按[实施计划](https://alidocs.dingtalk.com/i/nodes/R4GpnMqJzGjeYb0jtL2bmD9j8Ke0xjE3)实现首版 Teach 录制基础，基线为 `48c2ce27`。本轮包含人类示范、Agent 本次执行录制、只读视频回看与离线 OpenAdapt Flow 导出。后续语义提炼、技能生成、试跑及桌面重放不属于本轮。

## 使用入口

Windows 和 macOS 桌面应用的 Computer History 页增加“任务录制”区域。先手动暂停后台 Computer History，再点“开始示范录制”，选择已授权且正在运行的应用，确认原始视频录制范围。界面等待原生采集器就绪后显示“录制中”。全局状态条提供暂停、继续和停止；Windows 停止热键为 `Ctrl + Alt + Shift + R`，macOS 为 `Control + Option + Command + R`。

macOS 最低版本为 12.3，支持 Apple Silicon 和 Intel。首次使用时，录制确认页检查原生任务 helper 自身的“屏幕录制”“辅助功能”“输入监控”权限；仅点击对应按钮才请求授权或打开系统设置。返回应用时重新检查，系统要求重启时需重开 Memmy。缺少任一权限时禁止启动，授权操作不会自动开始录制。

聊天发送框的“录制本次执行”先确认应用和视频授权。选择随一条消息发送，在任务实际出队后启动，绑定后端真实 `turnId`、`chatId` 和 `client_request_id`。取消、完成或 20 分钟上限会停止录制。录制失败不重试 OCU 动作；手动停止录制也不取消 Agent。恢复同一条 Agent 消息不会自动重新录制。

已结束的录制显示视频卡片，可播放、倍速、拖动、按事件定位、下载、收藏、删除和清空。原生输入与 OCU 工具调用分别显示。Windows 的 `injected` 只保留系统报告的注入属性；macOS 不猜测输入来自人还是 Agent。旧历史接口不增加视频字段，也不把原来的摘要或事件流拼成连续视频。

视频保留原始可见画面，可能包含输入内容。默认仅本地保存，无音频，不额外上传模型，不参与历史摘要。应用选择与确认文案独立于旧历史的“不保存截图”承诺。

## 采集和存储

`win/native/src/win/task_video.cpp` 使用 Windows Graphics Capture、D3D11 与 Media Foundation。它在既有原生 helper 中新增 `record-task` 模式，与原有 hooks、UIA、窗口身份检查和单实例 lease 共用进程。既有 `observe` 的 v1 协议及默认行为不变。桌面包不增加 Python、OpenAdapt Capture 或 FFmpeg 运行依赖。

采集范围为本次授权的前台窗口。每帧复核 PID、进程创建时间、可执行路径、前台代次、窗口位置和 DPI；前台 A→B→A 变化通过 hooks barrier 检查。首版固定首次采集的显示器和 DPI，不新增浏览器、系统界面或远程桌面支持。

输出为 1920×1080 固定画布，按比例缩小并留黑边，采样上限 15 fps，H.264/MP4，无音频。事件与帧共享 QPC 时间轴，原始计数和频率以十进制字符串保存，避免 64 位精度损失；UTC 仅用于显示。暂停、未授权目标、不可用窗口和采集故障保留经过时间及明确缺口，使用新生成的黑色占位画面。

Windows 的帧池暂时为空时，在窗口身份、前台/焦点代次、位置、DPI 和授权策略仍匹配的前提下保留最近一次验证过的画面，避免静止窗口闪黑。显示重复帧保留原始采集 `sourceTicks` 并标记 `repeated`，不作为新的操作前／后截图；暂停、失去授权或身份校验失败会清空缓存，恢复后重新采集。定位过程、方案和前后对照见[静止画面修复记录](../../../../../docs/architecture/windows-task-recording-static-frames-2026-10-13.md)。

macOS 使用 `mac/task-recorder.swift`：一个进程内的 listen-only CGEvent tap 与一个 ScreenCaptureKit 独立窗口流。只采集本次选中、符合现有应用观察规则的前台原生窗口，绑定 Bundle ID、PID、进程启动时间、可执行路径、CGWindowID、窗口位置和显示缩放；浏览器、远程桌面与系统表面不支持。跨显示器的窗口、独立窗口流未包含的重叠菜单／子窗口、无法验证的窗口写入黑帧。现有规则损坏时拒绝任务录制，不沿用后台历史的宽松回退。

macOS 的 `clock.kind` 为 `mach_host`，使用 Core Media host clock 与 SCK 原始 sample PTS，统一换算为纳秒字符串；`qpc` 保持 `null`，不伪装成 Windows 时钟。Retina 点击坐标保留屏幕点坐标，通过来源窗口与画布变换转换到输出像素。静止窗口的视频重复帧记录 `sourceTicks` 和 `repeated`，导出时不能作为新采集的操作前／后截图。文本不读取 Unicode 字符串；快捷键只在可验证的键盘布局下映射。拖拽、多击、额外鼠标按钮、丢失事件及无法映射的输入明确标记不完整。

AVFoundation 负责 macOS 的 H.264 编码；每约 10 秒封存独立 MP4，并同步帧索引、大小、视频 SHA-256 和索引 SHA-256。停止后 AVAssetReader/AVAssetWriter 直接合并压缩样本，保留原始时间戳，不重编码。恢复校验每片独立关键帧、编解码格式、样本数、PTS、时长与帧索引；只保留验证通过的连续前缀。任务 helper 与历史 helper 通过共享门禁互斥，暂停任务时仍保留任务门禁。

每个录制包位于 `~/.memmy/computer-recordings/<UUID>/`：

```text
manifest.json             产品会话与完整性状态
events.jsonl              清洗后的原生输入、OCU 与控制事件
frames.jsonl              原生单调时钟、帧编号、来源身份与画布变换
policy.json               本次应用绑定，不扩展旧历史设置
native-clock.json         Windows QPC 起点与频率
native-completion.json    Windows 正常封存标记
capture-state.json        macOS 时钟与持续时间检查点
capture-finished.json     macOS 正常封存标记
native-media.json         经验证的媒体与缺口信息
gaps.jsonl                原生缺口区间
parts/000001.mp4          默认每 10 秒封存的分片
parts/000001.json         封存大小、SHA-256、起点和时长
recording.mp4             停止后无重编码合并的视频
exports/<UUID>/           Flow 导出任务和 ZIP
```

服务与原生 helper 分别提供互斥门禁。后台正在录制或切换状态时，任务录制返回 409；任务录制期间，后台也不能重新启动。不会自动暂停或恢复后台观察。

生命周期为 `starting → recording ↔ paused → finalizing → ready`，异常进入 `failed`。停止采集与合并分开：原生采集进程先退出，服务再运行 `finalize-task`，界面显示处理中。包级文件锁避免恢复过程与尚在退出的采集器同时修改产物。

启动恢复只使用经过封存标记、大小、SHA-256 和 MP4 读取验证的分片。未封存或损坏尾片不作为完整视频；保留可验证前缀及缺口，并丢弃未完成的最后一条事件行。即使合并失败，已验证分片仍可回看。元数据写盘失败也会停止采集并释放互斥门禁。

`videoIntegrity`、`timelineCompleteness` 和 `taskEndReason` 分开保存。完整视频不代表业务任务成功，输入事件丢失也不自动判定视频损坏。正常录制最长 20 分钟，48 小时后自动清理，收藏免自动清理。明确删除或清空会移除整个录制包，包括分片、帧索引和导出缓存。

根目录另有 `agent-attempts.jsonl`，只保存聊天／消息标识组合的 SHA-256，用于阻止已尝试的任务在恢复后再次采集；不包含原始标识、文本、图像或音频。它不属于视频留存或导出内容。

## 接口与媒体

独立命名空间 `/api/computer-recordings` 使用既有 bootstrap bearer 认证：

| 路径 | 方法 | 用途 |
| --- | --- | --- |
| `/` | GET | 列表，可按 `chat_id` 筛选 |
| `/configuration` | GET | macOS 应用范围、最低系统版本及原生权限状态；不请求权限 |
| `/permissions/open` | POST | macOS 单项权限，明确指定 `permission` 与 `request` / `settings` |
| `/start` | POST | 人类录制，必须提供标题、应用列表和 `consent: true` |
| `/:id` | GET / PATCH / DELETE | 状态、收藏、删除 |
| `/:id/pause`、`resume`、`stop` | POST | 只控制录制 |
| `/:id/events` | GET | 按序号分页的事件时间线 |
| `/:id/video` | GET / HEAD | 合并视频、已封存分片或导出包；支持单一 byte Range |
| `/:id/export-openadapt` | POST | 创建异步导出任务 |
| `/:id/exports/:exportId` | GET | 导出任务状态与缺失项 |
| `/clear` | POST | 明确清空 `today` 或 `all`；存在活跃录制／导出时拒绝 |
| `/active/stop` | POST | 应用退出时封存活跃录制 |

Agent 入口将授权放入消息的 `task_recording` 字段，由 AgentLoop 在实际开始时调用会话服务；客户端不能伪造一个后端 `runId` 来绑定录制。

Electron 注册 `memmy-recording://recording/<UUID>/video`，主进程从固定本地 gateway 获取认证并转发 Range，以流式响应供播放器和下载使用。URL 不带 token，不把整段视频加载为 Blob。媒体只允许 manifest 内的固定媒体 ID，并检查目录、文件类型及符号链接。

## OpenAdapt Flow

导出适配器对齐 OpenAdapt Flow **1.35.1**，上游 commit 固定为 `6e4e4ed0fe4addedd7c38ced44176b42bc40165a`。CI 的 Python 3.10 依赖由 `scripts/internal/shared/openadapt-flow-compat.lock` 锁定，独立于桌面运行时。

完整格式包包含 `meta.json`、`events.jsonl`、`frames/*_before.png`、`frames/*_after.png` 和 `memmy-export-manifest.json`。原生 `export-task-frames` 根据已保留的分片帧编号解码 PNG。坐标使用对应来源窗口和画布变换，来源身份不一致、跨缺口或缺必要帧时拒绝转换。after 帧仅表示下一张验证过的采样帧，不宣称界面已稳定或业务动作成功。

普通输入只保留按键计数，不还原文本，不使用 OCR 猜正文。缺文本、拖拽等不支持动作、输入溢出或缺帧时，生成带原始清洗事件和具体缺失项的证据包，其 Flow `events.jsonl` 留空，不把删掉步骤的片段冒充完整演示。所有导出均标记 `executionAdmission: not_admitted`、`replayable: false`，不生成 Capture 的 `recording.db`。

macOS 的 Command / Option 快捷键和连续滚动像素使用独立映射，不套用 Windows 滚轮单位。导出保留平台及原生时钟来源，仍由相同的 Flow 1.35.1 格式验证链检查；输入缺失时遵循同样的证据包规则。

上游兼容性检查调用真实的读取及 `compile_recording` 路径，使用固定 OCR 结果、禁止网络、不创建桌面执行器。该测试证明格式兼容，不证明可重放。

## 验证范围

本轮开发主机为 Linux。已运行 TypeScript 类型检查、历史兼容性／录制服务／前端交互／媒体认证与 Range／Agent 执行回归、前端生产构建，以及锁定版本 Flow 的离线读取和编译。

Windows 测试路径已加入既有 CI：

- `task_video.media_integrity`：真实 MF 编码、无重编码合并、帧抽取、图像朝向与损坏尾片恢复；无需真实桌面。
- `integration.task_video_lifecycle`：受控前台窗口像素、分片、暂停／继续、原生互斥与 QPC 索引；无交互桌面或 WGC 设备时明确跳过。
- `integration.task_video_static_frames`：静止窗口连续显示、暂停／继续、未授权窗口、返回以及撤销／恢复授权；重复画面保留来源时间并隔离旧授权区间的缓存。
- 现有历史、严格 schema、macOS 路径、安装资源和生命周期回归。

2026-10-13 已通过 WSL 联动 Windows 11 x64 真实桌面完成 MSVC 编译、原生媒体与生命周期测试、静止画面回归和 Electron 录制／暂停／继续／视频回看验证，定位与前后结果见上述修复记录。两次 20 分钟稳定性测试及干净安装验收仍未完成；CI 文件的加入不代表这些检查已通过。

新增 `.github/workflows/macos-task-recording-validation.yml`，在 Mac 上编译两种架构的生产 helper，运行真实 AVFoundation 编码／解码、时间戳、色彩朝向、无重编码合并、PNG 提取和损坏尾部恢复测试。测试用合成媒体仅编入 `MEMMY_RECORDING_TESTS` 二进制，不进入安装包。原有 Electron/ASAR 测试覆盖新增 helper 在无需 Swift 的安装环境中解析执行。

当前 Linux 主机已运行 macOS 驱动协议、原生应用策略、权限路由、Retina 坐标、重复帧拒绝、会话生命周期、macOS 前端权限及安装路径回归。Swift 编译、macOS 原生媒体测试和真实 SCK 采集未在本机执行，不能据此宣称通过。Mac 上还需验收权限拒绝／撤销／重启、锁屏、前台 A→B→A、Retina／外接屏、暂停／继续、录制中退出、两次 20 分钟稳定性、崩溃恢复和签名安装包。

macOS API 依据：[Apple 窗口采集示例](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)、[SCK 窗口与坐标说明](https://developer.apple.com/videos/play/wwdc2022/10155/)、[Core Media host clock 转换](https://developer.apple.com/documentation/coremedia/cmclockmakehosttimefromsystemunits(_:))。

从仓库根目录运行本地基线：

```sh
MEMMY_LEGAL_CN_BASE_URL=https://memmy.cn \
MEMMY_LEGAL_INTL_BASE_URL=https://memmy.bot \
node scripts/internal/shared/validate-computer-history.mjs
```

Windows 原生构建与测试沿用 `scripts/internal/win/history-recorder-native.ps1` 及 CTest。Flow 兼容性工作流为 `.github/workflows/openadapt-recording-compat.yml`；Windows 工作流为 `.github/workflows/windows-computer-history-validation.yml`。

macOS 打包沿用 `scripts/internal/mac/build-dmg.sh`，构建及安装后验证会检查 `human-recorder`、`app-icon` 和 `task-recorder` 三个原生可执行文件；缺少 helper 时报告安装错误，禁止在客户机器上临时编译 Swift。
