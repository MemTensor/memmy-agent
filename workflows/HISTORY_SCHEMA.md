# Memmy Computer History Markdown（MVP）

该格式用于把一次 Memmy Agent / Computer Use 会话，或一次由用户显式开始和停止的人工
桌面操作录制，转换为可阅读、可引用、可继续提炼的 Markdown 历史摘要。它参考 Codex
Computer History 的摘要形态，但不会作为长期后台监控运行，也不会读取选定录制之外的活动。

## 数据来源

- 默认目录：`~/.memmy/workspace/sessions/*.jsonl`
- 支持记录：metadata、user、assistant、tool
- 人工录制目录：`workflows/recordings/*/events.jsonl`
- 人工事件：前台应用变化、鼠标点击、键盘/文本、滚动、开始/停止和关键截图
- 连续滚轮采样会合并为一次滚动手势，记录方向与累计 delta，并在手势结束后保存关键截图
- 图片只记录本地路径，不复制 base64 到 Markdown
- application bundle id 只从会话文字中的明确应用名推断，也可由调用者显式传入

## 输出结构

```markdown
---
title: "用户任务或人工标题"
description: "会话范围与统计说明"
applications: ["com.google.Chrome"]
source_session: "cli:..."
status: completed
---

## Memory summary
...

### Relevant prior context
...

### Important non-obvious context
...

## Recording summary
...

## End State
...

## Citations
...
```

人工录制的 frontmatter 还包含：

```yaml
source_type: human_computer_history
```

## 状态定义

- `completed`：存在非空的最终 assistant 文本。
- `cancelled`：工具或模型结果明确包含取消信息。
- `error`：JSONL 中存在显式 error / `finish_reason: error`。
- `incomplete`：没有最终 assistant 文本，也没有明确取消或错误。

对于人工录制，存在 `recording_stopped` 事件即为 `completed`；意外退出且没有停止事件为
`incomplete`。该状态仅代表录制文件是否完整，不代表人工操作或 UI 结果一定成功。

这些状态只描述日志证据，不推断真实界面是否成功；最终 UI 成功仍应由截图或人工检查确认。

## 隐私约束

- 不把图片 base64、密码、token 或 API Key 写入摘要；生成器会对常见凭证模式主动脱敏。
- `Citations` 只列来源 session 和已在 session 中出现的本地图片路径。
- 用 `--last N` 缩小范围，避免把同一长期会话中的无关内容带入摘要。
- application 推断只用于演示，不等同于系统级进程或辅助功能事件采集。
- 人工 Recorder 默认不保留文本；只有同时指定 `--capture-text` 和一个或多个
  `--allow-app` 时，才会在白名单应用内保留文字。固定 Notes Demo 也只应输入非敏感测试文本。
- `--capture-search-text` 只保留可通过 Accessibility 语义识别为搜索框或浏览器地址搜索框的输入；
  密码框、普通文本框和无法识别用途的输入仍然脱敏，常见凭证模式仍会替换为 `[REDACTED]`。
