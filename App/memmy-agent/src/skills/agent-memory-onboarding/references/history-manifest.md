# History Manifest Contract

Create UTF-8 JSONL with one object per source message:

```json
{"messageId":"stable-id","conversationId":"stable-conversation-id","role":"user","content":"text","createdAt":"2026-07-01T10:00:00.000Z","workspacePath":"/optional/project","gitRoot":null,"rawMeta":{}}
```

Required fields:

- `messageId`: stable across repeat scans. Prefer the source record id. Otherwise hash immutable source coordinates such as canonical file path plus record offset or database primary key. Never use a random id.
- `conversationId`: stable source conversation or session id.
- `role`: exactly `user`, `assistant`, `tool`, or `system`.
- `content`: non-empty plain text or Markdown.
- `createdAt`: valid ISO-8601 timestamp.

Optional fields:

- `workspacePath`: project/workspace path when present in the source.
- `gitRoot`: repository root when known.
- `rawMeta`: small non-secret provenance such as the source table, relative transcript path, tool name, or tool call id.

Rules:

1. Preserve the real chronological order. The import tool sorts again but cannot repair wrong timestamps.
2. A complete memory turn starts with a user message and contains at least one assistant message before the next user message.
3. Exclude incomplete final turns, hidden chain-of-thought, binary payloads, image blobs, credentials, environment dumps, and unrelated telemetry.
4. Preserve useful tool results only when they explain the assistant answer. Drop bulky tool output.
5. Do not summarize during extraction. L1 memory stores the original user/assistant turn; later processing creates higher-level summaries.
6. For an incremental scan, it is safe to include records after the supplied boundary even if some were imported during the initial 500-turn window. Stable `messageId` values make that overlap idempotent.
7. Keep extraction code temporary in the Memmy workspace. Do not modify the source Agent's history database.
8. For an initial scan, never emit an empty manifest or invent an epoch boundary. Leave the scan pending until at least one complete turn is verified.
9. Provenance must identify the active product surface as well as the container. An empty database from a background daemon does not prove that a desktop app's remote web-chat surface has no history.
