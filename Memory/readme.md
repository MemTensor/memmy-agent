# Memory

`Memory` is Memmy's local-first memory service. It stores data in SQLite by
default and exposes memory operations through an HTTP service and the
`memmy-memory` CLI.

## Requirements

- Node.js 20 or later
- npm

## Development

Run the main workflows from the repository root:

```bash
npm run memory:serve:dev
npm run memory:test
npm run memory:lint
npm run memory:build
```

The development server entry point is `Memory/src/server/index.ts`. After a
build, the server entry point is `Memory/dist/src/server/index.js`, and it can be
started with:

```bash
npm run memory:serve
```

The service listens on `http://127.0.0.1:18960` by default. Override its
settings after `--`:

```bash
npm run memory:serve:dev -- \
  --host 127.0.0.1 \
  --port 18960 \
  --db ~/.memmy/memory-service/memory.sqlite \
  --config ~/.memmy/config.yaml
```

The built-in Memory panel is available at `/` and `/viewer`.

## Configuration

Unless `--config` is provided, the service checks these locations in order:

```text
MEMMY_CONFIG
~/.memmy/config.yaml
```

A minimal local configuration is:

```yaml
memmyMemory:
  version: 1
  activeProfile: byok
  storage:
    mode: local
    backend: sqlite
    sqlitePath: ~/.memmy/memory-service/memory.sqlite
    endpoint: http://127.0.0.1:18960
    token: local-token
  profiles:
    byok:
      embedding:
        provider: local
```

The `MEMMY_MEMORY_HOST`, `MEMMY_MEMORY_PORT`, and `MEMMY_MEMORY_DB`
environment variables override the corresponding server settings. The
`MEMORY_SERVICE_*` aliases are also accepted.

OpenAI-compatible embedding inputs are tokenized and split automatically with
a conservative 7,500-token per-input budget. Set
`memmyMemory.embedding.maxInputTokens` or
`MEMMY_EMBEDDING_MAX_INPUT_TOKENS` to use a smaller budget for a provider with
a shorter context window.

All remote summary-model calls (capture, reflection, long-turn splitting,
reward scoring, retrieval filtering, and turn routing) are clipped before
requesting when their estimated input would exceed an 8,192-token context;
the requested output budget and a 512-token provider overhead margin are
reserved first.

When `storage.token`, `MEMMY_MEMORY_TOKEN`, or `MEMORY_SERVICE_TOKEN` is set,
all HTTP routes except `GET /api/v1/health` require that token as a bearer token
or `x-api-key`.

## CLI

Run the CLI directly from source inside the `Memory/` directory:

```bash
npx tsx src/cli/index.ts health --url http://127.0.0.1:18960
```

After building, use the compiled entry point:

```bash
node dist/src/cli/index.js health --url http://127.0.0.1:18960
```

Available commands:

```text
memmy-memory init
memmy-memory install
memmy-memory serve
memmy-memory health
memmy-memory reload-config
memmy-memory session open
memmy-memory session close <sessionId>
memmy-memory turn start
memmy-memory turn complete <turnId>
memmy-memory search <query>
memmy-memory add <content>
memmy-memory get <id>
memmy-memory get <id> --verbose
memmy-memory delete <id>
memmy-memory raw <method> <path>
```

Use `--url`, `--token`, `--user-id`, `--source`, or `--config` to select the
target service and namespace for an individual command.

`memmy-memory get` prints compact, agent-readable content by default. Add
`--verbose` to inspect the complete JSON detail response.

`memmy-memory serve` does not start the local HTTP service. It only reports how
to connect this standalone CLI to an external Memory service.

For npm package installation and agent-skill setup, see
[`src/cli/npm/README.md`](src/cli/npm/README.md). For the integration-test
layout, see [`tests/service/README.md`](tests/service/README.md).
