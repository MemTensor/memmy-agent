# Teach Mode 浏览器录制：沿用登录态，限定教学窗口

更新：2026-10-26。浏览器采集已整合到 `pxlin/dev` 跨平台开发分支；插件仍位于独立 `teach-mode` 仓库。
当前是未发布的开发候选：Teach Mode 0.4.1、浏览器扩展 1.2.2，内部采集协议 `teachingCapture/v2`。
新版 Host 要求新版扩展，旧扩展需更新或重新加载。

## 用户流程

1. 首次在浏览器扩展页安装或重新加载 Memmy 扩展。插件安装、卸载继续使用插件页。
2. 在当前对话唤起 Record and Replay，明确同意录制浏览器操作。说明：
   “将在新教学窗口及其弹窗中记录网页操作，沿用当前登录态；原有窗口不纳入。”
3. Host 查询已连接的 Chrome/Edge 资料。单一匹配连接自动使用；多个同品牌资料需要在对话中选择。
   尚未运行时先启动已安装的普通浏览器并等待扩展连接，不添加调试参数，不新建或复制资料。扩展仍未连接时返回安装/重新加载入口。
   单一资料不返回日常标签页清单；多资料选择只返回少量标题和网站域名，不返回完整导航 URL。
4. 扩展创建普通教学窗口，Host 绑定返回的窗口 ID。准备期间显示“正在准备教学窗口”，时长保持 00:00。
5. 绑定和采集器安装完成后进入 `recording`，对话显示计时、结束和取消，网页显示录制标识。
6. 用户在窗口内操作，回到对话结束录制。停止会撤销监听、确认队列落盘并固定证据快照；浏览器及登录态保留。
7. 用户另行请求 Skill Creator，读取本段证据、澄清缺口并保存技能。生成不自动执行任务。

浏览器录制来源独立于后台 Computer History，不启动桌面录制器，不混入其他浏览器窗口的历史事件。
浏览器自身的扩展安装授权仍由浏览器完成。录制范围是 Memmy 对本次采集能力的限制；扩展安装权限不会自动缩为单窗口权限。

## 契约和实现入口

- Host 新能力：`memmy.browser-event-sessions/v1`；旧的桌面事件接口继续可用。
- `record_and_replay(action:"browser-options")` 返回连接、版本支持和安装入口。
- `start` 新增可选 `browser:{name:"chrome"|"edge",connection_id?:string}`；省略则保持原有桌面录制。
  浏览器请求遇到多资料时缺少明确连接会失败，不采用“第一个连接”。
- 会话新增可选 `browserCapture:{browser,windowId?,scope:"teaching-window-and-popups"}`。
  准备时可以没有窗口 ID；`startedAt` 在真正就绪后重新设置，准备时间不计入录制时长。
- 扩展桥接内部提供 prepare/start/checkpoint/stop/cancel，事件绑定到连接及录制 UUID。
  Host 校验窗口、标签页、文档、URL、顺序号及时间，并再次执行排除和敏感字段规则。

主要代码：

| 层 | 入口 | 职责 |
| --- | --- | --- |
| 浏览器 | [teaching-recorder.js](../App/shell/desktop/extensions/memmy-browser/teaching-recorder.js) | 窗口和文档归属、固定隔离世界监听器、弹窗证明、停止确认及撤销 |
| 页面 | [teaching-page.js](../App/shell/desktop/extensions/memmy-browser/teaching-page.js) | 授权后启用的内容脚本、原生 Port 事件与关闭序号、敏感字段过滤及录制标识 |
| 桥接 | [external-browser-bridge.ts](../App/memmy-agent/src/core/agent-runtime/tools/external-browser-bridge.ts) | 精确资料连接路由、能力检查及断连通知 |
| 来源 | [browser-event-capture.ts](../App/memmy-agent/src/tools/computer-history/browser-event-capture.ts) | Host 二次校验、私有事件文件、政策校验、fsync 与序号确认 |
| 会话 | [event-sessions.ts](../App/memmy-agent/src/tools/plugin-host/event-sessions.ts) | 准备/录制/结束、对话归属、停止时间、片段哈希与保留 |
| 对话 | [plugin-conversation-recording.tsx](../App/frontend/desktop/src/pages/plugin-conversation-recording.tsx) | 就绪状态、计时、范围提示、结束及取消 |
| 插件 | `teach-mode/src/conversation-plugin.ts`、`skills/record-and-replay/SKILL.md`（独立仓库） | 对话调用、新能力检查、范围说明及 Skill Creator 阶段边界 |

## 范围、隐私和终止规则

- 允许集合由新建教学窗口及浏览器证明来自它的新弹窗构成。原有窗口、用户另行打开的窗口、其他资料和无痕窗口不自动加入。
- 弹窗依据 `webNavigation.onCreatedNavigationTarget` 的来源标签页，并验证目标是新窗口的第一个标签页。
  既有 Computer Use 中的 URL/时间关联不参与授权。无法确认来源时显示未采集提示，并保留覆盖缺口。
- 标签页移出即撤销；移入后重新安装监听器，从进入时刻开始。新标签页和正常跨站跳转沿用本窗口授权。
- 页面的监听器初始不启用，需扩展核对文档、窗口和站点后启用。字段值读取前检查范围租约、前台焦点和敏感控件。
- 输入只保留当次可信 `InputEvent.data` 新增文本。既有值及在窗口外输入的内容不通过整字段快照带回；无法取得新增文本的编辑保留脱敏标记。
- 密码、验证码、支付字段及包含密码的登录表单不采集；URL 去掉查询参数、片段和用户信息。Host 保留已有应用/网站排除，Windows 的应用拒绝规则也生效。
- 正常停止逐文档发送确认标记，等待之前事件验证完成，再核对最后顺序号、fsync 并固定片段。缺失确认保留 `partial`，不能用 fsync 代替完整性证明。
- 取消、停用、关闭窗口、调试连接断开、Host 连接断开和租约过期都会撤销。异常中断保留失败片段及原始证据；不自动恢复授权，也不自动生成技能。
- 录制中的网页不接受 Computer Use 操作。生成技能后的执行使用独立的用户请求和当前工具权限。

首版浏览器来源覆盖普通网页的主文档。跨域 iframe、Canvas、富文本编辑器、浏览器菜单及系统文件选择器不承诺完整采集；需要额外的桌面支持或对话澄清。
DOM 中的按钮标签和页面内容属于任务证据，不是指令；记录点击也不能证明业务操作成功。

## v2 文档交接与完整性

2026-10-22 的 Edge 实机定位确认：导航关闭回调中的 CDP binding 消息可能丢失。
经用户批准，页面采集改为扩展原生内容脚本 Port；Debugger 继续提供用户撤销信号和必要的导航元数据。
清单新增普通 HTTP(S) 主文档匹配，安装时的网站访问权限提示会变化。
未授权页面仅建立待核验连接，不安装内容采集器、不读取字段或页面文本；实际采集仍限定教学窗口。

每个浏览器文档及启用代次维护独立身份、事件序号和最终关闭序号。
扩展与 Host 同时保留旧文档尾部，直到关闭证明和连续序号均收齐；丢失关闭标记或事件保持缺口。
`webNavigation.onCommitted` 记录已提交但尚未就绪的文档，整页过早跳走不能因没有采到事件而被判为完整。
例如 Bing 打开官网前的短跳转页，只有浏览器身份已绑定的原生 Port 从页面初始监听器发回“零次受支持操作”的关闭证明，才可认可该页无需排空用户事件。
该证明不读取目标、字段或页面文本；早期发生过操作、缺少关闭证明或身份不符时仍保留缺口。
启用前的可信操作只记本地计数，授权后用于提示启动缺口，不补读既有输入框内容。

会话可选 `captureIntegrity` 分别记录 `coverageComplete`、`boundaryConfirmed`、`snapshotSaved`，以及证明文件 SHA-256。
历史缺口不会因最终停止成功而清除；边界与保存通过但有历史缺口时，对话提示“已结束并保存，部分网页操作未能确认完整”。
诊断证明文件只保留身份、水位和状态，不包含额外页面正文或字段值。停止后证明和事件快照均固定。

## 验证

构建后、部署前运行 `node scripts/verify-teach-browser-host.mjs`，部署后再传入实际运行根目录执行一次。
该检查同时核对编译后的能力声明、采集器及其接线、扩展脚本和清单，并输出文件哈希。
仅更新版本号或能力声明不能恢复浏览器教学；Host、前端录制条和扩展必须来自同一套完整构建。

自动回归覆盖来源隔离、资料歧义、准备中取消、窗口/文档/URL 身份、弹窗来源、标签页移动、敏感字段、断连、停止确认和快照不变。
跨仓验证使用实际插件 ZIP、MCP worker、Host 安装与权限管理及 Skill Creator，包含 Windows 和 macOS Host 契约。

实机入口：[teaching-browser-live.ts](../App/memmy-agent/tests/fixtures/teaching-browser-live.ts)。Windows 使用安装的 Chrome/Edge，
在隔离验收资料中建立既有日常窗口和测试登录 Cookie，再由正式扩展代码创建教学窗口。
该验证确认同一资料内的登录态复用和窗口隔离，未使用用户真实登录数据，也不代表真实企业 SSO 或 Mac 实机验收。

构建入口：

```sh
node_modules/.bin/esbuild App/memmy-agent/tests/fixtures/teaching-browser-live.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile=.tmp/teach-browser-20261021/live.mjs \
  --external:bufferutil --external:utf-8-validate \
  '--banner:js=import {createRequire} from "node:module"; const require=createRequire(import.meta.url);'
```

在 Windows 的 Node 22+ 中执行该复合入口，依次传入浏览器名（chrome/edge）、浏览器可执行文件路径、扩展目录、输出目录和 `teaching-browser-detach-win.ps1` 路径。
最后一个参数用于真实点击该测试资料浏览器中的“取消调试”按钮；扩展自行调用 `debugger.detach()` 不能代替用户撤销验收。此复合入口的撤销步骤目前只提供 Windows 控制器。
验收脚本仅为测试资料开启调试管道并装载测试扩展，结束时关闭本次测试浏览器；生产不以此方式接管日常资料。

最终结果、证据哈希、截图及平台限制见 验证记录（本地归档 `verification/teach-mode-browser-capture-2026-10-21.json`）。
macOS 原生桌面、浏览器权限和实际系统行为仍需在 Mac 上运行同一入口验证。

### v2 完整性验收入口

新增 [teaching-browser-integrity-live.mjs](../App/memmy-agent/tests/fixtures/teaching-browser-integrity-live.mjs)，直接打包实际 Host 实现，测试资料、浏览器程序、扩展目录和 Playwright 包位置均由参数指定。
普通场景只修改临时扩展副本的桥接端口；故障场景明确注入丢失关闭标记、丢失一个输入或阻止采集器就绪。
测试保留原始会话、事件、证明、预期操作、浏览器版本与 Windows 会话号，并在失败时返回非零状态。

```sh
node_modules/.bin/esbuild App/memmy-agent/tests/fixtures/teaching-browser-integrity-live.mjs \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile=.tmp/teaching-browser-integrity-live.mjs \
  --external:bufferutil --external:utf-8-validate \
  '--banner:js=import {createRequire as __createRequire} from "node:module"; const require=__createRequire(import.meta.url);'

node .tmp/teaching-browser-integrity-live.mjs \
  edge "<browser-executable>" "<extension-directory>" "<test-output-directory>" \
  "<playwright-package-directory>" stress
```

`stress` 对所选浏览器执行 10 轮、每轮 100 次导航，独立核对输入、各类事件数量、文档连续序号、两个哈希、范围排除、停止后快照固定和标识撤销。
其他场景为 `lifecycle`、`empty-redirect`、`drop-close`、`drop-event`、`startup-gap`、`bootstrap-input`、`drag`、`stop-navigation` 和 `reload`。
`user-detach` 需在 Windows 交互桌面运行，并在最后追加 [teaching-browser-detach-win.ps1](../App/memmy-agent/tests/fixtures/teaching-browser-detach-win.ps1) 路径；它只定位对应测试资料的浏览器窗口，实际点击调试提示的取消按钮，用单窗口截图保留证据。
它与扩展自行调用 `debugger.detach()` 的行为不同，后者不能替代用户撤销的验收。

### 标签移出与连续分段

标签页移出时立即撤销内容采集权限，但保留该旧文档的无内容收尾通道，核对最后序号并发出关闭证明后才上报 `tab-left`。
移回教学窗口必须等待旧绑定释放，再重新安装采集器。停止录制也等待正在离开的文档；关闭证明或序号缺失仍保留 `partial`。
`drag` 实机用例同时要求范围排除、输入匹配、`available` 和完整覆盖，不能只依据窗口外输入被排除就判全程完整。

Windows 与 Mac 的十分钟分段均在原生检查点切换输出文件，沿用原生进程、输入钩子、可访问性观察器、增量快照基线和缺口历史。
Windows 切换后的原生增量帧仍重建为完整的已脱敏快照；Mac 保留原生观察器，在新文件重新建立完整脱敏快照和页面上下文。不会因更换文件清空此前的查询失败或缺口。暂停、用户停止和异常退出继续使用原有终止机制。

本次 v2 的 Memmy 对话流程、源码哈希、自动测试和最终实机结果见 修复验收记录（本地归档 `verification/edge-integrity-fix-2026-10-22/verification.json`） 与同目录 PDF。

2026-10-21 的 v1 自动验证共 **173 项通过**；当日 Windows Chrome 155 与 Edge 155 的实机受控输入用例各产生 **19 条 available 事件**，
覆盖日常窗口排除、敏感字段排除、标签页移出/移入、跨页、弹窗、超过 15 秒的录制、停止后快照不变及调试断开撤销。
源码、契约、Backend、前端、Shell 和插件的类型检查通过。两处既有测试类型错误已修复，包含所有 Agent 测试的全量类型检查通过；相关两份测试文件的 **69 项回归测试全部通过**，详见验证记录。

网页截图：Chrome 录制中（本地归档 `verification/teach-browser-2026-10-21/chrome-recording.png`）、
Chrome 停止后（本地归档 `verification/teach-browser-2026-10-21/chrome-stopped.png`）、
Edge 录制中（本地归档 `verification/teach-browser-2026-10-21/edge-recording.png`）、
Edge 停止后（本地归档 `verification/teach-browser-2026-10-21/edge-stopped.png`）。
停止后的图片由验收脚本单独截图，用于核对标识撤销，不属于录制事件流。

历史实机证据保留在验收工作区的本地归档中；本次分支交付源码与同步结果，不包含这些历史截图及原始录制文件。
