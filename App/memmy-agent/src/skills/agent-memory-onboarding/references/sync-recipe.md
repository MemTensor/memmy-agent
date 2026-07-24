# Automatic Sync Recipe Contract

The first onboarding session must convert its format discovery into one declarative recipe. Memmy validates and stores the recipe, then uses it for every later GUI sync without starting another Agent session.

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

Optional common fields:

- `fields.messageId`: a stable source record id. If omitted for a file recipe, Memmy hashes the relative file path and record position.
- `fields.conversationId`: a stable source conversation id. If omitted for a file recipe, Memmy hashes the relative file path.
- `fields.workspacePath` and `fields.gitRoot`.
- `roleMap`: exact source-role values mapped to `user`, `assistant`, `tool`, or `system`. Standard role names work without a map.

## JSONL

Use `format: "jsonl"` when each non-empty line is one object. If `path` is a directory, set `fileSuffix` so newly created transcript files are discovered recursively.

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

## Validation Rules

1. Test the recipe against the same native records used to build the initial manifest.
2. It must yield at least one complete turn: one user message followed by at least one assistant message.
3. Stable ids must remain identical when the recipe is run repeatedly.
4. Do not save shell commands, executable code, credentials, tokens, or a path to a temporary extraction artifact.
5. If the native container is unsupported or cannot be represented accurately, leave automatic sync unconfigured and report the limitation. Do not persist a misleading recipe.
