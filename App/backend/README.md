# @memmy/backend

Memmy desktop local backend. The backend follows the hexagonal layout described in `docs/workspace-quirky-pumpkin.md`.

## Modules

- `adapters/inbound/local-api`: Fastify local HTTP API, runtime token auth, CORS, and SSE.
- `adapters/outbound/agent-source`: external Agent history collection. Built-in sources: Cursor, Claude Code, Codex, OpenCode, OpenClaw, Hermes, and WorkBuddy.
- `adapters/outbound/skill-writer`: external Agent Skill, Hook, and plugin installation for Cursor, Claude Code, Codex, OpenCode, OpenClaw, Hermes, and WorkBuddy.
- `adapters/outbound/memory-client`: MemoryClient port with HTTP Memory Layer and local Memmy SQLite implementations for Agent Runtime routes.
- `infrastructure/app-state-store`: local SQLite app state and migrations.
- `infrastructure/agent-source-store`: source metadata and ingestion dedupe repository.
- `infrastructure/cli-binary`: Memmy CLI runtime config and symlink path helpers.
- `services`: use-case orchestration for bootstrap, ingestion, Agent Runtime, source scanning, skill distribution, and progress events.

## CLI Runtime

- Backend startup writes `~/.memmy/runtime.json` with owner-only permissions so `memmy-memory search` can reach the local daemon.
- `memmy-memory search "<query>"` calls `/api/v1/memory/search` and prints real Memory Layer hit snippets as markdown bullets.
- `infrastructure/cli-binary/installer.ts` can symlink a built `memmy` binary into `~/.local/bin/memmy`.
- The symlink installer is not wired into packaging or startup yet; release packaging must call it or provide an equivalent install step before external Agents can rely on `memmy` being on `PATH`.

## HTTP Endpoints

- `GET /api/health`: local API health.
- `GET /api/app/bootstrap`: schema-valid app bootstrap payload.
- `GET /api/events`: SSE stream. Uses `?token=` because EventSource cannot reliably send custom headers.
- `GET /api/agent-sources`: list built-in and manual Agent sources.
- `POST /api/agent-sources/scan`: start a background source scan and return `{ jobId }`.
- `POST /api/agent-sources/manual`: add a manual source.
- `DELETE /api/agent-sources/:sourceId`: remove a source.
- `POST /api/agent-sources/:sourceId/skill`: install the Memmy Skill for a source.
- `DELETE /api/agent-sources/:sourceId/skill`: uninstall the Memmy Skill for a source.

## Agent Runtime Routes

| Method | Path | Service | Permission | Idempotent |
| --- | --- | --- | --- | --- |
| `GET` | `/api/v1/health` | MemoryClient | none | no |
| `POST` | `/api/v1/sessions/open` | SessionService.open | runtime token | yes |
| `POST` | `/api/v1/sessions/:sessionId/close` | SessionService.close | runtime token | yes |
| `POST` | `/api/v1/turns/start` | TurnService.start | runtime token | no |
| `POST` | `/api/v1/turns/:turnId/complete` | TurnService.complete | runtime token | yes |
| `POST` | `/api/v1/memory/search` | SearchService.search | runtime token | no |
| `POST` | `/api/v1/memory/add` | MemoryDetailService.add | runtime token | no |
| `GET` | `/api/v1/memory/:id` | MemoryDetailService.getById | runtime token | no |
| `DELETE` | `/api/v1/memory/:id` | MemoryDetailService.delete | runtime token | no |
| `GET` | `/api/v1/panel/overview` | PanelService.overview | runtime token | no |
| `GET` | `/api/v1/panel/analysis` | PanelService.analysis | runtime token | no |
| `GET` | `/api/v1/panel/items` | PanelService.items | runtime token | no |

## Built-in Agents

| Agent | Source history | Skill target |
| --- | --- | --- |
| Cursor | Windows: `%APPDATA%\Cursor\User`; macOS: `~/Library/Application Support/Cursor/User`; Linux: `${XDG_CONFIG_HOME:-~/.config}/Cursor/User` (`workspaceStorage/*/state.vscdb`, `globalStorage/state.vscdb`) | `~/.cursor/skills/memmy-memory/SKILL.md`, `~/.cursor/hooks.json` |
| Claude Code | `~/.claude/projects/<cwd-slug>/*.jsonl` | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl` | `~/.codex/AGENTS.md` |
| OpenCode | `~/.local/share/opencode/opencode.db` | `~/.config/opencode/AGENTS.md`, `~/.config/opencode/skills/memmy-memory/SKILL.md` |
| OpenClaw | `~/.openclaw/memos-local/memos.db`, `~/.openclaw/memos-plugin/data/memos.db`, `~/.openclaw/**/*.db`, `*.sqlite`, `*.sqlite3` | `<workspace>/AGENTS.md`, `~/.openclaw/skills/memmy-memory/SKILL.md` |
| Hermes | `~/.hermes/sessions/**/*.jsonl`, `~/.hermes/state.db` | `~/.hermes/SOUL.md` |
| WorkBuddy | `~/.workbuddy/projects/<cwd-slug>/*.jsonl` (`WORKBUDDY_CONFIG_DIR` or `CODEBUDDY_CONFIG_DIR` can override the root) | `~/.workbuddy/skills/memmy-memory/SKILL.md` |

## Memory Layer Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `MEMMY_MEMORY_LAYER_URL` | empty | Memory Layer base URL, for example `http://127.0.0.1:8765`. Empty falls back to local Memmy SQLite discovery; startup fails if no real source is available. |
| `MEMMY_MEMORY_LAYER_TOKEN` | empty | Bearer token forwarded to the Memory Layer. |
| `MEMMY_MEMORY_LAYER_TIMEOUT_MS` | `5000` | Per-request timeout in milliseconds. |
| `MEMMY_MEMORY_LAYER_MAX_RETRIES` | `3` | Max retries for 5xx or network failures. |

## SSE Events

- `app.connected`: sent when the SSE stream opens.
- `app.heartbeat`: periodic heartbeat.
- `agent_source.scan_progress`: source scan progress.
- `agent_source.scan_completed`: source scan completion summary.
