# Memory 队列阶段 6：复查补修

日期：2026-10-22。基线 `6646adce`，工作分支 `test-memory-queue-v1.2.6`，整体 PR 目标 `upstream/v1.2.6`。本轮仅补修已确认的 5 项及其持续执行兼容边界，不进入后续阶段，不生成 DMG、不推送、不提交 PR。

后续复查更新：本记录对应补修提交 `23efb8bd`。该提交的既有回归通过后，额外边界复现又发现写入开关、事件循环让步与 Mistral 跨协议服务根 3 项遗漏；最新修复与验证见 [阶段 6 边界补修记录](memory-queue-stage6-boundary-fixes-20261022.md)。

## 复查发现与修复

| 问题 | 修前实际复现 | 修复与回归 |
| --- | --- | --- |
| 自动入口仍按 4 条等待整批结束 | 真实 HTTP、MemoryService、SQLite、默认云并发 2；首轮 3 条摘要与 1 条向量任务后，只剩首条慢摘要运行，3 个全局空槽、1 个云模型空槽仍无法继续领取 | 仅内部自动入口启用 continuous 模式，持续补位直至无可执行工作、取消或需要交还入口；真实 HTTP 验证第 5 条摘要在首条完成前已执行，全局及 Provider 上限不变 |
| 到期任务不能自行唤醒当前运行 | 慢任务运行时，5 秒后到期的独立任务在 10 秒仍 queued；失败退避、Embedding 重试及其他执行者的租约到期同样缺乏唤醒 | 运行中查询最近未来截止时间并设置单一可清理定时器，与任务完成、许可释放、新工作通知共同唤醒；已经到期但资源阻塞的记录不能遮住下一未来截止时间或产生零延迟定时循环 |
| Skill assign/evolve 缺少共享业务范围 | evolve 等待模型时 assign 加入新成员，memberCount 从 1 变 2；evolve 用旧快照写回后又变成 1，成员表仍 2 条 | 两类任务均按用户、项目互斥；assign 从真实 episode、evolve 从真实 cluster 读取项目，无 session/target 也正确；另一项目可继续执行，新成员保留并触发下一轮演化 |
| Anthropic 等价地址分成两个 Provider 根 | 默认地址与显式基础地址最终都是 `/v1/messages`；真实客户端、受控 fetch 测得相同 URL 的峰值 4，大于限额 2 | 按真实客户端的地址构造规则归一化，再计算许可根；相同实际 URL 共享上限，原复现峰值降为 2 |
| 已释放前台许可误拒新业务 | 首次模型调用结束后计数均归零，遗留定时回调开启新的模型业务仍报未准入，第二次 delegate 未执行 | 只在路由真正开启新前台业务时清理已释放的前台许可上下文；新业务重新准入；已释放 worker 的延迟调用仍拒绝，不放松旧任务 fencing |

这些属于原定连续补位、并发限制的实现补全，以及扩大并发后必要的业务保护，不增加新的 Skill 功能或恢复已取消的生产背压方案。

## 自动与手动执行边界

`runWorkerOnce(limit, request)` 手动请求仍严格服从总预算和 target 过滤。自动 HTTP 入口通过内部第三参数启用 continuous，HTTP 手动请求体不暴露该控制字段。自动入口原有的 `4` 不再是整次执行的总量限制，并发仍统一由控制器限制为全局 4、本地 1、云 2、Embedding 请求 1。

自动执行发现有等待的手动请求时停止继续领取，待已准入任务收尾后交还同一个 scheduler；手动 retry-only 入口也通过共同的通知路径唤醒自动执行。HTTP dispose 会取消自动继续准入，并等待已经开始的任务完成；不为凑满旧预算继续领取。手动请求仍是有限、独立且串行的执行请求，不允许 reentry。

长时间 continuous 不再每 4 条重新进入 `beforeRun`，因此预算对账截止时需要按原规则再次执行已有准备步骤。每个截止时间只尝试一次，未变化的 in-flight 时间不能导致反复等待；异步准备返回后重新检查取消、停止和待处理手动请求。预算对账完成时也会通知当前 pump 重新判断可运行任务。

legacy 仍保留其选择顺序；定时唤醒后的失败重试需完成原有的重新排队步骤，不能只唤醒而让 failed 项继续滞留。WRR 保持直接领取到期 failed 项的路径。定时器在被其他通知提前唤醒、执行结束或取消时清理。

## 修前证据

- 自动 HTTP：`/private/tmp/memmy-stage6-audit-http-cloud.log`。
- 当前运行缺少截止时间唤醒：`/private/tmp/memmy-stage6-audit-pump-boundaries.log`。
- 正式到期回归：`/private/tmp/memmy-stage6-deadline-formal-before.log`，4 项修前失败。
- 正式 HTTP 回归：`/private/tmp/memmy-stage6-http-formal-before.log`，新增 3 项中补位与关闭 2 项失败，手动预算对照通过。
- Skill：`/private/tmp/memmy-stage6-skill-scope-before.log`，2 项修前失败。
- Provider 和旧前台上下文：`/private/tmp/memmy-stage6-anthropic-root.repro.log`、`/private/tmp/memmy-stage6-stale-foreground.repro.log`；正式回归也先确认失败。
- 共同手动 retry 唤醒：`/private/tmp/memmy-stage6-manual-retry-yield-before.log`。
- 持续执行预算对账：`/private/tmp/memmy-stage6-reconcile-formal-before.log`。
- legacy 自然失败退避：`/private/tmp/memmy-stage6-legacy-natural-backoff-before.log`。

正式测试使用隔离临时 SQLite、真实服务/路由/业务 pipeline 和受控模型；未接入用户数据或外部付费模型。修前对照使用基线源码的临时加载或隔离副本，未回滚工作树、未影响并行修改。

## 最终验证

代码冻结后，在 macOS arm64、Node.js 22.23.3、npm 10.9.9 下验证：

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| Memory 全量 | 1650 通过、1 跳过；165 个文件通过、1 跳过 | `/private/tmp/memmy-stage6-review-fixes-memory-full.log` |
| 后端全量 | 1085 通过，132 个文件通过 | `/private/tmp/memmy-stage6-review-fixes-backend-full.log` |
| Memory 服务与 viewer 类型检查 | 通过 | `/private/tmp/memmy-stage6-review-fixes-typecheck.log` |
| 后端类型检查 | 通过 | `/private/tmp/memmy-stage6-review-fixes-backend-typecheck.log` |
| release workflow 保护 | 30 通过、5 跳过 | `/private/tmp/memmy-stage6-review-fixes-release.log` |
| packaging guards | 122 通过、1 跳过 | `/private/tmp/memmy-stage6-review-fixes-packaging.log` |
| 差异检查 | 通过 | `git diff --check` |

本轮新增 23 项正式回归：模型许可及上下文 4 项、Skill 2 项、HTTP 3 项、deadline 查询 6 项、共同手动 retry 唤醒 1 项、运行中到期与取消等 7 项。原有 HTTP 关闭测试按“停止继续准入、保留有限手动预算”的新明确行为调整，仍检查真实数据库状态、attempts、token 和已领取项全部收尾，不仅修改预期数量。

独立交叉审查覆盖准入与存储查询、业务范围、真实模型路由、持续执行交还入口、关闭与重入边界。复查发现的共同 retry 唤醒、持续执行预算对账及 legacy 退避兼容问题均已补修和测试；本轮 5 项没有遗留未处理的复现。定时唤醒测试不依赖手动 `notify`，取消测试检查定时器和 AbortSignal 监听器清理。

完整前端、Agent 工作区回归和真实桌面安装仍按后续统一验证计划执行。此处的后端全量、Memory 全量及打包保护不能表述为整个 monorepo 的 `npm test` 已通过。

本轮检查不替代真实 Provider 性能收敛、macOS DMG 安装及后续整体回归。
