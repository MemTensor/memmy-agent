# `memmy-memory add`

Intent map:
- store a durable fact, preference, decision, procedure, or project note -> `memmy-memory add`;
- manually create a memory item outside a turn lifecycle -> `memmy-memory add`;
- attach a manually added memory to a known session or turn -> `memmy-memory add --session-id <id> --turn-id <id>`.

Use this command when:
- the user explicitly asks the agent to remember something durable;
- a project decision, user preference, reusable procedure, or stable fact should be persisted;
- the memory should be added directly instead of waiting for `turn complete`.

API shape:
- endpoint: `POST /memory/add`;
- the CLI sends a JSON body;
- `content` is required;
- `layer`, `title`, `tags`, `source`, `sessionId`, and `turnId` are optional;
- installed agent skills should always pass `--source <agent-source>`;
- `--tags` is parsed as a comma-separated string array.

Never store:
- secrets, credentials, access tokens, private keys, or passwords;
- `<memmy_memory_context>` or `<current_user_request>` protocol tags;
- speculative conclusions the user did not confirm;
- temporary execution state that will not matter after the current task;
- sensitive personal data unless the user explicitly asks and it is safe to retain.

Command:

```bash
memmy-memory add "<content>" --source <agent-source>
```

Common flags:

- `--content <text>`
- `--title <text>`
- `--tags <tag1,tag2>`
- `--source <text>`
- `--session-id <id>`
- `--turn-id <id>`

Example:

```bash
memmy-memory add "this project stores local memory in sqlite" --source codex --tags project,sqlite
```

Working rules:
- prefer clear, complete memory content over keyword fragments;
- pass `--source` consistently so source attribution matches the calling agent;
- include `--session-id` or `--turn-id` when the source context is known;
- if input contains `<current_user_request>...</current_user_request>`, store only the inner durable fact and not the tag;
- keep manually added memories factual and durable.
