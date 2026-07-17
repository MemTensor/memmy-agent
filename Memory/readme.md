# Memory

`Memory` 是本地优先的 memmy 记忆服务，默认使用 SQLite 存储，并通过 HTTP 服务和 `memmy-memory` CLI 给 agent 暴露记忆能力。

## 常用命令

在仓库根目录运行：

```bash
npm run memory:serve:dev
npm run memory:test
npm run memory:lint
npm run memory:build
```

开发服务入口是 `Memory/src/server/index.ts`，编译后入口是 `Memory/dist/src/server/index.js`。默认服务地址是 `http://127.0.0.1:18960`。

自定义服务参数：

```bash
npm run memory:serve:dev -- \
  --host 127.0.0.1 \
  --port 18960 \
  --db ~/.memmy/memory-service/memory.sqlite \
  --config ~/.memmy/config.yaml
```

## 配置

默认配置文件查找顺序：

```text
MEMMY_CONFIG
~/.memmy/config.yaml
```

最小配置示例：

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

设置 `storage.token`、`MEMMY_MEMORY_TOKEN` 或 `MEMORY_SERVICE_TOKEN` 后，除 `GET /api/v1/health` 外的接口需要携带 bearer token。

## CLI

在 `Memory/` 目录内源码运行：

```bash
npx tsx src/cli/index.ts health --url http://127.0.0.1:18960
```

在 `Memory/` 目录内编译后运行：

```bash
node dist/src/cli/index.js health --url http://127.0.0.1:18960
```

当前专用命令：

```text
memmy-memory init
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

`get` 默认输出可直接给 agent 使用的精简内容；需要完整 JSON 详情时使用 `--verbose`。

`memmy-memory serve` 只说明如何连接外部 Memory 服务，不会启动本地 HTTP 服务。
