# memmy-agent

TypeScript refactor of the `memmy` runtime.

## 本地默认端口

| 服务 | 默认端口 |
| --- | ---: |
| Memory HTTP / 记忆底座 | `18960` |
| gateway health | `18970` |
| WebUI / WebSocket / admin HTTP | `18980` |
| OpenAI 兼容 API / `memmy serve` | `18990` |
| 桌面前端 Vite dev server | `19000` |
| Vite HMR | `19010` |
| 桌面本地 API | 随机端口 |
| Composio MCP bridge | 复用桌面本地 API 随机端口 |

## 安装后使用

安装完成后，直接使用 `memmy` 命令。先确认命令可用：

```bash
memmy --help
```

### 初始化配置

第一次使用先初始化配置和工作区：

```bash
memmy onboard
```

默认会创建：

- 配置文件：`~/.memmy/config.yaml`
- 工作区：`~/.memmy/workspace`

如果要指定配置文件或工作区：

```bash
memmy onboard \
  --config /path/to/config.yaml \
  --workspace /path/to/workspace
```

也可以用环境变量指定默认位置：

```bash
MEMMY_CONFIG=/path/to/config.yaml memmy status
MEMMY_AGENT_WORKSPACE=/path/to/workspace memmy status
```

### 交互式初始化

如果希望通过终端菜单配置模型、Provider、工具或 API 服务：

```bash
memmy onboard --wizard
```

交互式初始化只负责写入配置和初始化 workspace，不会启动 agent、API 服务或 Memory 服务，也不会实际调用模型验证 key。

### 查看状态

```bash
memmy status
```

这个命令会显示当前配置文件、工作区、模型和 provider 配置状态。

### 交互式聊天（TUI）

不带子命令时，`memmy` 会进入交互式聊天模式：

```bash
memmy
```

也可以显式使用 `agent` 子命令：

```bash
memmy agent
```

指定 session 可以复用同一个会话上下文：

```bash
memmy agent --session cli:work
```

指定配置或工作区：

```bash
memmy agent \
  --config /path/to/config.yaml \
  --workspace /path/to/workspace
```

### 直接发送一轮消息

```bash
memmy agent --message "你好，介绍一下当前工作区"
```

也可以从标准输入传入消息：

```bash
echo "帮我总结这个项目" | memmy agent
```

### 启动 OpenAI 兼容 API 服务

```bash
memmy serve
```

默认监听：

```text
http://127.0.0.1:18990
```

常用覆盖参数：

```bash
memmy serve --host 0.0.0.0 --port 18990 --timeout 120
```

当前服务提供 OpenAI 兼容接口：

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`

Provider OAuth 登录：

```bash
memmy provider login openai_codex
```

### 配置模型和 Provider

初始化后编辑 `~/.memmy/config.yaml`。例如使用 OpenAI 兼容模型：

```yaml
agents:
  defaults:
    model: openai/gpt-4.1

providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
```

然后在当前 shell 中设置环境变量：

```bash
export OPENAI_API_KEY="your-api-key"
```

`memmy-agent` 会在加载配置时解析 `${ENV_NAME}` 形式的环境变量。

### 命令速查

| 功能 | 安装后命令 |
|---|---|
| 查看帮助 | `memmy --help` |
| 初始化 | `memmy onboard` |
| 交互式初始化 | `memmy onboard --wizard` |
| 查看状态 | `memmy status` |
| 交互式聊天（TUI） | `memmy` |
| 单轮消息 | `memmy agent --message "..."` |
| OpenAI 兼容 API | `memmy serve` |
| Provider 登录 | `memmy provider login <provider>` |

## 源码开发运行

源码开发态使用编译后的入口 `node dist/main.js`。先进入当前包目录：

```bash
cd App/memmy-agent
```

### 环境要求

- Node.js >= 22
- npm

### 安装依赖

```bash
npm install
```

这个命令会安装 `package.json` 中声明的运行时依赖和开发依赖，依赖会放到当前包的 `node_modules/` 目录。

### 编译

```bash
npm run build
```

这个命令会把 `src/` 里的 TypeScript 编译到 `dist/`，并复制运行时需要的 templates 和 built-in skills。

### 使用源码态 CLI

查看帮助：

```bash
node dist/main.js --help
```

初始化：

```bash
node dist/main.js onboard
```

交互式初始化：

```bash
node dist/main.js onboard --wizard
```

交互式聊天（TUI）：

```bash
node dist/main.js
```

单轮消息：

```bash
node dist/main.js agent --message "你好，介绍一下当前工作区"
```

启动 OpenAI 兼容 API 服务：

```bash
node dist/main.js serve
```
