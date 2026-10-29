# 浏览器执行层整体修复与验收交接（2026-10-15）

本轮接续 `30caf7a16` 的快照挂起修复，目标是让连续网页任务可用。初次现场证据见 [快照挂起交接](browser-snapshot-stall-20261015.md)。本文件记录后续整体修复；最终验证结果以本文件为准。

## 已确认的根因和改法

| 根因 | 影响 | 本轮处理 |
| --- | --- | --- |
| Chrome 扩展用父 target 查询已附加子 target 的信息，真实 `chrome.debugger` 返回 `Not allowed` | 跨域 iframe 的初始化命令全部被前置校验拒绝，Playwright 等不到页面上下文 | 外部插件和内置浏览器统一通过已经登记的 child session 查询其自身 `Target.getTargetInfo({})`；仍核对 session、target ID、类型、URL、修订和授权 |
| task 的元素引用和诊断数据放在短暂的 CDP 连接里 | 预览失败、空闲断连、跳转回收后，刚读取的引用或动作日志丢失 | 观察结果和有界诊断归 task/tab 所有；连接可回收，真实文档换代仍使旧引用失效 |
| 子 frame 更新清除全部远端对象，或者新一轮根树覆盖未包含在其中的 OOPIF | 子页面刷新破坏主页面句柄，连续两步操作无法继续 | 对象按 session/context/frame 管理，只失效相关子树；保留经认证且仍存活的跨进程子页面映射 |
| frame 结构、导航、上下文事件到达顺序不一致；被禁止 frame 仍进入 Playwright 可见树 | 等待尚未建立的世界，或等待策略本来就禁止的内容 | 先发布可信结构，再发布导航和上下文；物理树与允许发布的树分别维护；未知 frame 有界等待，截图和无明确目标的输入保持拒绝 |
| 仅靠连接是否存在判断缓存有效 | 空闲时子页面同 URL 刷新后仍复用旧上下文 | 两个桥接层维护 `frameEpoch`，所有 frame 结构及导航变化都推进代数；旧插件缺该字段时每轮重连，沿用已有自动更新机制 |
| 停止 task 只清理当前连接，队列还可能继续 | 已停止任务排队的操作仍有机会派发 | task 状态同步撤销；运行中操作终止，排队操作校验原 owner；旧结果不能重新写入已结束 task |
| 连接回收清理的等待期间 task 已结束，或者最后一次标签页查询期间 child 已导航/解绑 | 已经校验过的旧 owner 或子页面身份在实际发送前失效 | 清理完成后先复查 task owner 再建连接；最后一次异步检查之后、发送之前再核 child 对象和修订 |
| 权限切换没有进入缓存有效性判断 | 已允许的子页面仍不可见，或沿用之前允许的视图 | `frameVersion` 纳入当前允许的 frame 集合，下轮操作按新策略重建；隐藏的上下文只保留可信身份元数据，所有执行仍校验当前策略和父链 |
| 任务结束先等待连接清理，权限审批中的旧工具尚未建立连接 | 旧任务在审批返回后可以重新获准并点击或上传 | Chrome/Edge 与内置浏览器的绑定代数在首次异步等待前推进；所有已捕获的桥接与上传流程检查原代数，新任务继续使用原标签页 |
| 页面在快照后替换了同名控件，旧 ref 被按文字重新定位 | 点击或填写可能落到另一条记录上却报告成功 | 旧 ref 只绑定观察时的 DOM 元素；元素替换后要求重新观察，明确的新选择器仍可操作新元素 |

上述问题已用真实隔离 Chromium、真实扩展或定向回归用例逐项复现失败，再验证修复。审查新增的两个问题分别复现了任务结束后审批返回仍派发点击/上传，以及旧引用点中同名替代控件却返回成功。没有添加税务网站特判、控件名单、模型提示规则或输入失败后的自动重放。

### 必须保持的执行约束

- 一个执行连接只暴露选定标签页；页面弹出新标签页后仍由路由器决定归属，任务之间不串标签页。
- target/session 必须来自当前已登记的父子关系；等待 native API 之后重新检查身份和修订，迟到回复不能授权已替换的 session。
- frame 的物理存在、已确认 URL、允许的父链、Playwright 可见状态分别管理。未知 frame 不等同于允许；同一模型覆盖结构事件、执行上下文、远端对象及无明确目标输入。
- 有副作用的操作不自动重试。已经派发但未完整确认的动作返回不确定状态，要求重新观察。
- task 结束后旧动作、队列和观察结果一并撤销；清理沿用原 lease ID，不能结束新任务的 lease。
- 每轮操作有截止时间；额外展示预览独立限时；这些只是退出保障，正常执行仍依靠正确的协议事件和对象生命周期。
- 当前任务诊断缓冲有界，输出时重新执行当前站点策略；没有新增空闲网页内容采集。

## 真实生产插件的完整流程

`browser-executor-journey.test.ts` 启动私有 Chromium profile、随机本地桥接端口、本地合成网站，装载生产 MV3 插件。只将插件发现端口改为测试端口；没有 mock Chrome API、执行命令、事件、授权检查或文档代数。

实际调用路径为：

`BrowserSessionManager → ExternalBrowserSessionRouter → ExternalBrowserBridge → 生产 MV3 worker → chrome.debugger → Chromium 页面`

单次连续任务验证：

1. 读快照并使用返回引用填写表单。
2. 动态加入跨域子页面，读取并填写其中控件。
3. 触发原生 JavaScript alert 并继续操作。
4. 打开新标签页，由第二任务填写，确认主任务输入未被修改。
5. 取消找不到控件的操作，同标签页立即恢复快照。
6. 经过真实文件访问及上传策略校验，上传测试工作区文件。
7. 勾选并提交本地合成表单，读取跳转后的回执和该动作的控制台日志。
8. 实时禁止网站后拒绝继续读取；结束任务不关闭用户标签页。

测试不使用用户浏览器 profile，不访问税务网站，不提交真实业务信息。

另外的真实 CDP 合约用例覆盖同 URL 子页面刷新、稳定 OOPIF 缓存、主页面操作期间无关 frame 刷新、动态允许/禁止/未知 frame、frame 删除、跨 session 句柄拒绝、停止后的队列撤销。桥接层单元用例补充子 target ID/类型/URL/修订改变、detach、未登记 session 零 native 调用等负例。

额外的两个边界也完成修复前失败、修复后通过：回收旧连接的等待空窗中关闭 task / 全部 task，旧 work 不再新建 lease 或发送输入；最后一次 `tabs.get` 等待期间 child 同 URL 导航或解绑，身份查询之后不再向旧 child 派发页面命令。权限用例覆盖无导航时 same-process / OOPIF 的 `block → allow → block` 连续切换。

## 验证环境和运行方式

- macOS 主机，仓库锁定的 Playwright 依赖；本轮没有升级执行依赖。
- 真实扩展用例需要完整的 Chromium / Chrome for Testing。普通品牌 Chrome/Edge 不支持以命令行加载扩展的测试方式，参见 [Playwright 官方扩展测试说明](https://playwright.dev/docs/chrome-extensions)。
- 浏览器运行时可以通过 `PLAYWRIGHT_BROWSERS_PATH` 配置，或通过 `MEMMY_BROWSER_TEST_EXECUTABLE` 指向测试 Chromium；代码没有固化本机临时路径。没有可用运行时时真实 Chromium 用例会明确 skip，不能将 skip 算作执行验证。
- Chrome 的 child session 行为参见 [chrome.debugger 官方说明](https://developer.chrome.com/docs/extensions/reference/api/debugger)。本轮 native 拒绝及正确路由均由实际 worker 调用确认。

最终联合验证：

- Agent 13 个相关测试文件 **197/197 通过**，包括实际执行的隔离 Chromium / 生产 MV3 完整流程，以及任务结束后的旧审批撤销和旧元素引用拒绝；没有 skip。
- 桌面 8 个相关测试文件 **195/195 通过**，包括两个桥接、子页面身份、History 接入、统一授权、CDP 事件和旧授权兼容。
- Agent 和桌面两套 TypeScript `--noEmit` 均通过；`git diff --check` 通过。
- 独立只读审查提出的连接回收停止竞态、外部插件最终异步查询竞态均已用修复前失败 / 修复后通过的测试闭合。
- 本次系统复核新增的旧任务审批竞态和同名控件错点，也均有修复前失败 / 修复后通过的证据；点击、输入、选择、上传及元素截图统一使用原始元素身份。
- 本地合成页面的一次联合执行记录：冷快照约 86ms，复用连接点击及观察约 119ms。这仅说明测试环境中执行开销，不代表真实网站或模型整次任务时延。

Agent 联合命令（在 `App/memmy-agent`，先配置测试 Chromium 运行时）：

```sh
./node_modules/.bin/vitest run \
  tests/core/agent-runtime/tools/external-browser-playwright.test.ts \
  tests/core/agent-runtime/tools/external-browser-playwright-relay-contract.test.ts \
  tests/core/agent-runtime/tools/browser-executor-journey.test.ts \
  tests/core/agent-runtime/tools/external-browser-tools.test.ts \
  tests/core/agent-runtime/tools/external-browser-session-router.test.ts \
  tests/core/agent-runtime/tools/external-browser-bridge.test.ts \
  tests/core/agent-runtime/tools/embedded-browser-playwright.test.ts \
  tests/core/agent-runtime/tools/browser-external-routing.test.ts \
  tests/core/agent-runtime/tools/browser-embedded-routing.test.ts \
  tests/core/agent-runtime/tools/browser-global-frame-policy.test.ts \
  tests/core/agent-runtime/tools/external-browser-history-integration.test.ts \
  tests/core/agent-runtime/tools/external-browser-upgrade-compatibility.test.ts \
  tests/core/agent-runtime/tools/browser.test.ts
```

桌面联合命令（在 `App/shell/desktop`）：

```sh
../../../node_modules/.bin/vitest run \
  tests/external-browser-extension-packaging.test.ts \
  tests/embedded-browser-driver.test.ts \
  tests/browser-history-extension.test.ts \
  tests/browser-global-approval.integration.test.ts \
  tests/browser-auth-request.test.ts \
  tests/browser-embedded-cdp-access.test.ts \
  tests/browser-cdp-event-buffer.test.ts \
  tests/browser-cdp-remembered-grant.test.ts
```

## 范围、兼容和交付

- 外部 Chrome/Edge 插件及内置浏览器两条桥接都修复；它们共用 Agent 执行器。插件沿用本分支尚未交付的 `1.0.7` 和现有自动更新流程。
- 原有统一权限、网站策略、History 接入、升级兼容一起回归。本轮稳定性修复没有新增 GUI、提示、数据迁移、权限开关或安装流程；History 的安装入口沿用浏览器增强分支已有变更。
- 源码基底 `b0d83635c`，首轮修复 `30caf7a16`。打包任务应从本分支最终提交整合两轮修复，并核对自身发布分支已有修复；不要只取某一个桥接文件。
- 2026-10-15 源码复核：1.2.3 rc.7 候选 `938b089ed` 没有本分支的浏览器执行层和 History 增强。只从 rc.7 打包，或只挑入最后两次修复提交，都不能交付这套能力。需在隔离的集成工作树中整合本分支的完整依赖链与 rc.7 后续修复，解决重叠文件冲突后再构建。应保留 rc.7 的 Windows History/微信、Mac 权限、Excel 状态及内置标签页等修复；不要用本分支旧文件直接覆盖它们。
- Mac/Windows 构建均重新编译 Agent 和桌面端并拷贝插件。目标包应确认 Agent JS、桌面内置浏览器 driver JS、`resources/browser-extension` 均来自同一集成提交。如果改为赶 1.2.3，还须同步 root/desktop/agent/native 版本，不可仅修改显示版本。
- 测试包已有插件 `1.0.6 → 1.0.7` 的权限清单相同。未发布 rc.7 候选里的 `1.0.4` 到 `1.0.7` 增加 `scripting` 和全部 HTTP(S) 站点权限；按 [Chrome 权限更新说明](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings)，浏览器可能要求测试用户确认新增权限，插件自身的自动重载不能代替浏览器确认。正式 1.2.2 包没有浏览器插件，因此正式老用户仍走首次安装入口。没有为此新增 Memmy 提示。
- 本任务只本地提交，不推送、不打包。VM 中当前 rc.4 不会因为源码提交自动获得修复。
- 本轮真实运行验证发生在 macOS 的隔离 Chromium；桌面桥接和 Windows 共用源码通过自动检查。尚未验收 Windows 安装包、Edge 安装态、真实站点及系统文件对话框，不能将源码测试表述为这些项目已通过。

### 新包用户回归重点

- Mac/Windows 的外部浏览器与内置浏览器连续完成原任务，包括多次观察、输入、勾选、子页面和跳转；真实开票任务继续遵守用户的“不提交”。
- 老用户覆盖升级后插件自动恢复；不装插件时原有 History 仍可用，安装后增强记录继续遵守暂停及排除应用/网站设置。
- 同时运行两个网页任务不串页；停止等待中的任务后没有迟到输入，同标签页可接新任务。
- 实时修改网站和全局权限后，后续读取和输入遵守新设置；History 的排除设置按原本的记录权限处理。
- 若真实站点仍失败，保留时间、任务记录和 `[browser-executor]` 阶段日志，确认是工具执行、路由、模型决策还是站点本身状态。通用合约测试是已验证范围，不是对任意网站成功率的保证。

## 第二轮复核与修复（分支 `cursor/browser-executor-hardening-20261015`）

本节接续 `88daf679b`，取代上文中插件版本 `1.0.7` 及「每次额外截图预览」的说明。打包须从本分支最新提交整合；与 rc.7 整合的注意事项不变。

### 根因与修复

| 问题 | 用户可见影响 | 处理 |
| --- | --- | --- |
| 插件在每条执行器 CDP 命令前后等待标签页、窗口、子页面查询；内置浏览器每 250ms 轮询事件 | 回复可能晚于其后发生的事件到达 Playwright，这正是 rc.4 快照卡死的成因；每条命令也多出数次往返 | 插件按事件维护的状态同步校验后立即派发；两条桥接在回复到达的同一时刻上报；内置浏览器事件与结果同一 IPC 通道推送。上一轮的 `Runtime.enable` 等待补丁已删除 |
| 单个 iframe 一直不给执行上下文 | 整次快照等满 30 秒后失败，模型反复重试 | 子页面单独限时 3 秒，超时跳过并在结果中注明 |
| 点击或回车后页面跳转 | 返回 `ok:false`，模型可能误判失败或重复提交 | 中继确认主文档已提交新导航时报告成功，并等新文档就绪后返回新页面内容 |
| 页面弹出 confirm/alert/prompt | Playwright 默认静默取消，确认类操作「点了没反应」 | 仍默认取消，但在结果中报告弹框内容；点击、输入、选择、按键支持 `acceptDialog` 显式确认 |
| 每次操作后再跑一遍完整 Playwright 截图做预览；调试器空闲 15 秒即断开 | 每步额外最多 3 秒；调试提示条反复出现 | 刚观察过且无被阻止 iframe 的页面直接截取视口；连接与调试器空闲保留 45 秒，轮次结束仍立即断开；回收连接不断开调试器，且一定结束租约 |
| CDP「始终允许此网站」新建的规则把访问/上传/下载设为询问 | 访问审批反而回来，并作废所有对话的本次会话授权 | 新规则沿用该网站当前生效的决定，只改 Debug / CDP；本次会话授权只在该网站生效结果或总开关变化时作废 |
| 全部允许开启时设备授权只看访问决定 | 被明确阻止的网站可被授予摄像头/麦克风，且关闭总开关后仍保留 | 设备授权同时遵守该网站自身规则 |
| History 内容脚本每 3 秒从所有标签页所有 frame 轮询 | 插件后台常驻唤醒，影响所有安装插件的用户 | History 关闭、Memmy 未连接或后台标签页时等待唤醒 |
| 内容脚本每次点击/按键同步读取整段 `innerText`；按住按键、页面自动滚动都产生事件 | 大页面卡顿，记录噪音 | 有界文本读取、可见性缓存、忽略重复按键、只记录用户触发的滚动 |
| 验证码、卡号、CVV、身份证等字段未识别为敏感 | 可能写入 History 并送去摘要 | 扩大敏感字段识别，双端对 Luhn 有效卡号脱敏 |
| 学习示范同时生成原生步骤和网页步骤 | 回放可能对同一按钮点两次 | 时间重叠时保留网页语义步骤，合并紧随其后的 change/submit，写明按键，网页滚动不成步骤 |
| 网页事件逐条作废实时摘要；同站路由变化收回租约；Windows 应用名不一致；`downloadPath` 取消后永久阻断该标签下载 | 摘要模型调用被浪费；搜索框输入丢失；摘要被拆碎；后续下载被静默取消 | 分别修复，见各提交说明 |

后续追加的三项：

| 问题 | 用户可见影响 | 处理 |
| --- | --- | --- |
| 快照先列全部控件、再列全部文字，没有层级 | 标签和输入框相隔很远，看不出按钮属于哪一行、哪个对话框 | 按页面顺序输出，并归入带名字的对话框（标注模态）、表单、表格行、列表、分组和 iframe；手形光标的文字标为可点击；超出预算时先保留控件及同一容器内的文字；`browser_find` 结果注明所在位置 |
| History 只检查顶层页面和 frame 自身的网址 | 被排除网站的 iframe 里再嵌套的子页面仍会被记录 | 每个 frame 上报浏览器提供的祖先来源，插件与 Memmy 双重校验；任何一层祖先被排除或无法确认即不记录。旧插件的子页面不再记录，顶层页面不受影响 |
| Agent 在内置浏览器设置的设备权限写入用户的网站权限文件 | 全部允许开启时可长期给未阻止的网站开摄像头/麦克风，关闭总开关后仍保留 | Agent 的设备授权只保存在桌面进程内存中，限当前标签和网站；任务结束、标签关闭、离开该网站、Agent 重启或满 30 分钟失效，不改动用户保存的设置。早前版本已写入的 Agent 授权无法区分来源，未自动清理 |

插件 `1.0.9` 的权限清单与 `1.0.7` 相同，沿用现有自动更新机制。

### 验证

- Agent 浏览器工具与 History 测试目录 114 个文件 1699 项通过（4 项仅限 Windows 的用例跳过）；桌面端相关 15 个文件 341 项通过；契约包 39 项与插件打包校验通过；两端 TypeScript 检查通过。
- 新增用例均在旧代码上复现失败：插件回复晚于事件、iframe 无上下文导致快照卡住、提交跳转返回 `ok:false`、页面自滚动被记录、标签与输入框不相邻、嵌套在被排除 iframe 内的子页面获得记录许可、Agent 设备授权写入权限文件。
- 根目录 `tests/browser-extension-package.test.mjs` 在 `88daf679b` 上已因版本号断言失败，本轮一并更新。
- 本轮仍是 macOS 主机上的源码与隔离 Chromium 验证，未在 Windows 虚拟机、Edge 安装态或真实税务站点上验收。

### 尚未处理

- Brave、Canary 等 Chromium 浏览器都报告为 Chrome，排除它们不影响网页增强记录。
- 「始终允许任意应用」打开时，正在等待的应用操控审批不会自动关闭。
- 单页应用的同站路由变化不再产生新的页面上下文事件。
