# 模型目录能力边界验证：2026-11-03

本轮没有全部通过。已验证当前数据库目录版本 2 的全部已配置思考档位、6 个模型的图片输入、输出参数上下限和大输入预算。确认的缺口是当前 GPT Sol 上游拒绝 `max`，以及当前客户端没有可用的视频发送链路；Claude 五个标签仍沿用原适配器的三种预算映射。

本轮只增加真实请求验收脚本和本记录，没有修改数据库、公共目录、模型连接或业务逻辑，没有提交或推送。结束时 `memmy_test` 仍为 6 条记录、版本 2，日常 config.yaml/models.json 哈希保持一致。完成的测试批次也核对了隔离 config.yaml/models.json 字节内容未变。

## 事实源和验证层次

- 采用已经从 MySQL 经 Java 同步到客户端的目录；每批先校验本地模型视图与 models.json 一致，再使用正式 Runtime 能力解析器和 Provider 发起真实请求。
- endpoint、协议、密钥来自隔离客户端已有连接。优先选公共模型预设；对于保存为自定义模型的连接，仅在测试进程内使用公共目录能力，保存配置和正式自定义优先级保持原状。
- 不经过 Electron 输入框、媒体上传接口或 WebSocket 发送。这是目录消费和 Provider 层真实验证，不能称为完整桌面媒体链路验收。
- 不保存密钥、原始 Provider 错误、输入正文或模型内部思考内容。JSON 记录包含参数、HTTP 状态、usage、答案断言及错误分类/指纹。

脚本：`App/memmy-agent/scripts/model-catalog-live-boundaries.ts`。

## 思考配置：20 次真实请求，19 次成功

算术问题由上游计算，并校验精确答案。测试使用实际输出额度 4096；关闭思考时使用 128。检查实际发出的 effort 或 thinking budget，并记录 reasoning usage/是否返回思考块，不以 HTTP 200 单独判定成功。

| 模型 | 开启档位 | 关闭 | 结果 |
| --- | --- | --- | --- |
| gpt-5.4-mini | low / medium / high | 成功 | 全部成功；上游报告非零 reasoning_tokens，关闭后为 0 |
| deepseek-v4.1-flash | low / high / max | 成功 | 全部成功，开启时返回思考内容，关闭时未返回 |
| claude-sonnet-4-6 | low / medium / high / xhigh / max | 成功 | 全部可调用，但 wire 预算只有三种，见下文 |
| gpt-5.6-sol | low / medium / high / xhigh 成功；max 返回 400 | 成功 | max 不通过 |
| deepseek-v4.1-flash-1017 | 未配置 | 不额外发明思考配置 | 不适用 |
| qwen3.5-27b | 未配置 | 不额外发明思考配置 | 不适用 |

GPT Sol 的失败项另行补查：上游 `invalid_request_error` 明确列出的支持值为 `none/low/medium/high/xhigh`，不含 `max`。该结论限定于当前已配置连接，不推断其他上游。

Claude 正式适配器当前转换结果为 low→1024，medium→4096，high→8192，xhigh→4096，max→4096。请求成功不代表上游获得五种不同强度；这是现有转换逻辑，本轮没有修改。

## 多模态

6 个模型均成功识别随机生成 PNG 中的八位验证码。期望答案只存在于图片，不在文字提示中；实际 wire 均包含图片块，返回答案全部精确匹配。

Qwen 目录的 `video` 项不能判为通过：正式 Responses 转换器会丢弃 video_url 块。测试使用明确标记的序列化探针确认视频没有进入请求，没有把伪造视频发给上游。现有前端附件校验测试也确认视频文件会被拒绝。没有用切换协议或抽帧图片来代替视频验收，因此尚不能判断该上游实际视频能力。

图片用例只覆盖单张 PNG 的真实识别，没有覆盖所有图片格式、数量、尺寸或桌面上传交互。

## 输出 Token 参数边界

所有模型在目录声明的输出额度下均完成短回答；请求 taskMaxTokens=maxTokens+1 时，正式适配器实际发送值均被裁剪为目录 maxTokens。

为独立观察上游，另在测试进程的 fetch 边界将输出参数替换为目录上限+1，绕过客户端裁剪；该变体没有改变 Runtime 或保存配置。

| 模型 | 目录输出上限：请求成功 | 上游直接收到上限+1 | 输出额度 1 |
| --- | ---: | --- | --- |
| gpt-5.4-mini | 128000 | 128001：400 | 400 |
| deepseek-v4.1-flash | 384000 | 384001：200，短回答正确 | 200，usage 输出 1 |
| claude-sonnet-4-6 | 64000 | 64001：200，短回答正确 | 200/length，但 usage 输出 4，不能据此宣称精确限制为 1 |
| gpt-5.6-sol | 128000 | 128001：400 | 400 |
| qwen3.5-27b | 8192 | 8193：200，短回答正确 | 200，usage 输出 1 |
| deepseek-v4.1-flash-1017 | 384000 | 384001：200，短回答正确 | 200，usage 输出 1 |

Claude 首轮高输出额度的非流式请求被 SDK 在本地拒绝，未发出 HTTP 请求。随后改用现有正式 chatStream 路径完成表中高额度用例，不能把首轮 SDK 拒绝当作模型不支持 64000。

这些用例验证额度参数接受情况和客户端裁剪，不代表真实生成了 64000～384000 个输出 Token。上限+1 成功也不证明可以生成那么多 Token，不能将目录上限当作所有上游都会拒绝越界的硬限制。

## 大输入和 Runtime 预留预算

总上下文窗口不等于可用输入长度。正式 Runner 的默认目录预算公式为 `contextWindowTokens - maxTokens - 4096`；显式用户覆盖和 task 额度还会影响实际调用，本轮不修改这些配置。

首轮用 cl100k（应用估算器）生成接近/超过总窗口的长输入，输出额度 128，并要求从输入开头取回随机标记。GPT mini、Claude、GPT Sol 的两侧请求均返回 400；两条 DeepSeek 连接和 Qwen 则完成了检索回答。不能仅凭靠近总窗口被拒绝，就判定目录错误，必须考虑输入/输出预留。

后续按 Runner 公式补测三个被拒绝的模型，保留 256 个估算输入 Token 给指令及消息开销：

| 模型 | 目录总窗口 / 最大输出 | 按公式计算的输入预算 | 补测上游报告的输入 Token | 结果 |
| --- | --- | ---: | ---: | --- |
| gpt-5.4-mini | 400000 / 128000 | 267904 | 267662 | 200，回答正确 |
| claude-sonnet-4-6 | 1000000 / 64000 | 931904 | 932023 | 200，回答正确 |
| gpt-5.6-sol | 1050000 / 128000 | 917904 | 917662 | 200，回答正确 |

Claude 的上游计数与 cl100k 有差异，所以不能把估算值当成其原生精确 Token 数。

另外两条 DeepSeek 连接均在上游报告输入 998985、1001033 Token 时成功取回标记；Qwen 在输入 31762、33809 Token 时成功。它们已经覆盖大于上述预留公式的输入量，但不表示已经找到各自的上游硬上限。

Claude 针对近总窗口的简化补测也曾成功，与首轮带标记请求的 400 不同。补测同时改变了提示内容，不能据此认定相同请求随机失败，也不能归因到具体路由或模型限制。当前证据支持预留后预算可用，尚未确定稳定、精确的上游最大输入边界。

这些大输入通过 Provider 执行，不是将百万 Token 聊天直接送入 Electron，再观察完整 AgentLoop 自动压缩。正式 Runner 输入预算相关的 9 项现有测试另行通过。

## 复现与证据

在 memmy-agent 根目录运行；可在 profile 后追加模型名，只重跑指定模型：

```sh
node --import tsx App/memmy-agent/scripts/model-catalog-live-boundaries.ts thinking .tmp/catalog-electron-JnKwr7
node --import tsx App/memmy-agent/scripts/model-catalog-live-boundaries.ts media .tmp/catalog-electron-JnKwr7
node --import tsx App/memmy-agent/scripts/model-catalog-live-boundaries.ts tokens .tmp/catalog-electron-JnKwr7
node --import tsx App/memmy-agent/scripts/model-catalog-live-boundaries.ts budget .tmp/catalog-electron-JnKwr7 gpt-5.4-mini claude-sonnet-4-6 gpt-5.6-sol
```

真实大输入请求会消耗上游额度；成功的短回答不代表没有大量输入 Token。

临时原始结果位置（可能被系统清理；首次 Token 批次因断言中止，保留其结果，不覆盖）：

- 思考：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-catalog-thinking-boundaries-lKLixn/result.json`
- 图片/视频探针：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-catalog-media-boundaries-46jstx/result.json`
- 首次 Token 批次：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-catalog-tokens-boundaries-ruMevD/result.json`
- 剩余四模型 Token 流式补测：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-catalog-tokens-boundaries-nhPX3p/result.json`
- 预留预算补测：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-catalog-budget-boundaries-WzkJ0g/result.json`

Agent TypeScript 检查通过。能力解析/Provider 参数 38 项、Runner 输入预算 9 项、前端附件校验 1 项现有测试通过，共 48 项；前端其他 91 项因定向筛选跳过，没有宣称执行了全部回归。

## 继续验证：真实长输出与精确输入边界（本轮已结束）

这一阶段采用流式真实请求，观察最终停止原因和上游 usage，不用“接受最大输出参数”替代真实生成。本轮请求已经全部结束；4 个模型满额输出通过，2 个未证实，不声明整体全部通过。

| 模型 | 实际输出 Token | 停止原因 | 是否达到目录输出上限 |
| --- | ---: | --- | --- |
| qwen3.5-27b | 8192 | length | 是 |
| claude-sonnet-4-6 | 64000 | length | 是 |
| gpt-5.6-sol | 128000 | length | 是 |
| deepseek-v4.1-flash | 384000 | length | 是，约 24 分钟 |
| deepseek-v4.1-flash-1017 | 299000 | stop | 否，约 18.5 分钟后提前结束，未达到 384000 |
| gpt-5.4-mini，指定两百万整数任务 | 60 | stop | 否，主动提前结束 |
| gpt-5.4-mini，开放式连续输出任务 | 808 | stop | 否，主动提前结束；这不证明模型硬上限低于 128000 |
| gpt-5.4-mini，长文本原样复写任务 | 3 | stop | 否，上游报告输出 3，但正式解析结果正文为空 |

长输出请求在测试进程中消费流，定期记录字符进度，最长等待 45 分钟。不把进度字符数当成原生 Token 数，也不保存生成正文或思考内容。所有请求均在超时前结束。已完成的输出分片被显式停止以避免重复调用，退出码 130 表示分片调度停止，不表示已保存的 Claude/Sol/DeepSeek 成功用例失败。主模型 DeepSeek 与后缀模型提示词不同，不能把生成长度差异单独归因于模型能力或上游限制。

精确输入探测先用三个小请求校准 padding 的原生计数，并重复相同输入确认计数稳定。随后用上游错误中的数字作为候选，实际验证成功/拒绝两侧并重复相邻点。校准失败、网络超时、额度错误、重复结果不一致均不能建立稳定上限。

- GPT mini：在当前连接、固定 padding 提示、请求输出额度 64 的条件下，272000 个原生输入 Token 成功，272001 返回 400；相邻两点均重复确认，建立该条件下的输入接受边界。
- GPT Sol：922000 曾成功，922001 被拒绝，但相同 922000 的重复请求也被拒绝。未建立稳定边界，不把第一次成功当作最终证明。
- Claude：首个校准请求超时，其余校准计数也没有满足稳定线性映射；另调用当前连接的官方形状 count_tokens 接口，返回 404。没有将其他模型的 tokenizer 当作 Claude 精确计数器。
- DeepSeek：接近极限时已经出现 HTTP 200、输入计数匹配，但因剩余空间不足以返回完整 EDGE_OK 而被 length 截断。后续探测区分“API 接受输入”与“仍能完整回答”；前者不能证明该输入长度适合实际对话。

后续补测已经完成的输入结果：

| 模型/连接 | 相邻接受/拒绝输入 Token | 重复确认 | 限制 |
| --- | --- | --- | --- |
| gpt-5.4-mini | 272000 / 272001 | 是 | 固定提示、输出请求额度 64 |
| qwen3.5-27b | 260096 / 260097 | 是 | 接受点仍返回完整 EDGE_OK；目录 32768 是较保守配置 |
| deepseek-v4.1-flash | 1048568 / 1048569 | 两侧各两次 | 接受点回答 length 截断；拒绝点为 400，具体错误分类并不总能识别为 context |
| deepseek-v4.1-flash-1017 | 1048568 / 1048569 | 两侧各两次 | 同上，只能证明当前提示的 API 接受边界 |
| gpt-5.6-sol | 922000 曾成功，随后相同输入也被拒绝 | 未通过 | 不能宣称稳定输入上限 |
| claude-sonnet-4-6 | 未确定 | 未通过校准 | 当前 count_tokens 返回 404，原生计数校准不稳定 |

GPT Sol 随后在与校准相同的固定提示下，按 Runner 预留公式所得 917904 个原生输入 Token 连续两次返回完整 EDGE_OK。该安全预算的成功不消除 922000 边界重复不一致记录。

当前证据文件：

- Qwen 满额输出：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-catalog-long-output-boundaries-2c4o51/result.json`
- 首组其他模型长输出：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-catalog-long-output-boundaries-yMR6bu/result.json`
- Claude、Sol、DeepSeek 后缀模型长输出：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-catalog-long-output-boundaries-oyf49j/result.json`
- GPT mini 开放式输出复测：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-catalog-long-output-boundaries-ieRDQU/result.json`
- 首组输入二分探测（主动停止，改用错误候选减少大请求）：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-catalog-input-ceiling-boundaries-Cgtcy1/result.json`
- 输入边界探测：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-catalog-input-ceiling-boundaries-UdMh6N/result.json`
- Qwen 扩大范围及输入接受探测：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-catalog-input-ceiling-boundaries-ZCxC50/result.json`
- 两条 DeepSeek 相邻输入独立复测：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-deepseek-adjacent-DWFCP5/result.json`
- 后缀 DeepSeek 独立长输出分片：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-catalog-long-output-boundaries-xQTsi0/result.json`
- GPT mini 长文本复写：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-catalog-long-output-copy-boundaries-P8qSUx/result.json`。首次生成 40000 行源文本未满足“源文本 Token 大于输出额度”的脚本断言，未发送请求；改为 60000 行后才执行真实请求。

脚本新增 `long-output`、`long-output-copy` 与 `input-ceiling` 模式；仍然只操作验收进程和临时产物，不修改数据库或保存的连接配置。旧输出分片在已分派的用例完成后停止，避免与另一分片重复运行同一模型。

本轮最终结论：满额输出已证实 Qwen 8192、Claude 64000、GPT Sol 128000、DeepSeek 主模型 384000；GPT mini 和后缀 DeepSeek 未证实。输入边界结论仅限当前连接、固定 padding 提示和输出额度，不推广为任意消息/路由的通用极限。现有思考 max 拒绝、Claude 档位映射合并和视频发送缺口仍保留，本轮没有实施修复或变更目录。Agent TypeScript 检查及 47 项能力/参数/Runner 相关测试通过；本轮未重跑桌面全部回归。
