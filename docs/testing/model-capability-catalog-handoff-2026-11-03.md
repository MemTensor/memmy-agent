# 云端模型目录接手验收：2026-11-03

## 本次结论

已在现有隔离 Electron 客户端完成一轮真实短消息请求。Runtime 本轮读取目录版本 `1793688862290`，选择 `gpt-5.4-mini`，Provider 正常结束，UI 显示 `CATALOG_OK` 并恢复可输入状态。没有重启客户端，没有改动业务代码、保存的模型配置或云端数据库。

这证明目录快照参与本轮请求，但不证明所有最终参数都来自目录：全局显式 Token 配置和现有 Provider 协议规则仍有优先级。

## 实时证据

- 隔离 profile：`.tmp/catalog-cloud-test-20261103`；界面地址 `127.0.0.1:48263/?memmyMode=full`。复用现有进程，没有访问日常 HOME 下的 models.json。
- 目录包含 276 条模型；目标预设没有自定义能力标记，也没有预设级 Token 覆盖。
- 会话选择：模型 `gpt-5.4-mini`，provider `openai`，协议 `openai-chat-completions`，source `byok`。BYOK 是连接来源，不等于自定义能力配置。
- 用户消息时间：2026-11-03 16:55:33（Asia/Shanghai）；返回时间 16:55:46。
- turn ID：`mw0gd69c-y9wiyhzd`；client request ID：`44f517e4-5855-4813-8db7-ac92ca557f60`。
- Provider 结果：`finish_reason=stop`，prompt tokens `32823`，completion tokens `7`，total tokens `32830`，reasoning tokens `0`。未单独采集 HTTP 状态码，不据此虚构 HTTP 200 证据。
- UI 显示精确回复 `CATALOG_OK`；停止按钮消失，模型选择和输入框恢复可用。

| 字段 | 云端目录条目 | 本轮 Runtime 能力 | 最终请求 |
| --- | --- | --- | --- |
| catalogVersion | 1793688862290 | 1793688862290，mode=catalog | 不作为上游请求参数 |
| contextWindowTokens | 400000 | 200000 | 不作为上游请求参数 |
| maxTokens | 128000 | 65536 | max_completion_tokens=65536 |
| inputModalities | text、image | text、image | 本轮仅文本，不验证图片能力 |
| thinking | 默认开启，medium；low/medium/high | 开启，medium | reasoning_effort=none |

## 差异来源

1. 隔离配置的 `agents.defaults` 显式保存 `maxTokens=65536` 和 `contextWindowTokens=200000`。正式配置加载器确认 `explicitTokenSettings` 包含这两项；`loop.ts` 将全局与预设显式配置传给 `resolveTurnModelCapabilities`，后者优先采用显式配置。此前只检查预设本身，不能排除全局覆盖。
2. `openai-compat-provider.ts` 的 `forceNoneReasoningEffort` 分支对满足条件的 OpenAI Chat Completions + tools 请求强制 `none`。本轮请求有 97 个工具定义，返回没有工具调用，reasoning tokens 为 0。本次不修改这项现有协议行为。

## 证据位置与清理

- 脱敏的请求前/流结束观测：`.tmp/catalog-cloud-test-20261103/observed-turn.json`。仅采集模型、能力、目录版本、参数、usage 和停止原因，不采集凭据或消息正文。
- 会话记录：`.tmp/catalog-cloud-test-20261103/workspace/sessions/websocket_f99a2229-ec7f-46ab-96f1-8cd08a6e418b.jsonl`。核对时仅提取本轮模型选择、时间、ID、停止原因和答案相等性。
- 修正已有临时观测脚本的局部变量暂时性死区读取问题；结束后移除调试断点、退出观察进程并确认 9229 无监听。隔离客户端继续运行。

## 剩余范围

本轮重跑 `turn-model-capabilities`、`catalog-request-parameters`、`model-capability-catalog` 三个测试文件，65 项测试全部通过。观测文件的模型、目录版本、记录数量及 stop 结果断言通过；`git diff --check` 通过。

本次只接续中断的四项桌面对话验收。未重新运行云端 CRUD→版本递增→自动/主动刷新→下一轮生效链路，未验证生产部署、扣费持久化或完整产品回归。既有记录中被用户排除的精确输入边界、满额输出、思考档位及视频链路，不重新列为此次验收阻塞。提交、推送和发布尚未执行。
