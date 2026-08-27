# Automatic Sync Recipe Contract

The first onboarding session must convert its format discovery into one declarative recipe. Memmy validates and stores the recipe, then uses it for every later GUI sync without starting another Agent session.

Copy the canonical property names exactly. The nested recipe uses camelCase even though the surrounding `memmy_agent_source` tool call uses snake_case. Do not invent aliases or retry by changing the discriminator at random.

## Source Representation Capabilities

Choose the product-maintained representation that the recipe can reproduce with the fewest transformations. A flattened transcript or display projection is a valid native source when the product updates and persists it; do not prefer a lower-level ledger merely because it is authoritative.

| Representation | Supported extraction |
| --- | --- |
| JSONL | Treat each non-empty line as one record. Follow dot-separated object properties only. Do not filter events or expand arrays within a line. |
| JSON | Parse each file as one document. Use `recordsPath` to select one nested array whose elements are message records. |
| SQLite | Use one read-only `SELECT`. Project or flatten JSON columns with SQLite JSON functions when needed. |

Inventory sibling files and referenced paths before choosing:

1. Prefer a flattened message projection, transcript, table, or view with stable message and conversation ids.
2. Otherwise prefer a JSON snapshot with a directly selectable message array.
3. Use a raw event or ledger stream only when its records map directly, without unsupported filters, array expansion, wildcards, joins, or executable transforms.

Reject only the failing representation, not the entire Agent framework. Test every viable product-maintained representation for the active surface before reporting that the native format needs a custom adapter.

## Common Shape

```json
{
  "version": 1,
  "format": "jsonl",
  "path": "/absolute/native/history/root",
  "fileSuffix": ".jsonl",
  "fields": {
    "messageId": "id",
    "conversationId": "session.id",
    "role": "message.role",
    "content": "message.content",
    "createdAt": "created_at",
    "workspacePath": "workspace.path",
    "gitRoot": "workspace.git_root"
  },
  "roleMap": {
    "human": "user",
    "ai": "assistant"
  },
  "timestampFormat": "auto"
}
```

Required common fields:

- `version`: exactly `1`.
- `format`: `jsonl`, `json`, or `sqlite`.
- `path`: an absolute path to the native history file or directory. Never use the temporary normalized manifest.
- `fields.role`, `fields.content`, and `fields.createdAt`: dot-separated property paths.
- `timestampFormat`: `auto`, `iso`, `unix_seconds`, or `unix_milliseconds`.

These names are invalid and must not be used:

| Invalid | Required |
| --- | --- |
| `type` | `format` |
| `id_field` | `fields.messageId` |
| `conversation_id_field` | `fields.conversationId` |
| `role_field` | `fields.role` |
| `content_field` | `fields.content` |
| `timestamp_field` | `fields.createdAt` |
| `role_mapping` | `roleMap` |
| `timestamp_format` | `timestampFormat` |
| `epoch_ms` | `unix_milliseconds` |

Optional common fields:

- `wslDistro`: include only when Memmy runs on Windows and `path` belongs to WSL. Keep `path` in absolute Linux form and use the exact distribution name returned by `wsl --list --quiet`; Memmy resolves it through that distribution for automatic sync.
- `fields.messageId`: a stable source record id. If omitted for a file recipe, Memmy hashes the relative file path and record position.
- `fields.conversationId`: a stable source conversation id. If omitted for a file recipe, Memmy hashes the relative file path.
- `fields.workspacePath` and `fields.gitRoot`.
- `roleMap`: exact source-role values mapped to `user`, `assistant`, `tool`, or `system`. Standard role names work without a map.

## JSONL

Use `format: "jsonl"` when each non-empty line is one object. If `path` is a directory, set `fileSuffix` so newly created transcript files are discovered recursively.

Use the narrowest stable suffix that selects only the chosen representation. For example, prefer `display.jsonl` over `.jsonl` when the same directory tree also contains ledger or observability streams.

One JSONL line is one candidate message record. A path such as `messages.0.role` does not expand a `messages` array, and JSONL does not support `recordsPath`. If a ledger line contains an event with nested messages, look for a sibling transcript or display projection, a JSON snapshot, or a queryable table before declaring the framework unsupported.

## JSON

Use `format: "json"` for a JSON file or directory of JSON files. Set `recordsPath` when the message array is nested:

```json
{
  "version": 1,
  "format": "json",
  "path": "/absolute/history",
  "fileSuffix": ".json",
  "recordsPath": "messages",
  "fields": {
    "messageId": "id",
    "role": "role",
    "content": "content",
    "createdAt": "timestamp"
  },
  "timestampFormat": "auto"
}
```

`recordsPath` is relative to each file root. A directory recipe requires `fileSuffix`.

## SQLite

Use `format: "sqlite"` with one read-only `SELECT` statement. The query must contain no semicolon. SQLite recipes require stable `messageId` and `conversationId` field mappings, normally mapped to selected column aliases:

```json
{
  "version": 1,
  "format": "sqlite",
  "path": "/absolute/history.db",
  "query": "SELECT message_id, conversation_id, role, content, created_at FROM messages ORDER BY created_at, message_id",
  "fields": {
    "messageId": "message_id",
    "conversationId": "conversation_id",
    "role": "role",
    "content": "content",
    "createdAt": "created_at"
  },
  "timestampFormat": "auto"
}
```

Use SQLite JSON functions in the `SELECT` when message fields are stored inside JSON columns.

The SQLite extractor executes the query without parameter bindings. Do not include `?`, `$name`, or `:name` placeholders. Select the native records needed to reconstruct history; Memmy applies the permanent sync boundary after extraction.

During Windows-to-WSL onboarding, a missing `sqlite3` executable does not block SQLite recipes. Inspect the schema and preflight the query with Python's standard-library `sqlite3` module, then save the absolute Linux `path` and exact `wslDistro`; the Windows backend performs later reads without depending on the WSL CLI:

```json
{
  "version": 1,
  "format": "sqlite",
  "path": "/home/user/.agent/history.db",
  "wslDistro": "UbuntuCustom",
  "query": "SELECT message_id, conversation_id, role, content, created_at FROM messages ORDER BY created_at, message_id",
  "fields": {
    "messageId": "message_id",
    "conversationId": "conversation_id",
    "role": "role",
    "content": "content",
    "createdAt": "created_at"
  },
  "timestampFormat": "auto"
}
```

If the initial manifest transformed an id, reproduce it in the query. For example:

```sql
SELECT 'example-' || id AS message_id,
       session_id AS conversation_id,
       role,
       content,
       created_at
FROM messages
ORDER BY created_at, id
```

Map `fields.messageId` to `message_id`. Do not emit raw `id` when the initial manifest emitted `example-<id>`.

## Validation Rules

1. Test the recipe against the same native records used to build the initial manifest.
2. It must yield at least one complete turn: one user message followed by at least one assistant message.
3. Run it twice and require unique, identical message ids.
4. Compare representative recipe output with the manifest. Require the same message id, conversation id, role, content, and normalized timestamp.
5. Do not save shell commands, executable code, credentials, tokens, or a path to a temporary extraction artifact.
6. Call `save_sync_recipe` and require `syncReady=true`; local preflight alone does not install automatic sync.
7. If persistence returns a schema error, compare the submitted object with this contract. Do not guess new field names, switch formats, or call the connection complete.
8. If one representation cannot be expressed, record the exact mismatch and test the next viable native representation for the same surface.
9. Only after all viable representations fail may you leave automatic sync unconfigured and report the connection as pending. Do not persist a misleading recipe or claim that a custom adapter is required earlier.
