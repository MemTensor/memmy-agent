# Codex Computer Use 解包记录（macOS）

> 下文保留 2026-09-27 的分阶段解包与初版实现记录，其中的「当前实现」和
> 「待验收」是当时状态。2026-09-28 的最新代码、签名权限与 Mac/Windows
> 实机结果以 [集成验收记录](../local-memmy-integration-acceptance-2026-09-28.md)
> 为准。解包结论是组件与可观察协议的证据，不代表已获得 Codex 专有源码。

记录日期：2026-09-27。分析对象是本机 `/Applications/ChatGPT.app`，版本
`26.924.22138`，Bundle ID 为 `com.openai.codex`。本文只记录接口、组件关系和
可观察的行为证据，不复制或分发包内的专有代码及二进制。

## 结论

Codex 当前的 Computer Use 不是“在虚拟机里运行所有 Mac 应用”。从安装包可确认的
主路径是：同一 Agent 工具入口按 surface 分流到浏览器运行时和 Mac 原生运行时；
浏览器有独立会话与后台页面；Mac 应用由单独的原生服务按 app 标识操作当前系统中的
窗口。小窗是原生 PiP 展示层，浏览器侧可由截图更新，Mac 应用侧有原生视频流、
窗口捕获和虚拟光标相关组件。它是展示及交互入口，不等于另一套 macOS 用户桌面。

这不证明所有应用、所有输入动作都能完全避开焦点争用。原生二进制出现焦点保护、
焦点恢复和用户介入检测相关类型，说明 Codex 专门处理这种争用；具体策略仍需黑盒
验证，不能只凭类型名断言。

## 已核实的组件和数据流

| 层 | 包内证据 | 作用 |
| --- | --- | --- |
| 统一入口 | `plugins/openai-bundled/plugins/unified-computer-use/.codex-plugin/plugin.json`、`.mcp.json`，`cua_node/lib/node_modules/@oai/cua-repl/README.md` | `cua_repl` 在 Node REPL 中装载 `@oai/cua/tinyskyAlt`；应用启动时按 `browser`、`computer` surface 写入实际运行路径。 |
| 浏览器 | `@oai/browser-desktop`、`app.asar/.vite/build/main-*.js` | 内置浏览器使用独立 Electron session，主进程可在后台持有页面；浏览器动作经 app 管理的 service 执行。 |
| Mac 应用 | `@oai/sky/dist/.../targets/mac/client.js`、`native-pipe.js` | JS 客户端用 `CodexComputerUseIPC-5` 协议，通过本机 pipe 对单独服务发送 `getAppState` 和动作请求；请求带 app 标识和回合元数据。 |
| 原生服务 | `@oai/sky/Codex Computer Use.app`，Bundle ID `com.openai.sky.CUAService` | 后台 `LSUIElement` app。其二进制包含窗口捕获、AX、输入、远程 PiP 内容生产、虚拟光标及用户介入相关组件。 |
| 小窗 | `native/sky.node`，`app.asar/.vite/build/main-*.js` | 主进程调用 `startRemoteHostedPIPContentHost`、`upsertBrowserUsePIPContent`、原生视频等桥接方法；原生层包含 `PIPStackWindow`、拖动和缩放交互。 |

### 观察、历史与 skill

`@oai/cua-repl/README.md` 明确说明它把 `@oai/cua/tinyskyAlt` 装进持续的
Node REPL。初始化时**不自动枚举**应用和浏览器；模型需要时才调用 `cua.getState()`。
同一 REPL 内的 app/tab 绑定与变量可跨调用保留。`tinysky-alt-core-cua-repl.md`
列出的应用和标签页 API 同时提供辅助功能状态、截图与动作；应用 AX 状态支持增量 diff，
网页还提供 DOM/Playwright 路径。文档要求动作后取新的状态，以最新元素索引操作。

安装包同时含旧版 `computer-use/skills/computer-use/SKILL.md`：其中 `sky.list_apps()`
结果有 `lastUsedDate`、`useCount` 字段，`get_app_state` 返回截图与 AX 文本，并可
按最近 AX 树做 diff。这个 skill 明确建议优先使用专用接口、优先 AX 元素索引，截图
用于 AX 不足时补充判断；`press_key` 和 `type_text` 由 Sky 服务针对目标 app 执行。
它证明“历史中的应用使用信息”和“上一次 AX 状态”可能帮助发现与定位，但不等于
用历史记录代替实时点击。新统一入口会对已接管 provider 压制这份旧 skill。

浏览器包确有 `browser.history()` 能力；`environment-docs/codex-app/api-use-behavior.md`
要求仅在任务需要时做一次有时间范围和关键词约束的调用，并提示可能触发用户批准。
它**不是每次 Computer Use 的默认观察输入**。浏览器前进/后退和标签页会话状态也
叫 history，但与读取用户浏览历史不是一回事。

另有一个容易混淆的来源：Memmy 当前使用的 `open-computer-use` 0.3.5 二进制在
`list_apps` 工具描述中明确写明，它返回当前运行的应用，以及过去 14 天用过的应用和
使用频次。这与 Codex 旧 Sky skill 的 `lastUsedDate` / `useCount` 相呼应，但不能据此
推断新统一入口的准确时间范围，也不表示每次 `cua_repl` 初始化都会自动读取这些数据。

官方 [Computer History 文档](https://learn.chatgpt.com/docs/customization/computer-history)
又是独立路径：用户选择开启后，系统从获准的应用与网站收集交互事件，并形成时间线
和本地记忆；Codex 可把相关记忆作为后续任务的上下文。历史不存截图，默认关闭。
Memmy 已有自己的 `computer_history` 检索工具和记录链路；其工具描述明确只返回证据，
不回放动作。复刻 Computer Use 时应把这种可选上下文和实时观察/执行分开。

`cua_repl` 的描述要求优先使用能完成任务的专用 plugin、skill、API 或 CLI。
README 还说明 Desktop 仅对由 `cua_repl` 接管的 provider 压制旧版 skill/hint。
因此 skill 可以影响工具选择和操作规则；实际网页/桌面点击仍由浏览器或 Sky 服务执行。
本安装包没有显示“每次 use 都自动读取个人电脑使用历史”的调用链。

浏览器 PiP 的一次更新链路可从主进程观察到：工具结果携带
`_meta["codex/toolSurface"]`，其中包含浏览器 ID、tab ID、backend 和截图 data URL；
主进程按 thread/tab 建立 presentation ID，调用 native addon 更新 PiP。点击浏览器
PiP 时，再把对应内置浏览器 tab 或扩展 tab 聚焦。回合完成或 tab 关闭时移除展示。
统一插件的 `plugin.json` 将 `Stop`、`Interrupt`、`SubagentStop` hook 都绑定到
`cua_repl.turn_ended`，说明回合结束清理是明确的运行时协议，不只是窗口自己消失。
因此，浏览器 PiP 中使用截图并不表示 Codex 通过“点截图”来执行网页操作：
Agent 的点击走浏览器服务里的页面操作接口；用户点击 PiP 则进入该会话的真实
可交互标签页。
[官方浏览器说明](https://learn.chatgpt.com/docs/browser) 也确认内置浏览器有独立于
普通浏览器的 profile、自己的历史，以及与用户共享的可操作页面。

Mac 应用通道返回当前 app 窗口截图和辅助功能文本。客户端把 `click`、`drag`、
`pressKey`、`typeText`、`scroll`、`setValue` 等动作连同 app 标识送到原生服务。
原生服务的静态符号包括 `ScreenCaptureKit`、`AXUIElement`、`CGWindow`、
`CGEvent`、`RemoteHostedPIPContentStream`、`RemoteHostedPIPVideoEncoder`、
`VirtualCursor`、`SyntheticAppFocusEnforcer`、`SystemFocusStealPreventer`、
`FocusRestoreTarget`、`UserInterruptedIntervention`。这些是组件存在的证据，
不是具体算法的完整证明。
`PIPStackWindow` 则出现在主进程加载的 `native/sky.node` 中。
原生工具的点击目标可来自辅助功能元素索引或窗口内坐标，动作由原生服务发送给
指定应用；截图是观察结果，不能代替原生输入通道。桌面 PiP 使用视频帧处理器，
也不是简单的定时截图刷新。

## 与 Memmy 当前实现的对应关系（2026-09-27）

用户提供的截图是 Codex 的「设置 → 电脑操控」，不是执行过程中的 PiP。
「任意应用」对应原生桌面工具；Chrome、Edge 是外部浏览器扩展通道；
Excel 是加载项；锁屏操作依赖 macOS 授权插件；「始终允许的应用」是授权策略。
它们是不同后端，不能用一张设置页或一个浏览器小窗代替。

| 能力 | 当前 Memmy 实现 | 验收状态与缺口 |
| --- | --- | --- |
| 设置页「任意应用」 | 设置页读写 `open_computer_use` MCP 预设并热重载 | 类型检查和组件测试通过；授权后的原生操作待实机验证。 |
| Chrome/Edge 扩展、Excel 加载项、锁屏操作、始终允许列表 | 页面显示准确的未接入状态 | 执行后端和授权策略尚未实现，因此整页不能算完整复刻。 |
| 内置网页会话 | 每个聊天使用同一个有头 Playwright Chromium context/page；用户侧栏和 Agent 操作共享页面；PiP 可打开真实 Chromium 窗口 | 本机导航、DOM、截图及保持用户前台应用的烟测通过。侧栏本身仍是页面帧镜像，没有 Codex 内置 Electron 标签页的完整体验。 |
| 浏览资料 | 独立 storage state 保存 cookies、localStorage、IndexedDB；清除浏览数据有 Agent 完成回执 | 单元测试通过；没有完全覆盖 Codex 的浏览历史、下载、扩展及普通浏览器资料迁移。 |
| 原生应用输入 | `open-computer-use` 0.3.5 的九个 MCP 工具；Mac PiP 点击走 `sky_click`，Windows 点击走目标 HWND 的 `app_post`；PiP 滚轮以目标应用翻页键实现 | helper 的工具 schema 已读取；本机 `get_app_state` 因缺少 macOS 辅助功能权限被系统拒绝，故点击尚未验收。滚轮尚不能精确命中指针所在的 AX 滚动元素。 |
| 连续桌面画面 | PiP 选中目标窗口后以 Electron 窗口捕获播放视频，失败时保留截图 | 打包后的 HTML 已验证具备 `getDisplayMedia`；未签名测试进程没有屏幕录制授权，实际视频仍待验收。实现方式也不同于 Codex 的原生 `PIPStackWindow`。 |
| 焦点和用户介入 | Mac 原生 helper 读取前台应用与 HID 空闲时间；动作前拦截用户正在操作的目标，动作后必要时恢复前台 | arm64/x64 编译与单元测试通过；用户与 Agent 同时操作各类应用的细粒度行为尚未实机验收。 |
| 按回合关闭 PiP | 表面协议区分 `presentationOnly` 与 session 销毁；PiP 关闭而侧栏会话保留 | 桥接测试通过；需要整体 GUI 回归。 |
| History 与 skill | 独立的 Computer History 证据链；Computer Use skill 指导优先当前 DOM/AX，截图补充 | 不会默认读取用户历史。没有与 Codex 相同的持久 `cua_repl` 与 provider 路由。 |
| Windows 安装包与桌面操作 | NSIS x64 脚本检查 `open-computer-use.exe`；Windows 已接入托管 MCP 会话，PiP 可按窗口标题找视频源，点击使用后台 HWND 消息；`get_app_state` 图片由 Electron 目标窗口捕获替换 | 单元测试、类型检查与 Windows 原生二进制静态检查通过；Electron 窗口捕获在 Windows 遮挡和最小化场景尚未实测，没有完成 EXE 构建、安装、点击和连续视频验收。 |

`open-computer-use` 二进制包含按目标应用 PID 投递事件的 `app_post` 与后台
`sky_click` 路径；全局指针回退可能移动真实指针并改变焦点，因此托管配置默认把
`OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS` 设为 `0`。
这证明有可复用的后台输入执行器，不证明所有应用都能无干扰地完成任意动作。
官方 Computer Use 文档明确区分平台：macOS 支持范围明确的后台任务，
Windows 在当前活动桌面前台运行。Windows 若要求用户继续使用同一桌面且互不干扰，
需要虚拟机或独立会话；不能把前台执行描述成后台复刻。

目前的目标应按逐项行为验收：同一页面由用户和 Agent 操作、原生窗口持续视频、
桌面点击与输入、焦点恢复和用户介入、应用授权、浏览器扩展与加载项、
锁屏操作，以及 Windows 安装包实机运行。未通过之前不称为完整复刻。

### 团队人测所需环境与通过条件

- **Mac arm64**：在测试机安装本地无签名 DMG，分别给 Memmy 屏幕录制权限及
  Open Computer Use 辅助功能权限。用 Notes/Calculator 等测试应用验证：
  PiP 连续更新；点击和输入只作用于目标窗口；在另一个应用持续输入时焦点不被夺走；
  用户切入目标应用时 Agent 写操作停止；回合结束 PiP 关闭但浏览器侧栏页面保留。
- **Windows x64**：在 Windows 主机以 `MEMMY_SKIP_CODESIGN=1` 运行
  `scripts/internal/win/build-nsis.sh`，安装生成的 NSIS EXE；验证
  `open-computer-use.exe` 随包存在、Notepad 等目标应用的点击/输入、
  浏览器页面和 PiP。用另一个窗口完全遮住 Notepad 后调用 `get_app_state`：
  返回的图片必须仍是 Notepad，或明确报错，不能返回遮挡者画面；再测试
  100%/150% 缩放、两个同名 Notepad 窗口、PiP 点击和滚轮、用户同时输入时的
  焦点与介入行为。Codex 官方 Windows 路径在同一活动桌面前台运行，
  “用户继续在同一桌面操作且互不干扰”须在 VM/独立会话中验收。
- **阻断条件**：Mac 权限未授予、Windows 主机不可用、Chrome/Edge 扩展与
  Excel 加载项及锁屏授权组件未实现时，不签收“完整复刻”。

## 复核方式

可从原始安装包重复检查：

```sh
plutil -extract CFBundleShortVersionString raw -o - /Applications/ChatGPT.app/Contents/Info.plist
plutil -extract CFBundleIdentifier raw -o - /Applications/ChatGPT.app/Contents/Info.plist
cat /Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/README.md
cat /Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/package.json
strings '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService'
```

`app.asar` 可用本仓库已有的 `@electron/asar` 读取，主进程的 Vite bundle 位于
`.vite/build/main-*.js`。文件名中的 hash 和协议版本随安装包升级可能变化。
运行 `node scripts/internal/mac/inspect-codex-computer-use.mjs` 可重复输出当前安装包的
组件指纹和关键符号存在性；脚本不输出包内源码。

官方 OpenAI Computer Use 文档说明产品集成需要持久的浏览器或桌面环境，并由宿主
执行动作和返回截图；它不披露 Codex Desktop 的上述私有实现。

## 追加实现与实机验证（2026-09-27 晚）

上文「本轮已落地的复刻切片」与能力表记录的是最初的截图预览切片。之后已补上：

- 托管桌面模式把 Agent 的 Playwright Chromium 作为真实浏览器窗口运行。PiP 的
  「打开标签页」显示同一个 Agent 页面，用户点击与 Agent 工具调用指向同一个
  Playwright context/page。Agent 窗口在用户当前应用后方运行；工具调用前后检查
  前台应用，用户把 Agent 浏览器切到前台时停止 Agent 的写操作。
- Agent 浏览器 surface 协议增加 URL、前进/后退状态，以及导航、后退、前进、刷新
  命令。托管桌面模式在 macOS/Windows 上走 CDP `Page.captureScreenshot`，并把截图
  作为模型可见图片返回。
  本机端到端烟测验证了导航、DOM snapshot、图片返回、浏览器真实窗口和前台应用
  在调用前后相同。网页内部截图工具的元素区域参数尚未覆盖离屏截图路径。
- 独立的真实 Chromium 重启烟测只访问本机测试网页：第一个 Agent 会话写入
  cookie 与 localStorage 后关闭，第二个会话成功读回两者；测试前后前台应用均为
  Finder。该烟测不包含浏览器扩展、下载、历史或 Windows。
- 浏览器回合结束发送仅关闭 PiP 的消息，侧栏继续保留同一页面和动作入口；
  真正的 session 销毁才清除侧栏。WebUI Agent 工具使用投影后的
  `projected-session` 浏览器 scope，回合结束清理会匹配该 scope。协议和桥接
  测试覆盖了这两个生命周期。
- Mac 原生 PiP 增加 Electron `desktopCapturer` 窗口捕获与连续 `getDisplayMedia`
  视频流，静态图片为失败回退。`list-windows` 与 `focus-guard` 原生辅助程序按
  arm64/x64 编译并纳入 DMG 打包。小窗视频与截图都可转发点击；视频点击在
  窗口尺寸未变时以操作时的新画面为准，截图点击继续拒绝过期坐标。
- 原生动作外围加入前台应用快照、用户新输入检测、必要时恢复原前台应用；动作
  抛错后仍尝试恢复。单元测试覆盖这些路径。解包看到的 Codex 原生虚拟光标和
  细粒度介入策略没有源代码级等价实现。

实机试验也排除了两种看似可行但不可靠的后台浏览器做法：macOS Chromium 忽略
`--start-minimized`，CDP 最小化后窗口状态仍为 `normal`；通过 AX 把应用隐藏后，
首次导航的页面虽可读取 DOM 和接受点击，却不产出截图或 screencast 帧。因此现用
「窗口保持在用户应用后方 + 焦点保护」策略。后台真实标签页的直接操作已验证，
但这不等于 Codex 的独立 Electron 浏览器服务，也未将 Memmy 普通浏览器 webview
与 Agent context 合并为一个浏览器资料分区。

连续视频的 Electron API 在单元测试中可选中正确窗口并授予捕获源；本机用未签名
Electron 烟测时 `desktopCapturer.getSources` 返回 `Failed to get sources`，因此尚未
完成已授权 Memmy 安装包中的视频播放、系统屏幕录制授权与目标应用行为验收。
另一次 Electron 实机检查发现，`data:` 来源的悬浮窗不具备安全上下文，
`navigator.mediaDevices` 为 `undefined`，所以即使捕获源可用也无法播放视频。
悬浮窗现改为打包的本地 HTML 文件；在实际页面上复查得到
`isSecureContext === true` 和可调用的 `getDisplayMedia`。这只验证 API 入口，
不替代获得屏幕录制权限后的连续视频验收。
第一次无签名 DMG 打包的最终检查发现，`electron-builder.unsigned.yml` 漏了
Computer Use 辅助程序的 `asarUnpack` 规则，导致可执行文件留在 ASAR 内。
该规则已补齐。重跑 `npm run dist:mac:unsigned --prefix App/shell/desktop`
已成功生成 arm64 测试 DMG；打包脚本确认 ASAR 边界、版本和解包后的两个
Computer Use 原生辅助程序。这个包未签名且未公证，仍需授予系统权限后做
原生点击与连续视频实机验收。
用 Electron 直接加载该包 ASAR 内的悬浮窗 HTML，再次得到
`isSecureContext === true`、`navigator.mediaDevices` 可用及
`getDisplayMedia` 为函数；证实此入口在打包后没有退化为 `data:` 来源。

跨模块定向测试通过，包括设置页、右侧浏览器、surface 协议、焦点保护、
原生动作和主进程桥接。完整 `runtime-services.test.ts` 在本机沙箱中有
`listen EPERM 127.0.0.1`、Memory 锁等待超时和独立的 Memory 指标断言失败；
单独运行与本功能相关的浏览器准备、surface 动作和清除数据三项均通过。
直接启动当前 `open-computer-use` 0.3.5 原生 MCP 时，`list_apps` 与九个工具的
schema 可读取，`click` 明确支持 `sky_click`；但 `get_app_state` 返回
`Accessibility permission is required`。这说明现有测试 helper 尚未获授权，
不能把静态 schema 检查当作桌面点击验收。
Windows x64 安装脚本包含 `open-computer-use.exe`；PiP 也会在 Windows 尝试按窗口
标题选择 Electron 视频捕获源。Mac 原生窗口归属匹配、焦点辅助程序和用户同时操作的
保护不能据此推断在 Windows 可用；需要 Windows
实机安装与前台控制验收。故当前仍不能称为完整复刻。

继续审计 Windows 原生二进制时发现两处实际阻断：原先 `isManagedOcuConfig` 只接受
macOS，使 Windows 上的工具调用绕过 Memmy 托管会话，小窗无法收到原生应用的截图；
而小窗点击固定传 `sky_click`，Windows helper 的内置 PowerShell 后端明确报
`click_method 'sky_click' is not supported on Windows`。现已把 Windows 默认预设
接入托管会话，并在 Windows PiP 点击时传 `app_post`，由后端向目标 HWND 投递消息。
Windows 不使用 macOS 的 TCC 自检或 `.app` agent socket；失败仍由原生工具结果返回。
相关定向测试和 Agent 类型检查通过。此处是静态检查与模拟测试，不能代替 Win x64
安装包构建及 Notepad 实际点击、输入、视频捕获、焦点争用和用户介入测试。

同一 Windows helper 的截图后端使用 `System.Drawing.Graphics.CopyFromScreen`，会把
目标窗口被遮挡位置上的其他窗口拍进来。为避免模型把那张图当成目标窗口，托管会话
在返回 `get_app_state` 前通过 Electron `desktopCapturer` 按目标窗口标题取得独立窗口
图片，并统一调整到原生截图的像素尺寸；匹配到多个目标、取不到图片或图片无效时返回
错误，且不把原始屏幕区域图片交给模型。Agent IPC 和主进程捕获的定向测试通过。
Windows Graphics Capture 对遮挡、最小化及某些受保护应用的实际表现仍须在 Windows
主机验收；该路径也没有完成所有应用下的用户介入保护。

随后加入了 Windows 进程 ID 匹配：Agent 从原生 `get_app_state` 文本提取目标 PID，
主进程用窗口句柄查询拥有者 PID，再决定 Electron 的截图源。标题不含应用名时也能
定位窗口；一个进程有多个窗口且无法用标题消歧时继续拒绝猜测。Agent 和主进程
定向测试、TypeScript 检查通过。Windows 的 PowerShell/Win32 查询尚未实机运行。

本地无签名 Mac arm64 DMG 于 22:37 重新构建成功。ASAR 逐项检查确认新的 Windows
窗口截图主进程模块、Agent 侧图片替换模块、PiP HTML 及原生点击模块均已进入包内；
`open-computer-use` 0.3.5 原生 helper 在 ASAR 外且包含 arm64/x86_64。该包仍未签名，
且未做获得系统辅助功能、屏幕录制权限后的 GUI 验收。

桌面 PiP 的滚轮翻页交互随后已加入，并于 22:43 重打本地无签名 DMG。小窗把滚轮交给目标应用的
`press_key` `Next`/`Prior`，动作前仍核对当前截图尺寸，视频模式允许画面自然变化。
协议与 Agent、主进程小窗测试通过；ASAR 已核对包含滚轮事件。它仍不等价于
Codex 能针对具体辅助功能滚动元素执行的 `scroll` 工具。

**打包时间说明：**共享浏览器任务结束后，于 23:45 重新构建本地无签名 Mac arm64
DMG。ASAR 检查确认 Windows PID 窗口匹配、浏览器下载记录和按网站授权模块均已
纳入此包。旧的 22:43 包已被同一路径的新包替换。Mac 系统权限、Windows NSIS
构建与 Windows 实机行为仍未通过验收。

## 集成与验收更新（2026-09-28）

本节覆盖上方 2026-09-27 的实现状态；上方的解包证据仍保留。统一集成分支
`codex/memmy-release-integration` 从 `v1.1.9` 提交 `39462d6e` 出发，合入近日的
Memory、History、桌面侧栏、浏览器控制、原生电脑操控和发布修复。新原生 helper
来自仓库内 `App/native-computer-use/` 的 Memmy 自有源码，打包时构建；不再把
`open-computer-use` 0.3.5 当作发布二进制。Mac 的 bundle ID 是
正式 macOS 包中的 helper 与主 App 共用 bundle ID `cn.memtensor.memmy`（开发构建和旧包仍可能是
`cn.memtensor.memmy.computeruse`），Windows 从 Go 源码生成 x64 PE。它们实现同一
九个 MCP 工具接口，但这仍不等于 Codex 私有原生服务的每项行为已经复现。

Chrome/Edge 设置页已加入两条安装路径。主路径在用户明确同意后，为 Memmy 创建
单独的浏览器资料目录，启动本机浏览器的调试 pipe，通过 CDP
`Extensions.loadUnpacked` 安装并用 `Extensions.getExtensions` 验证；这不会修改
用户日常浏览器资料。页面同时提供手动加载未打包扩展的步骤和配对码。真实 Chrome
隔离资料的安装和启用已通过集成烟测，产品设置页的最终安装点击仍待授权后验收。
浏览器共享真实页面、右侧栏导航和设置页在重打包后的 Mac GUI 中已经验收：
侧栏导航 `https://example.com` 后，辅助功能树显示 `Example Domain`。

本机完成的回归：Memory 1057 项通过、1 项跳过；Knowledge 48 项、Backend 937 项、
Frontend 1801 项、Desktop 382 项通过（另 106 项跳过）；Agent 5698 项通过、3 项
跳过；发布与打包守卫、契约和 TUI 测试也通过。根目录及 Agent TypeScript 检查通过。
测试机使用 Node 25，其实验性 `localStorage` 与 happy-dom 冲突，因此相应测试设置
`NODE_OPTIONS=--no-experimental-webstorage` 后分套运行；这不属于产品运行时设置。
Mac arm64 无签名 DMG 的 ASAR、版本、原生 helper 路径和九个工具的 MCP 握手通过。
实机 GUI 第一次启动发现 preload 在 Electron sandbox 中引用 `node:os` 而失败，
现已移除该引用，重打包后登录页、主页、设置和右侧栏正常启动。

**尚未通过的边界**：新 Mac helper 的辅助功能权限是按新 bundle ID 单独授予的；
直接请求 Calculator 快照仍返回 `Accessibility permission is required`，所以不能
宣称原生点击、连续视频 PiP、用户介入保护已在最终包实机验收。该机器只有
Command Line Tools，`swift test` 因缺少 `XCTest` 无法运行；发布构建中的 Swift
编译和 MCP 握手通过。Windows 原生 Go 测试和 x64 PE 交叉编译通过，最终 NSIS
安装、Notepad 输入、遮挡截图和 PiP 仍需在虚拟机中执行。Excel 的 Office.js
本地桥接和工具后端已有实现，但宿主安装和工作簿操作仍未验收；锁屏操作后端未实现。
Settings 对这些待完成环节明确显示提示；不应把设置项展示算作功能。
在这些行为和 Mac/Windows 双平台实机回归完成前，不签收“完整复刻”。

### 9 月 28 日进一步集成

后续合入了 History 与 Memory 的删除状态对账、电脑历史首次开启提示，以及个人微信
来源所需的独立 SQLCipher 资源。首次提示已经在最新 Mac 无签名包的隔离资料中出现；
设置页实机显示「记忆摘要」先于「技能进化」，两项均保持在 BYOK `gpt-5.5`。
SQLCipher 的本地动态加载和打包测试通过。Mac 无签名 DMG 已重新生成并通过 ASAR、
原生 helper 和资源校验，GUI 能启动并显示最新电脑操控设置。Windows x64 NSIS
安装包已完成一轮交叉构建；合入 Windows Memory CLI 入口修复后正在重打最终包。

上节对 Excel 的表述需要细分：Office.js 本地 HTTPS 桥接、manifest 和 `excel_live`
工具已有实现与模拟测试；证书信任配置、Excel 宿主内侧载和实际工作簿读写仍未验收。
锁屏 guardian 仍未实现。Mac 最新 helper 的 Calculator 快照仍因该新 bundle ID
缺少系统辅助功能授权被拒绝；Windows 虚拟机加密未解锁，尚不能执行安装和输入测试。
