# `memmy-memory health`

Intent map:
- check whether the Memory service is reachable -> `memmy-memory health`;
- verify storage readiness before memory operations -> `memmy-memory health`.

Use this command when:
- service state is unknown;
- a previous memory command failed due to connection or readiness issues;
- the agent or user just started the local Memory service.

API shape:
- endpoint: `GET /health`;
- no command-specific parameters are required;
- no request body is sent;
- the response includes service, storage, model, capability, and server time fields.

Do not use this command to:
- retrieve memory content;
- verify that a previous write succeeded;
- start the service.

Command:

```bash
memmy-memory health
```

Common flags:

- None.

Example:

```bash
memmy-memory health
```

Working rules:
- if this command fails, do not assume memory was read or written;
- if `storage.ready` is false, treat durable memory operations as unavailable;
- when the service endpoint is configured, verify readiness before memory operations.
