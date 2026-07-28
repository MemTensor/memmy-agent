# memmy-agent

The TypeScript agent runtime behind Memmy. It provides the `memmy` CLI, direct
and interactive chat, the channel gateway, and an OpenAI-compatible HTTP API.

## Requirements

- Node.js 22 or later
- npm

## Default Local Ports

| Service                               |                                 Default port |
| ------------------------------------- | -------------------------------------------: |
| Memory HTTP service                   |                                      `18960` |
| Gateway health server                 |                                      `18970` |
| WebUI, WebSocket, and admin HTTP      |                                      `18980` |
| OpenAI-compatible API (`memmy serve`) |                                      `18990` |
| Desktop Vite development server       |                                      `19000` |
| Vite HMR                              |                                      `19010` |
| Desktop local API                     |                                    Ephemeral |
| Composio MCP bridge                   | Same ephemeral port as the desktop local API |

## Installed CLI

After installation, use the `memmy` command:

```bash
memmy --help
memmy --version
```

### Initialize Configuration

Run onboarding once to create the configuration file and workspace:

```bash
memmy onboard
```

The default locations are:

- Configuration: `~/.memmy/config.yaml`
- Workspace: `~/.memmy/workspace`

Override either location with command-line options:

```bash
memmy onboard \
  --config /path/to/config.yaml \
  --workspace /path/to/workspace
```

The same defaults can be overridden with environment variables:

```bash
MEMMY_CONFIG=/path/to/config.yaml memmy status
MEMMY_AGENT_WORKSPACE=/path/to/workspace memmy status
```

Use the interactive wizard to configure models, providers, tools, and API
settings:

```bash
memmy onboard --wizard
```

Onboarding only writes configuration and initializes the workspace. It does not
start the agent, API server, gateway, or Memory service, and it does not make a
model request to validate credentials.

### Inspect Runtime Status

```bash
memmy status
```

The status output includes the active configuration file, workspace, model, and
provider readiness.

### Chat from the Terminal

Running `memmy` without a subcommand starts the interactive TUI:

```bash
memmy
```

The explicit `agent` subcommand provides the same interactive mode:

```bash
memmy agent
```

Reuse a session or select a different configuration and workspace:

```bash
memmy agent --session cli:work
memmy agent \
  --config /path/to/config.yaml \
  --workspace /path/to/workspace
```

Send a single message with `--message`, or pipe it through standard input:

```bash
memmy agent --message "Summarize the current workspace"
echo "Explain this project" | memmy agent
```

### Start the OpenAI-Compatible API

```bash
memmy serve
```

The server listens on `http://127.0.0.1:18990` by default. Override its bind
address, port, or per-request timeout when needed:

```bash
memmy serve --host 0.0.0.0 --port 18990 --timeout 120
```

Available endpoints:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

### Start the Channel Gateway

The gateway starts the configured chat channels and a separate health server:

```bash
memmy gateway
memmy gateway --host 127.0.0.1 --port 18970
```

Inspect channel state, authenticate a channel, or list the built-in channel
plugins:

```bash
memmy channels status
memmy channels login <channel>
memmy plugins list
```

### Configure Models and Providers

After onboarding, edit `~/.memmy/config.yaml`. For example, an
OpenAI-compatible model can be configured as follows:

```yaml
agents:
  defaults:
    model: openai/gpt-4.1

providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
```

Set the referenced environment variable in the current shell:

```bash
export OPENAI_API_KEY="your-api-key"
```

`memmy-agent` resolves `${ENV_NAME}` and `${ENV_NAME:fallback}` placeholders
when it loads the configuration.

OAuth providers support explicit login and logout:

```bash
memmy provider login openai_codex
memmy provider logout openai_codex
```

The configuration CLI currently supports setting the application user ID:

```bash
memmy config set app.userId <user-id>
```

### Command Reference

| Task                             | Command                                                   |
| -------------------------------- | --------------------------------------------------------- |
| Show help                        | `memmy --help`                                            |
| Initialize                       | `memmy onboard`                                           |
| Run the interactive wizard       | `memmy onboard --wizard`                                  |
| Inspect status                   | `memmy status`                                            |
| Start interactive chat           | `memmy`                                                   |
| Send one message                 | `memmy agent --message "..."`                             |
| Start the OpenAI-compatible API  | `memmy serve`                                             |
| Start the channel gateway        | `memmy gateway`                                           |
| Inspect or authenticate channels | `memmy channels status`, `memmy channels login <channel>` |
| List channel plugins             | `memmy plugins list`                                      |
| Authenticate a provider          | `memmy provider login <provider>`                         |
| Log out from a provider          | `memmy provider logout <provider>`                        |
| Set the application user ID      | `memmy config set app.userId <user-id>`                   |

## Source Development

Run package-local commands from this directory:

```bash
cd App/memmy-agent
npm install
```

Build TypeScript into `dist/` and copy the runtime templates and built-in
skills:

```bash
npm run build
```

Use the compiled CLI:

```bash
node dist/main.js --help
node dist/main.js onboard
node dist/main.js onboard --wizard
node dist/main.js
node dist/main.js agent --message "Summarize the current workspace"
node dist/main.js serve
node dist/main.js gateway
```

Run the package checks:

```bash
npm run typecheck
npm test
```
