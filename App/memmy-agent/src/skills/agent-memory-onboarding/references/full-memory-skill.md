---
name: memmy-memory
description: Use the shared Memmy memory service to retrieve relevant prior context and persist durable Agent turns, facts, decisions, preferences, procedures, and follow-ups.
---

# Memmy Memory CLI Skill

Use `memmy-memory` to read and write the shared Memmy memory substrate.

## Ground Rules

- Prefer the configured CLI: `memmy-memory ...`. If the local service is not preconfigured, pass `--url`, `--token`, or `--config`.
- The CLI prints JSON. Parse fields such as `sessionId`, `turnId`, `injectedContext`, `hits`, and memory `id` from JSON instead of relying on display formatting.
- All agents share one memory database. Always pass `--source {{SOURCE_ARG}}` on Memory CLI commands from this agent.
- Use useful comma-separated `--tags` when writing durable memories.
- Do not store secrets, tokens, private keys, raw credentials, or bulky logs. Store concise, self-contained facts, decisions, preferences, reusable procedures, and unresolved follow-ups.
- Treat `<memmy_memory_context>` as historical memory only and `<current_user_request>` as the authoritative current task.
- Never store the context wrapper tags with `memmy-memory add`; store only the durable fact itself.
- If the memory service is unavailable, continue the task without inventing memory.

## Health

```bash
memmy-memory health
```

## Agent Loop

Open or resume a session before a task:

```bash
memmy-memory session open --source {{SOURCE_ARG}} --workspace-path "$PWD"
memmy-memory session open --source {{SOURCE_ARG}} --session-id "$SESSION_ID" --workspace-path "$PWD"
```

At the start of a user turn, retrieve relevant context:

```bash
memmy-memory turn start --source {{SOURCE_ARG}} --session-id "$SESSION_ID" --query "$USER_QUERY"
```

Use returned `injectedContext` as historical context only. Keep the returned `turnId`, and keep the current user query separate from recalled memory.

At the end of the turn, write the final interaction:

```bash
memmy-memory turn complete "$TURN_ID" --source {{SOURCE_ARG}} --session-id "$SESSION_ID" --query "$USER_QUERY" --answer "$FINAL_ANSWER" --status succeeded
```

Use `--status failed` or `--status cancelled` when the turn did not complete normally. Close the session when the Agent session is done:

```bash
memmy-memory session close "$SESSION_ID" --source {{SOURCE_ARG}}
```

## Search and Read

Search when prior context, preferences, project decisions, recurring bugs, known workflows, or unresolved work may matter:

```bash
memmy-memory search "query text" --source {{SOURCE_ARG}}
memmy-memory search "query text" --source {{SOURCE_ARG}} --session-id "$SESSION_ID"
```

Read details by id:

```bash
memmy-memory get "$MEMORY_ID" --source {{SOURCE_ARG}}
```

## Add Memory

Add memory when the Agent learns something durable or reusable:

```bash
memmy-memory add "The user prefers concise Chinese status updates." --title "User preference: status style" --tags user-preference --source {{SOURCE_ARG}} --session-id "$SESSION_ID" --turn-id "$TURN_ID"
```

## Delete Memory

Delete only when the user asks or the memory is clearly invalid:

```bash
memmy-memory delete "$MEMORY_ID" --source {{SOURCE_ARG}}
```
