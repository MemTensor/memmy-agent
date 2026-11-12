# Memory 队列改造：v1.2.6 交付准备复核

后续复查及最终退出补修包的最新结果见 [队列方案复查与打包验证](memory-queue-plan-recheck-v126-20261023.md)。以下保留此前候选包的历史结果。

日期：2026-10-23。个人分支 `test-memory-queue-v1.2.6`，目标 `MemTensor/memmy-agent:v1.2.6`。本记录承接阶段 8；工作文档没有新的开发阶段。本轮只完成同步、补测、重新打包及 PR 说明准备，没有推送或创建 PR。

## 当前结论

同步后的自动化套件全部通过。最终包的受控公平性、并发上限、实际本地模型及数据保留检查已有通过证据；但实际重扫中的组合监控未在原预算内完成，不能写成“全部实机测试通过”。同一轮随后完成，新记忆在约 126 秒达到 ready，全量重扫在约 147 秒结束。此前约 35 秒的场景不是固定等待保证。

提交前需用户确认的边界是：是否接受当前按任务机会分配且不抢占长任务的 WRR 等待表现，以及保留 Desktop 退出清理超时。没有为了消除这些观察而修改权重、并发、模型延迟或扩大 Desktop 生命周期范围。

## 上游同步及自动检查

获取最新上游后，`v1.2.6` 从 `f19bd810` 更新到 `843d9d8712e3969b362bf1bb17af7872f2f2e080`，新增 9 个 Agent 工具参数别名、输出限制及测试文件。使用 merge 无冲突合入，代码打包提交为 `a960abe84e523aeb6865eead836e482b05758096`，没有 rebase、强推或合并他人个人分支；这些上游文件不额外计入本 PR 的交付差异。

| 检查 | 结果 |
| --- | --- |
| 根目录 lint、typecheck、显式 Agent typecheck | 均通过 |
| Agent 全量 | 7,256 通过、80 原有跳过 |
| Memory 全量 | 1,812 通过、1 原有跳过（根流程中执行两次） |
| Migrations / Backend / Frontend | 279 通过、1 跳过 / 1,109 通过 / 2,452 通过 |
| Electron | 1,259 通过、126 原有跳过 |
| release / packaging guards / contracts / AgentSource / Knowledge / local contracts / TUI | 30/5 跳过、122/1、8、62、48、32、5 |
| 相对目标分支差异检查 | 无空白错误或冲突标记 |

日志 `/private/tmp/memmy-delivery-sync-{lint,typecheck,agent-typecheck,agent-test,root-test}.log`。按顺序构建及测试，避免共享 dist 重建竞态。没有放宽生产回归断言或新增跳过；没有新增依赖、锁文件、版本号、用户数据库或安装包到 Git。

## 最终安装包

官方 arm64 国内未签名打包于 14:29:57 完成，3 分 31 秒、退出码 0。桌面 1.2.3、Memory 2.1.6，目标分支号不等于产品包内版本。DMG SHA-256：`eeeea9c25639d24cda7ab455c28e32b2824a833a6ca76c63548fc025925b76dd`，hdiutil 校验 VALID。固定副本 `/private/tmp/memmy-delivery/Memmy-1.2.3-arm64-a960abe8.dmg`；前轮 299a4a14 的包另保留为 `/private/tmp/memmy-stage8-package/Memmy-1.2.3-arm64-299a4a14.dmg`，不混淆同名 release 路径后续重打包的内容。

只读 DMG 复制到 `/private/tmp/memmy-delivery-installed/Memmy.app`。八个 Memory 模块及七个 ASAR 内 Agent 模块与源码编译产物逐个 SHA-256 相同，包括新上游 parameter-aliases 及本轮模型 Provider 兼容文件。Memory 源码未随本次上游合并改变，buildId 仍为 `f06ace64abaa318259c5f1263f575c249c756aca894910ed83fe116dbaaaa3ce`；桌面复用同 buildId 的 Memory 缓存，Electron 宿主路径可能沿用此前安装，但执行的 Memory 模块身份一致。证据 `/private/tmp/memmy-delivery/code-manifest.json`。

包内 10,000 条/32 KiB 受控混合负载完成 36 个逻辑成员，Lane 为 12/9/6/6/3，峰值逻辑任务 4、Provider 请求 2、embedding 请求 1，无未启动 attempts 和遗留许可，FIFO/补位通过。窗口 743.46ms、首次定时回调 158.72ms，只是观察值。共享模型、10ms 模型与持续 maintenance 探针完成摘要/反思 50/50，maintenance 48，失败 0。实际 LM Studio 再验 2 summary + 2 embedding 成功、2 ready、768 维向量、请求峰值 1，约 50.56 秒。

## 实际重扫及长任务等待

同一个独立 HOME/profile 保留 13,000 条 Claude L1，14:31:41.215 发起 full scan，14:34:07.986 完成，读取 26,000 条解析消息，导入 0 memory/0 Skill，数据库仍精确 13,000；这是去重重扫，不是从空库再次导入 13,000 条。

同时创建 `trace_15326b81430eee449b1f`。监控在 125,779ms 观察到 ready，摘要与 embedding 均 interactive、attempts1、succeeded，有 384 维向量；当时仍有 11,944 条历史摘要 queued。reflection 仍 queued，不能写成全演化完成。

原组合驱动仅执行 60 次轮询，退出时重扫还未结束，因此保留 `Full rescan did not finish` 失败。未放宽断言、重置数据或调快模型；同一轮后续结束后单独验证完成、计数及任务状态。证据 `live-check.log`、`post-run-observation.json`。60 个健康样本中位 29.14ms、P95 1,067.46ms、最大 1,600.52ms；受控模型每请求 5 秒，embedding 100ms，不是实际云 Provider 的测试。

Worker 日志记录反思：14:31:15.351→14:31:58.153，14:32:09.477→14:32:51.610，14:32:51.654→14:33:34.715；新摘要于 14:33:34.760 开始，14:33:40.216 成功，embedding 于 14:33:45.701 成功。它证明期间各任务推进、没有永久饥饿，也显示 WRR 按任务机会分配并不承诺短的墙钟等待时间。不能把 126 秒全部归于一个正在运行的任务，等待中也包含其他 Lane 的未兑现机会；未发现排队入口异常的充分证据。若产品需要更严格的实时等待目标，需先定义目标，再评估任务粒度、模型资源及调度政策，不凭一次结果擅自改变方案。

GUI 可搜索并打开新记忆，原始用户/助手正文与输入一致，截图 `/private/tmp/memmy-delivery/live-detail.png`。

## 重启、反思后的向量更新及退出观察

旧 schema9 种子的完整 record + vector 指纹保留；三种独立模型连接核对通过，13,000 条历史记录保留。首次退出和重启检查中，五条样本原始对话逐项与换包前备份或本轮原始 API 输入比对一致（`raw-source-retention.json`）。

不能要求后台演化运行时所有派生摘要和向量始终与冻结值相同。重启后 `trace_e783a65ec75de0309b5c` 的既有 reflection 于 14:41:04 完成；SpanPipeline 按 `reflection.updated`、`clearExistingVector:true` 更新派生摘要、清除旧向量并创建 embedding 任务。此时原“全部样本必须保持 ready、派生内容和向量 hash 不变”的临时断言失败，证据保留为 `restart-processing-investigation.json` 和 `body-retention-investigation.json`，没有据此修改产品。

随后通过最终桌面包的正式 `/api/v1/worker/run`，以 target filter 领取该持久化 embedding 任务，leased1/succeeded1/failed0，重新 ready 且有 384 维向量。没有直接改数据库、改优先级或删除任务。见 `post-reflection-worker.json`。这是业务演化后的重建恢复，不是把原重启不变断言重建 baseline 后记为通过；初始源对话、记录计数和未变化的旧种子另作校验。

一次退出后立即读取窗口触发 `quit:reopen-requested-during-quit`，自动重开不能当成受控重启证据。随后只发送 Cmd-Q、不读取关闭中的窗口，确认端口关闭后显式启动，已排除此工具干扰。最后一次单独 Cmd-Q 于 14:41:38.760 开始清理，仍捕获 `quit cleanup timed out; forcing app exit`，退出码 0、端口关闭且无重开事件；因此退出清理警告确实仍保留，不宣称完全正常退出，亦未定位或归因到队列。原日志 `/private/tmp/memmy-stage8-package/queue-delivery-restart-console.log`。

## 提交范围及未覆盖项

提交一个整体 PR，标题拟为 `fix: 统一记忆后台任务调度并修复历史任务阻塞`。包含此前用户批准的独立模型迁移兼容补修。仅推送个人 fork，正式 PR 创建前再次确认；当前未推送、未创建 PR。

没有恢复已取消的生产背压/批量取消，没有新增 Aging 提升或完整队列统计/ETA 界面。macOS x64、Windows、真实云 Provider 未验证，既有 FTS 写入放大、超长单会话成本和 DMG 背景图外观警告仍保留。自动化通过、最终完成与产品延迟验收应分别陈述，不以“最终执行”代替一个尚未定义的实时等待目标。
