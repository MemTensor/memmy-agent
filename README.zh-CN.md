<br>
<div align="center">
  <a href="https://memmy.cn/">
    <picture>
      <img alt="Memmy Logo" src="docs/assets/banner-zh.png">
    </picture>
  </a>
</div>
<br>
<br>
<p align="center">
    <a href="https://memmy.cn/docs/"><img src="https://img.shields.io/badge/Docs-Get--Start-64716C?labelColor=gray&style=for-the-badge&logo=googledocs&logoColor=white" alt="Docs"></a>
    <a href="https://memmy.cn/"><img src="https://img.shields.io/badge/Visit-Memmy_官网-006400?labelColor=gray&style=for-the-badge&logo=safari&logoColor=white" alt="Memmy 官网"></a>
    <a href="https://github.com/MemTensor/memmy-agent/releases/latest"><img src="https://img.shields.io/badge/News-安装Memmy-ED8D45?labelColor=gray&style=for-the-badge&logo=applenews&logoColor=white" alt="Memmy 最新版"></a>
    <a href="docs/assets/wechat-code.png"><img src="https://img.shields.io/badge/WeCom-Memmy_社区-07C160?labelColor=gray&style=for-the-badge&logo=wechat&logoColor=white" alt="WeChat"></a>
    <a href="https://x.com/Memmy_ai"><img src="https://img.shields.io/badge/Follow-Memmy-000000?labelColor=gray&style=for-the-badge&logo=x&logoColor=white" alt="X"></a>
</p>
<p align="center">
    <a href="https://www.producthunt.com/products/memmy?embed=true&utm_source=badge-top-post-badge&utm_medium=badge&utm_campaign=badge-memmy-agent" target="_blank" rel="noopener noreferrer"><img alt="Memmy Agent - Let every AI remember the same you. | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/top-post-badge.svg?post_id=1203499&theme=light&period=daily&t=1786083567983"></a>
</p>

<div align="center">

## 让你的工作在 DeepSeek Harness、Claude Code 和 Codex 等 Agent 之间接着做。

  [项目简介](#memmy-是什么) · [快速开始](#如何使用-memmy) · [技术实现](#memmy-如何实现的) · [路线图](#路线图) · [致谢](#致谢) · [贡献者](#贡献者)

</div>

<div align="center">

[English](README.md) • **简体中文**

</div>

<a id="what"></a>

## Memmy 是什么？

<p align="center">
  <img src="docs/assets/remember-card-cn.png" width="32%" alt="Remember：它记得你说过什么，自动把本机 AI 协作历史整理成结构化记忆">
  <img src="docs/assets/relay-card-cn.png" width="32%" alt="Relay：工具随便换，记忆不掉线，Memmy 会带上项目背景、偏好和进度">
  <img src="docs/assets/react-card-cn.png" width="32%" alt="Act：Memmy 本身也是一个 Agent，可以整理资料、合并方案并继续未完成的任务">
</p>

### 跨 Agent 任务延续
<table align="center">
  <tr align="center" valign="middle">
    <td width="100%" valign="middle">
      <video src="https://github.com/user-attachments/assets/8d3c7cdb-3481-4941-b143-5652c87a3eae" width="100%" controls playsinline></video>
    </td>
  </tr>
</table>

### 你正在用的 Agent，大多都能接入
**deepseek harness, openclaw, hermes, claude code, codex, cursor, workbuddy, openCode, pi...都能用!**
<br>
<br>
![cross-agent-cn.png](docs/assets/cross-agent-cn.png)


### 数据安全
![data-security-cn.png](docs/assets/data-security-cn.png)

<a id="how"></a>

## 如何使用 Memmy？

完整安装和配置说明见 [入门指南](docs/cn/start/getting-started.mdx)。

#### 1. 桌面端（推荐）

<p align="center">
  <img src="docs/assets/first-scan-cn.png" width="58%" alt="首次扫描">
  <img src="docs/assets/first-report-cn.png" width="38%" alt="初见报告">
</p>

点击[官网](https://memmy.cn/)或者 [GitHub Release](https://github.com/MemTensor/memmy-agent/releases) 下载。

> [!TIP]
> 注册 Memmy 后，即可获得免费 Token，体验完整的 Memory + Agent Runtime。<br>
> **体验额度：** <br>
> 注册赠送 Agent 任务体验 Token，当前额度和使用情况以应用内显示为准。<br>
> 当体验额度用尽后，可切换至 BYOK 模式，使用自己的模型 API。

#### 2. 使用 memmy CLI /TUI
![tui.png](docs/assets/tui.png)

Linux x64 或 arm64（需 Node.js 22 或更高版本，并且 systemd 用户会话可用）可一行安装：

```bash
curl -fsSL https://raw.githubusercontent.com/MemTensor/memmy-agent/main/scripts/install.sh | bash
memmy
```

安装器会立即启用本地 Memory Service（`memmy-memory.service`）。首次裸执行 `memmy` 时，如尚未配置模型，会在当前终端进入配置向导；保存后启用 `memmy-gateway.service`，等待就绪并进入 TUI。二者均为只绑定本机地址的 `systemd --user` 服务，退出 TUI 或关闭终端不会停止；以后登录时会自动启动。安装器不会启用 linger。只有安装器生成的 launcher 会启用这套服务管理，源码构建的 Linux CLI 保持原有行为。

启动或重新连接 Gateway 前，`memmy` 会把配置引用的环境变量、常用 Provider 凭据和终端 `PATH` 刷新到权限为 `0600` 的私有文件 `~/.memmy/systemd/gateway.env`。这些值发生变化后，下次裸执行 `memmy` 会使用新环境重启用户服务。

```bash
systemctl --user status memmy-memory.service
systemctl --user status memmy-gateway.service
```

安装阶段只初始化 Memory 基础配置，不会修改 Codex、Claude Code、Cursor 等外部 Agent。需要接入时，由用户明确执行 `memmy-memory init`（接入检测到的 Agent）或 `memmy-memory init --agent <agent>` 安装对应的 Memory Skill 及受支持的 Hook/插件。

```bash
memmy onboard                              # 交互式配置模型、Provider、Gateway、Memory 和工具
memmy onboard --defaults                   # 使用默认值初始化 ~/.memmy/config.yaml 和 workspace
memmy status                               # 检查配置、模型和 Provider
memmy agent --message "介绍一下当前工作区"  # 单轮任务
memmy                                      # 进入交互式 TUI
memmy serve                                # 启动 OpenAI 兼容 API（:18990）
```

最小 BYOK 配置位于 `~/.memmy/config.yaml`：

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


#### 3. 使用 memmy-memory CLI


供 Agent、脚本和调试流程访问本地记忆服务：

```bash
memmy-memory init
memmy-memory health
memmy-memory search "项目里的记忆策略"
memmy-memory add "这是一条需要保存的知识"
memmy-memory get <id>
```

默认连接 `http://127.0.0.1:18960`；可用 `--url`、`--token`、`--config`、`--source` 和 `--user-id` 指定服务与命名空间。


#### 4. 源码启动

```bash
git clone https://github.com/MemTensor/memmy-agent.git
cd memmy-agent
cp .env.example .env
npm install
npm run build
bash scripts/dev-start.sh
```

脚本会安装依赖、构建服务并启动开发环境。需要 Node.js `>=22` 和 npm；Windows 请使用 Git Bash。




<a id="architecture"></a>

## Memmy 如何实现的？

架构、记忆服务和接入方式的详细说明见 [Memmy 文档](https://memmy.bot/docs/)。

<p align="center">
  <img src="docs/assets/memmy-architecture-zh.png" alt="Memmy 系统架构：多个 Agent 和入口共享本地 Memory 与 Agent Runtime">
</p>
<br>

## 路线图

Memmy 做的是**个人记忆基础设施**，边界不止于 Coding Agent：

- **更多记忆来源**——从 AI 对话扩展到浏览器行为、本地文档，乃至更多终端与硬件设备。
- **团队协作**——规划中的 Agent 间协作能力，让团队成员的 AI 助手在隐私保护下共享知识。
<br>

## 致谢

Memmy 站在一群优秀的开源项目肩上，我们对此心怀感激。

- **[OpenClaw](https://github.com/openclaw/openclaw)** ——开源个人 AI 助手的先行者，它对多平台消息渠道的探索直接启发了 Memmy 的渠道连接设计。
- **[hermes-agent](https://github.com/NousResearch/hermes-agent)** ——Nous Research 打造的自我进化 Agent，它在持久记忆与技能自学习上的实践让我们看到 Agent 可以「越用越懂你」。
- **[nanobot](https://github.com/HKUDS/nanobot)** ——从极简原型生长为功能完备的开源 Agent 平台，它对 Agent 循环与 MCP 集成的工程实践为 Memmy 的核心设计提供了重要参考。

开源的意义在于让好的想法流动起来，我们希望 Memmy 也能成为这条河流的一部分。
<br>

## 贡献者

感谢每一位让 Memmy 变得更好的贡献者 ❤️
<br>
<br>
<a href="https://github.com/MemTensor/memmy-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=MemTensor/memmy-agent" alt="memmy-agent contributors" />
</a>
