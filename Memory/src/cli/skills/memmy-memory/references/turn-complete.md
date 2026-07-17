# `memmy-memory turn complete`

Intent map:
- finish a turn and persist the interaction -> `memmy-memory turn complete <turnId>`;
- record a failed or cancelled turn outcome -> `memmy-memory turn complete <turnId> --status failed|cancelled`;
- connect the final answer to the session and query -> `memmy-memory turn complete <turnId> --session-id <id> --query <text> --answer <text>`.

Use this command when:
- the agent has produced the final answer for the turn;
- the turn was started with `memmy-memory turn start`;
- the outcome should be available for future memory context and evolution.

API shape:
- endpoint: `POST /turns/:turnId/complete`;
- `turnId` is sent in the URL path;
- the CLI sends a JSON body;
- `sessionId`, `query`, and `answer` are required;
- `status` is optional and normalized to `succeeded`, `failed`, or `cancelled`.
- `source` should be passed as `--source <agent-source>` by installed agent skills.

Never store:
- secrets, credentials, access tokens, private keys, or passwords;
- unconfirmed speculation as if it were fact;
- sensitive personal data that is not necessary for durable memory;
- verbose logs when a concise result is enough.

Command:

```bash
memmy-memory turn complete <turnId> --source <agent-source> --session-id <sessionId> --query "<query>" --answer "<answer>"
```

Common flags:

- `--turn-id <id>`
- `--session-id <id>`
- `--query <text>`
- `--answer <text>`
- `--status <succeeded|failed|cancelled>`
- `--source <agent-source>`

Example:

```bash
memmy-memory turn complete turn_123 --source codex --session-id se_123 --query "fix failing tests" --answer "fixed the failing fixture" --status succeeded
```

Working rules:
- call this after the final answer text is known;
- keep `query` faithful to the user request or task;
- keep `answer` accurate to the actual result;
- use `--status failed` when the task failed but the result is still useful to remember;
- save returned memory ids when later inspection or deletion may be needed.
