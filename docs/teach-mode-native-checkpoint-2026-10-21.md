# Teach Mode：原生事件确认标记与 partial 修复

本轮在个人 fork 的 `pxlin/dev` 上补齐 Windows C++ 采集器到 Host 文件的确认链路。主程序和插件仍按既有边界分发，云端 Registry 接入继续留空；不创建或重开上游 PR。

## 实现

1. Host 为 checkpoint 分配 UUID。Windows 包装进程向原生采集器写入 `checkpoint <UUID>`。
2. 控制线程只唤醒调度器，不取消正在进行的 UIA 查询。暂停、停止、EOF 和控制队列溢出保留中断优先级。
3. 请求经 hook 消息循环进入采集 FIFO，获得递增的 `captureSequence`。标记不能被普通事件合并覆盖；满观察队列另留最多 16 个标记位置，超限不会伪造确认。
4. 调度器完成标记前的 pending 观察，再输出带原生会话 ID、连续事件序号、请求 ID 和采集序号的 `session.checkpoint`。可选的原生文件输出先刷新前序写入。
5. TypeScript 顺序校验协议、处理和脱敏前序观察，将 `recording_checkpoint` 写入同一文件并执行 `fsync`。完成后才返回原生序号、采集序号、落盘记录序号及精确字节位置。
6. Host 只读取确认位置之前的字节。即使后续事件在确认消息送达前已经写入文件，也不会混入这次快照。重复在途请求仍合并，超时、进程退出、暂停、写入或刷新失败不会返回成功。

队列溢出、查询失败/取消、提交拒绝和截断以区间缺口处理；`recording_gap` 诊断也在标记之前落盘。每个片段按自己的区间判定，恢复不会删除旧片段的缺口。`boundaryConfirmed` 单独表示边界已确认，避免把“已落盘但覆盖不完整”误报成“没有收到确认”。

确认标记和缺口诊断是传输证据，不计入教学操作、技能输入或语义摘要。保留证据时校验其结构；仅有控制记录的片段不生成活动摘要。

实机复验还发现一个游标竞态：Windows 原生时间略领先 Host 时钟时，周期读取曾跳过该事件并推进游标，最终片段可能错误变空。现在周期读取保留该事件的起始字节，下一轮继续读取；最终停止仍使用首次授权停止请求固定的截止时间，排除截止后的事件。回归包含中文 UTF-8 字节位置校验。

## 验证

- 生产 TypeScript 构建通过；变更文件 ESLint 通过。
- Computer History 与插件 Host 的相关回归通过，具体数量及跳过项见同目录验证 JSON。Linux 环境跳过的原生用例没有计为通过。
- MSVC 2022 x64 Release 构建通过。CTest 的 `unit`、`win.boundaries`、`win.metadata`、`task_video.media_integrity` 四项通过。
- 在真实交互桌面通过十一项原生集成测试，包括新增 `observe_checkpoint`、`observe_checkpoint_origin`、暂停和控制洪泛竞态、截断基线、观察生命周期、UIA 挂起恢复、EOF、刷新失败、输入钩子及停止快捷键。新增测试在提交写入被阻塞时请求标记，确认释放之前没有提前确认，释放后快照序号先于标记。
- 原生生产 EXE SHA-256：`5d15301ff2bbb4e21fc551434d3dece9887d41fe103935dc3995af7b8878f6da`。

Windows Host 验证使用真实生产采集器和受控 Win32 窗口，经过 `WindowsComputerHistoryService → PluginEventSessions`，实际运行在 Memmy 自带的 Node 22.20.0 中。依次记录健康、故意冻结 UIA 提供者、恢复三个片段，要求结果分别为 `available → partial → available`；同时验证原生序号递增、缺口证据已保存、控制标记不计为教学操作、停止后的片段哈希不变，以及后台采集意图保留。最终会话 ID、事件数量、哈希和状态见[验证摘要](verification/teach-mode-native-checkpoint-2026-10-21.json)。

原有正式版采集在运行测试时临时通过其自身 API 暂停，测试后恢复；不修改其数据。启动控制脚本使用系统 Node，因此这次确认的是宿主运行时和真实采集链路，不能作为无系统 Node 的干净机安装验收。既有浏览器采集范围没有扩展。对话、技能生成、浏览器操作的验收保留上一轮独立报告，本轮聚焦原生确认与片段落盘。

## 已有检查问题

扩大到 Computer Recordings 的检查时，`openadapt-export.test.ts` 的 `text`、`overflow`、`unsupported` 三项原有断言失败。在修改前的 `be206e34` 独立 worktree 上复现相同三项失败。

全量测试 TypeScript 检查仍有两处既有错误：`runner-image-text-fallback.test.ts:117` 的重写签名，以及 `websocket-http-routes.test.ts:1283` 的 `unknown` 类型。在同一基线 worktree 上重跑，错误文本与修改后的检查完全一致。生产构建不受影响。

原始证据与脚本保存在本机 `/home/zephyr/work/teach-mode-checkpoint-20261021/`：`final-tests.json`、`native-interactive.xml`、`host-probe.json`、基线对照结果及构建日志。早期探针的目录配置错误、实机发现游标竞态的失败尝试也保留，未覆盖成成功记录。

## 远端 CI 发现的取消管道竞态

首次 [Host 兼容 CI](https://github.com/Jovianix/memmy-agent/actions/runs/39566360339) 的 182 项后端断言通过，但命令插件取消后仍回写 Host-service 响应，触发未监听的 stdin `EPIPE`，使任务失败并取消另一平台。补充监听 stdin 错误并作为调用失败返回，同时跳过向已终止子进程的响应；新增确定性管道错误回归，保留取消、超时和权限行为。后端完整兼容组 183 项通过、1 项平台测试跳过，后端类型检查通过。

排队或合并通知保留最早的原始采集时间，缺口不使用延后的出队时间。新增原生阻塞用例通过真实 F6 输入验证：停止前的输入在停止后处理失败，仍落在原片段的缺口范围。相关 C++ 单元测试同时检查合并通知的最早时间没有被后续通知覆盖。

取消管道修复后的 [Linux / Windows Host CI](https://github.com/Jovianix/memmy-agent/actions/runs/39567516921) 均通过。独立 Windows History 流水线的原生构建和 CTest 阶段通过，综合验证仍被上述两处已有测试类型错误阻塞。
