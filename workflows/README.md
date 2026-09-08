# Computer History → Workflow Memory → Replay

该目录包含一个 macOS 单场景 MVP 闭环：显式录制一次人的桌面操作，把人工事件整理成
Computer History 风格 Markdown，再提炼为可执行流程文档，最后在新会话中回放。

固定 Demo 场景是：**人工用 Spotlight 打开 Notes，新建一条备忘录并输入内容；随后换一段
文本让 Computer Use 复现。** 这不是系统级长期后台监控，只在用户主动运行录制命令到
按 `control+option+cmd+r` 停止之间采集。

## Electron GUI：录制操作经验 → History → Workflow → CUA

Computer History 页面提供一条不依赖 CLI 的显式录制链路。GUI 录制默认不截图、不录音，
原始事件只在 `~/.memmy/computer-history/recordings/` 保留最多 48 小时；持久 History 只保留
应用、步骤顺序和 Accessibility 语义目标，不保留录制坐标或精确滚动距离。

1. 在「本次示范目标」填写要演示的事情；浏览器任务同时填写批准的起始页面 URL。URL 的
   查询参数、片段和凭据不会写入 History。点击「开始录制操作经验」。
2. 切换到 Chrome、Safari、Notes 或微信；浏览器任务先打开 History 中的起始页面，再按正确
   顺序人工完成一次。结束时保留结果界面。
3. 返回 Electron，点击「结束录制并生成 History」。
4. 在 Timeline 选择新生成的 `真实采集` History，检查 `Reusable operation experience`。
5. 填写后续请求，点击「结合 History 生成 Workflow」。录制步骤会被转换成严格顺序 Gate，
   当前 Gate 未验证时不得执行后续步骤；录制滚动只作为导航证据，每次回放最多移动一个视口。
6. 展开生成的 Workflow Markdown，确认安全边界，再点击「用 CUA 开始执行」。

首次使用前，在 macOS「系统设置 → 隐私与安全性」中给启动 Electron 的宿主终端/App 授予
「输入监控」和「辅助功能」权限，并在授权后完全退出、重新启动该宿主。GUI 的无截图录制
不要求把屏幕图像写入 History；CUA 自身仍可能需要其正常桌面读取权限。

## 0. 人工操作录制（完整 use case 入口）

首次运行前，在 macOS「系统设置 → 隐私与安全性」中给运行命令的 Terminal / Ghostty 授予：

- 输入监控（Input Monitoring）
- 屏幕录制（Screen Recording）

启动固定 Notes Demo 录制：

```bash
bash workflows/scripts/human-demo.sh record
```

命令开始后，人工完成以下操作：按 `cmd+space`，搜索并打开 Notes，点击新建备忘录，输入
一段不含隐私的信息。保持 Notes 最终结果可见，按 `control+option+cmd+r` 停止并截取最终
画面；也可以切回终端按 Enter 或 `Ctrl+C` 作为备用。脚本会自动生成：

- `workflows/recordings/<时间>-<id>/events.jsonl`：前台应用、点击、键盘、滚动事件
- 同目录 `screenshots/`：开始、应用切换、点击、结束等关键截图
- `workflows/history/create-note-human-summary.md`：结构化 History Markdown
- `workflows/create-note-human.md`：由固定 Notes 模板在本地生成的可回放 Workflow

文本默认不保存。固定 Demo 入口通过明确的 bundle id 白名单，只允许 Notes、Spotlight、
Finder 和 SystemUIServer 保留输入文字，并继续过滤常见 token、API key 和密码模式。

## 0.1 真实网站的临时浏览器流程

这个入口不提供、也不依赖固定测试网页。你可以在 Chrome 或 Safari 中临时选择一个真实网站，
人工完成“输入网址、点击页面元素、向下/向上滚动”等操作，再把这一次具体示范提炼并回放。

先给这次流程取一个 kebab-case 名称；不需要提前描述接下来会做什么：

```bash
bash workflows/scripts/browser-workflow.sh record wikipedia-demo chrome
```

命令开始录制后，在真实 Chrome 窗口里人工完成操作。建议用 `cmd+l` 后**键入**网址，
不要粘贴网址，这样 History 能保留网址文字；点击和滚动则照常操作。最终结果可见时按
`control+option+cmd+r` 停止。Safari 把最后一个参数改成 `safari`。

这一步会生成：

- `workflows/recordings/<时间>-<id>/events.jsonl` 和关键截图；
- `workflows/history/wikipedia-demo-summary.md`。

然后让当前配置的 Memmy 模型读取 History 和其中引用的截图，判断这次录制完成的任务，识别页面标题、按钮/链接文字、
滚动前后区域等语义目标，并生成 Workflow：

```bash
npm --prefix App/memmy-agent run build
bash workflows/scripts/browser-workflow.sh distill wikipedia-demo
```

这一步会把录制 History 和关键截图交给当前配置的模型处理。请先确认录制内容不包含密码、
token、支付信息、私信或其他敏感内容。生成后先人工检查 `workflows/wikipedia-demo.md`，再回放：

```bash
bash workflows/scripts/browser-workflow.sh replay wikipedia-demo
```

如果 Workflow 提炼出了变量，可以像 Notes Demo 一样在命令末尾传值：

```bash
bash workflows/scripts/browser-workflow.sh replay wikipedia-demo search_text="Memmy"
```

查看某次流程是否已经生成 History 和 Workflow：

```bash
bash workflows/scripts/browser-workflow.sh status wikipedia-demo
```

这里的“临时选择网站”指录制时不需要预先为网站写模板；回放目标仍是**同一个被录制的网站和
同一条操作路径**。Demo 适合无需登录的公开页面以及可逆的点击/滚动，不保证页面大改、弹窗、
验证码、登录、支付、上传、删除、对外发送或无限滚动场景。此入口不是 DOM 自动化：回放仍由
Computer Use 根据当前截图重新进行语义定位，不会直接照抄旧坐标。

## 1. 生成历史摘要

使用最近更新的 session：

```bash
node workflows/scripts/summarize-history.mjs --latest
```

使用最近一次人工录制：

```bash
node workflows/scripts/summarize-history.mjs \
  --latest-recording \
  --out workflows/history/create-note-human-summary.md
```

指定 session（`cli:...` 和磁盘上的 `cli_...` 名称都支持）：

```bash
node workflows/scripts/summarize-history.mjs \
  --session 'cli:YOUR_SESSION_ID' \
  --last 1
```

指定 JSONL 和输出路径：

```bash
node workflows/scripts/summarize-history.mjs \
  --file ~/.memmy/workspace/sessions/cli_YOUR_SESSION_ID.jsonl \
  --out workflows/history/my-memory-summary.md
```

若应用名没有出现在会话文字中，可以显式补充 bundle id：

```bash
node workflows/scripts/summarize-history.mjs \
  --latest \
  --application com.apple.Notes
```

输出格式见 [HISTORY_SCHEMA.md](./HISTORY_SCHEMA.md)。生成器完全离线，不调用模型。
实际摘要默认写入 `workflows/history/`，该目录中的 Markdown 已被 Git 忽略，避免误提交
个人任务内容和本地截图路径。需要作为 demo 附件提交时，应先人工脱敏后复制到其他目录。

## 2. 生成流程记忆

固定 Notes Demo 在 `record` 结束后会直接从 History Markdown 本地生成 Workflow，不调用
外部模型。若 Workflow 被删除，执行 `replay` 时也会自动从已有 History 重建。

如果需要验证模型提炼能力，再单独运行：

历史摘要或 `extract-trace.mjs` 生成的原始轨迹都可以作为提炼输入：

```bash
bash workflows/scripts/distill.sh \
  workflows/history/YOUR_MEMORY_SUMMARY.md \
  create-note-recorded \
  "用 Spotlight 打开 Notes 并新建一条备忘录"
```

模型提炼命令：

```bash
bash workflows/scripts/human-demo.sh distill
```

输出为 `workflows/create-note-human.md`。

流程文档规范见 [SCHEMA.md](./SCHEMA.md)。这一步会调用当前配置的 Memmy 模型。

## 3. 回放

`replay.sh` 使用 `memmy agent --standalone` 直接执行，不需要另起 gateway。回放前还要给
运行命令的 Terminal / Ghostty 授予「辅助功能（Accessibility）」权限，然后确保 Agent 已构建：

```bash
npm --prefix App/memmy-agent run build
```

然后运行：

```bash
bash workflows/scripts/replay.sh \
  workflows/create-note-recorded.md \
  note_text="流程记忆回放测试"
```

固定人工 Demo 可直接运行（参数值应与录制时不同）：

```bash
bash workflows/scripts/human-demo.sh replay note_text="人工流程回放成功"
```

## 推荐的 Notes MVP 录屏顺序

1. 运行 `human-demo.sh record`，人工完成一次固定的 Notes 任务，并在结果可见时按
   `control+option+cmd+r`。
2. 展示人工事件 JSONL、关键截图和生成的 history summary。
3. 展示提炼出的 workflow Markdown。
4. 换一个 `note_text` 运行 replay。
5. 展示 Notes 中的新内容和最终截图。

## 当前边界

- 人工 Recorder 只支持用户显式启动/停止的单次录制，不做全系统长期后台活动采集。
- 浏览器 Recorder 会把一个连续滚轮手势合并成一条事件，并在手势结束后截取页面状态；
  Chrome/Safari 中按 Enter 导航后也会截取页面加载状态。
- 为了完成 Demo，录制器保存鼠标坐标等原始证据；Workflow 提炼后仍必须使用语义定位，
  回放不能直接依赖旧坐标。
- Computer Use 目前只支持 macOS 主显示器。
- 前台应用来自 macOS 当前激活应用；Spotlight 的事件有时归属于 Finder/SystemUIServer，
  因此 Demo 白名单包含这些系统进程。
- 历史摘要可离线生成；流程提炼和回放依赖已配置且可调用的模型。
