# e3cd26f2：真实计费与全量回归重跑

## 本轮结论

2026-11-03，按用户要求在目录链路重验通过后，重新执行真实计费和全量自动化回归。测试环境为 `https://test-api.memmy.cn`；云服务本地 HEAD 为用户确认已部署的 `e3cd26f2`，工作区干净。真实流式、非流式计费均通过。全量回归已发现失败，不能标为整体验收通过。

这是测试复跑，没有修业务代码、修改断言、部署或推送。视频不在范围内。日志与 JSON 原始测试结果保存于 `/tmp/memmy806-full-rerun-KGcZBm/`。

## 真实计费持久化：两种路径均通过

从隔离 profile `.tmp/catalog-cloud-test-20261103` 用正式模型选择器解析平台连接，核对目标 hostname 和凭据有效期，发送 `memory_summary` 短请求。随后用远程 MySQL 按同一用户与 trace ID 精确读取流水及场景额度，未手工插入使用记录。

| 路径 | HTTP | 输入/输出/缓存/总 Token | 流水 ID | memory_summary_consume 前→后 |
| --- | --- | --- | --- | --- |
| 非流式 | 200 | 35 / 7 / 0 / 42 | 119026 | 412899 → 412941 |
| 流式 | 200，收到 [DONE] | 35 / 7 / 0 / 42 | 119046 | 412941 → 412983 |

两条流水实际模型均为 `qwen3.8-flash`，scene=`memory_summary`、token_source=`usage`、response_code=200，输入/输出/总量与 API usage 相同；每次额度增加恰好 42。两次共消耗 84 Token。响应 trace ID 与请求 trace ID 相同，各只匹配一条流水。

- 非流式 trace：`memmy806-billing-a7a103ca-1541-4037-b4af-607e4962393a`。
- 流式 trace：`memmy806-billing-7f7c1f75-305d-4340-a22a-cb3788f099d7`。
- 流式检查包含 usage 尾块、结束标记、落库及场景额度增量断言。
- 场景总额度 20,000,000；聚合字段 `token_consume` 前后为 0；provider_request_id 为空。这是场景 Token 计量及额度持久化证明，不是人民币扣款或供应商成本对账。
- 脱敏结果：本轮目录的 `billing.log`、`billing-stream.log`；隔离 profile 下 `billing-audit-stream-rerun.json`。真实使用流水和消耗保留，不删除计费证据。

## 测试执行与最终采用的结果

先执行整个 workspace 构建，Agent 构建单独执行。使用 Node 26 时，为桌面测试关闭原生 webstorage，避免其覆盖 happy-dom 的存储实现。按锁文件补齐 Office 插件已声明依赖，并通过正式打包脚本生成本地测试 MPP，没有新增依赖声明或改锁文件。

初跑中，并行的构建/打包流程重建 workspace 的 dist，造成部分测试导入失败。这些属于本次测试组织导致的无效结果，已在相关构建结束后复跑后端、共享协议、Shell、Memory；不把这些导入错误当作产品缺陷。根目录两个使用 node:test 的文件改用 `node --test` 执行，不计作 Vitest 的“无测试套件”失败。

| 范围 | 结果 |
| --- | --- |
| 云服务 Maven 全包 | 870 项：866 通过、1 断言失败、2 错误、1 opt-in 远程测试跳过 |
| 真实 MySQL opt-in 集成 | ModelCatalogRemoteTest：1 项通过，0 失败/错误/跳过，12.64s |
| Agent 全包 | 7784 项：7772 通过、3 失败、9 跳过 |
| Agent 3 个失败文件复跑 | 144 项：142 通过、2 失败；会话工具时序项复跑通过，配置断言仍失败 |
| 本地后端 src 全包 | 1212 项：1206 通过、2 失败、4 跳过 |
| 桌面前端全包 | 3334 项：3325 通过、6 失败、3 跳过 |
| Memory 全包最终复跑 | 2701 项：2698 通过、1 失败、2 跳过 |
| Desktop Shell 全包最终复跑 | 1472 项：1345 通过、1 失败、126 跳过 |
| 共享协议全包最终复跑 | 192 项全部通过 |
| Migrations | 280 项：279 通过、1 跳过 |
| AgentSourceCore | 85 项全部通过 |
| Knowledge | 48 项全部通过 |
| 根目录 Vitest | 379 项：372 通过、1 失败、6 跳过 |
| 根目录 node:test | 10 项全部通过 |
| Office 插件 node:test | 15 项全部通过 |
| Frontend utilities:check | 通过 |
| Workspace 实际 build / Agent 实际 build | 均通过 |
| 独立 TypeScript noEmit | Agent、backend、desktop、shell、Migrations、SourceCore、Knowledge、Memory、Memory viewer、contracts、desktop-interface 均通过 |
| git diff --check | 通过 |

不把完整测试与失败文件复跑相加为覆盖数。后端 `src` 全包不重复执行嵌套 contracts 的编译副本；contracts 单独完整运行。没有测试脚本的 workspace 通过实际构建验证，不虚构测试数量。

## 本轮失败清单

1. **Agent 配置迁移断言 2 项**：`tests/entrypoints/cli/commands.test.ts:355` 仍要求隐式 `maxTokens=65536` 写入 YAML；`tests/entrypoints/frontend-bridge/settings-api.test.ts:114` 仍要求移除的静态模型表提供 1050000/128000，实际为 200000/65536。两次运行均失败。需按已确认的配置优先级核对并更新测试或实现，不能据此直接判定所有请求额度错误。
2. **Agent 会话工具时序 1 项**：`exec-session-tools.test.ts:623` 全包时未及时读到 `still-running`，该文件单独复跑通过；记录为本轮不稳定项，不将它伪装为全包从未失败。
3. **云服务 3 项**：`DesktopClawforcePackagesTest` 的时间格式断言不一致，另一个 activation 用例的 latest 软链接路径不符合当前环境要求；`MemmyBackendApplicationTests.contextLoads` 扫描到 `ModelCatalogLocalServer.LocalConfiguration`，`jwtUtils` bean 重复定义导致 Spring 上下文失败。
4. **本地后端 2 项**：Office MPP 已生成后，完整安装/启用/渲染 e2e 在 `service.enable` 报 `fetch failed`，不能说 Office e2e 已通过；`plugin-sse-recovery.test.ts:32` 提前在 SSE 事件名处结束读取，尚未收到完整 snapshot JSON 就断言其存在。
5. **桌面前端 6 项**：5 项 titlebar 交互检查预期 `no-drag`，实际为空；HomePage 的源码文本断言仍要求 `optionAside`。
6. **Memory 1 项**：pkg 工具链无法解析 Node `v24.22.1`。完整最终复跑中 viewer HTML 标题检查通过；初跑的该项失败未复现，不当成稳定缺陷。
7. **Desktop Shell 1 项**：从非仓库目录检测 root 依赖时，`dev-cli-launcher.test.ts` 报 electron 仍缺失。
8. **根目录 Linux CLI 打包 1 项**：构建归档的子流程加载 sharp 时无法找到 `semver/functions/coerce`。完整根套件及该文件单独复跑都失败；不是原生 Linux 实机结果。

除已有源码差异证据外，本轮未逐项执行干净基线对照，因此不统一称为“历史问题”，也没有为使结果变绿而放宽断言。

## 桌面及验收边界

复用原有隔离 Electron 窗口；本轮实际看到原会话及其回复，任务搜索弹层能够出现，Token 用量页显示摘要约 413K，未修改额度设置。继续导航时 Computer Use 报系统捕捉错误 `SCStreamErrorDomain -3811`，后续未继续声称完成所有原生页面交互。该工具异常与视频模型链路无关。

本轮全量回归指当前 macOS 环境下仓库的测试套件、构建、类型检查及上述桌面冒烟。没有完成 Windows/Linux 原生实机回归，也没有本轮新做录音、图片生成或所有外部系统的真实调用；不能用单元测试通过替代这些实机验收。

此前目录部署链路复跑通过的证据仍见 `model-capability-catalog-e3cd26f2-rerun-2026-11-03.md`。本轮计费成功不会自动消除以上测试失败。
