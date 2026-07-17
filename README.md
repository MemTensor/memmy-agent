# memmy-agent

![image](docs/assets/banner-en.png)

**Memmy is your personal memory hub — and a dedicated Agent that knows you best.**

One unified memory layer for every AI you use. Evolving together through collaboration.

It distills your knowledge, preferences, and project experience into personal memory, and share the same context across every Agents — Cursor, Claude Code, Codex, OpenClaw 🦞, and more.

Available as a desktop app, CLI, and API. You can use the same long-term memory whatever the ways you like to use. **Build it once, use it everywhere.**

[Docs](https://memmy.bot/docs/) • [Quick Start](#quick-start) • [Core Concepts](#core-concepts) • [Build from Source](#build-from-source)

[简体中文](README.zh-CN.md) • **English**

## 🚀 Get Started with Memmy

Get Memmy from [Official Website](https://memmy.bot/) and [GitHub](https://github.com/MemTensor/memmy-agent/releases).

Sign up to get free tokens. Model routing is automatic — start exploring the full Memory + Agent Runtime with zero config.

> **Trial credits:**

- **Registration grants 30,000,000 tokens; you can check your remaining balance and usage inside the app.**

Once the trial credits run out, you can switch to BYOK and use your own model API.

## What Is Memmy?

Every AI session generates context. Most of it gets thrown away.

Switch agents, close a tab, start a new session, and you're re-introducing yourself from scratch.

Memmy fixes that.

With a unified memory layer shared across Cursor, Claude Code, Codex, and more, your agents build on each other's context instead of starting over. One-shot conversations become a long-term working relationship.

### 🧠 Cross-Agent Memory Layer

Memmy provides a unified personal memory layer for all AI Agents.

- **Cross-Agent shared memory** Whether working in Codex, Claude Code, Cursor, or OpenClaw, you can keep using the same context and experience, no need to re-introduce anything again.
- **MemOS-powered memory engine** Automatically collects, understands, and structures your knowledge, preferences, and work experience, distilling scattered conversations and behavior into searchable, reusable long-term memory.
- **Historical context onboarding** Supports importing the history of your existing Agents, turning past conversations and project experience into a continuously growing personal knowledge asset.

### 🕸️ Local Agent Runtime

Memmy provides a complete local Agent runtime environment.

- **A unified experience across entry points** Supports the desktop app, CLI/TUI, and an OpenAI-compatible API, all sharing the same Agents, memory, and configuration.
- **Continuous task collaboration** Start a task from any entry point and seamlessly continue it across different scenarios, unconstrained by a single session.
- **Extensible Agent capabilities** Connect more tools through Skills and MCP, taking the Agent from conversation to real task execution.

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

See the full support list → link to docs/import-agent-memory.md

## One Agent Runtime, Multiple Entry Points

Memmy is not just a chat interface — it is an AI Agent Runtime that runs locally. It unifies long-term memory, Agent execution, and tool connections in a single runtime environment, serving different scenarios through different entry points:

|                      | Role                               | Core Capabilities                                                                 |
| -------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| 🧠 Memory Layer      | Store and manage long-term context | Cross-Agent memory, history import, knowledge distillation, intelligent retrieval |
| 🤖 Agent Runtime     | Drive Agents to execute tasks      | Reasoning, task orchestration, tool calls, MCP, Skills                            |
| 🔌 Integration Layer | Connect external ecosystems        | Messaging channels, third-party tools, OpenAI-compatible API                      |
| 🖥️ User Interface  | Provide entry points               | Desktop App, CLI/TUI, Web API                                                     |

### Repository Structure

Memmy uses an npm workspaces monorepo architecture:

Memmy System Architecture

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

> **Account mode free credits**: signing in grants **30,000,000 (30 million) trial tokens**, so you can get running without your own API Key. You can check used / total / remaining amounts and the expiry date anytime in the app. Trial tokens use model `(TBD)`, valid for `(TBD)`. Once used up or expired, switch to API Key (BYOK) mode and continue with your own quota.

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
```

### Option 3: `memmy-memory` CLI (memory access for external Agents / scripts)

```bash
memmy-memory init                          # Write the Memory config and install Skills for each Agent as needed
memmy-memory health
memmy-memory search "memory policies in this project"
memmy-memory add "a piece of knowledge worth saving"
memmy-memory get <id>
```

Connects to `http://127.0.0.1:18960\` by default; use `--url`, `--token`, `--config`, `--source`, and `--user-id` to specify the target service, authentication, source, and user namespace.

## Core Concepts

- **Workspace** — the Agent's working directory, default `~/.memmy/workspace`; syncs templates, built-in skills, and memory files.
- **Config** — the main configuration, default `~/.memmy/config.yaml` (overridable via `MEMMY_CONFIG` / `--config`), covering models, providers, tools, MCP, gateway, Memory, and workspace settings.
- **Agent Runtime** — the core of task execution: model calls, message loop, tool registration, MCP, sessions, long tasks, skill loading, auto-compaction, and memory hooks.
- **Memory Service** — the local-first memory foundation, default `http://127.0.0.1:18960\`, providing session, turn, search, write, panel, and analytics APIs; every entry point reads and writes the same memory, so tasks and context carry over across Agents.
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
