# Memory 队列改造：阶段 6 分层并发与连续补位

日期：2026-10-22。工作分支 `test-memory-queue-v1.2.6`，整体 PR 目标 `upstream/v1.2.6`，承接阶段 5 补修提交 `597de81c`。本阶段不单独生成 DMG、不推送、不提交 PR；整体安装验收按后续统一验证阶段执行。

复查更新：初版提交 `6646adce` 的全量测试虽通过，独立复查仍发现 5 项遗漏。以下验证表保留初版记录，后续修复与最终验收以 [阶段 6 复查补修记录](memory-queue-stage6-review-fixes-20261022.md) 为准。

## 复现与范围

阶段 5 已统一执行入口并修复 WRR/FIFO，但 `limit=100` 仍会预先领取整段任务；摘要一组内的快任务结束后，还要等待该组最慢任务。其他类型即使不能并行，也会提前获得租约；Embedding 的逻辑条数、批处理大小与真实请求并发尚未分开控制。

本阶段先新增真实 SQLite＋WorkerRunner 的受控慢任务验收。修前最初 7 个场景均失败；扩展到含异常和 Provider 场景的 16 个用例时，11 项失败、5 项通过。证据：`/private/tmp/memmy-stage6-admission-before.log`、`/private/tmp/memmy-stage6-admission-before-full.log`。新存储准入的最初 9 项修前全部失败；同源扫描最初 10 项中 8 项失败、2 项通过。所有模型请求使用本地受控替身，没有接入当前 Memmy 窗口或用户数据库。

范围是工作文档第七部分的四层并发限制及连续补位。继续使用一个 Memory 进程、原有持久化任务表、WRR 4/3/2/2/1 和可运行 FIFO；不恢复已取消的生产背压方案，不引入多个 SQLite 写进程。

## 运行方式

手动入口的 `limit` 表示一次执行请求的总工作预算，不再代表预领取数量或并发上限。复查补修后，自动入口通过内部 continuous 模式持续执行，直到当前无可运行工作、取消或需要交还入口给手动请求；不再受 4 条总预算的整批屏障限制。执行流程：

1. 根据 WRR/FIFO 查找可运行候选。
2. 同步检查全局、资源、Provider 根及模型、业务范围所需的全部许可。
3. 全部可用时一次性取得许可，再在同一数据库事务内按 ID 领取。
4. 立即进入执行，只有实际运行的任务维持续租。
5. 任一任务完成即释放许可并唤醒补位，不等待其他慢任务。

资源不足时不领取任务、不生成 token、不增加 attempts，也不先占住部分许可再等待其他许可。因此不存在任务 A 占一半资源等任务 B、任务 B 又反向等待 A 的部分获取死锁。模型实际执行期间的内部串行请求，使用该任务已取得的许可，不重复获取自己的 Provider 槽位。

同一 Lane 的资源阻塞项保持入队位置，但允许寻找后续可运行任务。候选按 Lane、任务表和入队序号分页，不能因为前 200 或 500 条都被同一资源挡住，就永久看不到后面的其他资源任务。

并发任务可以按不同顺序完成；FIFO 约束候选选择和启动机会，不要求结果完成顺序相同。返回的主任务结果仍按领取顺序排列；同一个任务若在长 drain 内退避到期后再次领取，使用不同 lease token 分别统计每次结果，不能用后来的成功覆盖先前失败。

## 初始并发参数

| 限制 | 默认值 | 含义 |
| --- | --- | --- |
| Memory 活跃逻辑任务 | 4 | 所有 worker/run 与 retry 入口共用 |
| summary 资源 | 4 | 仍受 Provider 限额制约 |
| evolution_llm 资源 | 4 | 仍受 Provider、业务范围限额制约 |
| embedding 逻辑资源 | 4 | 每条记忆占一个逻辑槽位 |
| database 资源 | 1 | 维护类数据库任务保守串行 |
| scan 资源 | 1 | Memory 策略资源；Agent source 实际扫描另在后端同源入口互斥 |
| 本地 Provider 根及模型 | 1 | 同一实际服务共享，不因角色名不同重复计算 |
| 云 Provider 根及模型 | 2 | 模型还要服从其 Provider 根上限 |
| Embedding 请求 | 1 | 与批量条数独立 |
| Embedding 微批大小 | 最多 16 条 | 同时服从可用逻辑槽位与 embedding 资源余量 |

因此，默认全局上限 4 时，一个微批最多 4 条；若另有两个逻辑任务活跃，最多只领取 2 条用于微批。只有显式提高全局及 embedding 逻辑资源上限后，才可能形成 16 条微批，不能为了凑批次而提前领取等待。

可通过启动环境变量设置：

```sh
MEMMY_WORKER_MAX_ACTIVE_JOBS=4
MEMMY_WORKER_RESOURCE_LIMITS='{"summary":4,"embedding":4,"evolution_llm":4,"database":1,"scan":1}'
MEMMY_WORKER_LOCAL_MODEL_CONCURRENCY=1
MEMMY_WORKER_CLOUD_MODEL_CONCURRENCY=2
MEMMY_WORKER_EMBEDDING_REQUEST_CONCURRENCY=1
MEMMY_WORKER_EMBEDDING_BATCH_SIZE=16
```

配置接受正整数并进行范围校验，未知资源类或非法配置明确报错。测试可以注入控制器以隔离某一层约束；显式提高测试上限的用例不作为生产默认并发的证明。

## Provider 与模型调用

在准入前固定本次任务使用的模型上下文，实际执行使用同一组客户端；运行中更新配置不会让已准入任务转而调用未取得许可的模型。Provider 身份基于真实服务地址及模型，去除凭据和查询参数；本地回环地址别名、相同地址的不同 source 标签应共享同一根限制。配置未填写地址时按模型实现的实际默认地址归一化。

真实模型调用也经过同一控制器。任务内部对同一个 Provider 的并行调用串行使用自身许可；前台模型请求遵守同一 Provider 和 Embedding 请求限额，但不占 Memory 后台逻辑任务名额。任务提前结束时，已经开始的物理请求仍保留相应 Provider 限额至请求真正结束，不能因逻辑任务释放而放大物理请求并发。

摘要任务可能回退到演化模型，反馈经验任务也可能调用向量模型；策略注册表必须声明这些次级依赖，不能只声明主资源。审查已用真实业务链识别并补齐导入摘要回退和 feedback_experience 的依赖，配合实际路由回归验证。

相邻且同类、同 role、同 Provider 和同模型上下文的 Embedding 项才共享一个微批请求许可。每个成员分别占逻辑、资源、业务范围许可；一个成员 CAS 失败时只归还自己的份额，不影响其他已经领取的成员。成员组全部结束后才释放共享 Provider 与请求许可。仅凭地址和模型相同还不足以混合配置，凭据、headers 或其他真实模型配置变化也会使微批上下文区分。

## 业务范围与扫描

- 同一 target 的主任务与 retry 共享排他范围，不因为来自不同表或不同 jobType 而重复执行。
- 同 episode 的相关任务共享 episode 范围。
- L3 与 Work Memory 按用户、项目共享业务范围。生产 L3 payload 只有 batchId/targetField，Work Memory payload 只有轨迹数据，因此从真实 batch/session 读取项目，不能把两种不同的 scope 哈希当成同一个项目范围。
- Skill 聚类分配与演化也按用户、项目共享范围，分别从真实 episode/cluster 解析项目，避免演化的旧快照覆盖并发加入的新成员。
- 后端对同一 repository 实例、同一个 Agent source 的实际扫描/收集及持久化 staging 进行互斥，覆盖 collectOne/All 与 scanOne/All。不同 source 可并行；等待可以取消，失败后释放。锁不覆盖摘要等待，不整体锁住 scanAll。

扫描限制是相同 repository 实例共享的进程内限制，不宣称跨进程，也不宣称整个历史导入生命周期都串行。后端扫描不是额外插入 Memory 主任务表的第二套任务事实。

## 唤醒、异常与关闭

补位同时响应任务完成、许可释放和新任务唤醒。HTTP 自动调度通知当前活跃 drain，即使某个慢请求未结束，只要还存在其他空闲资源，新任务也可以进入。同步 CAS 失败归还许可产生的通知不会形成持续空转。

许可先取得、ID CAS 后执行。CAS 失败立即归还；整个领取事务异常时，连同本事务前面已经取得的许可一起归还，游标和数据库状态同步回滚。运行中业务异常仍通过原有失败退避与 fencing 路径处理。

停止时不再领取新任务，允许已经准入的任务及其收尾完成，再退出统一入口。关闭流程同时处理模型许可的等待者与已开始的完整模型业务任务，避免 Provider 释放后唤醒一个本应停止的请求，或在请求之后的数据库收尾尚未完成时关闭存储。

## 验证记录

初版提交 `6646adce` 于 2026-10-22 在 macOS arm64、Node.js 22.23.3、npm 10.9.9 下完成以下检查；补修后的最终数字见本文开头链接的复查记录：

| 检查范围 | 结果 | 证据 |
| --- | --- | --- |
| Memory 全量 | 1627 通过、1 跳过；161 个测试文件通过、1 跳过 | `/private/tmp/memmy-stage6-memory-final-clean.log` |
| 后端全量 | 1085 通过，132 个测试文件通过 | `/private/tmp/memmy-stage6-backend-final.log` |
| Memory 服务与 viewer 类型检查 | 通过 | `/private/tmp/memmy-stage6-memory-typecheck-final.log` |
| 后端类型检查 | 通过 | `/private/tmp/memmy-stage6-backend-typecheck-final.log` |
| 后端源码 ESLint（排除忽略的生成 bundle） | 通过 | `/private/tmp/memmy-stage6-backend-lint-source-final.log` |
| release workflow 保护 | 30 通过、5 跳过 | `/private/tmp/memmy-stage6-release-final.log` |
| packaging guards | 122 通过、1 跳过 | `/private/tmp/memmy-stage6-packaging-final.log` |
| Git 差异空白和冲突标记检查 | 通过 | `git diff --check` |

首次最终全量运行中，原有 `agent-source-runtime` 自动扫描测试出现一次 `automatic scan did not complete`，当时其他 1626 项通过。未更改该测试及生产代码，随后单文件 16 项通过，完整重跑 1627 项通过。保留失败日志 `/private/tmp/memmy-stage6-memory-final-verified.log` 和单独复核日志 `/private/tmp/memmy-stage6-auto-scan-recheck.log`，不隐去该偶发等待失败。

后端首次全目录 lint 将测试准备生成且被 `.gitignore` 忽略的 `memmy-workspace-bridge.mjs` 也纳入检查，报两处该 bundle 内禁用规则缺失。排除这一生成文件后，全部后端源码检查通过；没有为通过检查而修改规则或提交生成物。此阶段没有执行整个前端和 Agent 工作区的全量检查，留在统一回归阶段。

独立审查覆盖存储事务与许可回收、真实执行补位及测试语义，并完成交叉复核。审查过程中发现并补充了下列回归：

- 导入摘要回退模型与反馈经验向量调用需要在准入前声明完整依赖。反馈真实链路的两个用例修前均失败，修后及全量通过。
- reflection 与 reward 必须按真实 episode 串行，同时允许另一 episode 执行。两个专用回归修前均失败，修后及全量通过。
- 同一任务在一个长 drain 内失败并再次到期时，结果必须按 lease token 区分。修前错误汇总为 3 成功、0 失败；修后正确保留 2 成功、1 失败。
- 批次中间 CAS 失败只释放对应成员；连续 CAS 失败不能因同步释放通知形成空转；完整领取事务失败需归还前面已取得的许可。
- 停止服务需要等待真实请求及随后数据库收尾；已完成任务遗留的异步上下文不能被误认为仍在执行，也不能绕过已关闭路由。

现有测试中，依赖整批预领取、批次屏障或旧 document-first 分组的断言已改为阶段 6 的实际运行规则；原有 fencing、预算暂停、模型配置切换、业务输出和 SQLite 状态检查仍保留。测试中的显式并发覆盖仅用于隔离原有业务语义，生产默认值由独立准入与真实模型请求计数测试验证。

### 一万条长正文调度基准

使用真实 MemoryService 与 SQLite，插入 10000 条导入摘要任务，每条记忆正文 8192 字节；受控本地模型请求保持未完成。两种实现对比都只领取 1 条，其余 9999 条仍为 queued，控制器记录活跃逻辑任务为 1；不存在为了填满 `limit` 而提前领取。

| 同步补位中的配置解析方式 | 首个 handler 开始 | 配置加载器调用 | 候选准备次数 |
| --- | --- | --- | --- |
| 每个候选分别建立上下文 | 501.3ms | 10005 | 10000 |
| 本轮共用配置快照（最终实现） | 264.9ms | 6 | 10000 |

证据为 `/private/tmp/memmy-stage6-provider-bench.log`。这是本机一次受控对比，配置加载器返回内存配置，不能换算为真实磁盘配置读取成本或真实模型吞吐；仍会扫描被资源挡住的候选，因此不宣称消除了所有大队列调度成本。

上述验证使用真实 SQLite 和 WorkerRunner、受控慢模型、实际路由与后端扫描替身；没有接入用户数据库，不替代 DMG 安装、真实 Provider 压测或 Windows 验证。打包保护测试通过不等于已生成或安装 DMG。

## 交付边界

legacy 开关保留旧的选择顺序与 cohort 策略，但同样服从新的准入、Provider 限额和连续补位；它不恢复不安全的整批预领取或旧批次屏障。对新旧选择算法的对比，应区分选择策略与执行安全边界。

本阶段完成后停下等待用户确认。整体回归、同步最新目标分支、真实模型参数收敛、统一 macOS 打包安装与最终 PR 确认仍在后续统一验证阶段；不把自动化保护测试描述成安装测试已通过。
