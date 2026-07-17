# `memmy-memory raw`

Intent map:
- call an exposed Memory API route without a dedicated command -> `memmy-memory raw`;
- debug request or response shapes -> `memmy-memory raw METHOD /path`.

Use this command when:
- a route exists in the Memory HTTP API but no specialized CLI command exists;
- the user asks to test a specific endpoint path.

API shape:
- supported methods are `GET`, `POST`, and `DELETE`;
- the path may be `/path` or `/api/v1/path`;
- the CLI adds `/api/v1` when the prefix is absent;
- `GET` sends no body.

Do not use this command to:
- replace a dedicated command that already maps to the route;
- bypass service-side validation;
- send destructive requests unless the method and path are explicit.

Command:

```bash
memmy-memory raw <GET|POST|DELETE> <path>
```

Common flags:

- `--body '<json>'`
- `--json '<json-or-path>'`
- `--body-file <path>`

Example:

```bash
memmy-memory raw GET /health
memmy-memory raw POST /worker/run --body '{"limit":20}'
```

Working rules:
- quote paths containing `?` or `&`;
- prefer dedicated commands for normal agent workflows;
- use raw only for explicit debugging endpoints without a dedicated command;
- check the HTTP method before calling a route that can mutate memory.
