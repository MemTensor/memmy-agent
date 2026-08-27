# `memmy-memory session open`

Intent map:
- create a new Memory session -> `memmy-memory session open`;
- resume a known session -> `memmy-memory session open --session-id <id>`;
- bind a session to the current workspace -> `memmy-memory session open --workspace-path <path>`.

Use this command when:
- a conversation, task, or agent workflow begins;
- the agent needs a `sessionId` for `turn start`, `turn complete`, or scoped search;
- the host provides a stable external session id.

API shape:
- endpoint: `POST /sessions/open`;
- the CLI sends a JSON body;
- `sessionId` is optional;
- `workspacePath` is optional;
- `source` is optional in the request body but should be passed as `--source <agent-source>` by installed agent skills;
- when `sessionId` is omitted, the service generates one.

Do not use this command to:
- close a session;
- start or complete a turn;
- create multiple sessions for one continuous task without a reason.

Command:

```bash
memmy-memory session open --source <agent-source>
```

Common flags:

- `--session-id <id>`
- `--workspace-path <path>`
- `--source <agent-source>`

Example:

```bash
memmy-memory session open --source codex --session-id thread_123 --workspace-path "$PWD"
```

Working rules:
- save the returned `sessionId` for later turn commands;
- reuse a stable `sessionId` when the task belongs to the same conversation;
- inspect `resumed` to know whether the session was newly opened or reused.
