# Codex 内置浏览器解包记录（macOS）

记录日期：2026-09-27。分析对象为本机 `/Applications/ChatGPT.app`（Bundle ID `com.openai.codex`，版本 `26.924.22138`）。这里只记录可观察的组件、设置和调用边界，不复制安装包内的专有代码。

## 浏览器与 Computer Use 的关系

Codex 的浏览器是独立的浏览器服务和资料分区。`@oai/browser-desktop` 负责内置浏览器会话，`unified-computer-use` 将浏览器和原生应用控制接入同一个上层入口。浏览器 PiP 由主进程消费工具结果中的 `codex/toolSurface` 元数据更新；原生应用由另一套 macOS 服务处理。详细的 Computer Use 层次见 [codex-computer-use-unpack.md](./codex-computer-use-unpack.md)。

因此浏览器复刻与现有 Computer Use 任务需要共用“浏览器会话和展示协议”，但浏览器资料、站点权限和历史记录属于浏览器自身，不能由桌面应用控制器代替。两个任务若分别创建浏览器会话，用户看到的登录状态和 Agent 操作的页面就会分离。

2026-09-28 对当前安装包复核：`@oai/browser-desktop/environment-docs/codex-app/tab-mentions-iab.md` 明确将用户提及的内置浏览器标签页按 `browserId`、`tabId`、标题和 URL 解析，再从同一内置浏览器取回该标签页；文档还说明内置浏览器已打开的标签页可被 Agent 获取。`@oai/cua/dist/.../create_browser_api.js` 的 `getTab` 先查托管标签页，必要时从 `user.openTabs()` 找到并 `claimTab`，而不是另建一个外观相同的页面。`tab-cleanup-iab.md` 区分 Agent 新建的临时标签页和用户原有标签页的生命周期。由这些包内接口可确认“用户和 Agent 可操作同一个被选中的内置标签页”是 Codex 的实际能力；它不是另行假设的产品要求。具体的并发焦点策略仍以实机观察为准。

更细的会话规则也在包内写明：用户发出的标签页提及含 `browserId`、`tabId`、标题与 URL，Agent 要逐项匹配当前列表；标题或 URL 已变化时应报告不可用，不能静默换成另一页。Agent 新建页默认在回合结束时关闭，显式标为交付或交接的标签页才保留；用户原有页不随 Agent 回合结束而关闭。Memmy 后续多标签与提及实现应按这些可观察规则验收。

同日黑盒复核：在 Codex 内置浏览器创建 `https://example.com/` 标签页，`listTabs` 返回 `id=1` 与唯一 `providerTabId`；随后通过该 URL 调用 `getTab`，取回的仍是 `id=1`。使用取回的句柄导航到 `https://www.iana.org/help/example-domains` 后，原句柄的 `url()` 与标签列表都同步变为 IANA 页面，标签 ID 和 `providerTabId` 未变。测试后关闭临时标签页。这进一步证明 Agent 句柄指向已有页面，而不是另开一份副本；未由此推断后台并发点击和焦点仲裁的细节。

另用 `tab-v1` 提及做黑盒验证：对 `https://example.com/` 的临时标签页传入当前 `browserId`、`providerTabId`、标题和 URL，`getTab({mention})` 返回同一 `id=2`；只改提及中的标题时返回 `Stale tab mention`。把原标签页导航到 IANA 后，标签 `id` 仍为 `2`，但原提及因标题或 URL 不再匹配而被拒绝。临时页已关闭。这验证了包内文档所述的精确匹配及变更后拒绝规则；`id=2` 只是该次测试的临时值。

## 已核实的设置模块

本机 `app.asar` 的 `webview/assets/browser-use-settings-*.js` 包含截图里的设置定义：

| 设置 | 包内可见的行为线索 |
| --- | --- |
| 内置浏览器控制 | `in_app_browser` 功能与 Browser Use 插件状态共同决定开关是否可用。 |
| 网页、本地 URL 的打开位置 | 分别存储为两项偏好，目标为内置浏览器或系统默认浏览器。 |
| 显示完整网址 | 控制地址栏是否包含路径、查询参数和片段。 |
| 浏览数据 | 可分别清除 cookie、站点数据、缓存、下载历史和浏览历史，也有统一清理入口。 |
| 浏览历史 | 独立页面支持搜索、来源筛选、打开页面、删除所选记录。 |
| 密码与自动填充 | 密码管理和联系人信息分别进入嵌入式 Chromium 设置页。 |
| 站点设置 | 嵌入式 Chromium 设置页管理摄像头、麦克风等网站权限。 |
| 批注截图 | Memmy 已移除该入口，不作为当前浏览器能力。 |
| 下载 | 设置下载位置、下载前询问、查看和管理下载历史。 |

[OpenAI 官方浏览器文档](https://learn.chatgpt.com/docs/browser)还说明了独立浏览器资料、历史记录、站点访问确认、浏览器评论和 Computer Use 控制；其中的云端浏览器是另一种产品路径，不能直接当成本机桌面实现。

## Memmy 阶段落地范围（`14ced42c`）

Memmy 当前右侧浏览器使用 Electron `webview` 和 `persist:memmy-browser` 分区，支持直接输入网址、点击网页、表单输入、站内导航、前进、后退和刷新；关闭侧栏后保留该分区的站点数据。`will-attach-webview` 限定了分区与 HTTP(S) 页面，并关闭 Node 集成。Agent 的 Browser Use 仍使用单独的托管 Playwright 会话，Computer Use 浮窗订阅 Agent 的画面。两者目前不是同一标签页，也不共享登录状态；不能把侧栏人工浏览的成功当作 Agent 同页操作的验收。这里的同页能力来自上述 Codex 包内证据，而不是用户另外指定的实现方案。批注截图曾作为早期实验入口存在，当前已按最小内嵌浏览器取舍移除。

右栏的浏览历史和上次网址由渲染器保存；下载记录由主进程写入独立的 `webview-downloads` 目录与索引。用户可选择下载目录或每次询问保存位置；列表只展示文件仍存在且路径通过校验的记录。清除浏览数据会清理嵌入式浏览器分区、侧栏历史和下载索引，不会删除已下载文件。网站授权保存在独立文件中，不随该操作清除。Agent 浏览器原有的 Playwright 下载记录与侧栏下载记录分开。

主进程仍为嵌入式浏览器分区设置安全权限回调，未授权的设备与主机能力默认拒绝；但右栏不再提供网站权限管理面板，也不提供截图批注。`capturePage()` 只保留给内部浏览器/Agent 通道使用。

**这一阶段仍未达到 Codex 的整套 Browser Use。**侧栏没有 Chromium 原生密码保存、自动填充和完整内容设置；其历史使用渲染器存储，尚未覆盖所有可能的访问。Agent 托管浏览器与侧栏在此阶段仍为两个会话。

## 2026-09-28 同页通道（`94514574`）

Agent 的桌面 Browser Use 现可通过子进程 IPC 控制右侧真实 Electron `webview`：
主进程取得实际 `WebContents`，用 CDP 的可访问性树、输入、导航和截图接口执行工具；
站点访问沿用 Agent 原有的授权流程，目标标签页由 `WebContents.id` 固定，关闭右栏
或在已登录工作区页面间切换不会销毁该页。用户刚在目标页输入时写操作会暂停。
若没有可用内置页，Agent 请求网页导航时可打开右栏页面；不适合接管的已有页仍
使用原有托管浏览器路径。

这是按包内 `openTabs` / `claimTab` 和同一标签 ID 黑盒结果补出的能力，**不是用户
指定的特定技术方案**。代码测试已通过，当前最终安装包的同页、焦点与截图验收仍在进行。
`58e0c11f` 又为右栏加入多标签实例、当前标签选择以及按实际 guest ID 继续操作
已绑定标签页的路径；Agent 未绑定任何页时，导航会新建页而不覆盖用户原有页。
源码复核又发现一个路由边界：Agent 导航时用户若停留在设置等工作区页面，
原先由首页订阅的“新标签页”事件可能没有监听者。现把 IPC 订阅移到常驻路由层，
并让延后挂载的首页消费待打开标签。此修复已进入 `57823390` 的 Mac/Windows
测试包，但 Mac 的该次签名包带 `signed-local` 隔离资料标记，不能直接作为普通升级包
启动；Windows 包已安装并验证右侧栏可以展开。两平台同一标签页的 GUI 行为仍须实测。
Codex 的标签页提及四字段精确匹配、Agent 临时页回合清理、完整密码管理、
跨框架网页动作、原生应用 PiP 与 Windows 安装体验仍未签收。

## 2026-09-28 标签引用与临时页生命周期（`162e8553` 已集成）

右栏标签可复制包含当前浏览器会话 ID、真实 `webview` ID、完整标题和 URL 的
`tab-v1` 引用。Agent 接收引用时重新列出当前标签，四项必须精确匹配；过期引用
直接报错，不回退到选中标签或新建页。浏览器会话 ID 在桌面进程启动时生成，
旧进程的引用不能指向新进程中碰巧复用的页 ID。

Agent 新建的内置标签默认在回合结束时通过主进程通知右栏卸载对应 `webview`；
用户原有标签只关闭 Computer Use 展示。Agent 可在浏览器工具调用中设置
`tabDisposition=deliverable` 或 `handoff` 保留新页。本回合的标记在回合结束
后清除；后续回合只有再次操作该页且未重标记时才会关闭它。上述路径已并入总分支，
契约、路由、主进程和前端交互定向测试共 31 项通过，Frontend、Agent、Desktop
类型检查通过；打包应用中的 GUI 行为仍待实机验收。

## 2026-09-29 内置浏览历史 Agent 查询

Memmy 现为真实内置 `webview` 导航单独记录历史。右栏历史页和 Agent 查询读取同一份主进程历史；删除单条及“清除浏览数据”会同步影响两者。`browser_history` 仅在桌面托管交互任务中可用，必须同时给出关键词与带时区的 ISO 8601 起止时间；单次范围最多 30 天、返回最多 50 条。桌面主进程在每次读取前显示关键词、时间范围和条数的应用级授权对话框，拒绝时不返回任何历史。数据来源只限 `persist:memmy-browser` 的内置页，不读取 Chrome、Edge、托管 Playwright 资料或 Computer History。升级时，旧版侧栏 `localStorage` 中的内置页历史经受控主进程接口一次性迁入；迁移校验 URL、条数和大小，按 URL 去重并保留较新的记录，写入成功后才删除旧键。旧 `browser-history.json` 中的投影页面记录不混入内置页历史。

这一阶段补上包内 `browser.history()` 的受约束读取路径；当时历史管理页的来源筛选、分项清理、下载记录逐条管理尚未实现。最终打包 GUI 的弹窗、拒绝和清理行为还须实机验收。

## 2026-09-29 浏览器历史与数据管理补齐

进一步只读复核当前 Codex 安装包的 `webview/assets/browser-use-settings-63e741d711f6.js`：
历史页 `sourceFilterWithValue` 的选项为 `all`、`agent`、`other`，页面搜索把
`visitSource` 传给 `browsingHistory.searchHistory`；清理项为 `cookies`、`siteData`、
`cache`、`downloads`、`history`。下载历史中已完成记录的操作名称是
`Remove from download history`，调用 `removeFromHistory({id})`。这些是设置页
行为证据，未据此推断 `browser.history()` 工具额外接受来源参数。

Memmy 的内置页历史现在记录 Agent 与其他导航来源，右栏可按 `All / Agent / Other`
筛选，并可删除单条或所选记录；同一主进程索引供右栏与 Agent 查询读取。
Agent/Other 按实际内置页上的操作来源归类：Agent 发起的导航或网页动作及随后
触发的导航标为 Agent，用户地址栏、工具栏和网页输入触发的导航标为 Other。
来源归类对延迟超过 10 秒的跳转采用保守回退，且目前每个 URL 只保留最近访问，
因此尚未达到 Codex 按每次访问记录筛选的精度。

清理页可分别选择 Cookie、站点存储、HTTP 缓存、内置页下载索引、内置页浏览历史；
主进程仅作用于 `persist:memmy-browser` 和对应索引。清除下载历史或单条删除记录
只改索引，不删除已下载实体文件。旧版侧栏历史迁移完成后，清除浏览历史也会
移除旧键和上次网址，避免升级记录重新进入主进程索引。托管 Agent 浏览器资料、
外部 Chrome/Edge profile 和 Computer History 不在这些清理项内。

内置浏览器下载现在会在主进程保留进行中状态和字节进度，面板可暂停、恢复、取消；
完成、失败、取消后写入该分区的下载历史。已下载文件在外部被移走时，记录仍显示
“文件已删除”，但不提供显示文件操作。删除记录只改索引，不删除文件。下载任务的
控制对象只在当前进程存活；应用重启后不会续传未完成的任务。

## 内置浏览器扩展管理边界

本机 Codex 包 `webview/assets/browser-use-settings-63e741d711f6.js` 的内置浏览器设置页
有 `Extension manager` 入口，说明为 `Install, remove, and configure browser extensions`。
这只能证明入口和产品意图，不能推断其安装协议或所支持的 Chrome API。Memmy 使用
Electron 38 的持久 `Session.extensions` API 管理未打包扩展；该 API 明确要求每次启动
重新调用 `loadExtension`，且不支持 `.crx`。

Memmy 的主进程只通过原生目录选择取得用户指定的未打包扩展，并在可见确认中展示
扩展名、版本、目录及 manifest 声明的权限、站点访问范围和内容脚本匹配网站。
批准后把经完整指纹校验的目录复制到 Memmy 自有的受限快照目录，只从该副本加载。
重启时仅恢复指纹未变的已批准副本。原目录变化会在列表标记“需要重新批准”，
但不会自动运行变化后的代码；用户须重新选择同一目录并确认当前权限才能更新。
目录树中的符号链接、超限文件数或容量被拒绝，渲染进程不能传入任意目录路径。
该管理器仅接入 `persist:memmy-browser` 分区，不会扫描或修改个人 Chrome/Edge profile。
最终打包 GUI 的安装、拒绝和移除行为仍须实机验收。

## Agent 文件传输审批边界

本机 Codex 包的 `browser-use-policy-site-permissions` 设置页把 Browsing、Downloads、
Uploads、Debug / CDP 分成四列，支持 Block、Requires approval、Always allow，并展示
`https://*.example.com` 站点模式。进一步核对包内 `app-shared` 的 origin pattern parser
及 `browser-use-policy-site-permissions` 的有效策略计算：匹配保留 HTTP(S) 协议、端口，
`*.example.com` 仅覆盖子域，`**.example.com` 同时覆盖根域；匹配项中的 Block 优先，
其余以后匹配的规则为准，最后使用默认值。Memmy 将 Browsing、Downloads、Uploads、Debug / CDP
规则保存于 Agent 专用的 `browser-use/site-policy.json`，设置页可增删和编辑；
默认需要审批，Block 在浏览与文件传输操作点直接拒绝，Always allow 跳过逐次审批。
旧版单站点浏览授权仅在没有匹配的新规则时生效；已建立的浏览会话也实时检查 Block。
规则不读取或修改外部 Chrome/Edge profile。无效或损坏的策略文件按 Block 处理。

托管 Playwright 下载在写入目标文件前，以触发下载的页面站点和建议文件名请求桌面
应用级审批；拒绝时不显示保存位置对话框、不调用 `saveAs`。托管 Playwright 上传只在
当前会话恰有一个页面、文件是可信工作区内的普通文件时开放；桌面审批只显示站点和
文件名。批准后复核页面 URL 与文件 inode，临时复制到 Playwright MCP 可读取的私有
目录，以 `0600` 权限保存，并在成功、失败、取消后清理。审批只对一次工具调用有效。

Agent 对内置 `persist:memmy-browser` 页上传时必须指定当前所选标签中的文件输入节点
引用或唯一 CSS 选择器。桌面主进程验证工作区文件、当前标签和站点，再显示一次审批；
批准后驱动复核文件节点、站点与 inode 才调用 `DOM.setFileInputFiles`。审批等待最多五
分钟，晚批准及 Agent 回合取消不会继续执行。用户自己在内置页使用原生文件选择器的
行为不经过 Agent 工具。外部 Chrome/Edge 已连接标签的 Agent 上传也按次显示应用级
审批；审批前后绑定同一扩展连接、标签、URL、站点与文件快照，复制私有 `0600` 临时
文件，扩展在调用 `DOM.setFileInputFiles` 前复核当前标签、站点和真实文件输入节点；
拒绝、页面跳转、标签关闭、文件变化和回合取消均不发起 CDP 上传。此调用方式由
[Chrome 扩展 debugger 文档](https://developer.chrome.com/docs/extensions/reference/api/debugger)
及 [CDP DOM.setFileInputFiles 协议](https://chromedevtools.github.io/devtools-protocol/tot/DOM/#method-setFileInputFiles)
支持，尚未在真实 Chrome/Edge 扩展安装环境验收。包内
`plugins/browser/docs/capabilities/tab/cdp.md` 还确认 raw CDP 的实际入口是
`tab.capabilities.get("cdp")`，提供 `send` 与 `readEvents` 并限定当前 web origin；
文档描述可发送“permitted CDP command”。进一步读本机
`plugins/browser/scripts/browser-service.mjs`：约字节偏移 `856056–859307` 的 CDP
方法过滤器列出允许的协议域，排除 CacheStorage、Database、Storage、Target、WebAuthn
等整个域，以及 `DOM.setFileInputFiles`、`Input.dispatchKeyEvent`、`Page.navigate`、
`Page.setDownloadBehavior` 等方法；还禁止会覆盖 Browser Use 文档拦截或授予额外权限
的部分参数。约 `862500–864050` 的实际 `TabCdpCall` 处理器只接受浏览器扩展或内置
浏览器标签，先做 full CDP 站点策略与用户授权，再从 `Fetch.continueRequest`、
`Network.getCookies`、`Network.setCookie` 等参数提取目标 URL 分别校验；请求拦截或
凭据保护运行中还会阻止冲突命令。约 `580986` 的可见审批将 raw CDP 标为高风险，
提示“full Chrome Developer Tools access”。这些是运行逻辑证据，并非只凭设置页推断。
Memmy 提供 `browser_cdp_read`、`browser_cdp_events` 与 `browser_cdp_send`。三者只
作用于当前选中的内置 `webview` 或用户已连接的 Chrome/Edge 标签，不会切换到
托管 Playwright 或个人浏览器资料。只读求值强制 `throwOnSideEffect`；写入型 send
按上述运行时门禁允许 22 个协议域，排除 26 个明确禁止的方法、另外 7 个目标
URL/命令表中标为阻断的方法及 `Fetch.disable`，并校验会破坏文档拦截或启用额外
浏览器权限的参数。`Fetch.continueRequest`、响应 Location、Network Cookie 命令
等显式目标 URL 会逐个取得站点访问和 Full CDP 授权，拒绝时不调用 CDP。
Debug / CDP 规则默认 Block；Requires approval 对每次调用显示桌面应用级审批，
send 的审批明确标为高风险并显示方法与当前站点。审批和结果绑定标签、站点与
Agent 回合；跨站导航清空事件缓存，命令等待期间离开后又返回也拒绝旧结果。
事件按序号读取，缓冲上限 500 条。`target.sessionId` 或 `target.targetId` 只解析
当前标签已附着的 iframe 子目标，发送前后复查子目标的实时 URL 与附着版本；
`Input.*` 也发送到指定子会话。子目标可以跨 origin：这是本机 Codex
`browser-service.mjs` 约 `761224` 的 `rawCdpTarget` 归属校验和
`862500–863500` 的 `TabCdpCall` 顶层站点审批顺序所示行为，子目标并无独立站点
审批。跨标签或已脱离目标拒绝。事件记录来源中的 `sessionId`/`targetId`，可在目标
脱离后按来源读取；`timeoutMs` 最多等待 30 秒匹配事件，未给 `afterSequence` 时从
当前游标等待未来事件。顶层导航清空旧事件。Memmy 的密码/联系人填充和文件上传
运行期间阻断 raw CDP 写入，反向并发也阻断填充和上传。

`browser_cdp_read` 和 `browser_cdp_send` 的 `timeoutMs` 限定命令等待时间，
默认 3 秒，最多 30 秒；等待超时会返回错误，但底层 CDP 调用可能仍在执行，
因此写入期间的填充/上传互斥一直保持到 debugger 实际完成。外部桥接等待 45 秒，
内置桥接等待覆盖最长 5 分钟审批与 30 秒命令，避免桥接先行超时。
Codex 在 Browser Use 文档响应拦截或凭据保存时还会阻断冲突
raw CDP 命令；Memmy 目前没有同等的文档响应拦截器或浏览器凭据保存流程，因此
只协调现有的填充和上传窗口。`Target.setAutoAttach` 在两种浏览器通道中只启用
iframe，浏览器不支持时子目标不可用。当前标签上的允许方法及子目标命令仍需
最终安装包实测，包括扩展 debugger 通道是否接受相同命令与生命周期取消行为。

## Memmy 当前取舍（2026-09-29）

Memmy 不继续复刻 Codex 的页面批注，也不向用户暴露网站权限管理面板。浏览器侧栏保留
最小的内嵌浏览器能力：打开 HTTP(S) 地址、前进、后退、刷新、输入网址，以及现有的
页面导航与持久浏览器分区。截图批注组件、批注附件事件和对应设置已移除。

嵌入式 Chromium 的权限回调仍保留在主进程作为安全边界，未明确授权的设备和主机能力
默认拒绝；这不是一个需要用户维护的权限产品，也不代表 Memmy 继续承诺 Codex 的完整
网站权限管理体验。

## 复核入口

```sh
plutil -extract CFBundleShortVersionString raw -o - /Applications/ChatGPT.app/Contents/Info.plist
cat /Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/browser/.codex-plugin/plugin.json
find /Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/browser/docs -maxdepth 1 -type f
```

`app.asar` 可用仓库已有的 `@electron/asar` 读取。打包文件名中的 hash 可能随 Codex 升级改变。
