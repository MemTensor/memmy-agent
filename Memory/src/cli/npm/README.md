# @memtensor/memmy-memory-cli

Standalone npm package for the Memmy Memory CLI.

## Install

Node.js 20 or later is required.

```bash
npm install -g @memtensor/memmy-memory-cli
```

During npm installation, the package runs `node scripts/postinstall.js`.
The npm package is only a Node launcher shell. It downloads the platform-specific
`memmy-memory` binary archive for the current package version and extracts it to
the package `bin/` directory.

Supported targets:

- `darwin-arm64`
- `darwin-x64`
- `linux-arm64`
- `linux-x64`
- `windows-arm64`
- `windows-x64`

Environment variables:

- `MEMMY_MEMORY_INSTALL_SKIP_DOWNLOAD=1` skips the binary download.
- `MEMMY_MEMORY_BINARY_URL=<url>` uses a custom archive URL.

Default binary URL:

```text
https://github.com/MemTensor/memmy-agent/releases/download/memory-v{version}/memmy-memory-{version}-{target}.tar.gz
```

For example, a macOS arm64 archive name is:

```text
memmy-memory-{version}-darwin-arm64.tar.gz
```

If download is skipped, running `memmy-memory` will fail until the binary exists
at `bin/memmy-memory` or `bin/memmy-memory.exe` inside the installed package.

## Setup

Initialize Memory CLI config:

```bash
memmy-memory init
```

`init` writes the Memory endpoint and optional local SQLite path to the Memmy
config file. Install the standalone service without changing an Agent with:

```bash
memmy-memory install --service-only
```

Install the service and adapters for detected Agents, or upgrade the active
runtime and its installed adapters, with:

```bash
memmy-memory install
memmy-memory install --agents openclaw,hermes
memmy-memory upgrade
memmy-memory upgrade --version 2.1.0
```

By default, `init` installs agent-side files for each supported agent root it
finds and skips agents that are not installed. Use `--agent` to require and
install only selected agents, or `--skip-agent-skills` when only the Memory
configuration should be written:

```bash
memmy-memory init --agent codex
memmy-memory init --agent codex,cursor,claude
memmy-memory init --skip-agent-skills
```

Supported agents:

- `codex`
- `cursor`
- `claude`
- `opencode`
- `openclaw`
- `hermes`
- `dsh`
- `workbuddy`
- `pi`
- `qwenwork`

## Commands

```bash
memmy-memory --help
memmy-memory --version
memmy-memory init
memmy-memory health
memmy-memory reload-config
memmy-memory serve
memmy-memory session open --source <agent-source>
memmy-memory turn start --source <agent-source> --session-id <sessionId> --query "<query>"
memmy-memory turn complete <turnId> --source <agent-source> --session-id <sessionId> --query "<query>" --answer "<answer>"
memmy-memory search "<query>" --source <agent-source>
memmy-memory search "<query>" --source <agent-source> --verbose
memmy-memory add "<content>" --source <agent-source>
memmy-memory get <id>
memmy-memory get <id> --verbose
memmy-memory delete <id>
memmy-memory raw GET /panel/overview
```

`memmy-memory install` downloads a verified, versioned Memory runtime, registers
the user-level background service, starts it, and verifies `/api/v1/health`.
The development-only `--source-path` option retains the source-tree symlink flow.

`memmy-memory get <id>` prints compact agent-readable memory content by default.
Use `--verbose` when debugging the full JSON detail payload.

By default the CLI talks to `http://127.0.0.1:18960`.
Use `--url <url>`, `--token <token>`, or `--config <path>` to target a specific
Memory HTTP service or config file.
Use `--user-id <id>` or `--user_id <id>` when a single command must target a
specific Memory namespace user. If omitted, the CLI uses the active Memory
profile's user ID and then the application user ID from the configured Memmy
configuration. Configure the application default with
`memmy config set app.userId <user_id>`.
Use `--source <agent-source>` to identify the calling agent/source, such as
`codex`, `cursor`, or `openclaw`.
