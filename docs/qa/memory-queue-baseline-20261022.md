# Memory 队列改造：阶段 1 复现与基线

日期：2026-10-22（Asia/Shanghai）。本记录对应桌面《Memmy后台任务队列调度机制工作方案》的阶段 1。

## 开发基线与范围

- PR 目标：`upstream/v1.2.6`；执行前已 fetch；按用户最新要求，从该分支直接创建新的个人任务分支。旧 v1.2.4 与新目标存在分叉，未将旧分支的其他代码合入。
- 起点 commit：`3a5f5c44bd5cc557a529c2c715ce3f08cbb9fa93`。
- 个人分支：`test-memory-queue-v1.2.6`。
- 独立工作区：`/private/tmp/memmy-memory-queue-v124`。
- 环境：macOS arm64，Node.js 22.23.3，npm 10.9.9。
- 该 commit 中 Desktop/package.json 版本为 **1.2.3**，Memory/package.json 为 **2.1.6**；目标分支名不等于运行时版本。
- 本阶段仅新增复现测试和本记录；未修改生产实现，未打包，未推送或提交 PR。

## 方法及证据边界

测试使用项目真实 `MemoryDb`、SQLite schema、`Repositories` 和 `WorkerRunner`。业务处理器使用可控 Promise，本地 Embedding 替身返回固定向量；队列查询、领取、重排、完成与失败状态更新均调用当前生产实现。测试数据库各自放在临时目录，结束后清理。

这是调度层的确定性复现，未接入当前 Memmy 窗口，未调用付费模型，未改动真实用户数据。不能将替身处理器的耗时换算成产品吞吐、模型延迟或 UI 等待时间。租约过期用例将模拟 Date 时钟推进 61 秒，并未在真实时间中等待一分钟。未重放用户 Windows 环境的连续六小时日志，未声称已复现 UI 卡顿。

新增测试：`Memory/tests/service/worker/queue-scheduling-baseline.repro.test.ts`。测试明确标记为**修复前诊断基线**：部分断言确认当前不理想行为确实发生，不能把这些断言通过当作修复验收。后续修复时应将对应断言转换为预期行为的回归测试。

## 已复现的问题

| 编号 | 复现操作 | 实际结果 | 修复后的验收方向 |
| --- | --- | --- | --- |
| R1 | 入队 10,000 个普通 import_summary，同时放入可运行 reflection、已到期 Embedding retry 和一条启动维护任务；按自动 worker 配置连续执行 50 轮，每轮 limit=4、priorityCohortOnly=true。 | 200 个导入任务完成，剩余 9,800 个；50 轮 retryLeased 全为 0，reflection 和维护任务 attempts 均为 0。直接按目标队列领取可拿到 retry 与 reflection，排除了任务本身不可运行。 | 混合积压中各可运行 Lane 都有执行机会；retry 不依赖主队列剩余容量。 |
| R2 | 放入一条旧导入摘要；连续 25 次各插入一个目标记忆较新的同类摘要，然后领取一条并完成。 | 25 条较新任务均先完成，旧任务仍 queued、attempts=0。 | 同 Lane 对可运行任务按稳定入队顺序调度。 |
| R3 | 给两条不同创建时间的导入记忆各创建一个已到期 retry，先创建旧 retry，再创建新 retry，领取一条。 | 先领取新记忆对应 retry，旧 retry 继续 pending。 | retry 候选同样需要公平次序，不能只修改主任务表排序。 |
| R4 | 放入 1 个高优摘要和 3 个低优 reflection，limit=4、cohort=true。 | 只领取 1 条；另外 3 条可运行任务未补入本轮。 | 空 Lane 或不可运行候选不应使可用执行容量闲置。 |
| R5 | 入队 8 个同类摘要；第一次 runWorkerOnce(4) 启动并阻塞处理器，再同时调用第二次 runWorkerOnce(4)。 | 两次调用合计同时进入 8 个处理器。单次 limit=4 不是服务全局并发 4。 | 所有入口共享同一全局、资源和 Provider 并发边界。 |
| R6 | 入队 8 个摘要，单次 limit=8。前 4 个中保留 1 个慢任务，让另外 3 个结束。 | 仅剩 1 个处理器活跃，第 5 条仍未开始；后 4 条已经 leased。必须等待慢任务，才能开始下一组。 | 一个任务完成后即可补位，并只在有执行容量时领取。 |
| R7 | 入队 4 个串行 reflection，阻塞第一条；将模拟时钟推进 61 秒，再调用真实仓储领取。 | 首轮仅启动 1 个处理器，但 4 条都已 leased；过期后这 4 条均可被再次领取，attempts 变为 2。 | 未执行任务不提前持有租约；执行中任务续租；分别记录领取和业务失败次数。 |
| R8 | A 领取任务；模拟过期后 B 重新领取并成功；随后通过真实 runner 提交 A 的迟到失败。 | B 的 succeeded 被 A 改成 failed。 | 按 job id、当前状态、owner 和唯一 token 验证写入；拒绝旧执行者。 |
| R9 | 普通 reflection 处理器连续抛临时超时；固定 Date 时钟不变，连续执行三轮。 | attempts 为 1、2、3，同一时刻耗尽尝试并进入 dead_letter，无通用退避。 | 临时错误退避后重试，并与永久错误、配置阻塞和租约丢失区分。 |
| R10 | 分别创建未来 600 秒仍有效的主任务租约和 retry 租约，调用真实启动对账。 | 主任务立即 queued，retry 立即 pending；有效租约被清除。 | 启动恢复遵守文档的租约有效性规则，避免无条件重排。 |

R1 证明了这 50 轮中的饥饿现象，不能单凭有限轮次宣称任务在所有情况下永不完成。但当前“先主任务、后剩余名额”的规则意味着，只要每轮主任务持续占满，retry 就持续没有名额；同理，严格优先级可持续挤压低优任务。

R5 的直接执行证据位于共享 runner 层。代码审查确认自动排空器、历史导入、Onboarding 和 HTTP worker/run 可以进入该 runner；本阶段未用 HTTP 多端口端到端重放这些入口。

## 对照用例：当前已有能力

| 编号 | 操作 | 当前结果及含义 |
| --- | --- | --- |
| C1 | 仅放入一个到期 retry，执行 limit=4 的 worker。 | leased=1、succeeded=1。retry 机制可执行，R1 的 0 不是因为未到时间或完全不能运行。这里只验证队列成功转换，未验证真实向量模型与索引。 |
| C2 | 放入 10,000 个 source=startup.placeholder_summary_repair 的摘要修复，再放普通 reflection。 | reflection 先领取；当前目标分支已将启动修复降到优先级 90。历史截图中“启动修复优先于反思”的具体路径已修正。 |
| C3 | 同时放入 Onboarding 首次报告、原生摘要和导入摘要。 | Onboarding 首次报告先领取，现有高优先级可保留为改造回归要求。 |
| C4 | retry 由 A 领取，模拟过期后 B 重新领取，再由 A 提交完成。 | 旧 owner 的完成被拒绝，B 的 in_progress 保留。retry 已有 workerId+leaseUntil 校验，不应笼统认定所有队列都没有租约保护。 |

R1 还加入原生 trace_summary 对照：在导入积压仍存在时，原生摘要下一轮可以领取。它说明当前严格优先级能保护部分新摘要，同时牺牲其他类别；WRR 的作用是同时保证其余 Lane 的进展。

## 最新代码与方案描述的差异

1. 最新目标分支的并行白名单为 trace_summary、import_summary、observation_extract、embedding、l3_world_model_update、project_environment_profile 六类，不能继续描述为只有摘要、Embedding 并行。
2. 默认 limit=100 代表最多预先领取 100 个任务。普通可并行任务在单次调用中每 4 个一组，不能解释为 100 个模型请求同时执行。
3. 启动摘要修复已被降为低优先级，但普通导入积压、retry 剩余名额规则及其他租约问题仍在。
4. 文档第六部分 Lane 权重为 4/3/2/2/1，第十三部分参数表为 4/2/2/2/1。实施策略注册表与 WRR 前需统一；不影响阶段 1 或阶段 2。当前未擅自修改原文档。

## 验证与重跑

下列结果是阶段 1 提交 `726468f4` 的历史记录。后续阶段已修改实现和部分断言，在当前分支重跑不能重现全部修复前结果。

若要复核原始 14 项诊断，应从 `726468f4` 创建独立工作区，并在该工作区按 README 准备依赖，再运行以下命令。不要在当前开发分支切换或回退代码。原始证据 JSON 保留不变。

```sh
git worktree add --detach /private/tmp/memmy-queue-stage1-replay 726468f4
```

在上述历史工作区根目录运行：

```sh
node node_modules/typescript/bin/tsc -p AgentSourceCore/tsconfig.json
MEMMY_QUEUE_BASELINE_REF=upstream/v1.2.6@3a5f5c44bd5cc557a529c2c715ce3f08cbb9fa93 \
MEMMY_QUEUE_BASELINE_RESULTS=/private/tmp/memmy-queue-baseline-v126-20261022/results.json \
  node node_modules/vitest/vitest.mjs run \
  Memory/tests/service/worker/queue-scheduling-baseline.repro.test.ts \
  Memory/tests/service/worker/worker-runtime.test.ts --reporter=verbose
node node_modules/typescript/bin/tsc -p Memory/tsconfig.json --noEmit
```

当前分支的结果导出另外记录实际 `testedCommit` 和 `workingTreeDirty`；`MEMMY_QUEUE_BASELINE_REF` 仅作 `referenceLabel`，不能证明运行的是历史代码。历史提交的旧导出器没有这项检查，复核时必须另外记录 `git rev-parse HEAD` 和工作区状态。

- 新增诊断及对照 14 项、现有 worker-runtime 19 项：**33/33 通过**。
- Memory TypeScript 检查：通过。
- 原始结果副本：`docs/qa/memory-queue-baseline-20261022.json`。
- 完整执行日志：`/private/tmp/memmy-queue-baseline-v126-20261022/test.log`。
- 此时尚未进行仓库全量回归、lint、打包或安装验证；这些属于后续整体交付阶段。

## 下一阶段及确认点

改为 upstream/v1.2.6 后已重跑全部 33 项测试和 Memory 类型检查，结果仍成立。旧基线原件备份在 `/private/tmp/memmy-queue-baseline-20261022/v124-original`；原 Pages 工作文档仅三处目标分支引用更新为 v1.2.6。

阶段 1 已得到可重复、可核对的基线。按此前约定，向用户展示本记录，确认后进入阶段 2：先修主队列 owner/token fencing、长任务续租、过期恢复及失败退避，再改调度策略和提高受控并发。

租约安全与重试计数会被后续调度器使用；统一执行入口为四层并发提供控制边界；策略字段和注册表为 WRR、FIFO 提供依据。这些阶段按依赖顺序推进。整体改造完成后统一回归、macOS 打包测试，经用户确认后向 v1.2.6 提交一个 PR，标题使用 fix: 中文说明。
