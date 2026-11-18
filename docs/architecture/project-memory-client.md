# Memmy 客户端项目记忆接口

项目管理页把协作项目绑定到本机工作区或文件夹。Memmy 和已经接入轮次钩子的第三方 Agent 共用这份绑定。一个目录可以绑定多个项目，子目录继承绑定。会话中切换工作目录不改变归属。每轮开始记录命中的绑定，新增绑定在下一轮生效。解绑、切换账号或权限失效后，后续读写重新核对范围。未绑定的目录沿用普通本地检索。

## 项目管理页和主题页

本机 Backend 的前缀为 `/api/project-memory`，使用桌面运行时的 `X-Memmy-Local-Token` 请求头。账号由 Backend 读取。路径、绑定清单和桌面凭证均在本机处理。

| 方法与路径 | 参数 | 响应 |
| --- | --- | --- |
| `GET /bindings` | 查询参数 `project_id` | `project_id, workspace_ids[], folder_paths[]` |
| `PUT /bindings` | JSON 含 `project_id, workspace_ids[], folder_paths[]`。传两组空数组可清除该项目的全部绑定 | 替换后的绑定。桌面工作区使用工作区选择器的 ID，文件夹使用绝对路径 |
| `GET /topics` | `project_id, page?, size?`。页码从 1 开始，每页默认 20，最多 50 | `topics[], page, size, total` |
| `GET /topics/{id}` | 查询参数 `project_id` | 网关授权的主题详情、决策、分歧和来源 |
| `GET /items/{id}` | 查询参数 `project_id` | `memory_id, project_id, kind, content, read_from` |
| `GET /status/{task_id}` | 路径传整理任务 ID | `task_id, status, updated_topic_ids[]`，整理失败时附错误 |

按 ID 读取时，只缓存网关明确标为 `immutable`、无版本的固定正文。再次读取先向网关核验元数据。离线时无法读取旧副本。退出账号会清理该账号的缓存。

## 宿主与轮次事件

已接入 Memory 的宿主继续使用现有的 `/api/v1/sessions/open`、`/api/v1/turns/start` 和完成事件。直接接 Backend 的调用方可使用下表。以下接口均为 POST，公共参数是 `source, conversation_id`。会话首次事件传 `cwd` 或 `workspace_id`。同一轮的检索和写入使用相同的 `turn_id`。原生宿主的完成事件 ID 与检索 ID 不同时，钩子另传 `recallTurnId`。

| 路径 | 专用参数 | 响应 |
| --- | --- | --- |
| `/sessions/open` | 启动位置 | 固定会话归属，返回 `ok` |
| `/index` | `size?`，每个项目默认 8 | `projects[], degraded[]` |
| `/search` | `turn_id, query, domains?, limit?, view?, include_index?`。默认查主题，取 9 条，最多 25 条。查原文用 `view="trajectory"` | `topics[]` 或 `trajectories[]`，另有 `degraded[]`。自动检索在首轮和压缩后的检索中附最近主题索引 |
| `/add` | `turn_id, submission_id, messages[], domains?`。目标取本轮开始时确定且仍有效的绑定 | `submissions[]`，含 `project_id, submission_id, status`，受理后含 `task_id`。受理状态未知时 HTTP 202 |
| `/import` | 用户确认后传 `confirmed=true, submission_id, project_ids[], messages[], domains?`。按同一来源会话提交 | 仅导入指定且仍绑定的项目，按消息时间排序，每批最多 40,000 token。返回逐项目、逐批受理结果 |
| `/sessions/compacted` | 公共参数 | 下一次自动检索重新取索引 |
| `/read` | `turn_id, project_id, memory_id` | 在当前轮次的授权范围内按 ID 读取，供 Agent 工具使用 |

消息仅接受 `user` 和 `assistant`，正文为 `content`。可以传 `role_id, role_name`。新轮次缺少 `chat_time` 或 `message_id` 时服务会补齐，重试沿用首次记录。历史导入需要逐条传原始时间和稳定消息 ID。完成事件只取用户提问和可见回复，并剔除协议注入块和引用块。

Memmy 的 `memmy_memory_search` 返回混排结果。项目项带 `project:<项目>:<记忆>` 标识，可交给 `memmy_memory_get`。需要核对原话时使用 `search_team_trajectory(query)`。该工具由服务限定项目范围和片段长度，原文权限由网关检查。

## 混排与评测

每个项目主题与其分歧作为一项，本地命中按实际注入段落计数。两路按名次等权排序，查询中明确提到的错误码、路径、符号优先，同分时先放项目项。每轮最多 5 项，合计最多 3,000 token。超预算时先裁主题进展、经验和旧历史，保留入选决策的全部分歧。某一路检索暂时不可用时采用另一路已有的结果。

`/api/v1/turns/start` 的 `injectedContext.markdown` 是宿主本轮收到的文本；混排时 `projectMemory.selectedIds`、`blocks`、`tokenEstimate` 给出实际顺序、正文和文本 token 数。`sourceMemoryIds` 保持本地记忆原有含义。统一评测可以按轮次将这些字段与宿主的实际提示、回答和用量关联。

内置 Agent 对本轮获准使用的混排结果生成内容指纹。历史正文仍在实际模型请求中时，用当前轮次的短引用复用。工具结果被压缩、历史被裁剪或内容更新时，实际请求补回需要的正文。第三方宿主使用每轮返回的完整文本。

## 网关联调

Backend 使用当前账号的 Bearer 凭证访问 `/api/memmy/project-memory`。云端返回 `{code: 0, data: ...}`。读写错误使用 HTTP 状态码。云端负责项目成员权限、项目到 MemOS 空间的映射和主题整理。

- `POST /search` 和 `POST /index` 使用非空 `project_ids[]`，超过 20 个项目分批。检索另传 `conversation_id, query, domains?, limit, view`。返回主题和索引项均需带 `project_id`。
- `POST /add` 每次只提交一个项目，带 `project_ids, submission_id, source, conversation_id, messages, domains?`。每个项目有独立、稳定的提交 ID。已受理的结果需返回 `task_id, status`。
- 响应丢失时，Backend 用 `GET /submissions/{submission_id}?project_id=…` 复查。返回任务 ID 表示已受理，只有明确返回 `status="not_accepted"` 才重发。这是待与真实网关确认的接口。待确认的提交保存在本机，后台复查前再次检查账号和绑定。
- 主题列表走 `POST /topics`，分页参数放在 JSON 中。详情、整理状态和按 ID 读取沿用本机 GET 路径。读取固定正文的权限复核使用 `view=metadata`，读取正文使用 `view=content`。

在仓库根目录运行 `node scripts/mock-project-memory-gateway.mjs`，再用 `MEMMY_PROJECT_MEMORY_GATEWAY_URL=http://127.0.0.1:4198` 启动桌面 Backend，即可单独替换项目记忆网关。模拟网关在进程内保存数据，将一轮提问和回复映射为一个主题，支持写入、检索、主题详情和状态回查。客户端与模拟网关的端到端用例可用 `npx vitest run tests/smoke/project-memory.test.ts` 运行，无需真实账号。
