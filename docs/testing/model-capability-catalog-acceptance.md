# MEMMY-806 模型能力目录迁移验收记录

核对日期：2026-11-02（本次会话日期）。

方案：[模型能力目录迁移](https://alidocs.dingtalk.com/i/nodes/Exel2BLV5zRByQARS7ld4AnwJgk9rpMq)。本记录不修改方案文档，不代表部署或生产验收完成。

## 当前阶段与测试边界

当前处于实施顺序第 10 步：客户端与 Runtime 联调收尾。客户端同步、前端消费和 Runtime 快照链路已有实现及测试；正式 Electron 已验证正常调用、目录失效后 fallback 成功、fallback 失败的实时提示及历史回放。首轮隔离检查存在未归属的日常文件哈希变化，因此尚不宣布本步全部验收完成；部署后的云端 CRUD 联动也未验收。

本阶段使用旧客户端真实模型配置构造隔离目录，发送真实 Provider 请求。数据库不作为本阶段测试的事实源；本轮未连接数据库、未执行入库脚本、未运行会写库的 `ModelCatalogRemoteTest`，不使用 H2。将来生产运行的目录事实源仍按方案为云端数据库。

单元测试中的故障响应、预算服务替身与隔离目录用于验证控制逻辑，不等同于真实云端数据库或真实计费持久化。日常 `~/.memmy/config.yaml` 和 `models.json` 不作为测试输出位置。

## 已验证的链路

下列脚本位于 `App/memmy-agent/scripts/`；命令在仓库根目录执行：

```sh
node --import tsx App/memmy-agent/scripts/<脚本名> [选项]
```

| 验收项 | 脚本与选项 | 证据及边界 |
| --- | --- | --- |
| 有效目录、200/304、新旧版本 | `model-catalog-live-smoke.ts` | 真实 GPT 请求；目录接口为隔离 HTTP fixture |
| 省略 thinking、删除模型、云端缺项 | 同脚本 `--mutations` | 真实请求继续；不从源码表补齐 |
| 思考档位、关闭及无效档位回落 | 同脚本 `--thinking` | 核对实际 SDK 请求参数及真实响应 |
| 本轮快照不变、下一轮更新 | 同脚本 `--agent-loop` | 真实 AgentLoop 调用文件工具，工具执行期间更新目录 |
| 标题与历史摘要输出限制 | 同脚本 `--background` | 真实 mini 请求；摘要输入预算 5880、输出限制 1800 |
| 自定义配置与会话选择 | 同脚本 `--custom` | 自定义配置优先，空配置不套同名云端配置 |
| 自定义配置正式保存与重载 | `model-catalog-live-custom-config.ts` | 隔离 YAML；凭证、endpoint、指派及额外字段保持 |
| 文件缺失/损坏后的 fallback | `model-catalog-live-fallback.ts` | 实际等待 5/10/30 秒，最多 4 次目录请求，随后真实 Provider 成功 |
| 刷新失败仍使用有效本地目录 | 同脚本；`model-catalog-refresh-ui.ts` | 不清空有效目录；前端保留已有会话选择 |
| fallback 实际错误及统一展示 | `model-catalog-live-fallback.ts --error`；`model-catalog-wire-ui.ts` | 真实 Provider 负向请求；WebSocket/UI 部分回放错误记录，非完整发送链路 |
| 前端选择实际影响 Provider 参数 | `model-catalog-thinking-ui.ts` | 正式控件与状态逻辑；使用隔离 HTTP adapter，非完整 Electron |
| 同步后前端自动更新 | `model-catalog-refresh-ui.ts` | 正式 App、Backend、SSE、模型视图；外围服务有替身，未启动 Agent gateway |
| BYOK 历史摘要与用量补报 | `model-catalog-live-summary.ts` | 真实 sol 摘要；失败上传不丢结果、同 ID 补报、预算暂停阻断；用量接收服务为内存替身 |
| 官方账号历史摘要 | 同脚本 `--account` | 配额恢复后两次真实摘要成功；没有进入 BYOK 包装或创建 BYOK outbox |

官方账号使用实际保存的 `memory_summary` alias。隔离目录仅包含源码核实的真实 sol 配置，不编造 alias 能力；该合法缺项使用原有显式 token 限制，未触发整目录 fallback。两类摘要请求输出限制均为 1800，实际关闭思考。

### 本机结果文件

以下是先前执行的结果，本次回读确认下列 11 份 JSON 的 `passed` 均为 `true`；本次没有重新发送付费请求。文件位于临时目录，可能被系统清理，脚本保留在仓库中可重新执行。不要公开原始错误日志或含凭证的配置。

公共目录前缀：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/`。

| 场景 | 相对于公共前缀的结果路径 |
| --- | --- |
| 基础同步 | `memmy-catalog-live-GIleBR/result.json` |
| 目录变更与缺项 | `memmy-catalog-live-Ujr1Qt/mutations-result.json` |
| 思考参数 | `memmy-catalog-live-DehA2K/thinking-result.json` |
| AgentLoop 快照 | `memmy-catalog-live-t5oVwb/agent-loop-result.json` |
| fallback 成功 | `memmy-catalog-fallback-zpWuqA/result.json` |
| fallback 错误 | `memmy-catalog-fallback-unFHDW/result.json` |
| 自定义保存 | `memmy-catalog-custom-save-iRvJC3/result.json` |
| 思考控件真实请求 | `memmy-catalog-thinking-ui-WZLRmR/result.json` |
| 正式 App 自动刷新 | `memmy-catalog-refresh-ui-uK4QgT/result.json` |
| BYOK 摘要 | `memmy-catalog-live-summary-zZhD25/result.json` |
| 官方账号摘要 | `memmy-catalog-account-summary-oQUFSo/result.json` |

## 本次重跑的回归

直接调用 Vitest，避免 npm pre 脚本触发版本同步。下列三组共 **147 项通过，0 项失败**，不把以前的全量回归数字计入本次结果。

在 `App/memmy-agent` 执行，79 项通过：

```sh
npm exec -- vitest run tests/providers/model-capability-catalog.test.ts tests/providers/turn-model-capabilities.test.ts tests/providers/catalog-request-parameters.test.ts tests/core/agent-runtime/loop-model-capability-catalog.test.ts --reporter=dot --silent=true
```

在 `App/backend` 执行，40 项通过：

```sh
npm exec -- vitest run src/services/tests/model-capability-catalog-sync-service.test.ts src/adapters/inbound/local-api/routes/tests/model-capability-catalog.test.ts src/adapters/outbound/cloud-client/tests/model-capability-catalog.test.ts --reporter=dot --silent=true
```

在 `App/backend/local-api-contracts` 执行，28 项通过：

```sh
npm exec -- vitest run tests/model-capability-catalog.test.ts tests/model-thinking-levels.test.ts --reporter=dot --silent=true
```

覆盖整包校验、可省略但不能为 null 的 thinking、合法空档位、token 范围、原子文件读写、单飞、重试、取消及快照选择等控制逻辑。本次还核对了同步服务和每轮能力解析源码；生产源码搜索未找到旧 `MODEL_THINKING_CONFIGS`、`MODEL_TOKEN_DEFAULTS`、`thinking_supported`、`thinkingSupported`、`allowed_levels`、`allowedLevels` 标识符。该搜索不能单独证明不存在其他形式的硬编码。

## 改动范围及剩余验收

### Electron 正式界面补验

使用仓库已有 `scripts/dev-self-test.mjs` 完整开发态启动器，经 `App/memmy-agent/scripts/model-catalog-electron.ts` 提供隔离 HOME、全新应用状态和 HTTP 目录 fixture，启动正式 Electron renderer、Backend、Agent gateway 和 Runtime。未复制日常应用数据库，未连接 MySQL/H2，真实模型配置来自旧客户端提交 `b9e5a37a8891e3a1debae8de143198a3c0f44b25`。真实 Provider 请求使用本机现有 BYOK 连接；外围账号等服务为 fixture。

以下路径相对于仓库根目录；原始日志和 transcript 不应公开：

| 场景 | 本机证据 | 结果 |
| --- | --- | --- |
| 有效目录正常调用 | `.tmp/catalog-electron-YN3c2E/requests.json` 及 `runtime/webui/*.jsonl` | 正式界面显示 `MEMMY_ELECTRON_CATALOG_OK`；主流式请求 HTTP 200，输出上限 128000 来自目录 |
| 目录删除、刷新重试耗尽后 fallback | 同目录 | 正式界面显示 `MEMMY_ELECTRON_FALLBACK_OK`；真实主流式请求 HTTP 200，未套用失效目录输出上限 |
| 真实 Provider 负向错误 | `.tmp/catalog-electron-MvMftJ/requests.json` 及 `runtime/webui/*.jsonl` | 请求明确不存在的模型得到真实 503；两轮均保留 `model_catalog_fallback` 和非空实际错误，均有 `turn_end` |
| 失败历史回放 | `.tmp/catalog-electron-MvMftJ/fallback-error.png` | 重新打开会话显示统一提示 |
| 无刷新实时失败展示 | `.tmp/catalog-electron-MvMftJ/fallback-live-error.png` | 从正式输入框发送后，当前页面直接显示“未获取到模型信息，请重启客户端” |

最初尝试负向参数 `top_p=-1` 被 Provider 接受，因此该次成功响应不计作负向验收。负向注入脚本现只改主流式请求的模型名，避免后续运行时对后台任务也制造错误；本次已执行的负向轮使用修改前脚本，后台任务也产生了真实失败重试，不把这些请求计作主对话验收。

本次发现历史回放会丢失 `model_error.origin`，使同一 fallback 错误重新打开后显示普通模型错误。仅在 `frontend-bridge/transcript.ts` 保留精确已知的 `model_catalog_fallback` 标记，原始 detail 和普通错误逻辑保留；新增已知/未知标记回归。两套 transcript 测试共 **72 项通过**，Agent build 和完整类型检查通过，`git diff --check` 通过。

隔离检查：首轮 `YN3c2E/isolation-result.json` 的总结果为 false，未记录逐文件哈希，现有证据不足以归属是哪份日常文件或哪个进程改动，不能认定隔离完全通过，未擅自覆盖日常文件。中间一次启动因测试端口被前轮孤儿进程占用而失败，不计业务验收。最终 `MvMftJ/isolation-result.json` 逐文件确认日常 `config.yaml` 前后哈希一致，日常 `models.json` 前后均不存在。通过原生菜单正常退出，启动器退出码 0；测试端口 45160/45161/45162/45163/45165 已无监听，隔离配置和控制凭证文件已清理。最终轮通过不消除首轮未归属记录。

改动并非只在新增目录模块中。标题、Consolidator/Dream、heartbeat/evaluator、subagent、autocompact、电脑历史摘要和各 Provider 共用模型调用链，已有快照适配。先前越出能力来源迁移的行为调整按用户要求恢复原逻辑，同时保留目录快照接入。针对性测试通过不等于所有其他模块均无影响。

后续按以下顺序推进：

1. 收尾 Electron 验收和首轮日常文件哈希变化的证据边界。已有正式开发态隔离启动器，无需绕过 `MEMMY_TEST_PROFILE_ROOT` 的测试包检查；后续仍用真实配置 fixture，不连接目录数据库。
2. 汇总全部真实请求结果后，核对待入库数据与已验证 fixture；再执行入库及真实 MySQL 验证。数据写入不包含在本次收尾记录中。
3. 按方案先部署云服务，再发布兼容客户端和 Agent；用真实内部 CRUD 验证版本递增、自动/主动同步、已有会话下一轮生效且无需重新发版。

仍未验证：部署后云端 CRUD 到客户端的贯通、真实云端扣费持久化、全部辅助模型任务、模型声明的最大上下文/最大输出和各输入模态极限；首轮日常文件哈希变化尚未归属。Electron 本轮覆盖上述三条对话路径，不代表完整产品回归。短文本真实请求成功不能代替这些验收。
