# Memory 队列改造：阶段 3 策略注册表、持久化字段与影子调度

日期：2026-10-22。工作分支 `test-memory-queue-v1.2.6`，整体 PR 目标 `upstream/v1.2.6`。本阶段承接阶段 2 安全补修提交 `3836f391`，按工作方案仅建立和观察新策略，**尚未切换实际任务调度**。

## 本阶段完成内容

1. **集中策略注册表**：全部当前 `JobType` 加上重试适配类型 `embedding_retry` 都有明确策略，新增类型未登记会导致类型检查或测试失败。根据任务类型、来源、目标记忆元信息和操作模式确定 Lane、资源、基础紧急度、租约与并发策略描述。当前执行仍使用旧并发和租约入口，并发许可在后续阶段实现。
2. **区分真实生产来源**：首次报告保持 interactive；显式手工重试进入 repair_retry；普通历史摘要和向量进入 import；反思等进入 evolution；启动占位摘要、启动处理修复、检索重建及 observation 补扫进入 maintenance。同时识别实际 producer 使用的 `payload.source` 和 `payload.reason`，避免只覆盖测试中的虚构来源。
3. **调度字段**：主任务表与 Embedding retry 表均增加 `queue_lane`、`resource_class`、`enqueue_seq`、`first_queued_at`、`base_priority`、`policy_version`。已有 `available_at`、`blocked_reason` 和租约字段继续沿用。
4. **稳定顺序**：两个队列共用一个持久化计数器，插入触发器分配递增编号，覆盖直接 SQL 入队路径。计数器仅保存序号，不是第二张任务事实表。重复入队、退避、续租、配置恢复与过期恢复不重置编号；删除最大编号后也不复用。
5. **影子对比**：主任务和重试通过共同候选接口进入只读 WRR＋可运行 FIFO 计算。各 Lane、各来源表分别限量读取，避免先截取一批导入任务后看不到其他 Lane。旧领取和影子预览复用同一份可运行条件，保留现有时间、依赖、业务范围、预算、模型配置及目标过滤。
6. **隔离异常**：未知任务明确告警并在投影中标记 `unregistered`，不静默套默认 Lane。策略元数据计算失败不阻止真实入队；影子计算或观察回调失败不阻止旧 worker 执行。租约丢失异常仍按原安全边界处理，不被吞掉。

## 升级与索引

数据库版本升级至 **v12**；保留 v2–v11 升级路径，升级前由现有机制建立 `.pre-v12.bak`。测试验证 v11 文件真实关闭、升级、重开后任务状态和编号保持稳定。

历史行缺少可靠的原始入队时间，因此首次回填按已有 `created_at` 排序，时间相同使用稳定的表名及行顺序；这是一种确定性近似，不能声称恢复了历史跨表的精确入队先后。新插入任务的 `first_queued_at` 使用实际数据库插入时间，避免导入 producer 回填数月前的记忆时间而夸大等待时长。

增加 Lane/状态/可用时间/入队顺序索引，以及 FIFO 和策略版本索引。目标记忆元信息变化会使相应策略投影失效。重试表另加 `target_id` 单列索引，查询计划回归验证目标失效更新走索引查找；现有 `(target_kind, target_id)` 索引不能直接服务该单列查询。

## 如何看影子结果

默认启用影子观察，设置 `MEMMY_WORKER_SCHEDULER_SHADOW=0` 后可关闭，真实执行继续沿用旧路径。每个 runner 最多每 **5 秒**采样一次，每次比较最多 **32 个选择**；每次补齐最多 **500 行**尚未计算的策略元数据。

worker 的 `scheduler.shadow` 日志记录：

- `legacySelection`：同一时点旧规则预计选择的主任务及剩余名额重试；保留旧 cohort 行为。
- `shadowSelection`、`shadowLanes`：新规则的选择及 Lane。
- `sameSelection`：本轮两种选择是否相同。
- `coverageComplete`、`pendingPolicyCount`、`unregisteredJobCount`：投影是否完整、是否存在未登记类型。投影未完成时，不能把局部候选结果当作完整比较。
- `candidatePoolSize`、`sampleLimit`、`weights`、`nextCursor`：候选量、采样大小和 WRR 参数。

日志不包含记忆正文、会话内容、向量或模型凭据。影子只推进自己的内存游标，不修改任务状态、尝试次数、租约或业务写入；新字段的投影刷新属于元数据写入。重试表仍保留原事实，阶段 3 没有提前实施队列统一领取。

用户已确认采用工作方案正文 6.1 的权重 **4/3/2/2/1**（interactive / repair_retry / import / evolution / maintenance），后续实施以此为准；原实施参数表中的 4/2/2/2/1 不再作为实施依据。阶段 3 代码已与该决定一致，当前权重只用于观察。基础紧急度保留供策略审计，同 Lane 的选择仍以入队编号为准，不用静态紧急度破坏 FIFO。

## 复现对照与验收

真实 SQLite＋真实 WorkerRunner，业务处理器和模型请求使用受控替身，测试数据库位于临时目录。未访问真实用户数据或付费模型，未在当前 Memmy 窗口进行人工安装验证。

- **四条导入摘要＋反思＋重试**：旧执行仍完成四条导入，反思和重试继续等待；同一轮影子选择包含重试和反思。证明观测已接入且实际旧行为未被偷偷切换。
- **10,000 条导入积压＋反思＋重试＋维护**：影子候选仍包含各个可运行 Lane；纯选择器完整轮次和跨小批次游标测试验证权重机会。
- **业务事实不变**：直接采样前后，任务状态、尝试次数、租约、记忆、处理状态和 change cursor 全部相同，仅允许新投影字段刷新。
- **异常隔离**：策略投影、候选查询、观察回调异常时，真实入队和旧执行仍成功；关闭开关后不再查询影子候选。
- **过滤一致**：覆盖未来 runAfter、退避、配置阻塞、奖励依赖、Scope 前置任务、有效/过期租约、目标限制、预算暂停及摘要模型未配置。
- **安全升级和顺序**：覆盖双表递增、直接 SQL、删除后不复用、去重及恢复不改序、历史回填、新导入真实等待时间、目标标签变更及晚创建目标。

影子结果只是同一时点的选择对比，不是“假如过去所有任务都按新规则执行”的完整模拟。它不能证明实际吞吐提升或 UI 问题已修复；资源/Provider 许可、连续补位及实际公平调度仍需后续阶段验收。

## 本地检查

- `npm run memory:test`：**1440 项通过，1 项跳过**。
- `npm run memory:lint`：共享类型构建、Memory 与 Viewer 类型检查通过。
- `npm run test:release-workflow`：30 项通过，5 项跳过。
- `npm run test:packaging-guards`：122 项通过，1 项跳过。
- `git diff --check`：通过。

主要测试：`job-policy-registry.test.ts`、`shadow-queue-selector.test.ts`、`queue-scheduling-store.test.ts`、`worker-scheduling-shadow.test.ts`；原调度复现及阶段 2 回归继续保留。

日志：`/private/tmp/memmy-stage3-memory-tests-final.log`、`/private/tmp/memmy-stage3-memory-lint.log`、`/private/tmp/memmy-stage3-release-guards.log`、`/private/tmp/memmy-stage3-packaging-guards.log`。

按整体计划，本阶段不单独打包、不推送、不提交 PR。统一 Mac 打包与安装验收在完整改造后进行；提交一个 PR 前再次征得用户确认。阶段 3 完成后等待用户确认，再进入阶段 4 统一执行入口。
