# 实时任务预留全局槽位：修复与打包测试报告

日期：2026-10-24。开发分支：`test-memory-queue-v1.2.6`，目标基线：`upstream/v1.2.6`。
本轮源码提交：`f0c8070796b496d79feb410b251035efa02b5ce9`（fix: 为实时任务预留一个全局槽位）。

## 结论与使用方式

已实现默认总并发 4、后台最多 3，为 interactive 实时任务专门保留 1 个全局逻辑槽位。后台空闲时也不能借用预留槽位；实时任务可以使用全部尚可用的全局容量。Onboarding 首次报告沿用已持久化的 interactive 分类。

安装包：`/Users/lijia/Desktop/memmy-agent-main/queue-reservation-20261024/Memmy-1.2.3-darwin-arm64-cn-unsigned.dmg`。
这是 macOS Apple Silicon 中文未签名测试包，应用版本沿用仓库的 Desktop 1.2.3、Memory 2.1.6；开发分支基线为 v1.2.6，未擅自改版本号。

固定工作目录：`/Users/lijia/Desktop/memmy-agent-main/memory-queue-v126-work`。
测试证据目录：`/Users/lijia/Desktop/memmy-agent-main/queue-reservation-20261024`。

## 复现与调整

先在旧实现上运行新增回归，确认第 4 个后台任务可占满全局容量，不存在实时专用余量。随后才修改实现。

1. 在统一并发控制器中增加后台活跃任务计数，许可领取前同时检查全局上限和后台上限，失败不持有部分资源，也不先领取数据库租约。
2. 从持久化 queueLane 传递分类，仅 interactive 可用预留容量。历史 trace_summary 即便基础类型或 payload 看似实时，仍按其持久化 import 分类；启动摘要修复按 maintenance；Onboarding 首次报告保持 interactive。
3. 每个 Embedding 批次成员独立计入逻辑任务数，共享 Provider 许可不会共享或继承实时特权。成员独立释放，重复释放无副作用。
4. 扫描任务计入后台上限；前台模型请求继续只受 Provider／请求限制，不额外占用逻辑 worker 槽位。
5. 指标增加 backgroundActiveJobs、maxBackgroundJobs、interactiveReservedSlots、后台峰值和 background 拒绝计数，用于验证本次限制。
6. 总并发配置为 1 时，预留数退为 0、后台上限仍为 1，避免后台永远无法执行；总并发为 2／4／8 时，后台上限分别为 1／3／7。

本轮只解决第一项全局槽位预留，没有实现第二项“全队列精确 runnable／等待原因统计”。没有增加生产背压或批量修复取消。

## 回归覆盖与结果

- 总并发和后台上限共同生效；许可拒绝不泄漏 Provider、scope 或全局槽位。
- 3 个后台任务长期占位时，新实时记忆、Onboarding 首次报告可使用第 4 槽；被拒绝的历史／启动修复任务保持 queued、attempts=0、leaseToken=null。
- 扫描 300 条后台积压的真实事件循环切片期间插入实时任务，实时任务仍可进入；130 条积压全部检查后进入等待，再插入实时任务并通知也可启动，等待期间没有持续轮询。
- 共享 Embedding 批次、未知 lane、单槽配置、扫描等待／取消、租约安全、配置变化、失败／停止释放和指标窗口均有对应回归。
- WRR 游标专项测试使用非饱和容量隔离“配额游标”和“许可拒绝”两个因素；饱和场景由新增预留槽位测试独立验证。原模拟实时占位显式标记 interactive，不把真实扫描任务视为实时。

| 检查 | 最终结果 |
| --- | --- |
| npm run lint | 通过 |
| npm run typecheck | 通过 |
| npm test | 退出码 0 |
| Memory 首轮 | 2171 通过，1 跳过 |
| Memory workspace 第二轮 | 2172 通过，1 跳过 |
| Backend | 992 通过 |
| Frontend | 2505 通过 |
| Desktop | 1287 通过，126 跳过 |
| Agent TUI | 5 通过 |
| 打包后专项复核 | 65 通过 |
| 提交差异检查及两轮独立复查 | 通过，未发现新增问题 |

首轮恢复环境时出现过本地测试端口被沙箱禁止、Electron 测试运行时缺失，以及旧断言仍期待后台可占满 4 个槽位等失败。已分别允许测试所需的本地监听、恢复运行时、按新规则补充和更新断言后重新执行。上表只报告最终通过结果。Memory 两轮数字不同，是因为新增指标回归在第二轮开始前已加入，最终提交与打包后专项检查均包含该用例。

## 安装包验证

使用正式 `npm run package:mac:arm64:cn:unsigned` 构建，耗时 4 分 15 秒；原生组件、兼容 macOS 12 的 SQLCipher／OpenSSL、生产 renderer、运行时裁剪和打包守卫全部通过。复用本机已缓存的模型和原生依赖，没有依赖升级或锁文件提交。

DMG 完整性校验通过；只读挂载后复制到独立安装目录测试，未替换 /Applications 中的正式应用。

SHA256：`48f29997b55dd0ae226030eaf9d425dd97081b27fb015cefa823c37ac19c04f8`。
Memory buildId：`3142a05c95b56fdd39a81b07ca2f8ac6a08cb8198f239a1229b0ed8c08de7547`，schema 13。
包内 230 个 Memory JavaScript 模块与本次源码编译结果逐字节相同，关键控制器、requirements、runner、指标模块均已核对。

安装包中的 Electron、原生 SQLite 和编译后的真实 Runner 验证了 10000 条 import_summary 积压：后台仅领取 3 条并持续占位；新实时记忆、首次报告依次进入第 4 个槽位；9997 条后台任务仍 queued、attempts=0、无租约。任务结束和停止后所有逻辑槽位、后台计数、Provider 及 scope 清零。

该受控队列验证中，实时任务开始等待约 6.96 ms、首次报告约 6.63 ms。这里用可控等待替代业务处理和模型调用，数值只说明全局槽位不会被后台占满，不能作为真实模型耗时或生产 SLO 承诺。

实际启动独立安装的应用，使用隔离 HOME 和测试 profile：两轮均进入完整登录页面（已检查截图，未把启动动画算成功）；Memory /health 正常，返回正确 buildId、schema 13 和 native vector 存储。两轮健康就绪约 1.20／1.19 秒，正常退出约 140／117 ms，退出码均为 0；同一 profile 重启正常。

打包会将开发目录的 SQLite 原生库切换为 Electron ABI。结束后已恢复 Node 22 ABI，并用内存数据库及 65 项专项回归验证开发环境仍可使用。

## 实际边界

本轮 UI 测试是隔离新 profile 的自动启动、完整登录页面渲染、健康、退出和重启，没有登录真实账号或人工操作完整记忆业务流程。真实队列持久化与领取行为已通过包内 1 万条受控积压及源码回归验证；没有把它宣称为云模型或 LM Studio 满载性能测试。

预留全局槽位不会突破资源、Provider 或业务 scope 限制。共享本地模型正在执行不可抢占请求时，实时任务仍需等该请求结束。纯后台负载下，默认并发最多 3，这是专门预留容量的预期代价。

本轮只有本地提交，没有推送或创建 PR。没有修改用户的 Pages 方案文件。
