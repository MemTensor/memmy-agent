# Memory 队列改造：阶段 4 统一执行入口

日期：2026-10-22。工作分支 `test-memory-queue-v1.2.6`，整体 PR 目标 `upstream/v1.2.6`；承接阶段 3 及权重确认提交 `e50d6023`。本阶段仅统一入口，真实任务选择仍使用旧规则，影子调度继续使用用户确认的 **4/3/2/2/1**。

## 问题复现与范围

阶段 1 已复现：同一个 runner 同时接收两个 `runWorkerOnce(4)` 请求，实际有 **8 个摘要处理器同时执行**。自动 drain 的 `running` 标记只约束自身，不能约束 HTTP 手工调用、历史导入或首次报告发出的独立请求。

本阶段另外通过真实 HTTP＋SQLite 复现：摘要任务已存在时，导入摘要入队接口返回 `enqueued=0`，原接口不唤醒自动 worker；在禁用短期启动兜底的测试中，目标持续等待，修前验证超时。日志 `/private/tmp/memmy-stage4-http-wake-before.log`。

工作文档要求：历史导入、Onboarding 只负责入队、唤醒和查询目标状态；worker/run 统一进入同一个调度器。本阶段不提前切换 WRR，不实施四层资源许可，不重新增加已取消的生产背压方案。

## 实现

### 1. 同一个执行边界

每个 `WorkerRunner` 持有一个 `WorkerScheduler`，自动、手工、CLI、直接 MemoryService 调用和公开 retry 排空都通过它。当前按请求 FIFO 进入执行，上一请求退出后才允许下一请求领取任务。

该 FIFO 是**执行请求的顺序**；业务任务的实际选择仍沿用旧 SQL 排序及 cohort 规则。内存中等待的请求不包含第二份持久化业务任务事实，任务仍保存在原数据库表。

- 等待请求不提前领取任务，不持有租约，不增加 attempts。
- 每个请求保留自己的目标、limit、cohort 及结果，避免请求之间混用。
- 同步异常、异步异常或领取失败后释放入口，后续请求仍能执行。
- 主排空内部直接调用私有 retry 实现，避免拿着执行入口再等待自己。
- 当前任务若直接等待同一调度器再次执行或等待自己的关闭，明确拒绝，避免死锁。
- 自动唤醒是独立请求：自动 drain 清除继承的调度上下文后再入门，因此任务异步后代发出的正常唤醒可以排队；这不增加第二个活跃执行流程。

### 2. 历史导入与首次报告只入队、唤醒、等待

复用已有 `enqueueImportSummaries` 接口，不新增 HTTP API。它在鉴权和入队操作成功后无条件唤醒自动处理，包括 `enqueued=0` 的已有任务。

- 历史导入：保留已有 100 条目标分组，入队后每 250ms 查询处理状态、更新进度；保留取消、失败收集及 40 分钟无进展超时。取消停止调用方等待，不删除已持久化任务。
- 首次报告：入队后每 100ms 查询目标状态，保留 180 秒总时限；只有摘要与索引达到 ready 才进行后续检索，失败、缺失状态和 ready_text_only 不能被当成建立索引成功。
- 两个 producer 不再调用 `runWorker`；其依赖类型也不再要求执行能力。
- 手工重试仍通过现有路由更新状态并唤醒后台调度。

### 3. 生命周期也纳入边界

预算准备及排空后的自动历史 Skill 对账一并放在入口内。否则仅等待 runner 的模型执行结束，MemoryService 仍可能在数据库关闭后做收尾写入。

`MemoryService.stop()` 先停止接收新执行请求、拒绝未开始请求，允许当前有租约保护的请求及其收尾完成后再结束；外部重复关闭仍等待同一结束状态。每次关闭都先检查自等待，防止活跃任务等待一个已经由外部发起、但又必须等它结束的关闭 Promise。

HTTP 关闭继续等待已接受的请求与自动 drain；测试验证关闭 sockets 不会跳过服务器已接受的工作。

## 验收与证据边界

使用真实 MemoryService、WorkerRunner、HTTP 和 SQLite，模型与业务慢请求使用受控本地替身。数据位于临时测试目录，未接入当前 Memmy 窗口、未触发真实模型请求、未改用户数据库。

- 两个并发 `runWorkerOnce(4)` 摘要请求：峰值由原始复现的 **8 降为 4**；第二个请求的任务保持 queued、attempts=0、没有 lease token，之后正常完成。
- 真实 HTTP 自动处理与手工请求重叠：同样只有当前请求领取四条摘要，手工请求等待；释放受控慢请求后全部目标完成。
- `enqueued=0`：现有摘要被成功唤醒并最终 ready。
- 导入、首次报告：模拟后台独立推进目标状态，验证完成、失败、取消及超时路径，同时断言没有调用 `runWorker`。
- 关闭、同步/异步错误、同门重入、旧异步上下文、独立唤醒、直接 retry、请求过滤和默认 limit 均有回归覆盖。
- 原配置隔离与 observation 修订用例改为在新边界允许的场景下验证：并发可以发生在同一已接纳批次中，后续请求必须等待；继续验证旧配置失败不能恢复新配置下真实失败的其他任务，旧 generation 不能覆盖新 generation 的处理状态。

## 检查结果

- Memory 全量：**1465 项通过，1 项跳过**。
- Backend 全量：**1073 项通过**。
- `npm run memory:lint`：共享类型构建、Memory 与 Viewer 类型检查通过。
- Backend 源码 TypeScript 检查及全模块 ESLint：通过。
- 发布流程检查：30 项通过，5 项跳过。
- 打包守卫检查：122 项通过，1 项跳过。
- `git diff --check`：通过。

Backend 完整回归前按仓库脚本生成本地 lifecycle sidecar，并将独立工作区的 `@memmy/local-api-contracts` 链接到本分支编译结果；原链接引用另一工作区的旧产物，使两项语言测试错误返回 en-US。修正测试环境后全量通过，未修改语言功能源码，也未提交生成资源、node_modules 或锁文件。Memory 与 Backend 全量独立运行，避免一万条诊断等固定时间预算用例因并行争用资源而误超时。

日志：`/private/tmp/memmy-stage4-memory-tests-final.log`、`/private/tmp/memmy-stage4-backend-tests-final.log`、`/private/tmp/memmy-stage4-memory-lint-final.log`、`/private/tmp/memmy-stage4-backend-typecheck-final.log`、`/private/tmp/memmy-stage4-backend-lint-final.log`、`/private/tmp/memmy-stage4-release-guards.log`、`/private/tmp/memmy-stage4-packaging-guards.log`。

## 本阶段尚未改变的能力

统一入口不等于已经完成全部并发控制。默认 `limit=100` 保留原工作预算和返回语义；摘要在单次执行中仍每组最多四个，Embedding 仍可能整批预取和准备。**不能把阶段 4 的摘要峰值 4 当成所有任务都已具备全局逻辑活跃数 4 的证明。** 去除提前租约、四层许可、Embedding 微批次及连续补位属于阶段 6。

旧严格优先级、批次屏障和 retry 仅用剩余名额的规则尚在；入口统一后，首次报告也不能抢占一个已经运行中的长批次。阶段 5 将切换真实 WRR＋可运行 FIFO，阶段 6 再落实受控并发。

本阶段不单独打包、不推送、不提交 PR；按整体计划在全部改造后统一 Mac 打包与安装验收。完成本地提交后等待用户确认，再进入阶段 5。
