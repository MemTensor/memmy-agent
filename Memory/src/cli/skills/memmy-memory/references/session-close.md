# `memmy-memory session close`

Intent map:
- close an active Memory session -> `memmy-memory session close <sessionId>`;
- end a completed agent task lifecycle -> `memmy-memory session close <sessionId>`;
- close by option instead of positional id -> `memmy-memory session close --session-id <id>`.

Use this command when:
- the session id is known;
- the task or conversation lifecycle is finished;
- the user explicitly asks to close a session.

API shape:
- endpoint: `POST /sessions/:sessionId/close`;
- `sessionId` is sent in the URL path;
- the CLI accepts `sessionId` as `<sessionId>` or `--session-id <id>`;
- no request body is required.

Do not use this command to:
- create or resume a session;
- close a session that may still be used by the current task;
- guess or fabricate a session id.

Command:

```bash
memmy-memory session close <sessionId>
```

Common flags:

- `--session-id <id>`

Example:

```bash
memmy-memory session close se_123
```

Working rules:
- keep the session id available if close fails;
- close sessions deliberately, not as a default cleanup step;
- use the service response to confirm `status=closed`.
