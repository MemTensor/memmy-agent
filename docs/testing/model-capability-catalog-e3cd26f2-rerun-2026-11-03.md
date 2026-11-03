# e3cd26f2 部署后模型目录链路重验

2026-11-03，按用户确认的部署版本重跑 `https://test-api.memmy.cn`。本地云服务 HEAD 为 `e3cd26f2`，工作区干净；部署版本来源为用户明确确认，本轮未读取远端构建元数据。以下均为本轮实时测试，不沿用上轮 400/500 结论。

## HTTP CRUD：全部通过

独立测试名称 `memmy806-rerun-d2f8e51b-e47a-4f70-9605-a3a15fabfbd9`：

| 操作 | HTTP | 核验 |
| --- | --- | --- |
| POST 新增 | 200 | catalogVersion=1793688862311；text、8192/128，无 thinking |
| GET 查询 | 200 | 内容与新增输入完全一致 |
| PUT 替换 | 200 | catalogVersion=1793688862312；输出改为 256，thinking 默认 high |
| GET 查询 | 200 | 内容与修改输入完全一致 |
| DELETE 删除 | 200 | catalogVersion=1793688862313 |
| 删除后 GET / 再次 DELETE | 404 | 测试条目不存在 |

每次成功写操作的版本恰好加一。脱敏原始结果：`.tmp/catalog-cloud-test-20261103/http-crud-rerun.json`。

## 云端修改 → 客户端刷新 → 当前轮/下一轮：通过

复用运行中的隔离客户端 `.tmp/catalog-cloud-test-20261103`，经其正式本地刷新 API 更新 `home/.memmy/models.json`，并断言本地模型配置 API 的 `capabilityCatalog` 与云端目录整包一致。客户端配置文件前后字节一致，没有重启客户端。

使用已有验收脚本 `model-catalog-java-turn.ts`，新增 `--test-cloud` 入口；凭据只在内存读取，云端目标限定为测试域名。真实 AgentLoop 使用同一会话，第一轮实际调用 `read_file`，在两次 Provider 调用之间通过云端 PUT 修改 `gpt-5.4-mini` 的目录默认思考档位，并刷新运行中客户端。

| 调用 | 目录版本 | Runtime 档位 | 工具结果 | 实际 HTTP |
| --- | --- | --- | --- | --- |
| 第一轮第 1 次 | 1793688862313 | medium | 尚未产生 | 200 |
| 第一轮第 2 次 | 1793688862313 | medium | 已读到文件内容 | 200 |
| 同一会话下一轮 | 1793688862314 | low | 历史中保留 | 200 |

云端和客户端已在第一轮中间更新为新目录，但当前轮第二次调用仍保持旧快照；下一轮才采用新版本。两轮答案均满足精确匹配断言。

测试结束前再次读取云端条目，确认仍等于本测试修改内容后才恢复原值；随后刷新客户端并断言整个模型映射恢复为初始值，版本为 `1793688862315`。版本递增保留，不回退。证据：`/var/folders/qj/4zt6nb6x7hz1hmklks4fk6bm0000gn/T/memmy-java-turn-f7kcLh/result.json`。

参数边界：三次请求都显式限制输出 512 Token；现有 GPT Chat Completions 工具兼容规则使最终 `reasoning_effort=none`。medium→low 是 Runtime 目录档位变化，不能说上游实际思考参数也变成 low。本轮是真实 AgentLoop/Provider 链路，未使用 Electron composer 发送这两轮。

## 定时自动刷新与清理

通过。创建独立临时条目 `memmy806-auto-a1b5abb4-638a-4cad-8c0f-4dbd93fa2cb5`，云端版本增至 `1793688862316`。自动刷新阶段没有调用主动刷新 API，期间本地模型视图与缓存仍保持版本 `1793688862315`；创建约 190,294ms 后正式后台定时器使本地文件取得新版本及该条目。

随后通过 HTTP DELETE 删除该临时条目，版本增至 `1793688862317`；主动同步清理后的目录返回 `synced`、`hasValidCatalog=true`、相同版本。最终管理列表 HTTP 200、276 条，无 `memmy806-` 测试条目；客户端也为 276 条，`gpt-5.4-mini` 默认档位恢复为 medium。脱敏结果：`.tmp/catalog-cloud-test-20261103/auto-refresh-rerun.json`。

## 补充检查

实时平台目录 GET=200、带相同 catalogVersion 的条件 GET=304 且空响应体。自动刷新标记存在期间目录为版本 `1793688862316`、277 条（原有 276 加临时条目）。

`turn-model-capabilities`、`catalog-request-parameters`、`model-capability-catalog` 三个文件 65 项测试全部通过。没有重跑全量产品回归或真实计费；此前报告中的其他回归失败不能因本链路恢复而视为已解决。视频继续排除。
