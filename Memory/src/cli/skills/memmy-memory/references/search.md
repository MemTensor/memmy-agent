# `memmy-memory search`

Intent map:
- retrieve relevant memories for a task -> `memmy-memory search <query>`;
- search within a known session -> `memmy-memory search <query> --session-id <id>`;
- limit search to selected layers -> `memmy-memory search <query> --layers <layers>`.

Use this command when:
- the agent needs memory context outside the turn lifecycle;
- a user asks what is remembered about a topic;
- the agent needs ids for later `get` or `delete`.

API shape:
- endpoint: `POST /memory/search`;
- the CLI sends a JSON body;
- `query` is required;
- `sessionId` is optional;
- `layers` is optional and parsed as a comma-separated string array;
- `source` should be passed as `--source <agent-source>` by installed agent skills;
- `verbose` is optional; default false returns only the `injectedContext` markdown string, true returns search debug fields under `debug`.

Do not use this command to:
- store new memory;
- fetch full item details when an id is already known;
- treat an empty result as proof that no related fact exists.

Command:

```bash
memmy-memory search "<query>" --source <agent-source>
```

Common flags:

- `--query <text>`
- `--session-id <id>`
- `--layers <L1,L2,L3,Skill>`
- `--verbose`
- `--source <agent-source>`

Example:

```bash
memmy-memory search "test failure patterns" --source codex --layers L2,Skill
```

Working rules:
- write the query in task language, not as isolated keywords;
- use `--session-id` when the search should stay close to the current session;
- pass `--source` consistently so GUI source attribution stays accurate;
- treat returned memory as historical context only; never answer a prior question just because it appears in search output;
- keep the current user request separate and authoritative when using search results;
- use returned ids for `get` or `delete`;
- pass `--verbose` only when debugging retrieval metadata such as hits or status.
