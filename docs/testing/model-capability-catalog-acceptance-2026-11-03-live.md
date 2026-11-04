# MEMMY-806：测试环境补充验收（2026-11-03）

> 更新：用户确认部署 `e3cd26f2` 后已重新验收，HTTP CRUD、主动/自动刷新和当前轮/下一轮目录快照全部通过，见 [部署后重验记录](model-capability-catalog-e3cd26f2-rerun-2026-11-03.md)。下文保留此前部署状态的实测结果，不代表重验后的目录接口状态。其他全量回归失败未因此视为解决。

## 结论

真实平台请求的 Token 计量、使用流水和场景额度扣减已核验通过。远程 MySQL 服务层 CRUD 已通过；部署 HTTP CRUD 未通过。当前测试环境的目录接口行为与本地最新源码契约不一致，运行态目录读取返回 500，故“云端修改 → 客户端取得新版本 → 已有会话下一轮采用新目录”的部署验收尚未闭环。全量自动化回归发现失败项，不能标记完整产品回归通过。

视频不在本次验收范围。不改业务代码、不部署、不推送；测试写入仅使用独立模型名称。真实请求产生的使用流水和消耗予以保留。

## 真实计费持久化：通过

- 请求目标：`https://test-api.memmy.cn/api/agentExternal/v1/chat/completions`。
- 从隔离客户端配置经正式 `resolveModelSelection` 解析平台 `memory_summary` 连接；核对凭据未过期和目标 hostname 后，直接发送一条非流式短请求，无工具，输出上限 64 Token。
- HTTP 200，有 completion，响应 trace ID 与指定 trace ID 相同。
- trace ID：`memmy806-billing-dfd54a43-80bd-46a2-a779-7d48806d1119`。
- API usage：输入 35、输出 7、缓存命中 0、总计 42 Token。
- MySQL `agent_quota_usage_record` 恰好匹配一条，记录 ID `118842`；实际模型 `qwen3.8-flash`、场景 `memory_summary`、response_code=200、token_source=usage；输入/输出/总量均与 API 相同。provider_request_id 为空，没有据此补造上游 ID。
- 同一用户的 `agent_user_quota.memory_summary_consume` 从 `284032` 增至 `284074`，差值 42，与该请求相等；场景总额度 20,000,000。
- `token_consume` 前后均为 0；本次通过的是场景 Token 额度扣减，不是金额扣款或供应商账单对账。
- 脱敏证据：`.tmp/catalog-cloud-test-20261103/billing-audit-result.json`；复现脚本 `billing-audit.ts` 在同一目录，只从进程环境读取数据库密码。

## CRUD 与版本

### 远程 MySQL 服务层：通过

执行 `ModelCatalogRemoteTest`，指定 `memmy_test` 数据库，1 项通过。覆盖新增/批量新增、读取、替换、删除、重复新增回滚、版本更新后异常回滚、删除不存在条目、8 个并发写入与快照读取，以及 MockMvc runtime 200/304。

初始版本 `1793688862290`，结束版本 `1793688862310`；前后均 276 条模型，测试前原有模型完整映射一致。测试名称前缀 `memmy806-check-52a9f0f9-58c-`，结束后已清理。版本递增保留，不回退版本。

### 已部署 HTTP：未通过

使用配置中的真实管理凭据，不在报告记录凭据。未带凭据或错误凭据的管理读取返回 401；有效凭据的列表读取返回 500 `Model catalog operation failed`。

按当前源码格式，以独立名称 `memmy806-http-d2da6c8a-7282-4c98-ad4a-227169d36714` 顺序请求：

| 操作 | HTTP | 返回 |
| --- | --- | --- |
| POST 新增（text、8192/128、无 thinking） | 400 | Invalid model catalog fields |
| GET 单条 | 500 | Model catalog operation failed |
| PUT 替换（输出改为 256） | 400 | Invalid model catalog fields |
| DELETE 测试名称 | 404 | Model not found |

契约对照探测：使用旧版 `thinkingSupported/allowedLevels/defaultLevel` 格式，以独立名称 `memmy806-contract-f61b8fd9-4497-4767-82ae-8249f8a92547` 新增返回 500；随后删除返回 404。本地当前解析器明确拒绝这些旧字段，应返回 400。结合当前合法格式被拒，已证实部署接口与本地当前契约存在差异；未取得部署构建号或服务异常日志，不将具体 SQL 异常原因写成定论。

HTTP 探测后再次读取 MySQL：版本仍 `1793688862310`，模型仍 276 条，`memmy806-%` 测试条目为 0。没有残留测试模型。

## 客户端刷新及桌面

- 复用 `.tmp/catalog-cloud-test-20261103` 隔离 Electron 客户端，不访问日常配置。真实 local backend 从 runtime manifest 发现，为 `127.0.0.1:62916`，不把 renderer/webui 端口的 404 当作 backend 故障。
- 使用正式平台连接中有效凭据读取云端 `/api/agent/model-config`，实时返回 500，与管理列表故障一致。
- 本地主动刷新此前已观测 `retries-exhausted`、`hasValidCatalog=true`；本轮末再次请求时等待 45 秒后由调用方超时中止，未取得该次刷新完成状态。随后直接读取缓存仍为版本 `1793688862290`、276 条。不能把这次超时写成刷新成功或取得了新目录。
- 通过窗口的 Raise 操作恢复桌面交互；模型选择器可展开，平台模型与 BYOK 选项可见；模型配置和 Token 用量页面可打开。没有改变保存的分配或能力配置。
- 在原有 `CATALOG_OK` 会话发送下一条真实短消息，UI 精确显示 `CATALOG_NEXT_OK`，停止按钮消失、模型选择和输入恢复可用。request ID `0add0c36-3447-4613-aa6b-92e4f62feb98`，turn ID `mw0kuy4p-7apla57r`，模型 `gpt-5.4-mini`，finish_reason=stop。
- 本轮没有重新抓取 Provider 请求体或目录快照，不能把会话成功说成已验证采用云端新版本。

## 自动化回归

| 范围 | 实测结果 |
| --- | --- |
| Agent 全包 | 480 文件通过，2 文件失败，2 文件跳过；7773 通过、2 失败、9 跳过 |
| 云服务 Maven 全包 | 869 项：866 通过、1 断言失败、1 上下文错误、1 opt-in 远程测试跳过；远程测试另已显式运行通过 |
| Local API contracts 全包 | 27 文件、192 项通过 |
| 本地后端（生成 workspace bridge 后） | 158 文件通过、2 文件失败、3 文件跳过；1357 通过、3 失败、4 跳过 |
| 桌面前端（排除 Node 26 原生 webstorage 影响后） | 288 文件通过、2 文件失败；3325 通过、6 失败、3 跳过 |
| Memory 全包初跑 | 239 文件通过、3 文件失败、2 文件跳过；2690 通过、9 失败、2 跳过 |
| Memory 失败文件补建 bridge 后复跑 | 32 通过、1 失败；原先 8 个 bridge 缺失失败已消除，剩余 pkg Node 版本问题 |
| Desktop shell | 96 文件通过、1 文件失败、5 文件跳过；1345 通过、1 失败、126 跳过 |
| 发布/打包守卫/根协议检查 | 20 文件；269 通过、6 跳过 |
| Migrations | 21 文件；279 通过、1 跳过 |
| AgentSourceCore | 7 文件、85 项通过 |
| Knowledge | 7 文件、48 项通过 |
| OpenCode compatibility（补建 Memory bridge 后） | 24 项通过 |
| Agent、backend、desktop TypeScript noEmit | 均通过 |
| Agent build tsconfig noEmit | 通过 |
| Agent 实际 build | 通过 |
| Workspace 实际 build | `npm --ignore-scripts run build`，exit 0，通过；避免版本同步 hook 修改版本文件 |
| git diff --check | 通过 |

回归日志保存在 `/tmp/memmy806-regression-460sc5/`。测试输出未作为完整产品通过证明；以下失败应逐项归因或修复后再验收。

### 剩余失败的具体内容

1. Agent `commands.test.ts:355`：新建配置不再把隐式 `maxTokens=65536` 写入 YAML，旧断言仍要求字段存在；`settings-api.test.ts:114` 仍期望旧静态表的 1050000/128000，实际为 200000/65536。源码 diff 已确认本次迁移引入显式字段跟踪并移除旧静态默认值；需要按确认后的产品契约调整或补充断言，不能只跳过测试。
2. 云服务 `DesktopClawforcePackagesTest:71`：期望 `2026-10-12 10:00:00`，实际 `2026-10-12T02:00:00.000Z`。`MemmyBackendApplicationTests`：扫描到 `ModelCatalogLocalServer.LocalConfiguration`，其 `jwtUtils` bean 与实际 bean 冲突，ApplicationContext 加载失败。
3. 本地后端：2 个 Office e2e 缺少本地 release descriptor/catalog；1 个 `plugin-sse-recovery.test.ts:32` 在读取到 SSE 事件名时退出，收到的内容尚不含其随后断言的 JSON snapshot。
4. 桌面前端：5 个 titlebar 交互断言期望 `no-drag` 而实际为空；1 个 HomePage 源码文本断言仍要求 `optionAside`。最初 Node 26 导致的 localStorage 大量错误已通过禁用原生 webstorage 后复跑排除，不计入上述 6 项。
5. Memory：安装的 pkg 工具链无法解析要求的 Node `v24.22.1`。bridge 缺失属于测试前置构建，已补建并复跑相关失败文件，不再作为产品缺陷上报。
6. Desktop shell：`dev-cli-launcher.test.ts` 报告从调用者目录运行时 electron 依赖仍缺失。

未通过项是否属于此前已有问题，除上述源码差异证据外，没有用干净基线逐一对照，不统一标记为“历史问题”。本轮未修改这些业务行为或测试断言。

## 后续闭环条件

先确认测试环境运行的构建与当前 catalog 契约一致，取得目录接口异常日志并恢复读取；再重复四种 HTTP CRUD、版本递增、主动/自动刷新、当前轮固定快照与下一轮新目录验证。随后处理本次迁移相关断言与 Spring 测试配置冲突，并对剩余全量回归失败分别完成基线对照或修复复跑。部署需单独执行，本轮没有部署。
