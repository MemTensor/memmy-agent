# Memory 队列改造：阶段 8 整体回归与 macOS 安装验证

后续复查及最终退出补修包的最新结果见 [队列方案复查与打包验证](memory-queue-plan-recheck-v126-20261023.md)。以下保留此前候选包的历史结果。

日期：2026-10-22。工作分支 `test-memory-queue-v1.2.6`，整体 PR 目标 `upstream/v1.2.6`。按用户确认，工作文档从阶段 6 直接进入阶段 8；不恢复已取消的生产背压部分。本轮只验证 macOS arm64，不提交 PR。

## 最新结论（2026-10-23，299a4a14）

交付准备已再次合入最新上游并重新打包；补充的慢反思场景出现约 126 秒实时等待。最新结果和保留项见 [v1.2.6 交付准备复核](memory-queue-delivery-v126-20261023.md)，以下保留 299a4a14 的原轮次证据，不把约 35 秒写成固定保证。

队列相关统一回归、新包内负载/公平性、真实本地模型、同环境升级后 12,000 保留 + 1,000 新完整轮次扫描，以及退出重启的数据核对已通过。GUI 第 51 页加载成功，最终共 651 页；新普通记忆在 11,590 条历史摘要 queued 时约 35 秒达到 ready。

仍有独立的 Desktop 退出清理超时：旧包和新包均触发 5 秒保底退出，不能写成“整体无异常通过”。以下保留各轮失败与补修过程；末节及同目录 `memory-queue-stage8-20261023-results.json` 是最新包的汇总。未恢复已取消内容，未推送、未提交 PR，也未进入下一阶段。

## 基线与范围

阶段 8 开始前已通过 merge 同步 `upstream/v1.2.6` 的 `f19bd810`，合并提交为 `53d312b0`。保留阶段 1–6 的持久化单 worker、WRR 4/3/2/2/1、可运行 FIFO、租约 fencing、失败退避、四层并发和连续补位设计。

测试环境为 Node 22.23.3、npm 10.9.9、macOS arm64；安装包使用 Electron 自带 Node 22.20.0。项目当前桌面版本仍为 1.2.3，Memory 版本为 2.1.6；目标 Git 分支 v1.2.6 不等同于包内版本，本轮没有单独改版本号。

本轮还纳入用户授权的旧模型配置兼容补修：迁移把残留平台标记当成真实平台身份，可能误删仍在使用的自定义 Memory 连接。保留连接后，同一 Provider 的默认密钥、headers、body 又可能串入其请求，因此补齐独立 endpoint 的可选 `inheritProviderDefaults:false`。缺省/true 保持原继承规则。未选择向量模型仍使用默认本地模型，Memory loader 原规则及对应既有测试未改。

## 迁移兼容：先复现、再补修

- 错误保留方式先由实际 Memory 客户端请求暴露：只保留目录但不保留必要 raw fixed/custom 字段，会使摘要不可配置或 embedding 回退 local；只复制连接也会继承无关 Provider 的凭据及 `body.model`。正式修前记录见 `/private/tmp/memmy-stage8-endpoint-isolation-before.log`、`/private/tmp/memmy-stage8-endpoint-inheritance-before.log`。
- 独立端点使用正常 canonical Provider 和有效 assignment，不创建虚假 preset、私有 Provider 或假配置密钥；端点自有参数与 Provider 默认值分离。SDK 内原有的初始化占位值仅在内部使用，明确无鉴权时不进入 HTTP Authorization。
- 配置读取、迁移、实际模型客户端、Backend 投影、设置页保存、冲突重试、连接测试、Agent 主/备用模型及快照签名均保留独立语义。测试连接依据可信已保存端点判定，无鉴权权限不由客户端自报标记决定。
- 新增 `v1.2.6/0001-preserve-independent-memory-connections`，覆盖已执行旧迁移的安装；不重跑整个 normalize。只处理仍留有配置信息、实际独立且激活的目标连接。不改无关标签、Agent 配置和 Provider 默认值；已丢失且无备份的连接信息无法凭空恢复。
- 历史 normalize/repair 和后续修复均尊重已有 null/缺省/builtin-local 向量选择。对原标记范围保留 raw custom 但不自动激活；真正尚无目录的旧自定义连接仍可首次导入。
- 交叉审查补出了 Anthropic 无环境密钥硬拦截、OpenAI 自有 key 时环境组织/项目串入，以及历史 normalize 覆盖本地 embedding 选择的边界，均先新增失败回归再修复。

迁移全量 279 通过、1 跳过，新增迁移回归 106 项；共享契约显式测试 60 通过；Agent 全量 7,142 通过、80 跳过。最终仓库级检查和安装包结果在下文补记，不用中间包代替最终交付。

## 受控负载与真实模型证据

使用真实 MemoryDb、Repositories、WorkerRunner、路由和并发控制器，以 10,000 条导入积压加 interactive、reflection、maintenance、embedding retry 混合工作验证调度。此组 handler 是受控替身，结果不代表 10,000 条已全部完成摘要。

| 场景 | 完成窗口 | 启动计数（interactive/repair_retry/import/evolution/maintenance） | 真实请求峰值 |
| --- | --- | --- | --- |
| 串行，8 KiB | 24 | 8/6/4/4/2 | 1 |
| 本地并发，8 KiB | 36 | 8/23/2/2/1 | 1 |
| 云限制，1 KiB | 36 | 12/9/6/6/3 | 2 |
| 云限制，32 KiB | 36 | 12/9/6/6/3 | 2 |

所有 Lane 都有进展，可运行 FIFO 成立；没有尚未启动就增加 attempts/token 的任务，窗口结束无遗留许可/租约。Embedding 微批按成员条数计量，因此本地微批窗口不要求每条任务计数恰好等于 WRR 权重。云场景下一条导入在前一条慢任务完成前启动，证明连续补位。

证据在 `/private/tmp/memmy-stage8-load/`。仍有性能观察项：阻塞候选多时存在大量重复 SQLite candidate 查询，受控云窗口首次执行约 0.46–0.50 秒、36 条窗口约 8.9–11 秒；这些结果没有已定义的产品延迟阈值，不能据此宣称任意负载下零等待或吞吐已达标。

本机 LM Studio 另执行过两条短合成导入的真实摘要和向量请求，2 summary + 2 embedding 成功、两条 ready、向量 768 维，真实请求峰值 1。该次源代码证据位于 `/private/tmp/memmy-stage8-real-local/`，运行基线为 `53d312b0`；不能当作最终 DMG 或真实云 Provider 的测试。模型不支持 json_object 时，既有 text 降级成功。

## 自动检查中的非产品失败记录

1. 依赖最初缺少 Monaco，补齐本机已有的同版本 0.57.0 后检查通过，未升级依赖或改锁文件。
2. 沙箱环境不允许开启部分本地测试端口，导致 Memory HTTP 用例超时；在允许本地端口的环境重跑后 1,694 通过、1 跳过。后续新增 1 项保存/密钥轮换边界纳入最终全量。
3. 并行重建 contracts 的 dist 曾使 Agent 单文件导入失败；最终检查采用先构建后测试，避免共享产物竞态。
4. Agent Session DAG 原有一项用例曾在全量中出现 30 秒 processed=false，相关源码及用例未改，也不经过本轮 Provider 路径。整文件 16/16、原用例连续 8 次以及补修后的全量均通过；最初失败原因未确认，保留原失败和复核日志，不把原因直接归于 CPU 或环境。
5. 用系统 Node 加载 Electron ABI 的 SQLite 原生模块曾报不匹配，属于验证器运行时选错；包内验证改用该安装包自带 Electron Node。工作区与日常仓库的依赖已隔离，不修改日常安装的原生模块。

## 安装包真实扫描补查：native 历史任务分类

第一次候选包 `ca5ca477` 的自动检查全部通过，但实际 full scan 暴露新入口遗漏：当前历史扫描也走 `completeSourceTurn → completeTurn → trace_summary/capture.v7`，没有旧 `agent-source` 标签。现场导入 4,535 条时，4,405 个待处理历史摘要与 129 个待处理向量均进入 interactive，后者排在历史摘要后。该包不能作为最终队列验收通过的证据，扫描已通过正式接口取消并保留资料于 `/private/tmp/memmy-queue-stage8-profile-native-classification-repro`。

修复只增加内部调度来源：合法 `agent_source_scan + captureLegacyHistory=true` 的 full/initial_subset 历史捕获，将 `internal_info.capture_origin` 保存为 `agent_source_scan`。保留 `trace_summary`、`capture.v7`、capture decision 和原标签，后续 embedding 从目标记忆继承 lane。普通 Hook 与无该历史许可的 incremental 扫描保留原分类。首次报告、人工重试和启动修复规则优先；embedding retry 保留 repair_retry。

策略版本从 1 升到 2，存储的三条刷新路径都读取该来源。刷新不改变入队顺序、首次排队时间、尝试数或已有租约。无来源信息的旧 native 记录不猜测其生产渠道，也不把所有外部 Agent 的实时对话改成 import。

正式真实服务回归修前 12 项中 7 项失败；扩展后新增 18 项全部通过，连原 source-turn-capture 共 68 项。覆盖时间早于/晚于 activation、detached history、实际摘要→embedding、48 条历史积压中新任务的实际完成、同 Lane FIFO、首次报告、人工重试、启动修复、双方向 Hook/scan 去重及重启；实际 executor 的 full/initial_subset/incremental 也覆盖。注册表和存储直接新增 9 项，连选择器与连续准入共 77 项通过。

安装压力资料保持 12,000 个完整轮次和 1/8/32 KiB 三档原始消息。最终资料拆为 300 段对话，每段 40 轮，以覆盖多会话扫描；第一次 3 段各 4,000 轮的资料及失败现场另行保留。不能把换资料理解为旧超长会话性能问题已经修复。

补修后的全量检查有一次时间敏感失败：扫描响应测试 1 项未在 waitFor 默认时间内到达检查点，10,000 条基线测试 2 项超过 5 秒；原失败留在 `/private/tmp/memmy-stage8-native-root-final.log`。两个文件独立重跑 23/23 通过（`/private/tmp/memmy-stage8-native-timeout-recheck.log`），没有放宽测试超时或改行为断言。最终全量结果以下方记录为准。

## 最终检查与安装包验收

模型兼容补修版本 `ca5ca477` 的 `npm run lint`、`npm run typecheck`、Agent typecheck、`npm test`、显式 contracts 测试均通过。`npm test` 含 release 30 通过/5 跳过、packaging guards 122/1、Memory 1,695/1、Migrations 279/1、Backend 1,109、Frontend 2,452、Electron 1,259/126；跳过项沿用各套件原有条件，不能记为已覆盖平台能力。Agent 独立全量 7,142/80。

最终日志：`/private/tmp/memmy-stage8-{lint,typecheck,root,agent,contracts}-accepted.log`；Agent 单独类型日志为 `/private/tmp/memmy-stage8-agent-typecheck-final-compat.log`。接口和类型构建完成后再执行测试，未与全量 Agent 测试并行刷新 contracts。

历史扫描分类补修的 lint/typecheck 已通过，全量复核与重新打包验收进行中；最终 DMG 结论将在安装、扫描及重启验证后补充。


## 2026-10-23 续验记录

夜间限定测试并行度的那轮在 2026-10-22 22:40:46 遭遇系统低电量休眠。`pmset` 明确记录 Low Power Sleep、电量 1%、持续 35,795 秒，与用例记录约 35,797 秒吻合。因此这轮不能作为持续运行耗时或死锁证据。`queue-admission-claim.test.ts` 续验独立重跑 11/11，通过时间 0.896 秒。更早的短时等待失败仍保留，未据此将全部超时统一归为休眠。

本次全量采用 `VITEST_MAX_WORKERS=2` 限定测试文件并行度，`caffeinate -i` 仅在命令运行期间防止空闲休眠。没有修改产品并发、测试断言或超时阈值。低电量或合盖仍可触发系统休眠，不能认为该临时机制能覆盖所有系统中断。


续验又补出多会话标题来源的遗漏：把真实服务公平性场景从同一历史会话扩为 48 段独立历史会话时，新任务仍在 24 轮窗口内无法完成，因历史 `episode_title` 留在 interactive。修前日志 `/private/tmp/memmy-stage8-20261023-multiconversation-before.log`。标题没有 target memory，因此统一入队处根据真实 episode 的完整 L1 集合生成内部来源：只有全部明确属于历史扫描、且不含首次报告时才标记历史；混合、当前、空集合或缺失记忆保持原分类。临时/最终标题均使用同一入队逻辑，传入的来源提示不能覆盖实际判定。没有改标题生成或 capture.v7 业务逻辑。

多会话公平性与历史/当前/混合会话标题回归补齐后，新 source-turn 文件共 22 项；连 registry 共 40 项通过，Memory 类型检查通过。前一轮完整仓库在测试文件并行度 2 时全通过（Memory 1,722/1、其余组件计数同前），标题补修后重新执行 Memory 全量，最终结果另补。


最终源码补修的 Memory 全量：1,726 通过、1 跳过，169 文件通过、1 文件跳过，55.65 秒，日志 `/private/tmp/memmy-stage8-20261023-memory-accepted.log`。标题补修前的本日仓库全量全部通过，日志 `/private/tmp/memmy-stage8-20261023-root-final.log`；没有以先前失败轮次当作通过。此次后续源码改动限于 Memory，追加了 Memory 全量与类型检查，未重复未受影响的 Agent 全量。


## 前一轮打包及初步安装证据（73725434）

官方 `package:mac:arm64:cn:unsigned` 于 2026-10-23 成功生成包，耗时 3 分 14 秒。桌面版本 1.2.3、Memory 2.1.6，runtime buildId `9db0f80665606a86d658e023f87dcfca4fd99e04b9fab19c255dbac0f7d3e2b8`，schema 12，darwin-arm64。DMG SHA-256 为 `39d34d04663be054fa82f5fc396f320ae374b7a87eed1682d41d2feb6c939ffb`，磁盘映像校验 VALID。脚本仍有安装窗口背景图替换失败的外观警告，未修改打包脚本。

应用从只读 DMG 复制到 `/private/tmp/memmy-queue-stage8-accepted-installed/Memmy.app`。四个关键队列文件与源码编译产物的 SHA-256 均相同（`accepted-code-manifest.json`）。启动使用独立 HOME 和测试 profile，不覆盖日常应用及数据。旧 schema 9 升级至 12 后，完整旧记忆和向量指纹仍为 `df625239a98a67faf03de2cef9e84bdf3946913d11ddabddd117a35ef54e1f37`。三种独立 Memory 连接和不相干 Provider 默认值均保留，实际受控请求未携带后者凭据或错误模型。

最终包混合云队列探针（独立 SQLite、受控无网络 handler）在 10,000 导入积压中完成 36 个逻辑成员，五 Lane 启动数 12/9/6/6/3；峰值逻辑任务 4、物理请求 2、embedding 请求 1，无未开始就增加 attempts 的 queued 项，FIFO/连续补位断言通过，窗口耗时 8.71 秒。日志 `/private/tmp/memmy-stage8-20261023-packaged-cloud.log` 与 `/private/tmp/memmy-stage8-load/accepted-packaged-cloud-32768.json`。

最终包另以实际 LM Studio 完成两条合成导入：2 summary + 2 embedding 均成功、2 条 ready、768 维向量、请求峰值 1、结束无许可泄漏，总耗时约 70.28 秒。既有 json_object→text 降级成功，未新增模型协议能力。证据 `/private/tmp/memmy-stage8-real-local/final-packaged-result.json`；这部分确实使用已安装包内的 Memory 代码，而不是源码模块。

12,000 条真实 full scan 验收仍在进行，最终条数、现场新任务进展与重启验证不能从以上小样本测试推断。


实际 full scan 中途（约 5,300 条）新建独立 native 任务 `trace_a4b69831d9e5850172f1`，2026-10-23 12:08:39 创建，12:09:25 达到 ready。其 trace_summary/embedding 均 interactive，摘要 1 次成功；连续 3 次合成 429 耗尽 embedding 客户端内部 2 次重试后，主 embedding 任务第 2 次执行成功，processing 无错误。完成核对时仍有 5,076 条历史摘要 queued。此处是主任务重试，不是独立 embedding_retry_queue；独立重试表的公平性证据来自最终包混合探针。单次 429 的前一轮注入只触发客户端 HTTP 重试，未错误归为后台租约重试。

扫描期间 GUI 列表成功加载、翻到第 51 / 278 页并显示对应历史记录；这证明翻页已超过 50 页，但最终条数仍以 SQLite 为准。健康接口曾有约 3.56 秒响应，不能据服务仍响应推断界面延迟已达到未定义的产品目标。受控 Provider 首段每请求 1 秒，后续切为 5 秒慢服务场景，embedding 响应延迟 100ms；延迟变更与请求统计保存在测试证据目录中。

## 大负载响应补查（进行中，不能据此判阶段通过）

扫描继续至约 6,400 条后，健康接口记录过 18,531ms 响应；约 7,900 条时仍可推进并显示第 51 / 395 页，近期健康响应多为 0.5–1 秒。服务没有崩溃不等于延迟验收通过，保留现场继续排查。

受阻候选遍历的独立复现：持有同一模型 Provider 唯一许可，在 10,000 条摘要后放同 Lane 的纯数据库任务；原同步领取正确找到了第 10,001 条，但检查 10,001 次、连续占用事件循环约 270ms，零延迟定时回调同样等待约 270ms。真实扫描数据库的一致副本上，7,937 次候选检查中有 7,936 次被资源拒绝，领取一条 episode_idle_close；同步占用约 315ms。大量立即完成的数据库任务可触发重复补位，原有按成功领取 32 条才让步不能约束“检查很多、领取很少”的轮次。证据 `/private/tmp/memmy-stage8-admission-scan-profile.*`、`/private/tmp/memmy-stage8-real-queue-profile.*`。这证明一个阻塞源，不把现场 18.5 秒全部归因于该单次测量。

标题来源判定还存在本轮引入的额外读取：每次检查 episode 的全部 L1 会反序列化正文并加载向量。独立长会话 1,200 轮捕获探针中，该 getMany 累计约 6.26 秒；正在用只返回来源及首次报告判定的投影替代，保持全部历史/混合/当前/缺失/软删及旧字段标签语义。

标题轻投影修复保存为 `a74b5ec2`。新增 19 项回归，连相关文件共 111 项通过，独立复核 source-turn + 新文件共 41 项通过，Memory 类型检查通过。旧 tags_json、info_json.tags、properties_json.tags 合并识别均保留；重复 ID、软删、缺失、空集合和伪造来源也覆盖。同一 1,200 轮长会话探针由 18.646→16.284 秒（约 12.7%），末 400 轮均值 23.96→20.30ms。完整集合分类仍随会话长度增加工作量，未改成缓存推测，也未宣称常量时间。日志 `/private/tmp/memmy-stage8-title-projection-final.log`、`/private/tmp/memmy-stage8-title-root-review.log`、`/private/tmp/memmy-stage8-capture-profile/run-1200-long-projection-final.log`。

另发现既有 FTS 写入放大：新建记忆的 reindexFts 也执行 `DELETE FROM memories_fts WHERE id=?`，id 为 UNINDEXED，执行计划是虚表扫描。独立 3,200 轮探针中删除累计约 9.61 秒；隔离诊断仅跳过新 ID 的无效删除后总耗时 30.04→18.88 秒。该项属于原有写入性能问题，未修改生产 FTS 或扩大本轮队列范围，也不能独立解释 18 秒健康延迟。证据 `/private/tmp/memmy-stage8-capture-profile/`。

分片补修采用每片最多 64 次候选检查或策略投影，事务结束后先启动已领取任务，再通过原生 immediate 让出事件循环。不会只看前 64/200/500 条，也不提前领取一大批任务等许可。旧策略全部投影完成后才允许 FIFO 选择；资源释放、模型配置、旧任务到期或已有任务重分类使续扫失效。新导入任务的首次分类不导致深扫反复重置。同一 SQLite 连接的多个 Repositories 共享内存修订号；不同连接/进程直接改元数据不共享该编号，本轮未扩展多进程协调。

正式红→绿及交叉审查覆盖：定时取消/停止、后排纯数据库任务、先启动片内已领任务、手动请求接管、WRR/legacy 续扫、CAS 失败、片间删除/暂不可运行、available_at/runAfter/过期租约旧序号、模型快照变更、legacy 重试扫描中新主任务、恰好 64/128 个受阻任务后的空片，以及真实 dedupe enqueue 使已缓存/已检查任务换 Lane。最后两类由独立审查补出，已修复重复候选报错和遗漏旧序号的问题。核心定向 75 项、Worker/相关存储 353 项、独立审查 82 项通过；Store 直接 40 项包含 20 项新增，Memory 类型检查通过。证据 `/private/tmp/memmy-stage8-slice-worker-regression-final.log`、`/private/tmp/memmy-stage8-selection-revision-after.log`。

隔离实测显示响应与总工作时间需要区分：7,936 条策略投影从单事务约 1.743 秒拆为 125 片，最长同步片约 60.91ms，定时回调约 61.16ms，总耗时增至 2.814 秒。真实扫描副本 7,938 候选分片后最长约 19.04ms、定时回调约 32.97ms，仍领到深部 episode_idle_close；总扫描耗时约 1.412 秒，高于原同步约 315ms。反复复查策略会增加总开销，不能称其本身提高吞吐。

冻结源码的 10,000 导入混合探针则因已领取任务及时开始执行，36 条窗口耗时约 582.74ms，prepare 次数 3,917，五 Lane 12/9/6/6/3；逻辑峰值 4、Provider 请求峰值 2、embedding 请求峰值 1，FIFO、连续补位及无未启动 attempts/残留许可均通过。该结果尚须最终包复测，不与旧包直接当作同运行时的最终性能结论。证据 `/private/tmp/memmy-stage8-load/sliced-source-cloud-32768.json`。

12,000 条扫描在 2026-10-23 12:45:33 合盖休眠时，监控请求触发 30 秒超时；12:57:40 唤醒后健康 HTTP 200、约 1.48 秒。`pmset` 证据 `/private/tmp/memmy-stage8-clamshell-20261023.log`。监控保留全部样本和该中断记录后恢复，不把该次超时当作产品卡死；更早 18.531 秒样本仍单独保留。

历史记录达到 10,014 条后，另建 native 任务 `trace_e783a65ec75de0309b5c`，12:59:11→12:59:34 达到 ready，摘要与 embedding 各一次成功、均 interactive；完成核对时仍有 9,205 条历史摘要 queued。监控 JSON 的旧字段名 initialBacklog 在此表示历史记录总数，不能误当成全部尚未处理的摘要任务数。reflection 仍处于 evolution queued，不将 ready 错写为整条演化链全部完成。

## 分片补修后的统一检查（b827f7c0）

源码提交 `b827f7c0a5405874d88daef65c88d7cd27d12d79`。`npm run lint`、`npm run typecheck`、`VITEST_MAX_WORKERS=2 caffeinate -i npm test` 均通过。全量包含 release 30/5 跳过、packaging guards 122/1、contracts 8、Memory 1,790/1（两次）、Migrations 279/1、AgentSource 62、Knowledge 48、Backend 1,109、local contracts 32、Frontend 2,452、Electron 1,259/126、TUI 5。没有放宽测试超时或新增跳过；两个原有计时器清理用例改为一个逻辑槽位的测试布置，以确保走到等待计时器路径，仍保留原清理及取消断言。

日志 `/private/tmp/memmy-stage8-responsive-{lint,typecheck,root-test}.log`。Agent 全量 7,142/80 的先前证据仍有效，之后代码变化仅在 Memory，未据此重新运行未受影响的 Agent 套件。最终包正在重建；旧包的扫描数据和耗时不会冒充本提交的安装验证。

## 分片补修候选包（b827f7c0，尚未通过完整公平性验收）

官方打包于 2026-10-23 13:12:52 成功，3 分 40 秒；DMG SHA-256 `d6baaa9af04f4eaedf70522b65f9b0ec7c8658ebd0c0da338d93d82166d1f650`，校验 VALID。由只读映像复制安装至 `/private/tmp/memmy-queue-stage8-responsive-installed/Memmy.app`，Memory buildId `2bd01b8203842d5d645f5ef2ebd5908d4cea0a188fc63bfa7e5ead833fe6a321`，schema 12。七个关键模块 SHA-256 与源码编译产物逐个一致，见 `responsive-code-manifest.json`。桌面仍为 1.2.3，Memory 2.1.6，未擅自改版本。

同一 Electron Node 22.20.0、相同 10,000 条/32 KiB 混合探针及 36 条窗口：旧包 8,706.50ms、225,283 次 prepare、首次定时回调 436.87ms；新包 656.58ms、4,109 次 prepare、首次定时回调 111.01ms。两次均五 Lane 12/9/6/6/3、逻辑峰值 4、Provider 请求峰值 2、embedding 请求峰值 1，FIFO/连续补位/无许可泄漏/未启动任务 attempts 不增加均通过。它是同机受控处理器的观察值，不是模型业务吞吐或任意负载的延迟保证。证据 `/private/tmp/memmy-stage8-load/responsive-packaged-cloud-32768.json`。

本包实际 LM Studio 再验：2 import_summary + 2 embedding 均成功，两条 ready、各有 768 维真实向量；请求峰值 1，结束全部许可释放，总约 73.47 秒。保留既有 json_object→text 降级及响应处理路径，不新增模型协议能力。见 `/private/tmp/memmy-stage8-real-local/responsive-packaged-result.json`。

打包重建原生依赖后，工作区系统 Node 的 SQLite 绑定已原子恢复并实际打开内存数据库确认（Node 22.23.3、ABI 127）。安装包内绑定保留 Electron ABI，未修改日常仓库的依赖。

## 持续数据库任务下的共享模型公平性：新增阻断项

12,000 条旧包扫描于 13:24:21 完成，SQLite 精确计数 12,000、0 Skill；原记忆及向量完整指纹仍相同，独立模型连接核对通过。扫描完成后暂停后台写入，保留现场，后续新包测试继续使用该数据。它只证明本次扫描和普通任务可进展，不代表全部历史摘要/反思已经处理完。

补充检查在 `b827f7c0` 又复现核心公平性问题：真实 WorkerRunner continuous、import 与 evolution 各 200 条、同一 Provider cap 1、模型 10ms；每完成一条 episode_idle_close 就补一条，模拟扫描持续的快速数据库任务。独立两次测试连续完成 100 次模型请求，全部 import，evolution 为 0、200 条仍 queued/attempts 0；maintenance 分别完成 61/58 次。关闭 maintenance 补流的对照是 50/50。5ms 变体虽非整程恒为 0，仍出现连续窗口内反思完全不执行，不能把偶然进展当作公平保证。

原因是全局环形游标在 Provider 繁忙时跳过反思，快速 maintenance 成功又将游标推进回环首，下一次模型空闲便再次优先 import；尚未兑现的反思轮次没有保留。修复分片只保证事件循环响应，尚不足以解决这个调度缺陷。因此上述候选包不能作为阶段 8 最终验收通过包。

正式新回归 `Memory/tests/service/worker/worker-provider-lane-fairness.test.ts` 已先红：无补流对照通过，5/10ms、受控本地/cloud、长期占用另一 Provider 加持续新任务的 5 项均因反思窗口为 0 失败；其余完成数、并发、停机和许可/租约清理断言先通过。证据 `/private/tmp/memmy-shared-provider-fairness-expanded-before.log`、`/private/tmp/review-stage8-provider-fairness-100-0.json`。正在补修保留有界未兑现 WRR 机会，保持 4/3/2/2/1、FIFO、原并发和已取消背压部分的范围约束；暂不将方案或纯模拟结果当生产验收结论。

正式修补采用有序、每 Lane 唯一的剩余轮次：只有成功租约 CAS 才扣一票，耗尽后该 Lane 重填自身权重并移到队尾；暂时受阻的 Lane 保留位置与剩余票额，其他 Lane 可跳过它继续执行。空 Lane 的跳过只在另一个任务真正领取成功时确认，避免片间新 interactive 被过早移到队尾。每 Lane 最多自身权重，不按被拒候选数量堆积信用。原 KV key/weightsKey/cursor 保留，仅附可选 turns version 1；旧值、非法值及权重变化均有回退。无需新增数据库迁移或对外接口。

纯算法、真实存储及连续 Worker 回归合计 28 文件 375 项通过，独立组合审查 103 项通过；原真实探针模型从 100/0 变为 50/50，maintenance 仍完成 75 次。最终新文件共 7 项，覆盖额外业务 scope 被占用，不能因受阻 Lane 再次堵住共享模型。修补中曾由审查捕获新 interactive 入队顺序回归，修复后保留原断言通过，没有删测试。日志 `/private/tmp/memmy-stage8-lane-turns-worker-final.log`、`/private/tmp/memmy-shared-provider-fairness-final.log`。统一全量和新包尚待完成。

## 退出链观察（不归因于队列）

旧包 73725434 在全量扫描结束并暂停写入约 8 分钟后，通过 Cmd-Q 退出出现 `quit cleanup timed out; forcing app exit`。Memory 数据库无遗留打开句柄；现场克隆备份 `/private/tmp/memmy-queue-stage8-profile-after-12000-20261023` 的 quick_check 为 ok，原记忆与向量指纹仍相同。

只读核查：最后 Worker drain 为 13:24:22.840，quit cleanup-start 为 13:32:17.324，无退出时队列未完成请求证据。Desktop 总清理保底 5 秒；测试 profile 的进程生命周期会停止 Memory 子进程，此外还依次等待 gateway、原生 Computer Use agent、Backend、renderer server 和退出统计。原生 helper 的 4 秒定时器只发终止信号，并不保证 Promise 到时结束；日志没有每步完成埋点，无法确定卡在哪个 await。main/runtime-services 自 737 至本轮未改，不能据此认定是 Worker 停止引入。本轮未擅自扩大非队列 Desktop 退出流程修复；最终退出重启仍须明确记录该现象，不能宣称完全无警告。


## 保留 WRR 轮次补修的统一检查（299a4a14）

源码提交 `299a4a14144b26995db4709c808167d58b861f1b`，只包含新 admission selector、接入逻辑和三组回归文件。`npm run lint`、`npm run typecheck`、限定文件并行度 2 的根目录 `npm test` 均通过，退出码 0。Memory 1,812 通过/1 原有跳过（完整仓库流程中两次）；其余 release 30/5、packaging guards 122/1、contracts 8、Migrations 279/1、AgentSource 62、Knowledge 48、Backend 1,109、local contracts 32、Frontend 2,452、Electron 1,259/126、TUI 5。跳过均未新增。日志 `/private/tmp/memmy-stage8-turns-{lint,typecheck,root-test}.log`。Agent 全量沿用前述未受影响部分的证据，不将本次根目录流程描述为重复执行了 Agent 全套。

本提交的源码 10,000 条、32 KiB、cloud cap2 混合探针完成 36 个逻辑成员，Lane 12/9/6/6/3，峰值逻辑任务 4、Provider 请求 2、embedding 请求 1，FIFO 和无未开始 attempts/许可泄漏通过。耗时 775.14ms，首次定时回调 57.61ms，prepare 3,534 次；受控 handler 无外部 HTTP，仍不代表真实模型业务吞吐。证据 `/private/tmp/memmy-stage8-load/turns-source-cloud-32768.json`。最终包验收如下。

## 最新包实际验收（299a4a14）

官方打包 2026-10-23 13:50:30 完成，3 分 25 秒、退出码 0。DMG `App/shell/desktop/release/Memmy-1.2.3-darwin-arm64-cn-unsigned.dmg`，SHA-256 `2260abf6ad2640cf5b52a4d243d2f4ce1256f2e9af07a87da4e61ced13ad9646`，映像校验 VALID。只读映像复制到 `/private/tmp/memmy-queue-stage8-turns-installed/Memmy.app`；Memory buildId `f06ace64abaa318259c5f1263f575c249c756aca894910ed83fe116dbaaaa3ce`、schema 12。含新 admission selector 的八个关键模块与源码编译产物 SHA-256 一致。桌面 1.2.3/Memory 2.1.6 未改，背景图替换外观警告仍在。打包后隔离源码区恢复系统 Node ABI127，安装包保留 Electron ABI139。

包内 10,000 条/32 KiB 混合队列完成 36 个逻辑成员，五 Lane 12/9/6/6/3，逻辑峰值 4、Provider 请求峰值 2、embedding 请求峰值 1；FIFO、连续补位、未开始 attempts 和许可/租约清理通过。窗口 572.97ms、首次定时回调 24.99ms、prepare 4,173 次。受控 handler 无外部网络，不代表生产模型吞吐。见 `/private/tmp/memmy-stage8-load/turns-packaged-cloud-32768.json`。

包内复测原 100/0 共享模型问题：import/evolution 各 200、Provider cap1、10ms 模型、maintenance 持续补流，100 次模型完成为 50/50，maintenance 同时完成 79 次，失败 0；剩余 queued attempts 最大 0，每 10 次模型完成窗口两 Lane 均推进。见 `/private/tmp/memmy-stage8-turns-packaged-fairness.log`。

实际 LM Studio Gemma/Nomic：2 条合成导入、2 import_summary + 2 embedding 成功，2 ready、各 768 维真实向量、请求峰值 1、无许可泄漏，总约 38.06 秒；既有 json_object→text 降级成功。见 `/private/tmp/memmy-stage8-real-local/turns-packaged-result.json`。

### 同环境升级、完整扫描和新任务

本包沿用旧包已完成的 12,000 条现场及独立 HOME，没有清空重建。启动后仍精确为 12,000，旧记忆完整 record + vector 指纹不变，三种独立模型连接及无关 Provider 默认值保留。随后实际 full scan 重读已有来源，并追加 25 段×40 完整轮次、1/8/32 KiB 的 1,000 条合成对话。不是声称最新二进制从空库重新导入了全部 13,000 条。

13:53:06→13:54:56 扫描完成：解析消息 26,000、导入 1,000 memory/0 Skill；SQLite 精确 13,000 个 Claude L1，原 12,000 未重复。达到 12,220 条时创建 native 记忆 `trace_32b734a530bc0fe32a62`，13:53:51.923→13:54:26.549 ready（34.63 秒），核对时仍有 11,590 条历史摘要 queued。其 trace_summary/embedding 均 interactive、attempts1、succeeded；reflection 仍为 evolution/queued/attempts0，不将 ready 描述为全部演化已完成。

扫描使用本机受控 HTTP Provider，摘要/演化延迟 5 秒、embedding 100ms。48 个健康样本中位 45.99ms、P95 308.49ms、最大 673.75ms，只是该负载观察，不能与旧包不同导入规模直接当严格基准比较或作延迟保证。实际本地模型证据另列，未测试真实云 Provider。见 `/private/tmp/memmy-stage8-package/turns-scan-acceptance.json`。

GUI 加载列表和第 51 页的对应历史记录，最终共 651 页；完整搜索新标识返回该记忆，详情显示正确的用户/助手正文。截图 `turns-page51.png`、`turns-live-search.png`、`turns-live-detail.png` 在同证据目录。

### 退出重启与保留项

本包 Cmd-Q 于 13:56:13.519 开始清理，仍报 `quit cleanup timed out; forcing app exit`。应用返回码 0、Memory/Backend 端口关闭，随后同包重启成功。此警告旧包也存在，尚无具体 await 的定位证据；不归因于队列，也不以返回码 0 宣称完全正常退出。未扩大 Desktop 生命周期修改范围。

退出后及重启后核对：13,000 总数保留；四条关键记忆的正文/内容 hash、完整向量记录 hash 和 ready 状态一致，SQLite quick_check 为 ok。旧 schema9 种子的完整指纹始终为 `df625239a98a67faf03de2cef9e84bdf3946913d11ddabddd117a35ef54e1f37`。独立模型连接再次通过，重启后 GUI 仍能检索新记忆。见 `turns-final-restart-check.json`、`turns-final-seed-fingerprint.json`、`turns-after-restart-model-audit.json`。

测试结束留在独立应用环境，并重新施加进程内暂停以保留积压现场。直接 Memory PATCH 的测试覆盖在重启后会被持久化配置重新加载，不断言其跨进程保存；未修改产品配置持久化机制。

临时 QA 脚本三处错误已保留失败并修正，未据其修改产品：新增文件首次复制到待导入目录（只重读原 12,000，新增 0）；SQLite null-prototype 对象与 JSON baseline 的原型比较失败（字段/hash 一致）；误认为运行时暂停跨重启保存。分别修正实际扫描路径、规范化对象后比较全部字段、重启后重新施加测试暂停。没有清空数据、重建 baseline 或放宽生产回归断言。

队列目标已有上述通过证据，Desktop 退出清理超时、背景图外观警告及原有 FTS/超长单会话写入性能仍保留。没有覆盖 Windows/macOS x64/真实云服务，没有宣称所有历史摘要/反思清空。无 PR、无推送，后续操作等待用户确认。
