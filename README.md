<br>
<div align="center">
  <a href="https://memmy.bot/">
    <picture>
      <img alt="Memmy Logo" src="docs/assets/banner-en.png">
    </picture>
  </a>
</div>
<br>
<br>
<p align="center">
    <a href="https://memmy.bot/docs/"><img src="https://img.shields.io/badge/Docs-Get--Start-006400?labelColor=gray&style=for-the-badge&logo=googledocs&logoColor=white" alt="Docs"></a>
    <a href="https://github.com/MemTensor/memmy-agent/releases"><img src="https://img.shields.io/badge/Download-ED8D45?labelColor=gray&style=for-the-badge&logo=applenews&logoColor=white" alt="applenews"></a>
    <a href="https://discord.gg/zfhKKn52wP"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fdiscord.com%2Fapi%2Fv10%2Finvites%2FzfhKKn52wP%3Fwith_counts%3Dtrue&query=%24.approximate_presence_count&suffix=%20online&label=Discord&color=404EED&labelColor=gray&style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
    <a href="https://x.com/Memmy_ai"><img src="https://img.shields.io/badge/Follow-Memmy-000000?labelColor=gray&style=for-the-badge&logo=x&logoColor=white" alt="X"></a>
</p>
<p align="center">
    <a href="https://www.producthunt.com/products/memmy?embed=true&utm_source=badge-top-post-badge&utm_medium=badge&utm_campaign=badge-memmy-agent" target="_blank" rel="noopener noreferrer"><img alt="Memmy Agent - Let every AI remember the same you. | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/top-post-badge.svg?post_id=1203499&theme=light&period=daily&t=1786083567983"></a>
</p>

<div align="center">
  
## Continue the same work across DeepSeek Harness, Claude Code, Codex, and etc.

[Overview](#what-is-memmy) · [Quick Start](#how-to-use-memmy) · [Technical Overview](#how-is-memmy-built) · [Roadmap](#roadmap) · [Acknowledgements](#acknowledgements) · [Contributors](#contributors)

</div>

<div align="center">

**English** • [简体中文](README.zh-CN.md)

</div>

<a id="what"></a>

## What Is Memmy?

<p align="center">
  <img src="docs/assets/remember-card-en.png" width="32%" alt="Remember: Memmy remembers what you said and turns your local AI collaboration history into structured memory">
  <img src="docs/assets/relay-card-en.png" width="32%" alt="Relay: switch tools without losing context—Memmy carries your project background, preferences, and progress forward">
  <img src="docs/assets/react-card-en.png" width="32%" alt="Act: Memmy is also an Agent that can organize information, combine approaches, and continue unfinished tasks">
</p>

### Cross-Agent Task Continuity

<table align="center">
  <tr align="center" valign="middle">
    <td width="100%" valign="middle">
      <video src="https://github.com/user-attachments/assets/79318828-9b28-44a1-a940-c78dc2029dd3" width="100%" controls playsinline></video>
    </td>
  </tr>
</table>

### Most of the Agents You're Using Can Connect to Memmy

**DeepSeek Harness, OpenClaw, Hermes, Claude Code, Codex, Cursor, WorkBuddy, OpenCode, Pi...they all work!**

![cross-agent-en.png](docs/assets/cross-agent-en.png)

### Data Security

![Memmy data security](docs/assets/data-security-en.png)

<a id="how"></a>

## How to Use Memmy

For complete installation and configuration instructions, see the [Getting Started guide](docs/en/start/getting-started.mdx).

#### 1. Desktop App (Recommended)

<p align="center">
  <img src="docs/assets/first-scan-en.png" width="58%" alt="First scan">
  <img src="docs/assets/first-report-en.png" width="38%" alt="First Meeting Report">
</p>

Download Memmy from the [official website](https://memmy.bot/) or [GitHub Releases](https://github.com/MemTensor/memmy-agent/releases).

> [!TIP]
> Sign up for Memmy to receive free tokens and try the complete Memory + Agent Runtime.<br>
> **Trial credits:**<br>
> Registration grants Agent task trial tokens; the current balance and usage are shown in the app.<br>
> When the trial credits run out, switch to BYOK mode and use your own model API.

#### 2. Use the `memmy` CLI / TUI

![Memmy TUI](docs/assets/tui.png)

On Linux x64 or arm64 with Node.js 22 or newer and an available systemd user session:

```bash
curl -fsSL https://raw.githubusercontent.com/MemTensor/memmy-agent/main/scripts/install.sh | bash
memmy
```

The installer enables the local Memory Service immediately as `memmy-memory.service`. The first bare `memmy` invocation opens the model setup wizard when needed, then enables `memmy-gateway.service`, waits for it to become ready, and enters the TUI. Both are `systemd --user` services bound to localhost and remain available after the TUI or terminal exits. They start again on later logins; the installer does not enable linger. Only the installer launcher activates this service management, so source-built Linux CLIs keep their existing behavior.

Before starting or reconnecting to the Gateway, `memmy` refreshes a private `~/.memmy/systemd/gateway.env` file (mode `0600`) with configuration-referenced environment variables, common Provider credentials, and the terminal `PATH`. If those values change, the next bare `memmy` invocation restarts the user service with the new environment.

```bash
systemctl --user status memmy-memory.service
systemctl --user status memmy-gateway.service
```

The installer initializes Memory without changing Codex, Claude Code, Cursor, or other agents. Run `memmy-memory init` (all detected agents) or `memmy-memory init --agent <agent>` when you explicitly want to install the Memory Skill and the supported Hook/plugin for an agent.

```bash
memmy onboard                              # Configure models, providers, gateway, memory, and tools interactively
memmy onboard --defaults                   # Initialize ~/.memmy/config.yaml and the workspace with defaults
memmy status                               # Check the configuration, model, and provider
memmy agent --message "Introduce the current workspace"  # Run a single-turn task
memmy                                      # Enter the interactive TUI
memmy serve                                # Start the OpenAI-compatible API (:18990)
```

The minimal BYOK configuration is located at `~/.memmy/config.yaml`:

```yaml
agents:
  defaults:
    model: openai/gpt-4.1
    provider: openai
    timezone: "+08:00"
providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
```

#### 3. Use the `memmy-memory` CLI

Use it to access the local memory service from agents, scripts, and debugging workflows:

```bash
memmy-memory init
memmy-memory health
memmy-memory search "memory policies in this project"
memmy-memory add "a piece of knowledge worth saving"
memmy-memory get <id>
```

It connects to `http://127.0.0.1:18960` by default. Use `--url`, `--token`, `--config`, `--source`, and `--user-id` to specify the service and namespace.

#### 4. Start from the Source Code

```bash
git clone https://github.com/MemTensor/memmy-agent.git
cd memmy-agent
cp .env.example .env
npm install
npm run build
bash scripts/dev-start.sh
```

The script installs dependencies, builds the services, and starts the development environment. Node.js `>=22` and npm are required; use `Git Bash` on Windows.

<a id="architecture"></a>

## How Is Memmy Built?

For details about the architecture, memory service, and integration methods, see the [Memmy documentation](https://memmy.bot/docs/).

<p align="center">
  <img src="docs/assets/memmy-architecture-en.png" alt="Memmy system architecture: multiple Agents and entry points share the local Memory and Agent Runtime">
</p>
<br>

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


<a href="https://github.com/MemTensor/memmy-agent/graphs/contributors">  </a>
