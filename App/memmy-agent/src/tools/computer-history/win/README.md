# Windows Computer History 产品接入与 TypeScript 适配器


## 当前采集行为 2026 年 10 月 16 日

默认对当前窗口按实际内容能力读取，浏览器与其他应用共用通用路径；支持窗口内不同 PID 的托管子树。已知浏览器名称不再导致拒绝，普通、无痕和模式未知均可记录。URL 为可选元数据，前后可确认属于同一页面时附加，识别失败保留正文。已知 URL 仍执行网站规则；未知 URL 在 Windows 当前阶段按观察处理。

任意角色的 TextPattern、ValuePattern 均可读取，前者失败可退回后者和 LegacyIAccessible。缺少名称或名称等于正文不再清除通用正文；字段来源、可见范围与文档上下文继续区分。Control View 不提供正文时有界尝试 Raw View；Chromium/Electron 使用共用窗口级辅助功能请求。该机制不代表所有第三方应用已提供正文。

`captureText` 默认 true；区域配置只作提示，不再隐式关闭通用读取。显式 false 保留旧受限模式。明确密码、敏感子树、凭据脱敏及显式应用排除继续生效。本文后面的历史应用验证不代表新通用路径的完整覆盖，当前证据以 [VALIDATION.md](../VALIDATION.md) 最新日期为准。


已接通独立 C++ UIA 采集器、共享 TypeScript 录制/摘要服务，以及 Windows 页面、应用授权和 HTTP 路由。Windows NSIS 构建会编译并分发生产 EXE；实际安装验收结果见 [VALIDATION.md](../VALIDATION.md)。没有新增 npm 依赖，也不需要 .NET。

下一阶段的范围、实现顺序和验收条件见 [Windows Computer History 下一阶段实现计划](../WINDOWS-NEXT-PHASE-PLAN.md)。

## 产品入口与开发配置

开发环境设置 MEMMY_WINDOWS_HISTORY_BINARY 指向生产版 EXE，并编译 Agent；默认仅查找编译后模块旁的同名文件。新 Windows 配置与 Mac 的默认应用范围对齐：确认开始记录后采集支持的应用，不要求逐项勾选。页面的“应用范围”可排除应用，或切换为“仅选定应用”；保存范围先停止当前记录。组件或发现过程不可用时不启动采集；仅选定模式还要求有已选择且运行中的应用。

产品使用共享 `~/.memmy/computer-history/observation-settings.json` 管理应用和网站范围，也支持 `MEMMY_HOME`。Windows 的 `windows-settings.json` 保留内部选择器、预算与迁移标记。首次使用会备份已有文件到旁边的 `.before-unification.json`，将旧 Windows 范围与共享规则的有效交集合并；旧配置缺少默认字段时保留原有仅选定范围。迁移完成后，共享文件丢失或损坏会报告错误，不回退到扩大范围的默认值。新配置不会自行开始录制。

共享应用规则可携带绝对 `executable`，其 `bundleID` 使用对应路径的 `windows:<SHA-256>`；省略该 ID 时由解析器生成。已有 `win32.*` 规则继续兼容，适用的排除规则优先。Windows settings API 是共享范围的兼容视图，保存时保留网站规则；页面和 Agent 工具共用服务。高级选择器规则最多 32 条，原生实例绑定在默认观察模式下最多 512 条。

产品编译的普通应用策略默认启用 `captureText`，读取非密码编辑控件值和正文；显式正文选择器配置保留受限模式，也可显式设置 `captureText:false`。浏览器始终使用独立适配，不能借通用文本读取绕过其范围。旧的直接原生策略省略该字段时仍保留原有受限行为。

`GET /api/computer-history/windows/settings` 返回配置、可选应用与 readiness；`POST` 的请求体为 `{settings: <完整配置>}`。两者要求现有 API token 和 Windows 宿主。可选列表合并本地开始菜单快捷方式、运行进程和已有配置，名称优先使用快捷方式，再使用 EXE 的 FileDescription 或文件名；可以按名称或路径搜索，筛选后保存保留隐藏的选择和高级规则。目录信息缓存 60 秒，发现失败时回退到 EXE 名称；显示目录不读取窗口标题或 UIA 内容、不启动应用、不提供授权实例。每次启动及每两秒刷新，将所选范围绑定到真实 PID、规范路径和创建时间；新打开的应用需等刷新后才能采集。刷新前等待暂停确认；没有可用实例时使用明确拒绝的策略，设置损坏、超过预算或刷新失败会停止采集。

服务沿用十分钟分段、摘要调度、保留/删除和工作流提取。暂停会关闭本次子进程，恢复可继续同一时间段的已正常关闭 JSONL，保持单个 metadata 和连续序号；中断或跨平台文件不能续写。Windows 的 `permissions.platform=windows` 与 `ready/reason` 表示组件和范围就绪，Mac 权限字段保持 false，界面不展示 Mac 系统权限向导。Windows 已注册历史检索以及 `computer_history_status`、`computer_history_get_settings`、`computer_history_update_settings`。更新共享规则会先停止当前采集，再写入配置。

`captureHealth.content` 报告最近一次实际落盘样本的正文质量、原因和时间，不包含用户正文。页面显示“正文可用／部分内容／正文暂不可读”；空闲、空白窗口和被排除内容不自动算失败。正文的 DocumentRange、provider 可见范围和控件当前值分别标记，摘要不能把全文当成用户看过或输入过的内容。

## 入口

先按 [原生构建说明](native/README.md) 构建生产版采集器。在 `App/memmy-agent` 中编译 TypeScript：

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.build.json
node dist/tools/computer-history/win/record-human-history.js --help
node dist/tools/computer-history/win/record-human-history.js --binary "D:\memmy-cpp-env\native-core-review\release\memmy-history-recorder.exe" --policy "D:\history-validation\policy.json" --out "D:\history-validation\events.jsonl" --title "Windows validation" --seconds 30
node dist/tools/computer-history/core/summarize-history.js --file "D:\history-validation\events.jsonl" --out "D:\history-validation\summary.md"
```

路径必须是绝对路径；输出文件默认必须不存在。`--settings <绝对路径>` 可以替代 `--policy`，启用持久应用规则与实例刷新；二者互斥。`--append` 只允许续写正常结束的同平台文件。`--input-hooks` 开启动作元数据及 `Ctrl+Alt+Shift+R` 停止热键，产品服务默认开启。热键不需要前台应用被授权，也不将组合键写成采集内容；原生暂停时仍能停止。默认运行 30 秒，最大 86400 秒。stdin 接受 `pause`、`resume`、`stop`；EOF 和 Ctrl+C 会结束采集。CLI 的 stdout 输出 JSON 状态行，stderr 只输出固定诊断码。原生 stdout 一直被适配器读取，不会直接写入录制文件。

## Windows 安装包

从仓库根目录运行 `bash scripts/package-win.sh --version 1.1.8 --arch x64 --edition cn --sign unsigned`（版本须与根 manifest 一致）。需要 Git Bash、Node、VS 2022 C++ x64 Build Tools；Electron 的 SQLite 重建还需 Python 3，可通过 `NODE_GYP_FORCE_PYTHON` 指定。目标用户机器不需要这些编译工具或 .NET。`.sh` 通过 Git 属性固定为 LF，版本检查允许 CRLF，但仍拒绝版本值不一致。离线 embedding 模型可通过现有的 `MEMMY_EMBEDDING_MODEL_SOURCE_DIR` 指定完整模型目录；必须保留四个必需资源文件。

打包脚本调用 `scripts/internal/win/history-recorder-native.ps1 -Configuration Release -ProductionOnly -StageDirectory ...`，只构建生产 helper。默认下载固定哈希的 nlohmann/json header；离线构建可设置 `MEMMY_HISTORY_JSON_HEADER` 指向已校验的本地 header。单独构建也可用 `-JsonHeader`。EXE 静态链接 CRT，PDB 留在构建目录，不随包发送。第三方许可证随 `memmy-history-recorder.NOTICES.md` 分发；C++ 源码、测试 fixture 和故障注入 EXE 不进入 Agent dist。

安装版 helper 固定在 `resources/app.asar.unpacked/dist/runtime/memmy-agent/dist/tools/computer-history/win/memmy-history-recorder.exe`。签名和无签名配置都显式解包该文件，打包后校验实际磁盘文件为 x64 PE。安装版忽略 `MEMMY_WINDOWS_HISTORY_BINARY` 和显式 binary 覆盖；缺少包内组件时失败，不搜索开发目录、不编译、不下载。开发模式仍支持这些覆盖配置。无签名 QA 包不能作为已签名发行包；签名状态以实际产物证据为准。

## 授权与数据

- 原生协议见 [PROTOCOL.md](native/PROTOCOL.md)。适配器严格校验 UTF-8、消息类型、字段、序号、sessionId、时间顺序和大小上限。启动消息必须对应自己创建的子进程，生产入口拒绝 testHooks 构建。
- 原生采集始终要求精确实例策略，PID、规范化 EXE 路径和可选 HWND / 创建时间必须匹配。`compileWindowsPolicy()` 将默认观察/仅选定范围绑定当前实例，没有原生通配授权。deny 优先，锁屏/登录/屏保表面始终拒绝。Chrome/Edge 仅通过专属浏览器适配采集，其他已知浏览器仍然拒绝。改名浏览器和嵌入网页不能仅凭 EXE 名称识别，仍受普通应用的节点过滤约束。
- Windows 应用使用 `windows:<EXE 路径 SHA-256>` 标识，不伪装为 Mac bundleId。应用和网站范围使用共享规则，内部实例策略由 Windows 编译；Mac 的权限布尔值不代表 Windows 就绪。
- 原生读取前结合 UIA 密码属性与 Win32 HWND 所属 PID、Edit/RichEdit/Windows Forms 类名及 `ES_PASSWORD`。原生密码样式可覆盖 UIA 的非密码 Pane 误报；不确定状态不能放行文本。读取后再次核对原生状态，变为密码或未知时丢弃内容并裁剪子树。没有原生 HWND 的元素仍使用现有 provider 规则。
- full/delta 先重建为完整树，再独立检查父子层级、重复键、输入框授权、密码状态、敏感标识、子树裁剪与文本预算。无基线的 delta、上下文/策略改变后的 delta、部分结果后的 delta 都会拒绝。阻断快照、暂停和恢复会清空基线。
- 只有脱敏后的 `human_history_metadata` / `human_event` JSONL 落盘。Windows 节点保存为通用 `accessibility` 结构；Mac 原有 AX 字段及旧导入路径兼容保留。UIA 的触发通知不转换成虚构的点击或键盘动作。真实低级钩子可提供点击位置、滚动方向、导航键及有限快捷键；普通文本键只记录次数，AltGr 的可打印键身份也被清除。不能将这些次数当成字数或 IME 上屏文字。密码、敏感或未知焦点不输出键盘动作。
- 动作与授权快照一起校验 HWND、前台/焦点 generation 和最终提交条件，最多 64 条，丢失通过 `actionOverflow` 表示。`injected` 标识软件注入；摘要保留此限制。点击目标与结果没有通过钩子证明，工作流不能把坐标当成稳定目标。低级输入与 WinEvent/UIA 的异步顺序仍可能漏记；该链路不提供无遗漏的输入审计保证。
- `updatePolicy()` 先等待暂停确认，再替换策略文件并重建基线；失败保持暂停。应用重启后必须重新绑定 PID 与创建时间。宿主应独占策略修改，避免外部进程并发改写文件。
- 退出码为 0、收到终止消息、hooksDetached 为 true 且全部输出排空，才写 `recording_stopped`。异常退出、损坏协议、写盘错误均使录制失败；不将中断录制误标为成功。写盘是同步有界操作；调用方的磁盘和 `onEvent` 回调应保持响应。

共享摘要先生成 `summary_state: pending` 的机械元数据，再由 `compactEventEvidence()` 和 `writeSegmentNarrative()` 进入现有模型摘要链路。离线测试使用模型替身，不消耗真实模型请求。模型提示词明确指出 UIA 的可见性是 provider 报告，不能证明用户阅读或像素可见。

## 验证

### Chrome 与 Edge

浏览器共用通用内容读取，专用模块只补充可确认的 Document URL。头像、登录状态、普通模式证明及地址栏一致性不再是采集准入。页面变化造成 URL 不确定时，仅省略 URL。Firefox 等其他浏览器可以尝试通用读取，专属 URL 增强与真实软件覆盖单列后续工作。

### Word 与 VS Code 受限兼容模式

本节的固定正文规则仅用于显式 `captureText:false` 的旧受限模式；默认通用采集不依赖这些层级和选择器。以下真实应用结果保留各自测试时间与条件。

应用获准并绑定实际进程后，未自定义正文规则的 `WINWORD.EXE` 默认使用
`Edit + Body` 与 `{controlType:"Document", automationId:"", scope:"word.document"}`；
`Code.exe` 默认使用 `{controlType:"Edit", automationId:"", scope:"vscode.editor"}`。
显式 `documentRegions: []` 关闭默认正文规则，已有自定义规则保留。应用 deny、浏览器拒绝、
密码和敏感子树检查不变。该适配不向未授权应用授予权限。

VS Code 仅允许固定链 `Edit("") ← Text("") ← Group("") ← Group("workbench.parts.editor")`，
节点及祖先的密码状态与 ID 都必须明确可读。C++ 在读取前后检查实时祖先、进程与敏感 ID；
worker 校验与 TS 完整树复核各自重新判断范围。不存在通用空 ID 通配符，也不以文件名授权。
启用此范围时，未明确授权的 workbench 节点不读 Name，防止查找词经旁边的状态提示泄露；
Chat、终端、搜索和快速打开不能依靠普通 Text 标签绕过输入框过滤。

Word 外层正文仅允许固定类型/窗口类链
`Document(_WwG) ← Pane(_WwB) ← Pane(_WwF) ← Window(OpusApp)`，深度必须依次为 3、2、1、0，
各层 ID 明确为空且密码状态明确为 false。读取前后还检查真实 HWND、窗口类、所属进程、
原生父子关系和最外层采集窗口；worker 与 TS 根据完整树独立复核类型/类名/层级。
匹配并尝试读取后不再遍历正文子节点，避免重复或借子节点泄露内容。该规则适配本机草稿和页面视图，
不把任意空 ID Document、查找框或对话框当成正文。

上述两种范围内正文另有 `documentStatus: available | label_only | read_failed`。
Name 与 Text 去掉首尾 ASCII 空白后相同且非空时，保守视为提示，清除所有内容；读取失败也清除内容。
该判断不依赖提示语言，但正文恰好等于文件名时也会被保守排除。状态是采集证据，不保证用户阅读、
正文完整或像素可见。VS Code `auto` 不保证自动启用辅助功能；本机显式 `on` 可读，`off` 和本轮
未启用的 `auto` 仅得到不可访问提示。采集器不修改编辑器设置。

本机 VS Code 的系统 `GetVisibleRanges` 在短文档中曾仅返回光标所在行，尽管 DocumentRange 返回四行正文，
且屏幕能显示四行。1.140.0 的长文档滚动后还出现实际显示第 37–73 行、接口仍返回开头十行的情况；
光标在末尾空行时范围为零，上移至末行标记后又返回该行。独立探针与生产输出一致，不能将
这些范围当作像素可见性。归一化器在独立验证编辑区且正文可用后添加
`documentContext: vscode.editor`；原生流不能自行声明这个字段。摘要将该正文另列为
结构化 `document observation:` 中的 `document_context`（旧录制保留
`document context (visibility unconfirmed):`），允许描述文档主题，但不能据此声称用户看过、写过或
操作过整篇文档，也不能推断其意图或偏好。`visibleText` 仍单独保存和使用，不用正文填补缺失的
可见范围。文档上下文独立去重、凭据脱敏、每项最多 2,000 字符，并参与原有 12,000 字符总预算；
不会保证整屏或全文进入摘要。已有不含该字段的录制保持原有摘要取材方式。
新录制还在 TS 独立范围复核后添加 `documentEvidence`：编辑器/文档标签来自 `uia.name`，正文来自
`uia.document_range`，可见范围来自 `uia.visible_ranges`，焦点仅记录 provider 报告。原生协议不能
自行声明这些受信元数据。摘要把标签、焦点、可见范围和正文绑定到同一观测；标签不是经过文件系统验证的
文件名或路径。摘要字段用 `provider_range_text` 表示接口范围文本，`pixel_visibility: unverified`
同时限定该字段和 `document_context`；不沿用容易误解为屏幕事实的 `provider_visible_text` 名称。
窗口按会话、进程创建时间和 HWND 区分，generation 变化只分段，不虚构新窗口。
观测引用不是持久文件 ID；分屏同名文档不合并，A→B→A 保留返回 A 的观测。预算裁剪保持完整 JSON，
过长标签直接省略并标记，不能截成另一个貌似真实的名称。Word 只使用原有可见文本，没有扩大正文取材范围。

这些是证据格式和模型提示约束，不是对模型输出准确性的保证。此前真实模型曾把上下文误称为可见文字、
把正文当成名称；加强来源规则后仍有含糊措辞，具体失败样本与复验结论见 VALIDATION.md。
2026-10-08 进一步检查 DocumentRange 与逐行 `GetBoundingRectangles`，也只有光标行返回矩形；
其余合成正文行的矩形为空；长文档滚动样本又出现多行共用同一位置的扁平矩形。因此本机不能靠这些几何信息可靠补全可见范围。

已验证 Word 两页 RTF 的草稿视图、页面视图、切换至第二页、查找内容排除。
页面视图的完整正文与 provider 可见文本分开保存，翻页后可见文本随之更新。
替换对话框中的预填查找内容未泄露，但非空替换值和执行替换尚未完成真机验收。Office 其他版本、
受保护文档、其他视图、VS Code 插件界面均不由这些样本保证；1.140.0 的合成分屏、同名文档和
auto/on/off 对照已有独立证据，实测边界见 VALIDATION.md。

真实应用正文缺失的定位入口见 [四层采集诊断](native/tests/diagnostics/README.md)：分别保存系统 UIA、生产 C++ 输出、实际 TypeScript 归一化结果和最终 JSONL，并核验前台及进程身份。先运行合成阳性/阴性对照，再测真实应用的合成文档；原始 UIA 诊断成功不等于产品采集成功。它只在测试构建中提供，不进入安装包，实测结论见 VALIDATION.md 的 2026-10-07 四层诊断记录。

日常回归优先在仓库根目录运行统一入口：

```powershell
node scripts/internal/shared/validate-computer-history.mjs
```

入口覆盖共享业务、Windows 接入、前端、类型、lint 和构建，并保存逐项报告。可通过 `--native-bin <绝对构建目录>` 加入生产 EXE 的生命周期验证。平台条件、跳过原因及 Mac 接续步骤见 [阶段基线与验证说明](../VALIDATION.md)。

`.github/workflows/windows-computer-history-validation.yml` 在 Windows 2025 / Node 22 x64 上构建原生核心、串行执行受控 fixture 测试，再运行统一回归及包内 EXE 检查。`native-summary.json` 分开记录通过、失败和桌面前提不满足的跳过；基础逻辑、Win32 边界、元数据和 CLI 用例必须运行并通过。日志和测试输出上传为 CI artifact；这不代表签名安装包、真实应用、IME 或模型服务已经验收。

Desktop 退出、进程树和安装脚本回归单独从仓库根目录运行，不与 History 计数合并：

```powershell
node node_modules/vitest/vitest.mjs run App/shell/desktop/tests --maxWorkers=2 --reporter=default --reporter=json --outputFile=App/shell/desktop/release/desktop-tests.json
```

Windows 的脚本测试自动寻找标准安装位置的 Git Bash；自定义位置可设置 `MEMMY_TEST_BASH` 为其 `bash.exe` 完整路径。缺失 Bash 应修复环境，不能将其当作平台跳过。POSIX 文件符号链接用例在 Windows 明确跳过，Windows `.cmd` 迁移与无关文件保护仍执行。打包会重建 Electron SQLite ABI；回归测试应在打包前运行，打包后恢复开发目录的 Node ABI，再执行 Node 测试，不能并发混用。

`runtime-force-exit.test.ts` 的两项真实后代进程终止用例仅在 Windows 执行，验证 `taskkill /T` 与两种 Memory 退出策略；Mac/Linux 明确跳过该 Windows 断言，仍需执行各自的真实服务生命周期回归。

安装版退出会在用户数据目录写入 `quit-lifecycle.jsonl`。按同一 `quitId` 检查 `start`、`history-stopped`、`services-closed`、`cleanup-complete`；`history-stop-failed`、`cleanup-failed`、`force-start` 必须单独报告。5 秒触发退出保护，同步终止命令再共用 2 秒预算；这不是严格的总退出耗时保证。`force-complete` 只表示已执行尽力终止，仍需检查实际进程是否消失。日志写入失败不阻止退出，因此日志缺失只能判未确认，不能据此声称没有兜底。

下面是从 `App/memmy-agent` 目录直接运行适配器测试的入口；设置二进制目录后会尝试前台内容测试，属于交互验证：

```powershell
node node_modules/vitest/vitest.mjs run tests/tools/computer-history/win --maxWorkers=2
$env:MEMMY_WINDOWS_HISTORY_TEST_BIN_DIR = 'D:\memmy-cpp-env\native-core-review\release'
$env:MEMMY_WINDOWS_HISTORY_TEST_ARTIFACTS = 'D:\memmy-cpp-env\ts-adapter-review-artifacts'
node node_modules/vitest/vitest.mjs run tests/tools/computer-history/win --maxWorkers=2
```

未设置测试二进制目录时，真实 C++ 用例明确跳过。设置后运行生产 EXE 的启动、暂停、恢复、EOF、时长退出，以及受控 Win32 fixture 的隐私和摘要链路。内容用例需要解锁的交互桌面并取得前台；失败前提会明确跳过并保留 `fixture-precondition.json`，不能视为内容采集通过。所有测试只关闭自己创建的子进程，证据保留在测试目录。

共享/Mac 业务回归已纳入统一入口。目录逃逸在 Windows 使用 junction 实测；文件 symlink 权限不足和 POSIX 信号用例明确跳过。本机 Windows 无法替代 Swift / AX、Unix helper 权限与 Mac 真机回归。

2026-10-02 接入阶段历史证据：生产 C++ 的受控 fixture 内容采集成功过一次，记录位于 `D:\memmy-cpp-env\ts-adapter-review-artifacts\ts-native-adapter-ne4ynr\events.jsonl`，同目录 `summary.md` 为共享 CLI 生成的机械摘要。后续运行遇到前台激活限制会明确跳过内容用例，不能作为稳定性验收。当时原生 Release/Debug 全量重跑各 16 项通过、16 项因前台前提跳过。2026-10-03 新默认范围版本各 33 项通过、0 跳过，真实安装版模型摘要已单列验证；最新分层结果见 VALIDATION.md，历史计数不可直接沿用。

产品接入阶段的真实 Node 入口 + 生产 EXE 完成启动、暂停、同段恢复及撤销授权，证据在 `D:\memmy-cpp-env\product-integration-artifacts\ts-native-adapter-*\product-service-result.json`。当时生产 EXE 为 572,928 bytes（559.5 KiB），PDB 不作为运行依赖。

当前回归范围与结果以统一入口的 `results.json` 为准，包含先前遗漏的 Windows 模型同步测试。独立子进程的退出也会等到 stdout 排空、终止状态校验通过才结束观察；退出码 0 或旧 stop marker 不能单独代表成功。

当前包与安装检查见 VALIDATION.md。后续范围包括正式签名、Windows 实体输入与 IME/DPI/多显示器兼容验证和长时间采集；浏览器上下文仍未支持。产品接入与自动测试不等于已经达到 Mac 真机的完整功能对等。
