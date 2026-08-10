
<br>
<div align="center">
  <a href="https://memmy.bot/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
      <img alt="Memmy Logo" src="docs/assets/logo-light.svg" width="50%">
    </picture>
  </a>
</div>
<br>
<br>
<p align="center">
    <a href="https://memmy.bot/docs/"><img src="https://img.shields.io/badge/Docs-Get--Start-006400?labelColor=gray&style=for-the-badge&logo=googledocs&logoColor=white" alt="Docs"></a>
    <a href="https://github.com/MemTensor/memmy-agent/releases"><img src="https://img.shields.io/badge/News-ED8D45?labelColor=gray&style=for-the-badge&logo=applenews&logoColor=white" alt="applenews"></a>
    <a href="https://www.producthunt.com/products/memmy?launch=memmy-agent"><img src="https://img.shields.io/badge/Memmy--Agent-DA552F?labelColor=gray&style=for-the-badge&logo=producthunt&logoColor=white" alt="producthunt"></a>
    <a href="https://discord.gg/zfhKKn52wP"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscord.com%2Fapi%2Fv10%2Finvites%2FzfhKKn52wP%3Fwith_counts%3Dtrue&query=%24.approximate_presence_count&suffix=%20online&label=Discord&color=404EED&labelColor=gray&style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
    <a href="https://x.com/Memmy_ai"><img src="https://img.shields.io/badge/Follow-Memmy-000000?labelColor=gray&style=for-the-badge&logo=x&logoColor=white" alt="X"></a>
  </p>

<div align="center">
  
## Memmy is your personal memory hub — and a dedicated Agent that knows you best.

</div>

<div align="center">

**English** • [简体中文](README.zh-CN.md)

![image](docs/assets/banner-en.png)

</div>

## 🆓 Sign-up for Free Trial

Get Memmy from [Official Website](https://memmy.bot/) or [GitHub Release](https://github.com/MemTensor/memmy-agent/releases).

Sign up to get free tokens. Model routing is automatic — start exploring the full Memory + Agent Runtime with zero config.

> [!TIP]
> **Trial credits:** 
> **Registration grants Agent task trial tokens; the current amount and usage are shown in the app.**
> Once the trial credits run out, you can switch to BYOK and use your own model API.

## Fork Updates

This branch is a second-party modification based on the upstream
[`MemTensor/memmy-agent`](https://github.com/MemTensor/memmy-agent) repository.
The working fork is [`bluewatercg/memmy-agent`](https://github.com/bluewatercg/memmy-agent),
branch `actions/windows-package/remote-memory`.

Changes in this fork that are not part of the original upstream README:

- Added the shared `memmy.agent.v1` lifecycle protocol for external adapters, including Codex, Claude Code, and Pi hook templates.
- Added provenance capture for Memory writes: source agent, adapter id, request id, workspace path, project id, source memory ids, and Git repository / branch / commit where available.
- Added project-scoped Memory isolation so different workspaces are separated while agents in the same project can share context.
- Added Memory governance features: Markdown audit export/import, stable supersession relations, and detailed provenance/supersession fields in read models.
- Added structured session checkpoints for resumable handoff state.
- Scoped panel, retrieval, bundle import/export, worker, and API log views by tenant/project namespace.
- Ignored generated `output/` artifacts and raised the Memory test timeout to reduce load-related flakes.

## What Is Memmy?

Every AI session generates context. Most of it gets thrown away.

Switch agents, close a tab, start a new session, and you're re-introducing yourself from scratch.

Memmy fixes that.

With a unified memory layer shared across Cursor, Claude Code, Codex, OpenClaw 🦞, Hermes Agent and more, your agents build on each other's context instead of starting over. One-shot conversations become a long-term working relationship.

It distills your knowledge, preferences, and project experience into personal memory, and share the same context across every Agents.

Available as a desktop app, CLI, and API. You can use the same long-term memory whatever the ways you like to use. **Build it once, use it everywhere.**

###  Cross-Agent Memory Layer

Memmy provides a unified personal memory layer for all AI Agents.

- **Cross-Agent shared memory** Whether working in Codex, Claude Code, Cursor, or OpenClaw, you can keep using the same context and experience, no need to re-introduce anything again.
- **MemOS-powered memory engine** Automatically collects, understands, and structures your knowledge, preferences, and work experience, distilling scattered conversations and behavior into searchable, reusable long-term memory.
- **Historical context onboarding** Supports importing the history of your existing Agents, turning past conversations and project experience into a continuously growing personal knowledge asset.

### 🕸️ Local Agent Runtime

Memmy provides a complete local Agent runtime environment.

- **A unified experience across entry points** Supports the desktop app, CLI/TUI, and an OpenAI-compatible API, all sharing the same Agents, memory, and configuration.
- **Continuous task collaboration** Start a task from any entry point and seamlessly continue it across different scenarios, unconstrained by a single session.
- **Extensible Agent capabilities** Connect more tools through Skills and MCP, taking the Agent from conversation to real task execution. Memmy also provides managed Chromium browser tools for local page inspection and visual verification.

### 🔬 Tool & Ecosystem Connections

Memmy can connect to your working environment, letting the Agent truly participate in your daily workflows.

- **Connect the tools you use** Supports Telegram, Discord, WeChat, Feishu, and DingTalk, plus productivity tools like GitHub, Gmail, Notion, Slack, and Jira.
- **An open tool ecosystem** Supports MCP and custom Skills, extending capabilities such as file handling, shell, web, image generation, and task automation.
- **Flexible model configuration** Configure reasoning, Embedding, memory processing, speech, and image generation models as needed, compatible with mainstream model services.

### 🔐 Local-First — Your Data Belongs to You

Memmy is designed to guarantee your control over your personal data and memory.

- **Local-first architecture** Memory, configuration, and app state are stored on your machine by default; no data needs to be uploaded to the cloud.
- **Secure access control** Local services provide controlled access mechanisms, ensuring only authorized sources can invoke memory capabilities.
- **Real memory, no hallucinations** When the memory service is unavailable, Memmy reports the error explicitly instead of returning nonexistent "fake memories".

## Build Context in Minutes, Not from Scratch

After installing Memmy, it can automatically scan the history of your existing AI Agents. Within minutes, the project context, work habits, and preferences you have accumulated over the past months are converted into personal long-term memory, along with a personalized "First Meeting Report".

Now supported: Cursor, Claude Code, Codex, OpenCode, OpenClaw, Hermes Agent.

[See the full support list](https://memmy.bot/docs/memory/sources)

## One Agent Runtime, Multiple Entry Points

Memmy is not just a chat interface — it is an AI Agent Runtime that runs locally. It unifies long-term memory, Agent execution, and tool connections in a single runtime environment, serving different scenarios through different entry points:

|                      | Role                               | Core Capabilities                                                                 |
| -------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| 🧠 Memory Layer      | Store and manage long-term context | Cross-Agent memory, history import, knowledge distillation, intelligent retrieval |
| 🤖 Agent Runtime     | Drive Agents to execute tasks      | Reasoning, task orchestration, tool calls, MCP, Skills                            |
| 🔌 Integration Layer | Connect external ecosystems        | Messaging channels, third-party tools, OpenAI-compatible API                      |
| 🖥️ User Interface  | Provide entry points               | Desktop App, CLI/TUI, Web API                                                     |

### System Architecture

![Memmy System Architecture](docs/assets/memmy-architecture-en.png)

## Memmy vs. Personal AI Agents

Compared with "personal AI Agents" like Hermes and OpenClaw, what sets Memmy apart is not "yet another assistant that chats and runs errands for you" — it is a **memory foundation shared across Agents**: it remembers you first, then builds a general-purpose Agent on top of that.

| Capability                                                   | Memmy                             | Hermes            | OpenClaw              |
| ------------------------------------------------------------ | --------------------------------- | ----------------- | --------------------- |
| Product positioning                                          | Memory foundation + general Agent | Personal AI Agent | Personal AI assistant |
| Local-first, data stays on your machine                      | ✅                                | ⚠️              | ✅                    |
| One memory shared across Agents                              | ✅                                | 🚫                | 🚫                    |
| Takes over external Agent history (Cursor/Codex/Claude Code) | ✅                                | 🚫                | 🚫                    |
| Installs memory Skills for external Agents                   | ✅                                | 🚫                | 🚫                    |
| Structured memory engine (MemOS hybrid retrieval)            | ✅                                | ⚠️              | ⚠️                  |
| Multi-channel reach (Telegram / Discord / iMessage…)        | ✅                                | ✅                | ✅                    |
| Voice messaging                                              | ✅                                | ⚠️              | ✅                    |
| Multi-model / BYOK                                           | ✅                                | ✅                | ✅                    |

> ✅ Native support ｜ ⚠️ Partial / requires setup ｜ 🚫 Not supported

> The comparison is based on each product's public positioning (as of this writing), not an item-by-item benchmark; corrections are welcome.

## Quick Start

### Option 1: Desktop App

1. Launch the Memmy desktop app and choose **Account mode** or **API Key mode**.
2. In API Key mode, configure the primary model and pass a connection test; optionally configure Embedding, ASR, image generation, memory summary, and skill evolution models.
3. Enter the main workbench and send your first task.
4. Open "Tools" to connect messaging channels or third-party tools; open "Memory" to scan Agent history sources.

> **Account mode free credits**: signing in grants Agent task trial tokens, so you can get running without your own API Key. The current amount and usage are shown in the app. Once used up or expired, switch to API Key (BYOK) mode and continue with your own quota.

### Option 2: `memmy` CLI (Agent Runtime)

```bash
memmy onboard                              # Initialize ~/.memmy/config.yaml and the workspace
memmy status                               # Check config, workspace, model, and provider status
memmy agent --message "Hi, introduce the current workspace"  # Single-turn message
memmy                                      # Run without a subcommand to enter interactive chat (TUI)
memmy serve                                # Start the OpenAI-compatible API (:18990)
```

Minimal BYOK configuration (`~/.memmy/config.yaml`):

```yaml
agents:
  defaults:
    model: openai/gpt-4.1
    provider: openai
    timezone: Asia/Shanghai
providers:
  openai:
    apiKey: ${OPENAI_API_KEY}   # Supports ${ENV_NAME}-style environment variable references
tools:
  browser:
    enabled: true
    maxSessions: 4
    idleTimeoutS: 900
```

The desktop app and `scripts/dev-start.sh` prepare the matching managed Chromium build before the Agent Gateway starts. Agent requests never download a browser; when the managed executable is unavailable, browser tools are omitted while other Agent features continue to work.

### Option 3: `memmy-memory` CLI (memory access for external Agents / scripts)

```bash
memmy-memory init                          # Write the Memory config and install Skills for each Agent as needed
memmy-memory health
memmy-memory doctor
memmy-memory namespace current
memmy-memory stats --workspace
memmy-memory search "memory policies in this project"
memmy-memory add "a piece of knowledge worth saving"
memmy-memory get <id>
```

Connects to `http://127.0.0.1:18960` by default; use `--url`, `--token`, `--config`, `--source`, and `--user-id` to specify the target service, authentication, source, and user namespace.

### Docker Memory Service

For a persistent standalone Memory service, use the root `compose.yaml` and
`Memory/Dockerfile`. It uses Node 24 Debian (not Alpine) for the native
`better-sqlite3`, `sqlite-vec`, and ONNX dependencies, persists SQLite and the
Hugging Face model cache in named volumes, and requires a strong
`MEMMY_MEMORY_TOKEN`. The default host binding is `127.0.0.1:18960`.

When Docker Desktop runs on the same Windows machine, point the desktop config
at `http://127.0.0.1:18960` and set `memmyMemory.storage.runtime` to `remote`.
The desktop app then performs health checks only; it does not stop or restart
the Docker container. Keep LAN deployments behind Caddy or Nginx HTTPS rather
than exposing port 18960 directly.

## Core Concepts

- **Workspace** — the Agent's working directory, default `~/.memmy/workspace`; syncs templates, built-in skills, and memory files.
- **Config** — the main configuration, default `~/.memmy/config.yaml` (overridable via `MEMMY_CONFIG` / `--config`), covering models, providers, tools, MCP, gateway, Memory, and workspace settings.
- **Agent Runtime** — the core of task execution: model calls, message loop, tool registration, MCP, sessions, long tasks, skill loading, auto-compaction, and memory hooks.
- **Memory Service** — the local-first memory foundation, default `http://127.0.0.1:18960`, providing session, turn, search, write, panel, and analytics APIs; every entry point reads and writes the same memory, so tasks and context carry over across Agents.
- **Local Backend** — the backend for the desktop local API (Fastify + SQLite app state), handling accounts, configuration, integrations, source scanning, and Skill writing.
- **Agent Source** — an adapter that collects historical context from external Agents; each source has history-reading logic and an optional Skill install target.

## Build from Source

### One-Command Start

Get running in three steps:

```bash
git clone https://github.com/MemTensor/memmy-agent.git && cd memmy-agent
cp .env.example .env         # Cloud address is pre-filled — works out of the box
bash scripts/dev-start.sh    # Install deps → build → start the full stack
```

`scripts/dev-start.sh` does it all in one command: installs dependencies, builds Memory and memmy-agent, installs the `memmy` / `memmy-memory` CLIs, and starts the full stack (Memory, Agent API, Gateway, frontend, desktop backend). Once the desktop app opens, finish account sign-in or BYOK setup and you're ready.

> `MEMMY_CLOUD_SERVICE` in `.env` defaults to `https://memmy-api.memtensor.cn`, so copying it connects you to the official cloud — no self-hosted backend or API key required. On Windows, run it in Git Bash.

### Requirements

- Node.js `>=22`
- npm

### Common Commands

At the repository root:

```bash
npm install

npm run dev:desktop     # Start the desktop frontend Vite server and the Electron desktop shell together
npm run build           # Build Memory and all workspaces
npm run lint            # lint
npm run typecheck       # Type checking
npm run test            # Run Memory and workspace tests
```

Developing Memory standalone:

```bash
npm run memory:serve:dev -- \
  --host 127.0.0.1 --port 18960 \
  --db ~/.memmy/memory-service/memory.sqlite \
  --config ~/.memmy/config.yaml
```

Running `memmy-agent` from source:

```bash
cd App/memmy-agent
npm install
npm run build
node dist/main.js --help
```

Packaging:

```bash
npm run package:mac        # macOS DMG
npm run package:win:x64    # Windows x64
```

## Roadmap

Memmy is building **personal memory infrastructure**, and its scope goes beyond coding Agents:

- **More memory sources** — expanding from AI conversations to browser activity, local documents, and eventually more devices and hardware.
- **Team collaboration** — planned Agent-to-Agent collaboration, letting team members' AI assistants share knowledge under privacy protection.

## Acknowledgements

Memmy stands on the shoulders of a group of excellent open-source projects, and we are deeply grateful.

- **[OpenClaw](https://github.com/openclaw/openclaw)** — a pioneer of open-source personal AI assistants; its exploration of multi-platform messaging channels directly inspired Memmy's channel connection design.
- **[hermes-agent](https://github.com/NousResearch/hermes-agent)** — the self-evolving Agent built by Nous Research; its practice in persistent memory and skill self-learning showed us that an Agent can "understand you better the more you use it".
- **[nanobot](https://github.com/HKUDS/nanobot)** — grown from a minimal prototype into a fully featured open-source Agent platform; its engineering practice around the Agent loop and MCP integration provided important references for Memmy's core design.

The point of open source is to let good ideas flow, and we hope Memmy becomes part of that river.

## Contributors

Thanks to every contributor who makes Memmy better ❤️
