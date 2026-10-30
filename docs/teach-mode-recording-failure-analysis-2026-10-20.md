# Teach Mode Windows 录制失败根因与计时条修复

2026-10-20，在业务源码基线 `0af001d193efe5aecafc2bc4d0f40ba03e883e31` 上复现并修复。插件仍使用独立仓库 Teach Mode `0.3.0` 的固定 Windows CI ZIP，SHA-256 为 `d3c388a20c85658c6be54f5e1977d871b9b9141f0e2bb7b94ee4018f01485eb3`。这次修改均在 Host，未更改插件包或正式云端配置。

## 结论

录制失败由两个问题叠加：Windows PowerShell 5.1 在组装完整 UIA 快照时抛异常，Host 又把可恢复的观察器故障当成采集进程已停止，随后主动释放了最后一个采集订阅。此前看到的 `capture_source_stopped` 是这条链路最终对会话报告的错误，不能据此认定原生进程先崩溃。

修复后，同一 Windows 原生链路持续采集 30 秒并保存 6 条事件；真实 Memmy 对话会话持续约 193 秒，结束时有 11 条事件，状态为 `ready / available`，实际文件 SHA-256 与会话元数据一致。新计时条在实际对话中从 `00:01` 递增至 `00:07`，结束后固定为 `03:12`。

## 直接故障：完整快照的泛型列表转换

`App/native-computer-history/apps/OpenComputerHistoryWindows/worker.ps1` 的 `Snapshot` 创建 `System.Collections.Generic.List[object]` 存放已验证的点击目标，原先用 `targets=@($targets)` 组装结果。

在本机 Windows PowerShell 5.1 中，这个转换会触发 `System.ArgumentException`。为排查，临时诊断副本只记录异常类型、错误代码和脚本行号，不记录异常消息或观察内容。8 次真实 UIA 请求中，6 次完整快照进入同一异常分支；调用栈指向修改前的 `Snapshot` 第 256 行。非完整观察仍可能成功，所以会先看到 `observer_ready` 和 `application_changed`，随后完整快照连续失败并产生 `observer_unavailable`。

修复将结果组装集中到 `SnapshotResult`，显式调用 `$targets.ToArray()`。同一个真实 Windows UIA 探针复测后，完整请求返回非空快照，未再发生该异常。PowerShell 5.1 自检新增空列表和非空列表的实际序列化回归，并接入 Host Windows CI。

此前的受控事件测试没有执行真实 UIA 快照组装；原有原生纯自检主要覆盖协议、来源校验及调度，也没有覆盖这一泛型列表转换。这解释了受控测试通过而真实桌面采集失败的差异。

## 放大故障：把覆盖质量当作采集进程生命周期

`ComputerHistoryDemoService.eventCheckpoint()` 原先只有在 `captureObserverReadyAt > 0` 且不存在 `observer_unavailable` 等问题时，才返回 `running: true`。`PluginEventSessions.collect()` 收到 `running: false` 就会将会话标记失败，并释放订阅。

```mermaid
flowchart LR
  A[完整 UIA 快照组装异常] --> B[observer_unavailable]
  B --> C[checkpoint.running 误置 false]
  C --> D[capture_source_stopped]
  D --> E[释放最后一个订阅]
  E --> F[Host 主动停止共享采集器]
```

Windows 诊断时间线（UTC）说明了实际先后关系：

| 时间 | 观察 |
| --- | --- |
| 14:06:53.068 | 收到采集心跳 |
| 14:06:54.153 | 收到 `observer_ready` |
| 14:06:54.176 | 教学会话进入 `recording` |
| 14:06:58.888 | 收到 `observer_unavailable` |
| 14:07:06.308 | 采集子进程仍存活，健康状态为 degraded |
| 14:07:06.927 | 教学会话被标记为 `capture_source_stopped` |
| 14:07:07.307 | 释放订阅后，采集子进程已退出 |

同一判定还会导致另一种启动失败：当前窗口暂时不可读或浏览器普通窗口身份无法确认时，还没有 `observer_ready`，即使进程仍在工作，也可能返回 `capture_not_running`。隐私规则要求跳过的窗口继续跳过；它们不会因此获得采集授权。

修复后，`running` 根据订阅、Host 状态和真实子进程退出状态判断。观察器就绪、健康问题和 native→disk 边界用来判断完整性：未确认时保留 `partial` 与限制说明；真正停止、退出或撤销订阅仍返回非运行状态。录制期间出现过的不完整边界，在恢复后也不会被覆盖为完整片段。

共享采集仍保留用户的后台 Computer History 意图。测试时后台意图为 stopped，插件临时取得采集订阅；最后一个订阅释放后恢复 stopped。这是预期行为。

## 窗口录制计时条

`PluginConversationRecording` 在对话输入框上方显示独立录制条，复用现有录制条样式：视频图标、红色录制标记、按真实 `startedAt` 计算的时长，以及结束、取消、停用操作。

- `/teach` 仅待命时不显示活动计时。
- 实际会话进入录制后，每秒更新；超过一小时显示 `HH:MM:SS`。
- 结束请求处理中显示处理状态；结束后按真实 `endedAt` 固定时长并撤下活动条。
- 部分可用时显示覆盖提示，失败时显示真实错误，不保留活动录制样式。
- 会话切换只展示当前对话的状态；结束和取消均不会自动生成技能。

该计时条表示已授权桌面操作事件采集；本次没有新增屏幕视频或音频采集。

## 验证

| 检查 | 结果 |
| --- | --- |
| 采集健康、重连、暂停/恢复、共享订阅、边界、插件会话 | 120 项通过 |
| 对话计时条、插件商店及录制可见性 | 30 项通过 |
| Agent 编译、renderer 类型检查与生产构建 | 通过 |
| Go 原生观察器测试 | 通过 |
| Windows PowerShell 5.1 空/非空快照目标序列化 | 通过 |
| Windows 原生采集前后对照 | 修复前约 12.8 秒失败、0 条事件；修复后 30 秒结束、6 条事件，`ready / available` |
| 真实 Memmy 对话 | 单独待命与明确开始；模型实际调用本地插件；计时递增、UI 结束、时长冻结、落盘哈希核验通过 |

真实 Memmy 会话：`5a237049-b30c-4fc6-93f2-66e3bbef7a9f`；对话：`47da2c82-bc98-4898-bada-41c0600f441e`；起止时间：`2026-10-20T14:25:01.117Z` → `2026-10-20T14:28:14.089Z`。11 条事件为 8 条可访问性快照和 3 条应用变化，包含公开诊断文本。证据哈希：`ed2bc49398c7f4fcc4e3e0e01316b18c432016c74d1841e7bb4a6c29ad0eb519`。

本机证据保存在 `/home/zephyr/work/teach-mode-recording-fix-20261020/evidence/`：`before-trace.jsonl`、`uia-trace.jsonl`、`after-trace.jsonl`、`worker-selftest-result.json`、`live-result.json`、`ended-result.json`、`file-verification.json` 及 `screenshots/`。截图和运行数据留在本机，未上传到仓库；运行密钥与配置不进入报告。

## 仍需单独处理的事项

真实对话复测前，仍需通过重新安装恢复已知的 Windows 插件初始化时序问题，并重连 Gateway 刷新插件工具。首次模型调用误用了 Composio 搜索，重连并明确重试后，实际调用的是 `mcp_plugins_plugin_record_and_replay_cb7d2519`。快速确认安装权限还暴露了现有界面的操作锁竞态，等待安装操作完成后再次确认可恢复。这些启动与安装问题不在本次采集器和计时条修复内。

本次验收覆盖采集、计时条及结束落盘。论文完整示范、生成 skill 和第 2–5 条复用仍需后续完整重验；此前端到端失败报告继续保留。正式云端 Registry、catalog、下载和更新入口仍留空。

## 2026-10-21：片段覆盖、启动恢复与停止边界整改

本节更新上节遗留的启动恢复问题，并修复持续 `partial` 和停止请求排队带入后续事件的问题。全部修改仍在 Host，插件固定制品不变。

- Windows 原生采集器改为记录缺口的起止时间。checkpoint 携带片段 `from/through`，只有与该区间相交的丢失、截断、观察器故障才影响完整性；恢复不删除历史缺口。Host 同样保留有界缺口记录，旧采集器没有范围确认时继续保守报告部分可用。相同在途 checkpoint 共用 Promise，周期采集最多保留一个任务。
- 保留 Windows 首窗先展示的流程，依赖 Gateway 的恢复任务等待真实健康检查完成后再启动。新增迁移 `0033-plugin-enabled-intent.sql` 保存 `desired_enabled`，运行失败不再抹掉用户启用意图；兼容恢复旧的已启用记录及已知连接错误记录。连接类错误默认最多尝试四次，间隔 0.5、1.5、5 秒；权限、资格与兼容错误不重试。停用、卸载和退出会取消等待、重试及 MCP 初始化，并清理失败的初始化缓存。
- 实机还发现 MCP 刷新回调持有初始化前的旧工具注册表。Agent 重建注册表后，旧回调使插件虽为 `active`，新对话仍缺少录制工具。刷新现在明确接收当前注册表，新增覆盖重建后注册和撤下工具的回归测试。
- Host 校验停止请求的插件和对话归属后，立即固定 `endedAt`；在途采集与最终落盘均使用同一截止时间。重复停止共用同一 Promise 和边界，越权请求不会提前截断其他对话。

### Windows 范围与停止验证

使用安装包自带的 Memmy Node 22.20.0、真实 Windows UIA 采集器和独立公开诊断窗口。测试未注入模拟录制事件；停止竞态通过延迟真实 checkpoint 的回调人为构造。

| 检查 | 实际结果 |
| --- | --- |
| 缺口片段 | `004c10c4-1147-43ab-96ba-ddcd923b85eb`，无法验证普通浏览器窗口，`ready / partial` |
| 后续健康片段 | `7eac1917-f43e-43ff-8431-b53a07eb72b0`，同一采集子进程 PID 21528，2 条真实事件，`ready / available`；原缺口片段状态与哈希不变 |
| 停止竞态 | `e84ee7d9-c3bb-48c8-962a-2308ed528271`，请求与截止时间同为 `2026-10-21T03:52:28.863Z`，约 6 秒后完成，1 条事件，`ready / available` |
| 截止后事件 | 真实源文件另有 2 条截止后事件，教学片段保存 0 条；重复停止返回相同 Promise |

前两次诊断尝试也保留：一次跨过十分钟进程轮换并遇到新观察器启动缺口，正确保留 `partial`；一次健康窗口没有新变化，结果为 `empty`。随后让公开窗口标题定时更新，得到上表的真实非空健康片段，未放宽完整性判断。

证据目录：`/home/zephyr/work/teach-mode-lifecycle-fixes-20261021/evidence/`。`windows-range-stop-result.json` 保存断言结果，`native-probes/` 保存各次尝试、会话清单、冻结事件和源文件；测试脚本位于该目录的同级 `scripts/`。浏览器用户资料、认证配置和密钥均不进入证据。

### 冷启动对话与回归检查

修复工具注册表后再次冷启动隔离的 Windows memmy-dev，保留原安装和授权，未重装、未重启 Gateway、未手动刷新 MCP。在新对话中先 `/teach` 待命，再单独要求开始录制；模型实际调用 `mcp_plugins_plugin_record_and_replay_cb7d2519`。会话 `eba89230-f811-4b3f-83a2-5a13f47ef0d5` 的窗口计时由 `00:20` 递增至 `00:26`，点击结束后固定为 `00:40`，活动计时条撤下。

该对话会话于 `03:54:36.558Z` 开始、`03:55:17.348Z` 结束，保存 2 条实际 Electron 窗口事件。会话未确认全区间 native-to-disk 完整性，仍如实为 `ready / partial`，没有将其写成完整采集通过。文件 SHA-256 为 `bfb8676639ea2d4a2e8901e8482338cb588251e72035f9c4f671dfdfa33af1ae`，与清单一致。后续健康片段不继承历史异常的结论来自上表同进程、具有真实窗口变化的范围验证。

本轮相关专项共 **366 通过、13 跳过**：Backend 插件、账号与升级兼容 149 通过 / 1 跳过；事件采集与落盘 57 通过；MCP 连接、调用与注册表刷新 73 通过 / 2 跳过；Desktop 服务启动和 Windows 运行时归属 87 通过 / 10 跳过。覆盖恢复等待期间再次启用，以及恢复成功、工具仍在刷新时重复启用；后者不应拆掉已正常运行的 worker。等待新增权限批准的插件保持 `pending_approval`，启用意图不能跳过授权或改成无恢复入口的失败状态。Contracts、Backend、Agent 生产代码及 Desktop 编译、Go 原生测试和 Windows 交叉编译通过。

工具目录刷新和 Gateway 就绪回归已加入两平台 CI。新增步骤暴露了既有 Memory 强杀测试的 Unix 假设：Windows 实际以退出码 `1` 报告被终止的子进程。该断言改为平台对应的精确退出描述，并同时确认子进程已退出，没有跳过该测试或修改运行时终止逻辑。Memory 复用测试会执行最多 10 秒的 Windows 进程查询，其 Windows 测试预算改为 20 秒以覆盖这次真实 OS 调用；仍断言没有启动第二个服务，产品启动时限不变。

扩展检查没有全部通过，以下失败涉及的断言、代码位置或配置均未在本轮修改：Agent 全量测试类型检查的 `runner-image-text-fallback.test.ts:117` 与 `websocket-http-routes.test.ts:1283`；Desktop 打包边界测试要求 `bundled-plugins` 的 `filter: ["**/*"]`，而现有 YAML 未写该字段；额外的 MCP HTTP probe 测试假定 `unreachable-host.test:80` 不可连接，本环境实际返回可连接。没有放宽这些测试来计入通过数。

本轮未重做论文示范、生成技能和第 2–5 条内容复用，原完整链路报告继续保留。桌面操作由交互 Session 1 完成，控制脚本使用已安装的系统 Node；因此不将本次 UI 验证称为“整台机器未安装系统 Node”的验收。正式云端接入按用户要求继续留空。


## 2026-10-21：C++ 原生确认链路补齐

后续已实现带序号的原生 FIFO 标记、顺序处理、脱敏文件写入与 fsync 确认，Host 使用精确字节水位读取；缺口诊断一并落盘并按片段区间判定。新增标记不计为教学操作或活动摘要。还修复了周期读取在原生时间略领先时跳过事件并推进游标的竞态，最终停止继续遵循固定截止时间。

真实 Windows Host 复验得到 `available → partial → available`，保留旧片段缺口，恢复片段独立完整；11 个标记和 2 条缺口记录已保存，停止后的快照哈希不变。相关回归 762 项通过、21 项受平台限制跳过；原生 CTest 四项和交互桌面集成十一项通过。历史完整对话中的 partial 记录不自动改写；浏览器采集范围及云端接入边界保持此前记录。

实现、实机证据及基线已有检查问题见 [原生 checkpoint 专项报告](teach-mode-native-checkpoint-2026-10-21.md) 和 [验证摘要](verification/teach-mode-native-checkpoint-2026-10-21.json)。

缺口区间额外保留排队及合并通知的最早采集时间，防止停止前的丢失因延迟出队而被排除；原生阻塞输入回归已通过。
