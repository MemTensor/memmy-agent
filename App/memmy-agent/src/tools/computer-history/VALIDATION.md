# Computer History 阶段基线与平台验收

本阶段包含 Windows C++ 采集核心、TypeScript 适配、共享业务服务、Windows 应用授权与页面接入，以及 Windows 安装包接入。本文按日期保留开发基线、受控 fixture、包内组件和真实安装版操作的独立结果；浏览器/Office/WPS 专项适配不在本轮范围内。

## 统一验证入口

### 2026-10-10：个人 fork 开发分支改名

当前 Windows History 开发分支为 `feature/windows-history-native-core`，由 `codex/windows-history-native-core` 改名，已有提交历史保留。协作指南没有强制个人任务分支前缀；参考 upstream 已有 `feature/agent-wy`（PR #557）采用 `feature/`。本任务继续在同一分支追加提交。

专项 CI 的 push 目标及对应工作流契约测试同步使用新名称，个人 fork 的分支、跟踪关系和本地拉取范围同步调整。下文历史验收记录保留当时的分支名与提交 ID。本次不更改产品实现，不向 MemTensor upstream 推送或创建 PR。

本次定向验证：`node node_modules/vitest/vitest.mjs run tests/windows-history-workflow.test.ts` 为 **4/4 通过，零跳过**，覆盖新分支触发规则及原有 CTest 报告判断；`git diff --check` 通过。不把这次配置验证计为新的产品或安装版验收。

### 2026-10-09：吸收 PR #578 的 Windows History 实现

对照快照 `upstream/pr-578`（`c578572e`），迁入三项：原生密码样式兜底、本地应用目录与友好名称、Windows History 专项 CI。应用目录保持展示用途，采集继续按原有规范 EXE 路径、PID、创建时间及前台窗口校验；普通输入框、正文选择器及浏览器排除边界保持原有规则。

- 密码测试先独立确认合成窗口的系统 UIA 返回 `Pane / IsPassword=false`，且 Name 和子节点暴露秘密标记；生产快照返回 `password=true / redaction=password`，没有秘密内容和后代节点。原生元数据测试另覆盖 HWND 所属 PID、销毁窗口、样式变化、未知属性及无关窗口类的同位样式。
- 应用目录测试覆盖中文快捷方式、同名 EXE 的不同路径、重复项、运行进程回退、Squirrel 同目录启动目标和缺失/辅助/网络目标排除。产品测试覆盖严格协议、目录与运行实例分离、缓存及失败回退；前端测试覆盖友好名称/路径搜索、无匹配提示、隐藏选择和高级规则保留。
- Release 与 Debug 各 34/34 个 CTest 用例通过，零跳过。报告在 `.history-migration/release-native.xml`、`debug-native.xml`；受控输出在 `.history-migration/artifacts/`。初次沙箱内 UIA 调用阻塞，旧版用例同样阻塞；改为沙箱外仅运行受控 fixture 后通过，这不是放宽密码判断。
- 统一回归通过：590 项通过、8 项明确跳过，类型、lint、Agent/前端构建及 Electron 包内生产 EXE 执行检查通过。逐项报告在 `.history-migration/regression/computer-history-validation-EI7bGT/results.json`；跳过名称与原因保留在该报告中。
- Release EXE 为 1,021,952 字节，仍是静态 CRT 的独立原生程序；新增依赖为 Windows 自带 Shell/version API，无新增 npm 或 .NET 依赖。
- 上述源码阶段不计为安装版验收；后续 fork CI 与本机安装复验分别记录如下，不扩大 IME 或真实模型结论。

#### Fork 提交与专项 CI

迁入提交为 `7619722c`（原生密码保护及应用目录）、`8ae788f9`（产品设置与应用搜索）、`870d6820`（专项 CI），另有 `72640b64` 修复 CI 前端构建环境。只推送用户 fork 的 `origin/codex/windows-history-native-core`，没有向 MemTensor upstream 推送代码或创建 PR。GitHub 将原 `JovianSJTU/memmy-agent` 重定向到 `Jovianix/memmy-agent`，原有远端配置保持不变。

[专项 CI 37906790384](https://github.com/Jovianix/memmy-agent/actions/runs/37906790384) 在 `72640b64` 上通过：原生 **34/34，零跳过**；产品回归 **591 通过 / 0 失败 / 7 明确跳过**，类型、lint、Agent/前端构建与 Electron 包内生产 EXE 执行通过。下载证据在 `.history-migration/acceptance-20261009/ci-passed/`。CI 的原生测试运行于交互 session 2，但仍不是用户安装版、真实应用或模型验收。

首轮 CI `37905538741` 的原生与测试均通过，最后的前端构建因缺少必需法律网站 HTTPS origin 配置失败；修复仅给专项 workflow 提供仓库已有默认地址，并增加对应契约断言，没有削弱产品构建校验。首轮证据保留在同目录的 `ci-first/`。

#### 新版安装与真实应用复验

本机报告位于 `.history-migration/acceptance-20261009/`。重新编译全部 Agent、界面及生产原生组件，复用上一轮已验证且依赖清单未变化的 shell/runtime 暂存依赖，以正式 unsigned NSIS 配置封装；这是限定范围的重打包，不计为重新执行完整依赖安装流程。安装器于本地 17:05:40 安装成功，用户数据保留，旧安装器另存 `prior-installer.exe`。

- 新安装器仍为 `App/shell/desktop/release/Memmy-1.1.8-win32-x64-cn-unsigned.exe`，**1.1.8 / x64 / CN phone / NotSigned**，355,358,715 bytes；SHA-256 `E6B3B180D05298961CCC4AA9581E1DE8EDEAE06BAC4D962C9F353CD2B031A95A`。版本、ASAR 边界和实际 x64 PE 检查通过。
- 正式生产 helper 为 **700,928 bytes**，SHA-256 `666BC89541FB56124AFCDCF63F4820C92ED6A0DF13607D6A64F510E2E7D1A1AC`，Release `/O2 /Ob2 /DNDEBUG`、静态 CRT，只有 Windows 系统 DLL 导入。上面的 1,021,952 bytes 来自旧本地 Release 配置，其缓存的 `CMAKE_CXX_FLAGS_RELEASE` 为空，不能拿来代表正式优化产物体积。该差异没有扩大采集权限。
- 安装后 Desktop、ASAR、helper 三项哈希与新包匹配。包内及安装后的 History 编译模块和界面资源各 **40 文件**与当前本地构建相符。正式 ASAR 校验见 `asar-verification.log`；实际 Electron SQLite 查询为 ABI 139，开发环境随后恢复 Node ABI 137，并实际查询通过。
- `packaged/preflight.json` 与 `installed/preflight.json` 各 **9 通过 / 0 失败**：固定包内生产 helper、实际应用目录（包含 Word 与 Visual Studio Code 友好名称）、默认 stopped 和 legacy 范围、三个 SQLite、共享摘要 CLI 及退出日志。PATH 不含开发工具，并设置故意无效的 helper 覆盖。
- `installed/fixture-foreground-service/` **6 通过 / 0 失败**：仅授权合成 fixture；密码样式兜底、密码/普通 Edit/敏感后代与凭据内容均未落盘；暂停期间无新增内容，恢复保持同一段且 sequence 递增；排除 fixture 后停止且权限不再 ready；实际摘要请求经合成 provider 响应进入生产检索，文件停止后稳定；录制中调用服务 shutdown 正常结束。首轮 `fixture-service/` 未取得前台，在开始采集前失败并保留；使用桌面工具确认唯一 fixture 前台后重跑，没有降低前台门禁。
- `installed/word-layers/`、`code-layers/` 前台/身份条件有效，合成正文各自系统 UIA → 生产原生 → 标准化 → JSONL **四层贯通**，无隐私阴性标记泄漏。Word 采用默认正文规则；Code 1.140.0 使用禁用扩展、辅助模式 `on` 的隔离 profile，不推广至 auto/off 或其他版本。
- `installed/word-service/` 与 `code-service/` 各 **5 通过 / 0 失败**：实际安装版服务采集、默认应用规则、完整停止、真实摘要请求输入、各一次合成模型响应、生产检索及停止后文件稳定。Code 的结构化摘要输入保持 `provider_range_text`、`pixel_visibility: unverified` 和 `uia.name` 标签；没有新增真实模型、像素可见性或聊天端到端验收。
- 实际 Desktop 窗口验证了 Word 名称搜索、`Microsoft VS Code` 路径搜索、无匹配提示及取消返回。没有操作授权开关、勾选或保存范围。隐藏选择与高级规则的保存由前端 6 项交互回归覆盖，不冒充此次真实 UI 保存操作。

Windows History 设置文件仍维持本轮开始时的不存在状态。共享 `config.yaml` 在 Desktop 启动时被产品重写，整文件哈希从 `64E70311...` 变为 `A2A1CF11...`，见 `installed/ui-catalog.json`；时点与既有 `mutateRuntimeConfig`/Memory endpoint 启动写入一致。本轮没有调用模型设置写入 API，但只保留了启动前哈希，没有完整内容快照，因此不宣称共享配置字节或所有字段均未变，也不覆盖正在运行的配置。

首次封装在 PowerShell 5 将 Vite stderr 警告当错误时中断，尚未替换暂存内容；保留 `repack-first-result.json`，PowerShell 7 重跑封装成功。其首次 Electron 直接调用未捕获查询输出，改为等待进程结束后实际查询，记录为 `electron-sqlite-verified-query.json`；包内预检再次实际加载所有 SQLite，才允许安装。托盘退出独立核验，不用服务 shutdown 结果替代实际托盘动作。

本轮 Word 与隔离 Code 测试窗口正常关闭，fixture/采集器/探针均无残留，Memory 服务健康检查为 200，见 `cleanup-before-tray.json`。Desktop PID 25884 保持 stopped 状态，实际托盘退出等待用户点击；当前桌面工具没有返回可操作的 Windows 托盘窗口，不能从源码接线或组件 shutdown 宣称真实托盘验收通过。这一步尚未完成，退出后需检查该 PID 的 `quit-lifecycle.jsonl`、子进程清理与 Memory 保留状态。本轮不新增录制中的真实 Desktop 托盘退出结论。

在仓库根目录执行，Windows PowerShell、Git Bash 和 macOS 终端使用同一入口：

```text
node scripts/internal/shared/validate-computer-history.mjs
```

前提是已按仓库要求安装根目录和 `App/memmy-agent` 的依赖，使用满足 Agent 要求的 Node.js 22 或以上版本。入口直接调用本地 TypeScript、ESLint、Vitest 和 Vite，不执行 npm 的版本同步钩子，不下载依赖，不启动 Memmy App，也不调用真实模型服务。

执行内容：

1. 编译 Knowledge、Migrations、local-api-contracts 和 desktop interface。
2. 检查 Agent（包含测试）与前端类型，编译 Agent。
3. 检查 History 相关源码及测试的 lint。
4. 用两个 Vitest worker 执行共享/Mac/Windows 业务、HTTP、工作流、技能注册、前端、跨包协议与 Mac/Windows ASAR 布局测试。传入 Windows 原生目录后，也执行真实 Electron 包内 EXE 检查。
5. 检查共享 `core/summarize-history.js` 和旧 `mac/summarize-history.js` CLI 入口，构建前端。

默认报告保存在系统临时目录下的新目录；可通过 `--report-dir <绝对目录>` 指定父目录。每次都会创建独立目录，保存每项检查日志、Vitest JSON 报告和总表 `results.json`。总表列出跳过的测试名称；`passed` 只表示此基线通过，不表示真机或安装包验收通过。构建输出位于 Git 忽略的 `dist` 目录。

Windows 可额外验证生产 EXE 的生命周期：

```powershell
node scripts/internal/shared/validate-computer-history.mjs --native-bin D:/memmy-cpp-env/native-core-review/release --report-dir D:/memmy-cpp-env/history-baseline-artifacts
```

`--native-bin` 应指向当前源码构建得到的生产 EXE 与 fixture 所在目录。先用 `scripts/internal/win/history-recorder-native.ps1` 构建；自定义路径仅为本机示例。入口会先重新编译 Agent，再运行真实 Node + EXE 的启动、暂停、恢复、撤销授权、EOF 和有界时长用例。仅启动受控 fixture，不激活窗口、不注入输入、不授权用户的其他应用。前台内容/动作用例不在此基线内。

原生 C++ 全量测试另用构建脚本的 `-Test` 参数执行。CTest 返回 77 的前台条件跳过必须保留，不能计入通过；需要取得前台的场景留到 Windows 交互验收。

## 平台边界与明确跳过

| 检查 | Windows 上的处理 | Mac 上的要求 |
|---|---|---|
| 共享服务、摘要、恢复、保留、前端与协议 | 执行 | 再执行，确认运行时平台差异 |
| Mac POSIX 子进程正常结束 | 跳过；Windows `SIGTERM` 不执行 Node 的 POSIX 清理回调，Windows 驱动另测 stdin/ack/close | 必须执行，退出码及停止后不再写入均通过 |
| 录制目录链接逃逸 | 使用无需提权的 junction 实测 | 使用目录 symlink 实测 |
| pin 文件 symlink 边界 | 仅创建链接遇到 EPERM/EACCES 时跳过；有权限时仍执行 | 必须执行，目标内容不得被截断 |
| Swift 分类、命中目标与原生 ingest fixture | 现有测试按平台跳过 | 必须执行，需要 Xcode Command Line Tools |
| Unix helper 可执行权限、Electron 包内 helper 执行 | 现有测试按平台跳过 | 必须执行，需要本仓库 Electron 依赖 |
| Windows 原生适配 | 默认整文件排除；指定 `--native-bin` 时只跑生命周期 | 不适用 |

不要把 Mac 业务测试所在的 `mac/` 目录等同于“全都只能在 Mac 测”。绝大多数共享业务用例仍在 Windows 执行；只为确实依赖平台能力的用例设置条件。

共享摘要根据录制 metadata 的 `platform` 生成 `capture_policy`。Windows 为 `accessibility_events_no_screenshots`；Mac 和旧的无平台字段记录保留 `accessibility_events_and_page_urls_no_screenshots`。恢复记录时不以当前宿主平台替代录制平台。旧 Mac AX 数据、bundleId 和导入路径继续兼容。

## Mac 接续步骤

Windows 基线完成后，下一步需要一台 Mac。将本分支的阶段提交带到 Mac，安装仓库依赖与 Xcode Command Line Tools，然后：

```sh
node scripts/internal/shared/validate-computer-history.mjs --report-dir /tmp/memmy-history-validation
```

先查看 `results.json`。上述 Mac 专属用例应实际执行，不能仍被跳过。若失败，保存失败日志并定位，不应通过放宽 Windows 分支或删除断言解决。

自动回归通过后，在 Mac 上继续手工验证共享层抽取后的产品行为：

1. 启动开发版 App，检查辅助功能/输入监控的授权提示、拒绝及重新授权；确认 Mac 原有设置文件和应用/网站规则仍生效。
2. 使用临时测试文档执行开始、暂停、同段恢复、停止；确认暂停/停止后事件文件不再增长，App 退出后所属子进程结束。
3. 验证原有停止热键、应用图标、浏览器同标签页 URL 更新，以及密码/敏感内容过滤。仅使用受控测试数据。
4. 跨越一次十分钟分段边界，检查时间线、摘要、保留/删除、pin、恢复和检索；真实模型摘要单列结果，与自动测试中的模型替身区分。
5. 检查既有 Mac 打包 helper 的构建与执行。自动 ASAR 测试只证明布局和受控 helper 执行，不能替代安装版 Swift/AX 采集验收。

留下 Node/macOS/CPU 架构、验证提交、自动报告目录和各手工场景的结果，再判断是否可以进入下一阶段。当前 Windows 机器不能代替这些 Mac 验证。

启动开发版 App 前，还应确认 Memory 使用的原生依赖与实际运行 Node 的 ABI 一致。在仓库根目录用将用于启动 Agent/Memory 的 Node 执行：

```sh
node -e 'const Database = require("better-sqlite3"); const db = new Database(":memory:"); console.log(db.prepare("select 1 as ok").get()); db.close();'
```

若出现 `NODE_MODULE_VERSION` 不匹配，使用同一 Node 在根目录执行 `npm rebuild better-sqlite3`，再重复探测并确认 Memory 服务实际启动。统一入口的类型、History 测试与前端构建不会启动 Memory，不能代替此运行时检查。

## 2026-10-02 Mac 回归结果

验证分支为 `codex/windows-history-native-core`，提交 `47d03da4c160c5fd0b93706ada619471105f142f`，包含 `26c2467d`。执行前工作区干净。环境为 macOS 26.4 / arm64、Node 22.23.3、Electron 38.4.0、Xcode Command Line Tools / Swift 6.3.2。

本机自动报告：首次为 `/tmp/memmy-history-validation/computer-history-validation-JKynDD/results.json`，修复退出问题后的复跑为 `/tmp/memmy-history-validation/computer-history-validation-xUdZKI/results.json`。真机及受控 fixture 证据：`/tmp/memmy-history-validation/mac-acceptance/`，接续证据位于其 `followup/` 子目录。这些临时目录未提交，其他机器应重新生成证据。

| 层级 | 实际结果 |
|---|---|
| 统一自动回归 | Agent 417、前端 84、跨包协议/ASAR 11，共 **512 通过、0 失败、0 跳过**；类型、lint、构建及两条摘要 CLI 全部通过。Windows 原生适配按入口规则排除，不属于 Mac 跳过项。 |
| 后端退出回归 | 本地 API 的 60 项测试通过，包含新增的 SSE 正常关闭及鉴权过程中关闭（允许/拒绝）三个用例；后端 TypeScript 编译和修改文件 lint 通过。 |
| Mac 专属自动用例 | Swift 分类及同窗口 URL、鼠标命中/拖动、Swift→TS ingest 隐私、POSIX 子进程、目录与 pin symlink、helper 可执行权限、Electron 无 Swift 的包内 helper 执行均实际通过；具体名称和耗时见 `environment-and-mac-audit.json`。 |
| 共享服务受控 fixture | `service-fixture/results.json` 的 10 项检查通过，包括真实墙钟十分钟边界、暂停/恢复/停止、摘要/检索/pin/删除/恢复及子进程清理；采集子进程和模型响应是替身，停止热键仅为合成协议事件。 |
| 真实开发版 App + Swift helper | 使用独立 App 配置、临时数据目录及默认拒绝的应用/网站规则。用户在受控 Cocoa 测试窗口输入后，取得 81 条该应用事件；搜索及文档内容为阳性对照，密码框为 `[REDACTED]`，已知密码标记和合成 API Key 明文未落盘。实际停止热键产生 `stop_hotkey`，状态停止且 recorder 退出。 |
| 真实生命周期与分段 | 通过生产 HTTP API 开始、暂停、同段恢复、停止；暂停/停止后文件稳定。首次 18:50 仅验证轮换，接续在 19:30 用 Chrome 受控网页补齐跨段内容：旧段有 `browser before boundary`，新段有 `browser after boundary`，旧段不包含后者且不再增长。 |
| 真实浏览器与网站规则 | 同标签页 `one.html → two.html → 被排除的 localhost → one.html`；允许页面内容及 URL 更新入库，查询参数/片段标记、合成密码/API Key、禁止页面文字和 URL 未落盘，回到允许页面后恢复采集。 |
| 录制中 App 菜单退出 | 修复本地 API 的 SSE 退出阻塞后，从实际 History 页面菜单退出；1,048 ms 内出现 `will-quit`/`quit`，无 5 秒强制退出告警，Desktop/Agent/recorder 子进程结束且文件稳定。Memory 按既有设置常驻，随后单独清理测试实例。 |
| 摘要、检索与图标 | 本机 HTTP 模型替身生成摘要并显示在生产快照；生产检索读取真实录制摘要的副本，Mac capture policy 保留；真实条目 HTTP pin/unpin 通过。真实原生图标 helper 及 TS 适配读取 TextEdit/Safari PNG 通过。未调用真实模型服务。 |
| 原生 helper 打包冒烟 | 实际编译的 `human-recorder` 和 `app-icon` 经 Electron 从 ASAR unpacked 路径执行，在无 Swift 的 PATH 下分别完成权限探测和图标读取。没有替代安装版签名、权限身份及 AX 采集验收。 |

首轮修复了本机运行条件和测试替身：根目录 `better-sqlite3` 原为 ABI 139，与 Node 22 的 ABI 127 不符，重编译后 SQLite 探测及 Memory 启动通过。共用模型替身最初缺少 Memory 所需的 `summary` 字段，触发重复摘要/embedding 作业；补齐合成字段后待办处理一次并停止重复，见 `model-fixture-shape-fix.json`。

接续真机退出检查发现实际缺陷：隐藏窗口仍持有 `/api/events` SSE 订阅，Fastify 的关闭过程等待长连接，触发 Desktop 的 5 秒强制退出兜底。后端现在在 `preClose` 结束现有事件流；鉴权在关闭期间完成时返回带 `Connection: close` 的 503，避免新流或 keep-alive 阻塞退出。真实 HTTP 用例在修复前失败、修复后通过，实际 App 随后正常退出，见 `followup/server-lifecycle-before.log`、`followup/backend-api-tests.json`、`followup/app-quit-after-fix.json`。未改变正常运行时的鉴权、采集隐私规则或测试跳过条件。

隔离记录：接续时发现临时 App 数据库残留 `scan_and_write_skill`，引导页显示了本机 Agent 会话线索。已将这个临时数据库的扫描权限设为 `none`，并关闭临时配置中的自动扫描、文件监听和技能注入。该类引导页内容未用作受控 History 证据，也未调用真实模型推理，见 `followup/isolation-correction.json`。History 的默认拒绝规则始终保留。

权限探测最初为辅助功能/输入监控未授权；用户暂不授权。随后只读探测均返回已授权，本轮未改动系统权限开关，不能据此认定拒绝→重新授权流程已完成。第一轮桌面工具无法将测试窗口置前，真实 Cocoa 输入/热键由用户协助；后续浏览器、跨段及菜单退出已由桌面工具完成。最终进程清理结果见 `followup/cleanup.json`，分层结果总表为 `mac-acceptance/results.json`。

同日生成 Apple Silicon 安装测试包 `App/shell/desktop/release/Memmy-1.1.8-darwin-arm64-cn-history-regression-20261002-adhoc.dmg`，版本仍为 1.1.8，包含本轮后端退出修复。该包为 CN/phone 配置、ad-hoc 临时签名，未做 Apple 公证。包内 13 项检查通过：严格递归签名、ASAR 边界/版本、退出修复与编译产物一致、源包元数据保持、运行时资源、环境文件排除、arm64 helper 签名、第三方 Computer Use 签名保留，以及实际打包 Electron 中三份 SQLite 加载、真实 History helper 执行和 Mac 摘要 CLI。helper 仅执行只读权限探测及图标读取，未进行安装后的桌面采集；未调用真实模型。打包器将开发依赖 SQLite 改为 Electron ABI 139 后，已恢复为 Node ABI 127 并确认内存查询通过。构建和包内证据位于 `/tmp/memmy-history-validation/mac-package/`。

### 同日安装版验收

用户安装到 `/Applications/Memmy.app` 并开启权限后，校验安装版 ASAR 与测试包一致，原生 helper 和生产 API 均返回辅助功能/输入监控已授权。安装版证据为 `/tmp/memmy-history-validation/installed-app/results.json`：16 项通过、1 项未确认、1 项未执行。这是安装版检查项计数，不与前述 512 项自动测试相加。

- 在现有用户配置中暂时将采集范围收紧为 TextEdit、Chrome 和 `127.0.0.1`，保留原有历史。新建的合成测试文档最终保存于证据目录；原生事件确认 A/B 文字实际落盘。通过生产 API 暂停/恢复，通过真实页面开关停止/重启；暂停和停止期间文件稳定，专用阴性标记未落盘。
- Chrome 同标签页访问受控页面一、页面二、排除的 `localhost` 页面，再返回允许页面。页面正文、搜索词和 URL 更新有阳性证据；合成密码、API Key、查询参数、片段、禁止页面文字及 URL 未落盘。21:40 实际轮换，旧段有边界前搜索词，新段有边界后标记，旧段不再增长。中途锁屏，用户解锁后继续完成检查。
- History 页面显示 TextEdit/Chrome 图标及实际模型生成的测试摘要。模型沿用安装版配置和既有摘要上下文，未替换成 fixture；摘要生成通过，但存在把文档正文误述为文件名、从单次测试推断用户偏好的事实精度问题。原生事件仍明确区分 `AXWindow` 标题与 `AXTextArea` 内容，因此不能把这一质量问题认定为 Mac 采集或共享层抽取回归。另用安装包中的生产检索实现检索隔离复制的真实摘要，通过；这项属于受控调用，不代表聊天端到端检索验收。
- 实际 History 页面处于录制中时，通过 Memmy 菜单退出。主进程及当时的全部 7 个后代进程（含 Agent、recorder）结束，未见强制退出告警，事件文件随后稳定。退出耗时记录包含工具调度间隔，不能作为精确性能指标。测试开始前已存在的常驻 Memory 和第三方 OpenComputerUse app-agent 保留；没有将它们当作 History 孤儿进程。
- 桌面工具能修改目标应用，但 AX 定向动作不会保证切到系统前台；通过 Finder 打开测试文档/应用后才取得真实采集证据。多次合成停止热键未产生全局键盘事件或 `stop_hotkey`，所以安装版全局热键仍为未确认，不据此判定产品失败，也不沿用开发版用户实体按键的通过结果。权限拒绝→重新授权的完整流程未执行，本轮没有操作系统权限开关。

验收结束后按字节恢复原观察设置，关闭受控网页、文档与目录窗口，移除测试应用链接并停止本地网页服务器。Memmy 保持退出；测试记录保留以供检查，未删除用户已有历史。详情见 `cleanup.json`、`quit-results.json` 和 `real-model-results.json`。

**阶段判断：自动回归、开发版及安装版已执行的 Mac 功能检查通过，退出缺陷已在安装版验证。** 可以继续下一阶段功能开发；完整 Mac 验收仍保留安装版实体停止热键和权限拒绝/重新授权两项，真实摘要的事实精度需另行改进。

## 2026-10-02 Windows 基线结果

统一入口报告目录：`D:/memmy-cpp-env/history-baseline-artifacts/computer-history-validation-aMwSLD`。该路径是本机证据位置，其他机器应运行入口生成自己的报告。

| 检查 | 结果 |
|---|---|
| 共享/Mac/Windows 业务、HTTP、工作流和技能 | 411 通过，6 个平台/权限条件跳过，0 失败 |
| 前端（包括两平台模型同步） | 84 通过，0 失败 |
| 跨包协议与现有 Mac ASAR 布局 | 10 通过，1 个 Mac Electron 执行用例跳过 |
| 生产 EXE + 重新编译的 Node CLI 生命周期 | 3 通过；1 个前台内容用例按本阶段范围过滤 |
| 类型、相关源码/测试 lint、Agent 编译、两条摘要 CLI、前端生产构建 | 通过 |
| C++ Release / Debug | 均确认构建无待更新；各执行 `unit`、`win.boundaries`、`integration.cli_contract` 三个 CTest 入口，全部通过 |

原生 C++ 本次只重跑上述三个入口；较早的全量 16 通过/16 前台条件跳过记录见原生 README。本次没有将完整交互套件重新验收。前端构建仍有现有的大 chunk 体积提示，不影响本阶段构建通过。

## 2026-10-03 Windows 安装包与默认范围对齐

验证基点为 `07a7a85d`，包含前述 Windows 核心、产品接入和 Mac SSE 修复；本节记录在该基点上的本轮工作区改动。初始工作区干净，已从用户 fork origin 安全同步；没有推送 upstream，也没有使用 Claude Code。

Windows 新配置改为与 Mac 相同的默认应用范围：用户确认开启后观察支持的应用，可额外排除或切换到仅选定模式，不要求先逐项选择。已有 Windows v1 文件缺少 `defaultApplicationBehavior` 时保留原白名单；不存在文件时才使用 `observe` 默认值，且保持停止状态。产品层把范围编译为真实 PID/规范路径/进程创建时间，最多 512 个实例；原生层不接受通配匹配。密码、普通 Edit、敏感子树、已知浏览器和锁屏/登录/屏保表面继续过滤。Windows 尚不具备 Mac 浏览器 URL/网站规则或图标功能，不能将默认范围对齐称为完整功能对等。

Windows NSIS 构建现在使用 `-ProductionOnly` 编译静态 CRT 的 Release helper，随包分发 EXE 和 nlohmann/json 许可证，不带源码、fixture、故障注入 EXE 或 PDB。两个 Windows builder 配置均显式解包 helper；安装版只使用 `app.asar.unpacked` 中的固定路径并忽略开发覆盖，缺少包内组件则报错。打包后校验要求实际 x64 PE 文件存在。Windows 停止热键为 `Ctrl+Alt+Shift+R`，在原生暂停或前台应用不在范围时仍可停止；停止组合键不进入内容事件。

本机证据根目录：`D:/memmy-agent/App/shell/desktop/release/history-validation-20261002/`。目录与安装包被 Git 忽略，仅在本机，其他机器须重新生成。

| 层级 | 实际结果与证据 |
|---|---|
| 最终统一自动回归 | **523 通过、0 失败、8 明确跳过**：Agent 420、前端 87、跨包/ASAR 13、原生生命周期 3。类型、lint、编译、两条摘要 CLI 和前端构建通过。总表：`final-aligned/computer-history-validation-gwQ2b0/results.json`。 |
| 后端本地 API | **60 通过、0 失败**，包含 3 个真实 HTTP SSE 退出用例；11 个文件，独立于统一计数。`backend-local-api.json`。 |
| 原生 Release / Debug | **各 33 个 CTest 入口通过、0 失败、0 跳过**；含实际前台 fixture、竞态/超时/父进程退出、输入钩子和停止热键。`native-release-mac-aligned.xml`、`native-debug-mac-aligned.log`，原始 Debug 证据在 `native-mac-aligned/debug/`。Release EXE 574,976 bytes（561.5 KiB），Debug 3,363,840 bytes，不随包分发。 |
| 打包防护回归 | **28 通过、0 失败**：20 项运行时配置/ASAR 防护和 8 项版本防护，`packaging-guards-aligned.json`。新增缺 helper、非法 PE 和夹带原生测试源码的断言实际执行；3 项 Windows ASAR/Electron 检查已包含在统一计数，不重复相加。 |
| 原生 TS 适配器最新独立复跑 | **3 通过、1 前台条件跳过**，`native-adapter-aligned-executed.json`；窗口激活失败的 `fixture-precondition.json` 保留在 `native-adapter-aligned/`。更早 `native-adapter.json` 为 4 通过；后者不是最新复跑结果。误用环境变量的一次运行 4 项明确跳过，保留在 `native-adapter-aligned.json`，不计通过。 |
| 最终包内预检 / 安装版预检 | **各 6 项通过、0 失败**：包内 helper、默认范围就绪且不自动开始/旧空白名单拒绝、三份真实 SQLite 查询、共享摘要 CLI。`packaged-aligned-fixed/preflight.json`、`installed-aligned/preflight.json`，独立于统一计数。 |
| 安装版产物与源码对应 | Desktop EXE、ASAR、helper 三份 SHA-256 与最终包一致；7 个 Windows 生产 JS 模块和后端 SSE 文件共 **8/8** 与当前编译产物一致。`installed-aligned-hashes.json`、`installed-source-matches-aligned.json`。 |
| 安装版生产组件 + Win32 fixture | **14 项通过、0 失败**，`installed-components-aligned-fixed/results.json`。实际安装 Electron、包内 EXE、隔离数据目录和模型替身；不代表 Desktop UI 或真实模型。 |
| 实际 Desktop + 真实模型 | **9 项检查通过、0 失败**，`installed-ui-aligned/real-acceptance-results.json`；实际页面开始/停止，生产 API 暂停/恢复，受控原生文字与敏感过滤、真实模型摘要和隔离副本的生产检索。实体热键、托盘正常退出仍未执行，不并入通过数。 |

统一入口的 8 项跳过逐项为：Windows 不具备 POSIX 子进程信号语义；本机无文件 symlink 创建权限；Mac Swift 分类/同窗口 URL；Mac 鼠标命中/拖动；Unix helper 可执行权限；Mac 原生 ingest；Mac Electron/Swift 包内执行；Windows 前台内容用例按统一入口范围过滤。最后一项不能代替交互采集验收；Release/Debug 前台原生检查另有上述独立结果。

新增“无需选应用直接开始”的页面测试首次因 mock 未返回 Promise 而失败，修正替身后全部通过；报告 `final-aligned/computer-history-validation-gLr2Sv/` 保留。没有删断言或降低隐私要求。更早的 508/517/521 基线均为不同源码阶段，不作为本轮最终计数。

初始 unsigned 包的受控组件检查 `installed-components/results.json` 为 13 项通过，包括实际墙钟 06:10→06:20 UTC 分段、暂停/恢复/停止、敏感过滤、合成热键、异常 recorder 退出和受控生产检索；模型使用 fixture，没有调用真实模型，也没有代表 Desktop UI 操作。该包采用旧白名单与旧弹窗布局，保留为 `Memmy-1.1.8-win32-x64-cn-unsigned-before-picker-fix.exe`（SHA-256 `9BD93B115FF4A02E20DBFF45487B677B7E483004E543150991403E80E9F11A3C`），不能作为新默认范围的安装版证据。

最终打包前的只读预检发现 SQLite ABI 缺陷：开发环境曾恢复根目录 SQLite 到 Node ABI 137，但 `.forge-meta` 仍为 `x64--139`；electron-rebuild 根据该标记跳过重建，根目录错误二进制进入包。`packaged-aligned/preflight.json` 实际加载失败，不能以打包器 exit 0 认定该包可用。失败包保留为 `Memmy-1.1.8-win32-x64-cn-unsigned-abi-failed.exe`。修复后，Windows 打包每次明确安装 Electron 目标 ABI，并在最终打包 Electron 中对 Desktop/Memory/Agent 三份 SQLite 实际执行内存查询；不再仅依赖 PE 格式或重建缓存标记。最终安装包按此流程重建，具体结果另列。

### 最终安装测试包

产物为 `D:/memmy-agent/App/shell/desktop/release/Memmy-1.1.8-win32-x64-cn-unsigned.exe`，版本 **1.1.8 / Windows x64 / CN phone / NotSigned**，Memory 版本 2.1.3。NSIS 大小 **355,098,553 bytes（338.6 MiB）**；原生 helper 大小 **574,976 bytes（561.5 KiB）**，无需 .NET 或目标机编译工具。该文件是本机测试包，未签名、未正式发布。

| 文件 | SHA-256 |
|---|---|
| NSIS 安装包 | `8E666DA2FAC2EE28719154C981A8ADCB2E351468A5AD2BCDC512AD36AD31B729` |
| Desktop Memmy.exe | `7144FE4423D18B39788EB2C9D5EFFCF07C7B0E10AB8B690857390A53EC7CBDA5` |
| app.asar | `270356F5312FA00CB98F18B630EF15A50CA571B9C411562F5196F24EF834654C` |
| memmy-history-recorder.exe | `2E77D871EF8F0397F0523C18FB0EAE712C5124D61AD58DA6CB02BE0F52945E1B` |

使用本机已校验的 nlohmann/json header、既有完整 embedding 模型离线资源，在重新编译 Agent/前端和生产 helper 后从 Windows 构建脚本的打包阶段接续，未移除打包防护。构建日志 `win-1.1.8-x64-cn-unsigned-20261003-145357.log` 中 NSIS 已生成，但后置校验最初因 `cygpath` 不能转换 ASAR 虚拟子路径退出 1。修复为转换实际 ASAR 路径后拼接内部相对路径，重新执行完整后置校验成功，日志 `win-1.1.8-x64-cn-unsigned-20261003-152224.log`；此修复仅涉及校验脚本，包内代码未变。具体 hash 见 `final-package-hashes.json`。

安装器于本地时间 2026-10-03 15:24 完成，exit 0，安装位置为 `C:/Users/zephyr/AppData/Local/Programs/Memmy`。安装版与包内三份实际文件逐一匹配，helper 固定在安装目录的 `app.asar.unpacked` 内；预检刻意提供无效 binary 覆盖和无编译工具 PATH，仍执行包内 helper。安装后实际 Desktop/Memory/Agent SQLite 查询通过。打包后开发根目录 SQLite 已恢复为 Node 24.21.0 / ABI 137，真实内存查询通过，见 `development-sqlite-restored.json`。Electron 为 38.4.0 / ABI 139，Python 为 3.12.14，C++ 为 VS 2022 v143 / MSVC 19.44 x64。

### 安装版受控组件与实际界面

最终 14 项组件检查使用真正的安装版生产模块和原生 helper。`applications: []`、默认 `observe` 时可直接采集 fixture；为隔离测试，其余当时运行的应用均排除，所有内容事件的 EXE 均为 fixture。实际墙钟 **07:20→07:30 UTC**（本地 15:20→15:30）跨段，旧段有边界前阳性标记且随后稳定，新段有边界后阳性标记。暂停/恢复/显式停止、合成全局停止热键、异常 recorder Node 父进程退出后进入失败、撤销范围停止均通过。模型替身产生 5 次请求，生产检索为受控调用；这些结果不属于真实模型、实体输入或聊天端到端验收。

首次最终组件脚本 `installed-components-aligned/results.json` 为 6 通过、1 失败：切换 `applications: []` 时验收脚本丢失了 fixture 自定义敏感 ID `1007`，随后检查整个追加文件时发现该合成面板内容。该面板不是密码框，没有系统敏感标识。修正脚本将同一 ID 放入全局 `sensitiveAutomationIds` 后保持空应用规则，全部 14 项通过；没有改变产品过滤、删除断言或使用真实敏感数据。**密码标志、普通 Edit、脱敏正则和明确配置的敏感 ID 有过滤保证，不能声称可自动识别任意业务敏感面板。**

实际 Desktop 新配置初始就绪但停止，页面直接开启时出现确认框，不要求先选应用。真实模型检查临时将范围收紧为唯一 Win32 fixture，配置搜索 `1003`、文档 `1006`、敏感子树 `1007`，保留其他应用排除，沿用本机已配置的 **BYOK gpt-5.5** preset；仅合成 QA 文字进入采集/模型。API 的 `model_preset: null` 首次返回 `model_selection_unavailable` 422，验收脚本改用已有明确 preset 后成功，没有修改凭据。模型请求未拦截，因此不报告精确请求次数。

真实页面确认开始后，包内 helper 采集 Heliotrope/Friday 等合成静态文字和授权文档；生产 HTTP API 暂停/同段恢复，暂停期间文件保持 **12,978 bytes**，暂停阴性标记未落盘。实际页面开关停止后文件稳定，确认停止后阴性标记未落盘，且无原生 collector 残留。普通 Edit/子节点、密码/子节点、敏感面板和合成 API key 明文均未落盘，有 `[REDACTED]` 阳性证据。一次 UI 停止动作因工具的 `coordinate input geometry is unavailable` 失败，API 仍为 running；取得新截图后坐标点击成功，只有第二次确认停止后的标记作为阴性对照。

真实模型生成并在页面显示 **Heliotrope synthetic QA fixture**，保留 Windows capture policy；内容对应合成项目说明、计划 Friday 发布和恢复后的 QA 文字，未观察到此次样本推断偏好的问题，不能据单一样本宣布先前摘要质量问题已解决。安装包生产检索实现读取隔离复制的真实摘要，查询 Heliotrope 命中；这是受控调用，**没有验证聊天端到端检索**。页面中的可选范围弹窗已确认列表可滚动、底部取消/刷新/保存可见；未通过 UI 改动范围设置。

真实 Desktop 首次启动耗时约 31.5 秒，启动日志为 ready 但主窗口空白，`Ctrl+R` 后界面恢复。这是本轮实际遇到的启动界面问题，根因未定位，不能标为无问题启动。证据位于 `installed-ui-aligned/` 的生产 API 快照、隐私审计、合成事件副本、真实摘要和 `cleanup.json`；该目录未提交到 Git。

验收结束后通过生产 API 恢复有效原范围，并恢复原 Windows settings 文件不存在的状态；store 按调用重新读取文件，不需修改现有用户配置或历史。测试窗口/host 已关闭，App 保持打开且采集停止，合成历史保留。安装前关闭旧 App 用的是强制进程树清理，仅为替换文件前准备，**不代表正常退出验收**。

### 6fe3655f 阶段的待验项（后续结果见下文）

1. 实体键盘：在受控测试范围启动记录，真实按下 `Ctrl+Alt+Shift+R`，确认 UI 停止、JSONL 的停止原因及 collector 退出；本轮仅有 C++/安装版组件的软件注入结果。原生 paused 热键通过不证明产品服务 paused 热键，因为服务暂停会关闭 recorder。
2. 正常退出：在受控录制中右键系统托盘 Memmy 图标→“退出 Memmy”，确认 Desktop/Agent/recorder 全部结束、事件文件稳定、无强制退出告警。当前桌面工具无法定位托盘菜单；窗口右上角关闭按现有逻辑隐藏 App，不能视为退出。
3. 安装版首次空白界面的根因、IME、多屏/DPI、系统锁屏、真实应用兼容与长时间稳定性，以及正式签名仍未完成。本轮没有扩展 Windows 浏览器/Office/WPS。

## Windows 首帧交接、退出收尾与安装版复验（2026-10-03）

本轮接续 `6fe3655f`。此前安装版的启动日志已 ready，但窗口空白，需要 `Ctrl+R` 才恢复；源码确认 Windows 主窗口创建时立即可见，且在 `did-finish-load` 时关闭 splash，该事件并不保证首帧已绘制。现改为 Windows 完整窗口初始隐藏，收到 `ready-to-show` 后显示并关闭 splash；加载失败、30 秒首帧超时、退出期间的迟到事件仍受原有生命周期控制。Mac/Linux 的初始可见和页面加载交接保持原行为；本机仅运行平台分支替身测试，没有再次进行 Mac 实机验证。

### 自动回归与证据层级

本机证据目录为 `D:/memmy-agent/App/shell/desktop/release/startup-diagnostics-20261003/`。报告、截图和安装包均未提交到 Git。

- 修复前加入首帧断言，`startup-before-20261003.json` 为 **18 通过、1 失败**，失败证明原主窗口在首帧前已显示。修复后的启动页、启动生命周期和窗口模式三组测试为 **64 通过、0 失败、0 跳过**，报告为 release 下的 `startup-final-20261003.json`。Windows checkout 的窗口模式源文本检查统一 CRLF/LF，保留所有断言。Desktop TypeScript 检查和编译通过。
- 退出收尾新增 **10 项**真实本地 HTTP 与生产 cleanup 顺序测试，覆盖认证、等待响应体结束、空闲 409、认证/停止失败、超时、Windows 先排空后终止及 Mac/Linux 原顺序。连同上述三组重新执行为 **74 通过、0 失败、0 跳过**，见 `exit-drain-regression-20261003.json`；这是重跑后的定向结果，不能与 64 相加。
- 真正 Electron + 新包内 `createMainWindow`、renderer、preload 的隔离检查为 **4 通过**：初始隐藏、页面加载不提前交接、首帧交接、真实 React 页面渲染。`packaged-probe/results.json` 与 `paint.png` 保留。使用独立用户目录、合成本地 API，拒绝外部请求；没有启动真实 Desktop 服务或调用模型。首次脚本因用户目录缺失及合成枚举不合法失败，修正脚本后通过，不将其当作产品失败或安装版验收。
- 新包和新安装目录的生产预检各 **6 通过**，分别见 `packaged/preflight.json`、`installed/preflight.json`。无效 helper 环境变量和空 PATH 下仍执行包内 EXE；Desktop/Memory/Agent 三份 SQLite 实际查询及共享摘要 CLI 均通过。三份安装文件与包内文件的 SHA-256 全部匹配，见 `installed-matches.json`。
- 扩大到 Desktop 全目录的首轮有效回归为 **431 通过、13 失败、0 跳过**，原始报告 `desktop-regression-20261003.json` 保留，不能写成全绿。更早受限环境的进程查询被拒绝，该轮中断，没有完整计数。13 项的后续定位如下，不能把定向复验拼成另一次完整回归总数：

| 首轮失败 | 定位与定向结果 |
|---|---|
| 9 项 dev CLI | 当前 PowerShell PATH 找不到 `bash`（ENOENT）。临时加入 Git Bash 后该文件 **9 通过、2 失败**；余下两项要求 POSIX 文件符号链接，Git Bash 在本机产生普通文件，断言仍失败，未跳过或删除。 |
| 1 项真实 Memory 重启 | 打包临时切换根目录 SQLite 到 Electron ABI 139。新 ASAR 生成后恢复 Node 24.21.0 / ABI 137，真实查询及该项重启复验通过。 |
| 1 项打包边界 | 多行源文本断言受 CRLF 影响；本轮未修改该测试，仍待修复。 |
| 1 项 Memory 强杀 | Windows 实际退出描述为 `code 1`，原测试要求 POSIX `signal SIGKILL`；本轮未修改断言，仍待平台适配。 |
| 1 项升级 relay | 默认 Vitest 5 秒预算先于用例已有的 10 秒业务时限终止。定向重跑仍失败；仅将框架预算设为 15 秒、保留原小于 10 秒断言后 **1 通过**。31 项是 testNamePattern 未选中的用例，非平台跳过；测试入口的预算仍待调整。 |

### 首帧修复测试包与实际启动

首帧修复包随后保留为 `D:/memmy-agent/App/shell/desktop/release/Memmy-1.1.8-win32-x64-cn-unsigned-before-exit-drain-fix.exe`，**1.1.8 / Windows x64 / CN phone / NotSigned**，大小 **355,096,041 bytes（338.6 MiB）**。沿用上一阶段已验证的完整 runtime/helper/embedding 资源，仅重新编译 Desktop 主进程并从当前 Windows 构建脚本的打包阶段接续；SQLite ABI 与资源后置防护全部执行，日志 `win-1.1.8-x64-cn-unsigned-20261003-160816.log`，构建 exit 0。此前安装包已保留为 `Memmy-1.1.8-win32-x64-cn-unsigned-before-startup-fix.exe`，其 `8E666D...` 校验值仅属于上一阶段。

| 新文件 | SHA-256 |
|---|---|
| NSIS | `9545FCBFDE95F1EB188E25FAA7EE0A202B0E96A64413571C6E3A13D9B99631C1` |
| Desktop Memmy.exe | `5F7F53665E22A40149C78C0EEA0DE61961D68499D9300C1011AF70204075A4F9` |
| app.asar | `6177D06FBDB8A217FA497CB91429F2CC71D7BA33DA7F9A404B70940FBC202BE4` |
| 原生 helper（未变） | `2E77D871EF8F0397F0523C18FB0EAE712C5124D61AD58DA6CB02BE0F52945E1B` |

用户从托盘正常退出旧 App，日志记录 `08:15:30 UTC quit:cleanup-start`；该次退出时采集已停止，只属于空闲退出证据。确认安装操作于本地 **16:18:27** 返回 exit 0；首个安装进程结束时未保留退出码，未启动 App 的情况下再次对同一包确认安装，见 `install-result.json`。

新安装版于本地 **16:19:18** 启动，无开发目录或 helper 覆盖。实际界面直接显示主页面，**没有使用刷新**；启动日志于 `08:19:29 UTC` 以 `main-ready-to-show` 交接，耗时 **9,974 ms**，随后 boot ready。见 `installed/startup-acceptance.json`、`startup-excerpt.log`。这是一个正常用户配置下的真实安装版启动成功样本；UI Automation 树仍不完整，按实际截图确认页面，不以空树判定空白，也不据一次成功承诺所有间歇绘制问题均已消除。

### 实体热键与录制中的托盘退出

实体热键使用唯一合成 fixture 范围。首轮等待期间先通过 API 停止并清理，用户回复在清理后到达，因此不能作为实体输入证据。第二轮保留自动监控，JSONL 于 **08:30:59.679 UTC** 写入 `stop_hotkey`，API 变为 stopped、segment 为 null，原生 collector 为 0，文件保持 **6,985 bytes**；阳性标记和敏感字段过滤审计通过。该轮跨十分钟边界，前段 `stop_command` 属于正常分段，后段 `stop_hotkey` 才属于实体停止。见 `manual-retry/hotkey-start.json`、`hotkey-stop.json`、`controlled-audit.json`。停止后的阴性命令响应未单独保留，故仅声称文件稳定，不声称完成独立阴性输入确认；自动化工具返回的页面图像与目标不一致，未据其宣称 UI 视觉停止状态。

用户在下一轮合成录制中于 **08:37:26 UTC** 从托盘退出。Desktop、Agent 和 collector 全部退出，文件停止增长，但 **缺少最终 `recording_stopped`**。`manual-retry/tray-before-fix-result.json` 保留失败，不能以进程消失替代完整退出验收。最初进程监控将所有 `Memmy.exe` 都视作 Desktop，因仍有 PID 7128 而失败；查询实际 Memory runtime/lock 及只读 App 设置后，确认它是用户配置 `stop_memory_service_on_exit = 0` 所允许的 Memory 服务，见 `tray-exit-role-audit.json` 和 `memory-exit-policy.json`。没有强制结束它，也没有修改退出设置。

Windows 的进程树强制终止绕过了 Agent 异步 shutdown。现于 Desktop 清理 runtime 前，通过 gateway bootstrap secret 换取临时令牌，再调用生产 stop API，等待 recorder 排空。两个请求及响应体共用 **3 秒**时限，保留既有 **5 秒**退出保护；服务不可用时记录收尾失败并继续进程清理。Mac/Linux 不增加该步骤。停止 API 仍不等待模型请求；本次修复验证原始事件完整写入，不能推导为退出前所有模型摘要已生成，已有重启恢复机制仍负责未完成摘要。

### 退出修复最终测试包

最终包为 `D:/memmy-agent/App/shell/desktop/release/Memmy-1.1.8-win32-x64-cn-unsigned.exe`，**1.1.8 / Windows x64 / CN phone / NotSigned**，**355,102,354 bytes（338.7 MiB）**。构建日志 `win-1.1.8-x64-cn-unsigned-20261003-165122.log`，耗时 **9 分 19 秒**，exit 0，ASAR、版本、SQLite ABI 与资源后置防护通过。本轮先遗漏 unsigned 参数，尝试中止后遗留的 builder 又干扰后一次输出目录；两次失败日志保留。确认所有旧 builder 结束后串行重建，没有安装失败产物。

| 最终文件 | SHA-256 |
|---|---|
| NSIS | `C43EAD1F0E4EC617E593927BE82BF172F2DD9740761C547B0BCAED112C077236` |
| Desktop Memmy.exe | `562A90EDD2B4BEB01865190F1B97CA68E3404CBC24E4A8A406FA7F9BBF545627` |
| app.asar | `C9D7EFD2BD813C37A72DD364907A6AC19DDCA272C3C8D4E5C97758BFC970184A` |
| 原生 helper（未变） | `2E77D871EF8F0397F0523C18FB0EAE712C5124D61AD58DA6CB02BE0F52945E1B` |

最终包与新安装版组件预检各 **6 通过**，见 `exit-drain-installed/packaged-preflight.json` 和 `installed/preflight.json`；三份安装文件校验全部匹配，安装于本地 **17:01:56** 返回 exit 0。安装版首次预检错误复用了包内预检已写入 legacy 设置的合成 profile，因 ready 断言失败；保留 `installed-preflight.json` 的 **1 通过、1 失败**，改用独立空 profile 后原断言全部通过。没有调整产品权限或断言。

新安装版于本地 **17:03:02** 启动，实际页面与 UI Automation 树均显示主页面，未刷新。`09:03:12.736 UTC` 收到 `main-ready-to-show`，耗时 **9,006 ms**，随后 boot ready，见 `exit-drain-installed/startup-acceptance.json`。打包后的开发目录 SQLite 已恢复 Node 24.21.0 / ABI 137，真实查询通过；包内保留 Electron ABI 139。

### 最终安装版托盘退出与清理结果

本地 **17:09:29** 五分钟等待窗口结束时 App 仍在录制；原等待报告现保留为 `exit-drain-installed/exit-processes-wait-timeout.json`，不能算一次产品退出失败。用户随后于本地 **17:52:10** 完成真实托盘退出，重新采样的 `exit-processes.json` 确认 Desktop、Agent、recorder 均已退出。

实际退出核心审计为 **9 通过、0 失败、1 未确认**，见 `exit-drain-installed/exit-acceptance.json`。这属于安装版合成范围的实际操作验收，与 74 项自动回归、组件预检及先前真实模型/检索结果分别统计。

- `09:52:10.673 UTC` 记录 Desktop `quit:cleanup-start`，`09:52:10.685 UTC` 写入最终 `recording_stopped / stop_command`，相隔 **12 ms**；明确检查事件在真实退出开始之后，未将十分钟轮转停止代替最终结束。修复前遗漏结束事件的失败证据仍保留。
- 本次唯一 fixture 从 `09:04:01.903 UTC` 运行至最终停止，持续 **48 分 8.782 秒**，覆盖六个 UTC 对齐分段及五次十分钟轮转；六段均有开始/停止，内容应用均为 fixture，阳性标记存在，普通 Edit、密码、子节点及敏感 ID 明文均未落盘。这只是单一合成窗口样本，未记录全过程资源曲线，不能据此宣称日常应用长期稳定性已完成。
- 实际退出后向仍打开的 fixture 写入阴性标记，命令响应确认成功，六个文件分别保持 **3,395 / 3,390 / 3,390 / 3,390 / 3,390 / 3,390 bytes**，阴性标记均未落盘。见 `negative-command-confirmed-final.json` 和 `synthetic-events.jsonl`。
- 剩余 PID **18784** 是 Memory；runtime/lock 一致，只读查询 App SQLite 确认 `stop_memory_service_on_exit = 0`，符合用户的常驻设置，未强制结束。见 `memory-exit-policy.json`。本机操作工具未发送强制终止，但这本身不证明 Desktop 内部未触发兜底。
- 持久化启动日志无 `quit:cleanup-failed`。**是否触发过 5 秒强制退出兜底仍未确认**：Desktop 使用的 `console.info/warn` 未由 `initLogger` 转发至 `electron-log` 文件，现有成功提示及超时告警没有持久证据。最初审计脚本错误要求 `main.log` 含收尾成功提示，因而失败，原脚本和 `exit-audit-first-result.json` 均保留；正式报告将日志可观测性列为未确认，未把删除日志断言当作全绿，也未据没有告警宣称无兜底。后续需增加持久化的收尾完成/兜底标记，并在下一测试包实测。

本地 **17:57:15** 已完成恢复：核对当前 settings 与本轮合成范围完全一致后，恢复原 Windows settings 文件不存在的状态；fixture 和 Node host 正常关闭，App 保持退出，采集器为 0，保留用户历史、凭据、退出设置及允许常驻的 Memory。见 `controlled-settings-before-restoration.json`、`settings-restored.json`、`final-cleanup.json`。本轮没有新增模型请求计数或聊天端到端检索验收。IME、多屏/DPI、锁屏、真实应用长期稳定性、正式签名及既有 Windows 浏览器/Office/WPS 限制继续保留。

## 2026-10-07：退出生命周期与 Windows 测试基线收敛

本轮从 `8b12d2b8` 安全同步开始；fork 当前分支无新增提交，工作区初始干净。本机证据根目录为 `D:/memmy-agent/App/shell/desktop/release/quit-validation-20261007/`，报告与安装包不提交 Git。

修复正常退出清理先将 `runtimeServices` 置空、导致超时兜底失去服务引用的问题：单次退出上下文保留服务及 Memory 策略，正常清理与兜底共用；超时后的异步返回不能再记录正常完成，重复退出不会重复清理。启动晚到的服务仍按该次退出策略处理。清理失败也执行尽力终止，避免直接退出后遗留所属服务。

新增用户数据目录内 `quit-lifecycle.jsonl`，按 `quitId` 保存开始、History 排空、服务清理、正常完成或强制退出阶段。小型记录同步追加并 flush，不记录正文、token 或异常响应体；写盘失败不阻止退出，证据缺失仍须判未确认。5 秒是兜底触发时间；同步终止命令另共用 2 秒剩余预算，优先处理 Agent/recorder 进程树，不能宣称总退出耗时严格小于 5 秒。`force-complete` 仅指尽力终止调用返回，进程消失仍需独立验证。

自动回归分别统计：

| 层级 | 本轮结果 | 证据 |
|---|---|---|
| Desktop 完整回归 | **468 通过、0 失败、1 跳过** | `desktop-final.json` |
| 统一 History（类型、lint、构建及测试） | **523 通过、0 失败、8 跳过** | `computer-history-validation-Id5qaP/results.json` |
| 后端本地 API，含 3 项真实 HTTP SSE 生命周期回归 | **60 通过、0 失败、0 跳过** | `backend-local-api.json` |
| 原生 Release CTest | **33 通过、0 失败、0 跳过** | `native-release.log`、`native-artifacts/release/` |
| 原生 Debug CTest | **33 通过、0 失败、0 跳过** | `native-debug.log`、`native-artifacts/debug/` |

Desktop 唯一跳过是 POSIX 符号链接保护/迁移，Windows Git Bash 的 `ln -s` 默认复制行为不能代表 POSIX 链接；Windows `.cmd` 迁移、旧 launcher 替换及无关文件保护均实际执行。Bash 解析显式支持 Git for Windows，自定义路径通过 `MEMMY_TEST_BASH`；源码断言统一 LF/CRLF，进程退出断言按平台语义并检查 PID 消失，升级 relay 保留 10 秒业务上限、将测试框架时限设为 15 秒。

History 的 8 项跳过逐项保存在 `results.json`：1 项 POSIX 子进程信号、1 项文件 symlink 权限、2 项 Swift 原生采集、1 项 Mac helper 可执行权限、1 项 Mac 原生 ingest、1 项 Mac Electron helper，以及 1 项被统一入口过滤的 Windows 前台内容测试。最后一项不是本轮前台条件失败；原生 CTest 的前台合成用例本轮均实际通过。不能以原生 CTest 代替完整安装版操作。

新增隔离测试执行实际生产退出回调和 5 秒计时器，覆盖重复退出、认证/停止响应超时、服务卡住、迟到响应、清理异常、终止异常、启动晚到服务，以及两种 Memory 策略。独立 Node 进程写入退出记录后立即退出，父进程确认记录落盘；真实合成 Agent 子进程及其 recorder 后代均验证被终止，持久 Memory 按策略保留或退出。首轮完整回归 **466 通过、2 失败、1 跳过** 保存在 `desktop-full.json`：新测试误从持久 Memory 的空 stdout 管道等待就绪，修正为独立就绪文件后完整复跑通过。首次沙箱内 `os.userInfo` 失败属于运行环境限制，改在正常用户环境执行；未删断言或弱化隐私规则。

本轮类型检查通过；打包结束后开发目录已恢复 Node 24.21.0 / ABI 137，真实 SQLite 查询通过，见 `sqlite-restored.json`。Mac/Linux 分支自动回归保留，但共享退出上下文变更尚未在 Mac 真机重验。

### 本轮测试包与安装

通过官方 `scripts/package-win.sh --version 1.1.8 --arch x64 --edition cn --sign unsigned` 完整构建。首次构建的进程与工具会话消失，日志停在封装阶段、没有完成记录，原因未确立；未安装其不完整产物。`package.log`、`build-interruption.json` 保留，确认无残留构建进程并恢复开发 SQLite 后串行重试。重试 **25 分 34 秒**、exit 0，ASAR、资源、版本和 SQLite 后置检查通过，见 `package-retry.log`、`package-retry-result.json` 及 `release/logs/package-win-1.1.8-x64-cn-unsigned-20261007-104733.log`。旧记录中的 9 分钟是复用已编译产物的封装阶段，不能与本次完整构建入口直接比较。

新包仍为 `D:/memmy-agent/App/shell/desktop/release/Memmy-1.1.8-win32-x64-cn-unsigned.exe`，**1.1.8 / Windows x64 / CN phone / NotSigned**，**355,185,605 bytes（338.7 MiB）**。校验见 `package-hashes.json`：

| 文件 | SHA-256 |
|---|---|
| NSIS | `282570DFADEB2071E4DAD2C23DDE243C623C2B4C54CFE12FD5284466D9D1AE20` |
| Desktop Memmy.exe | `32A1BCD106A542526FB468EF90F23F961DDE37B236FDCAC0C2CBD2DAF6302163` |
| app.asar | `701586AB13C8CA00E7E3B96D2C71CAFF9CDBCC93207E41BEB11188D61523AC2D` |
| 原生 helper（574,976 bytes，未变） | `2E77D871EF8F0397F0523C18FB0EAE712C5124D61AD58DA6CB02BE0F52945E1B` |

包内与安装版隔离预检各 **8 通过、0 失败**，分别见 `packaged/preflight.json` 和 `installed/preflight.json`。覆盖固定 ASAR 外 helper、默认停止状态及旧白名单配置、三份 SQLite、共享 CLI、实际同步写入的退出日志与生产主进程接线。每次使用独立空 profile，不复用前次预检写过的 legacy 配置。安装于本地 **11:14:37** 返回 exit 0，目标仍为 `C:/Users/zephyr/AppData/Local/Programs/Memmy`，安装后三个关键文件哈希一致；见 `install-result.json`、`installed-hashes.json`。

安装版于本地 **11:15:40** 启动，未指定开发 helper 覆盖。实际主页面截图非空、未刷新；`03:15:52.396 UTC` 首帧就绪，耗时 **11,273 ms**，随后 boot ready，见 `installed/startup-acceptance.json`。本地 **11:17:04** 经生产 API 开始唯一合成 fixture 录制，阳性标记和密码/普通 Edit/敏感子树过滤已检查；实际进程路径指向安装包内 helper，父进程为安装版 Agent，见 `installed/positive-capture.json`、`actual-helper-processes.json`。本轮 `modelSource = null`，没有变更模型设置，不新增真实模型/摘要质量或聊天端到端检索验收结论。

### 本轮安装版托盘退出结果

用户于本地 **12:15:06** 从真实托盘菜单退出。此前被动监测于 **12:14:42** 等待超时，原结果保留为 `installed/exit-processes-wait-timeout.json`；它发生在退出之前，不能算产品退出失败。用户确认后重新检查实际进程，更新 `installed/exit-processes.json`，未用测试工具强制结束 App。

安装版退出审计为 **8 通过、0 失败、0 未确认**，见 `installed/exit-acceptance.json`，与上面的自动测试、两次组件预检分别统计：

- 持久日志同一 `quitId = 86bdd63d-a0ec-4cd8-9e85-98ab57f7e638`、Desktop PID 22884，依次记录 `start → history-stopped → services-closed → cleanup-complete`。开始于 **04:15:06.803 UTC**，完成于 **04:15:07.274 UTC**，耗时 **471 ms**；没有强制退出阶段，关闭此前“是否触发 5 秒兜底”的未确认项。日志副本为 `installed/quit-lifecycle.jsonl`。
- 最终 `recording_stopped / stop_command` 于 **04:15:06.889 UTC** 落盘，在真实退出开始后 **86 ms**，未将之前轮转事件代替最终停止。合成阳性标记存在，所有应用内容均来自唯一 fixture，密码、普通 Edit 及敏感子树标记没有落盘。
- 实际 Desktop、Agent、recorder 均已退出。Memory PID **13260** 保留，与只读确认的 `stop_memory_service_on_exit = false` 一致；没有改动该设置。
- 退出后仍打开的 fixture 确认收到新的阴性标记，四个事件文件保持 **3,395 / 3,395 / 603 / 3,409 bytes**，阴性标记未落盘。见 `installed/negative-ack.json`、`synthetic-events.jsonl`。本轮不据等待期间的段文件宣称完整长时间或连续分段验收。

本地 **12:19:25** 核对当前 scope 与 QA 写入值完全一致后，恢复原 Windows settings 文件不存在的状态；fixture 和 Node host 正常结束。**12:19:50** 复查 App、Agent、recorder、fixture、host 均无残留，仅保留配置允许的 Memory；用户历史、凭据和模型设置未删除或修改。见 `installed/settings-restored.json`、`final-cleanup.json`。

提交前复查将新增的两项真实 Windows 进程树测试明确限于 Windows：测试的是 `taskkill /T`，普通 POSIX Agent 子进程并非 detached 进程组，合成 fixture 也没有真实 Agent 的优雅退出处理，不能沿用 Windows 后代终止断言。该文件调整后在 Windows 复跑 **3 通过、0 失败、0 跳过**，见 `force-platform-final.json`，不与完整回归相加。Mac 的共享退出逻辑及其实际子进程行为仍需在 Mac 重新验证。

## 交付边界

- Windows EXE 的构建、包内固定路径、必要许可证及 unsigned NSIS 分发已接入；正式代码签名尚未验收。
- Windows 实体停止热键已有一次真实安装版通过证据；IME、多显示器/DPI、系统锁屏行为、真实应用兼容性和长时间采集仍待验收。
- 录制中的托盘退出已确认最终事件排空、进程清理及停止后的阴性标记；2026-10-07 新包持久日志确认本次正常清理完成且未触发兜底。卡住/失败时的强制退出有隔离自动测试，未对用户真实安装版注入故障。
- 本轮共享退出上下文和测试基线变更尚待 Mac 真机回归，不能沿用此前 Mac 结果宣称新提交已经通过。
- Windows 已知浏览器仍拒绝采集；Office/WPS 正文选择器和应用图标尚未产品化。
- 受控组件/fixture、真实安装版 UI、真实模型请求和聊天端到端检索属于不同层级，不能互相代替或合并计数。

## 2026-10-07：第一步——四层正文采集诊断

本轮以 `8115b1d8` 为基线，只建立并运行诊断，不实施第二步应用适配，不修改生产隐私策略。新增测试专用 `memmy-history-capability-probe` 与仓库根目录的 `scripts/internal/win/history-capability*.mjs`；使用说明见 [诊断 README](win/native/tests/diagnostics/README.md)。证据根目录为 `D:/memmy-agent/App/shell/desktop/release/capability-validation-20261007/`，不提交二进制、原始报告或合成 profile。

诊断分别留存系统 UIA 的实际 TextPattern 正文、生产 EXE 原始 stdout、实际 `SnapshotNormalizer.normalizeEvents()` 的返回值、实际 `RecordingWriter` 写出的 JSONL。Node 侧只在测试进程临时旁路复制输入/返回值，不改传入数据或生产方法的返回结果。原生生产握手验证 `testHooks=false`。采集先于原始 UIA 探测，避免先用宽松探测器预热后再声称产品冷启动成功。外部 watcher 在整轮期间检查前台切换（含离开后返回）、PID/创建时间/EXE/HWND 和窗口标题；原始探测另做前后核验。所有真实应用用例均通过这些条件检查。

这是**真实应用中的合成文档 + 生产采集组件链路**，不是安装版完整 App 验收。没有启动 Memmy、修改用户观察配置、调用真实模型或重新生成安装包。工具采用独立诊断预算 4000 ms；生产仍为查询 650 ms / worker 1500 ms，不能用探测器成功宣称生产时延达标。

### 环境与独立检查

- Windows x64、Node **24.21.0**、MSVC **19.44.35229.0**，Release 静态 CRT。本轮使用新构建的生产 EXE（574,976 bytes），并非故障注入版本；SHA-256 为 `CC7329F0C4E7CFAE4991F73166612F43580E1A4319CF0A991FBFBAB9A6AA4A49`。这不是此前安装包内 helper 的哈希，不能混用。
- 诊断 EXE SHA-256：`B51153CC816A4CA40B3088C9DEC94FA318E730144C68F3806FE22263A5FAC13E`。仅 `MEMMY_HISTORY_BUILD_TESTS=ON` 时构建，不进入生产打包目标。
- Word **16.0.14334.20918**；VS Code **1.139.1**。Word 为一页合成 RTF；VS Code 为合成 TXT，分别使用 `auto`、`on`、`off` 的隔离 profile，关闭扩展，不更改用户日常 profile。文档在 `documents/`。

| 检查层级 | 本轮结果 | 本地证据 |
|---|---|---|
| 诊断归因逻辑 | **9 通过、0 失败、0 跳过** | `analysis-tests.tap`，入口 `npm run test:history-capability` |
| 四层合成对照 | **5 个对照均符合预期** | `fixture-final/results.json`；首次结果保留在 `fixture-attempt-01/` |
| 原生 Release CTest | **33 通过、0 失败、0 跳过** | `native-release.log`、`native-release.xml`；详细 fixture 在 `C:/Users/zephyr/AppData/Local/memmy-history-recorder/test-artifacts/release/` |
| 现有 ASAR 打包保护 | **2 通过、0 失败、1 跳过** | `packaging-tests.json`；跳过 Windows 不能执行的 Mac Electron/Swift helper 用例 |
| 空 AutomationId 策略契约 | TS 拒绝；生产原生返回 `blocked / policy_invalid` | `policy-contract.json` |

5 个合成对照分别是：正确正文策略四层都出现标记；不提供正文选择器；生产选择器错误；诊断选择器错误但产品仍成功；目标故意置于后台。后台项验证“正确拒绝无效前提”，不能算内容采集成功。密码、普通 Edit、镜像子节点和敏感子树标记在生产三层均未泄露。归因单测还验证前台 ABA、身份变化、探测超时、适配层丢失和写盘丢失的不同分类；这些故障分类单测不是实际应用发生对应故障的证据。

### Word：已有接口能完成正文链路，缺少默认接入

| 合成用例 | 系统 UIA | 生产 C++ | TS / 文件 | 结论 |
|---|---|---|---|---|
| 外层 `Document`，空正文规则 | 有正文；ID 为空 | 同 RuntimeId 节点存在，但无正文 | 均无正文 | 未匹配正文策略 |
| 子节点 `Edit + Body`，空正文规则 | 有正文，`IsPassword=false` | 同节点被标为 `edit_control` | 均无正文 | 原生策略排除已确认 |
| `Edit + Body`，配置现有正文规则 | 有正文 | 有正文 | 均有正文 | **完整链路通过，两次重复一致** |

对应目录：`word-document-default/`、`word-body-default/`、`word-body-explicit/`、`word-body-explicit-repeat/`。空正文规则模拟当前默认生成的应用规则，授权仍只绑定本次合成窗口。显式规则仅为现有协议的 `documentRegions: [{controlType: "Edit", automationId: "Body"}]`，没有修改 C++ 或 TS 过滤器。

因此，不能根据“Word 外层 Document 的 AutomationId 为空”推断 Word 必须先扩展选择器协议。本机可用的正文子节点已经有 `Body` ID。证据仅覆盖这一版本的一页 RTF、这个正文标记，不证明多页完整性、滚动、不同视图、受保护文档或所有 Office 版本。

首次 `word-attempt-01/` 没有命中诊断正文，是测试清单使用了不完整节点名称：实际 UIA Name 带有 `兼容性模式` 后缀。原始报告、完整 metadata 和后续纠正均保留；它不是 Word 无接口或权限不足的证据。

### VS Code：应用辅助功能状态与生产选择器是两个独立问题

`code-auto-attempt-01/` 中，profile 为 `editor.accessibilitySupport=auto`，截图在采集前已显示 **Screen Reader Optimized**。系统探测读到合成正文；生产流含**同一 RuntimeId** 的 `Edit` 节点，AutomationId 为空、`IsPassword=false`、支持 TextPattern，但正文被标记为 `edit_control` 并排除。显式 `on` 的 `code-on-attempt-01/`、`code-on-repeat/` 重复得到同样结论。

原始树同时发现正文节点的祖先 `Group` 带有 `workbench.parts.editor` ID，为后续范围识别提供候选依据。此 ID 本身尚不能证明该范围内所有 Edit 都是正文，查找/替换等阴性场景必须另测。空 ID 在当前 TS 和原生策略中均被拒绝，不能用现有配置直接把该正文节点放行；也不能简单允许所有空 ID Edit 或整个 `RootWebArea`。

显式 `off` 后，正文候选节点的 Name 变为应用提示 `The editor is not accessible at this time...`。最初两轮用文件名选择器没有命中；第三轮 `code-off-label-probe/` 按实际标签读取 TextPattern，调用均成功，但返回的就是该不可访问提示，**不是正文**。这说明“支持 TextPattern / HRESULT 成功”也不能等同于读到了文档。当前只证明本版本关闭模式下这些编辑器节点没有提供正文，不能扩大为 Windows 没有 UIA 接口。

`auto` 结果不能证明完全没有其他辅助功能客户端时也会自动开启：本机存在桌面工具，本轮只避免请求其文字树，并记录了实际状态。没有据此要求所有用户必须手动开启，也没有把辅助功能设置当成 Windows 隐私授权。

`code-off-attempt-01/` 的生产流另有 **1 次 `worker_timeout`**；`code-off-repeat/` 另有 **1 次 `budget_ms` 截断**。这些原始事件仍保留在 `native.jsonl`、`result.json`，原因未进一步确立，不能算无异常的稳定性通过。其他窗口的成功也不抵消它们。

### 证据边界与第二步实施条件

真实应用共 **11 轮探索性记录**，逐轮结论在 `real-application-summary.json`；不把全部有效前台条件或诊断进程 exit 0 合并为“11 项功能通过”。其中 Word 5 轮（包含首次错误诊断选择器），VS Code 6 轮（包含辅助功能关闭及其纠正探测）。本轮没有发现已存在于原生输出的正文在 TS 或文件层丢失；这不是对未来新选择器的自动保证。

开发期间还有两类工具问题已独立处理：初次 MSVC 构建将 CONTROLTYPEID 指针误写为 long 指针，修正测试代码后构建通过；沙箱下 tsx 的 `os.userInfo()` 报 ENOMEM，换正常用户执行环境后运行。空 ID 契约检查首次误把策略拒绝的 exit code 预期为 2；实际 snapshot 入口返回 exit 3 和 `policy_invalid`，保留 `policy-contract-first.json`，最终同时断言协议拒绝原因与正确退出码。均不归因于产品采集能力。

下一步据此拆分实施，不做通用空 ID 放行：

1. **先交付 Word 的最小产品接入。** 为已绑定/允许的 Word 应用生成现有 `Edit + Body` 正文策略，保留密码、敏感 ID、输入子树、窗口身份和最终提交检查。先验证多页、滚动、视图切换、查找/替换和对话框；若 `Body` 只覆盖局部页，再评估读取外层 Document 所需的受限协议扩展，而非预先假定必须重写。
2. **再实现 VS Code 的应用范围选择器。** 以 `workbench.parts.editor` 祖先为候选边界，补足区分正文与编辑器内查找/替换等输入的证据。生产 C++、worker 协议校验、TS 策略与归一化需一致验证新选择规则；为空 ID 正文设计显式受限授权，不依赖动态文件名当作权限。Chat、终端、快速打开、搜索、密码/敏感节点必须有阴性用例。
3. **把辅助功能状态和性能作为可观测结果。** 记录 auto/on/off 下实际正文可用性；不可访问提示不能进入正文摘要。对上述超时/预算截断补充重复测量和恢复检查，保留现有预算及失败封闭策略，不靠放宽预算制造通过。
4. **应用适配合入后再做安装版验收。** 沿用本轮四层证据，新包验证默认规则生成、包内 helper、实际 JSONL/摘要/检索；再扩展 Excel/PPT/WPS。浏览器、网站规则、图标、鼠标语义、IME/DPI/锁屏与长稳不属于本次完成范围。

本轮合成应用窗口已正常关闭，未写入用户原有文档。后续不需要用户先修改系统权限或安装新的采集运行时；只有具体应用在验证中确实需要人工操作时再说明原因。

## 2026-10-07—08：Word / VS Code 受限正文适配

本轮在上述四层结论上做产品接入，未扩展浏览器、Office/WPS 其他应用或系统权限。
证据根目录为本机 `D:/memmy-agent/App/shell/desktop/release/document-adapters-20261007/`，不提交合成采集文件和二进制。

### 实现与隐私边界

- 应用获准且绑定实际进程后，Word 默认生成 `Edit + Body`；VS Code 默认生成显式 `scope: vscode.editor`。
  自定义规则优先，`documentRegions: []` 禁用默认正文规则，deny、浏览器拒绝和实例身份检查保持原状。
- VS Code 空 ID 例外只适用于 `Code.exe` 的固定元数据链：
  `Edit("") ← Text("") ← Group("") ← Group("workbench.parts.editor")`。
  C++ 在正文读取前后复核实时祖先、PID、密码和敏感 ID；worker 协议校验及 TS 完整树各自重建范围，
  包括 delta 中祖先变化。文件名不授予权限，普通空 ID 选择器仍拒绝。
- 新增可选 `documentStatus`。正文与非空节点 Name 去掉首尾 ASCII 空白后相同则为 `label_only`；
  Name/Text 读取失败或实时授权检查失败则为 `read_failed`，均清除内容。
  这也会保守排除正文恰好等于文件名的情况；`available` 不保证完整性或用户确实阅读。
- **真实负向测试发现并修复旁路**：VS Code 把查找词复制到相邻的“无结果”Text 提示，旧的通用 Name
  读取会泄露该词。启用编辑器范围后，原生分类器不再读未授权 workbench Name；TS 独立拒绝这类内容。
  `code-find-attempt-01/` 保留泄露证据，`code-find-fixed/` 对同一查找/替换值重新验证，无泄露且正文仍贯通四层。
  没有删除断言、扩大预算或放宽输入规则。

### 真实应用的合成文档结果

仍使用 Word **16.0.14334.20918**、VS Code **1.139.1**。VS Code 为隔离的 auto/on/off profile，禁用扩展；
未改变日常 profile。四层工具使用实际 `compileWindowsPolicy()` 生成默认规则，不手工注入正文选择器。
`real-application-summary.json` 保留 **15 轮**开发期记录，不将探索、负向、无效前提合并为通过总数。

| 场景 | 结果与证据 |
|---|---|
| Word 两页 RTF 页面视图、移动至第二页 | `word-default-page1/`、`word-default-page2/` 均四层贯通。采集树包含两页 Body，不能据此宣称用户看过屏幕外页面。 |
| Word 查找 | `word-find-exclusion/` 正文贯通，合成查询未出现在生产原生、归一化及文件中。 |
| Word 替换对话框 | 主窗口清单首次因实际前台已变成对话框而无效；`word-replace-parent-attempt/` 保留。绑定实际对话框后 `word-replace-exclusion/` 有效采集 26 个节点，预填查找词未泄露；没有填写替换值或执行替换，不能声称完整替换操作验收。 |
| Word 草稿视图 | **未支持**。`word-draft-default/` 无 Body；按实际外层 Document 名称探测的 `word-draft-document-diagnosis/` 确认系统有正文，同 RuntimeId 在生产中被规则排除。不是 Windows/Word 缺接口。 |
| VS Code on | `code-on-default/`、修复后的 `code-find-fixed/`、`code-quick-exclusion/` 正文四层贯通；查找、替换和快速打开值均不进入生产三层。 |
| VS Code off | 首次使用英文提示名未命中中文节点；`code-off-localized/` 使用实际中文 Name 后确认 TextPattern 只返回不可访问提示。生产节点为 `label_only`，三层均无提示文字。 |
| VS Code auto | 本轮未显示阅读器优化状态，`code-auto-default/` 未达到原先正文预期；`code-auto-repeat/` 的正确诊断名及重复测量确认同样只返回提示。与上轮已开启优化的 auto 情况不同，不能宣称 auto 一定启用。 |

各轮保留前台 watcher、身份、RuntimeId、构建哈希、HRESULT、预算和截断信息。开发期有效采集没有出现
worker_timeout 或预算截断；样本很短，不构成长稳结论。`audit-evidence.mjs` 另断言修复后的隐私值排除及
off/auto 的无内容 `label_only` 状态。Chat、终端的越界拒绝目前为单元测试，没有实际输入这些界面；
搜索侧栏的实际阴性验证见下方安装版记录，没有把测试树当成真实应用操作证据。

### 自动验证

统一入口最终报告：`regression/computer-history-validation-TvtkcF/results.json`。

| 层级 | 实际结果 |
|---|---|
| Agent 共享/Windows 测试 | 447 通过、0 失败、6 跳过 |
| 前端 | 87 通过、0 失败、0 跳过 |
| 契约及包内路径保护 | 14 通过、0 失败、1 跳过 |
| 原生生命周期入口 | 3 通过、0 失败、1 按入口范围排除 |
| 上述统一入口合计 | **551 通过、0 失败、8 跳过**；类型、lint、构建和两个摘要 CLI 均通过 |
| 四层归因单测 | 9 通过、0 失败、0 跳过，`analysis-tests.tap` |
| 四层 fixture | `fixture-controls-final/results.json`：5 个阳性/阴性对照均符合预期 |
| 原生 Release / Debug CTest 复验 | **各 33 通过、0 失败、0 跳过**；`native-release-retry.log`、`native-debug-retry.log`，详细证据在 `native-artifacts-retry/`；其中 unit 可执行程序各运行 48 个用例 |

8 项分别为：POSIX 真实子进程退出、文件 symlink 权限、2 项 Swift 原生采集/鼠标测试、Mac helper 可执行权限、
Mac 原生 ingest、Mac Electron/Swift 包内 helper，以及统一入口明确不执行的 Windows 前台内容用例。
它们不代表相应功能通过。Windows 前台与隐私另由原生 CTest、四层 fixture 和真实合成应用覆盖。

首轮统一回归在 lint 超时（`3K9gPd`）；重试发现新增测试格式违反 `no-unexpected-multiline`（`K5coWA`），
修正调用换行后完整重跑通过。首轮 Release/Debug CTest 各 16 通过、17 因前台前提跳过，日志与原始 artifacts
保留，桌面清理后的复验单独记录。不同测试层级及重试次数不相加成一个通过总数。

### 打包过程记录

首次完整打包在准备内置 `Xenova/all-MiniLM-L6-v2` 时因远端 DNS `EAI_AGAIN` 失败，
此前 runtime、原生 helper、版本和资源边界检查已通过，见 `package.log`。没有安装该失败产物。
随后核对旧 `win-unpacked` 与当前安装版模型的 4 个文件 SHA-256 一致，复制到本轮独立
`offline-model/`，通过正式脚本支持的 `MEMMY_EMBEDDING_MODEL_SOURCE_DIR` 重跑完整流程。
来源、大小和哈希记录于 `offline-model-source.json`；未修改模型文件或跳过打包防护。

正式脚本重跑成功（`package-retry-result.json`，2026-10-08 10:41），产物为 **1.1.8 / x64 / cn / NotSigned**：

- 安装包：`D:/memmy-agent/App/shell/desktop/release/Memmy-1.1.8-win32-x64-cn-unsigned.exe`，
  **355,249,963 bytes（约 338.8 MiB）**，SHA-256
  `65109978D346B8256CA41777E7BD5759EFC0FD6D4F6089B5665458D977B26A27`。
- 生产 helper：**581,120 bytes（567.5 KiB）**，SHA-256
  `9298DF1FD674B90F457C746BADE7314DBB62E85C8903E2E22AE33E3A52B15126`。
- `package-hashes.json` 保存 Desktop、ASAR、helper 和安装包哈希；`install-result.json` 确认安装退出码 0，
  `installed-hashes.json` 确认已安装 Desktop、ASAR、helper 三项均与包一致。
- 安装位置：`C:/Users/zephyr/AppData/Local/Programs/Memmy`。安装前正常停止既有 Memory，安装后恢复同一
  server 命令和原配置/数据库，未改服务注册；`memory-restored.json`、`final-process-state.json` 健康检查通过。
- 打包后已恢复开发目录 Node SQLite ABI 137，并执行真实 `SELECT 1`；`node-abi-query.json`。
  包内 Electron SQLite ABI 139 独立验证，未被恢复开发依赖的操作覆盖。

### 安装后的生产组件验证

以下全部使用已安装的 `Memmy.exe` 作为 Electron Node runtime、包内 JS 和 ASAR 外 helper。
PATH 只保留 Windows 系统目录，binary 环境变量和显式覆盖故意设为不存在路径，仍解析包内 helper。
测试用的四层探针和调用脚本在仓库证据目录，不是产品运行依赖。每次使用新的隔离设置/记录/摘要目录，
只授权实际合成 Word 或 VS Code 进程；设置未注入 `documentRegions`，由生产编译器生成应用默认值。

| 层级 | 实际结果与证据 |
|---|---|
| 包内静态/受控启动检查 | `packaged/preflight.json`：8 通过、0 失败；helper、默认状态/旧范围、三处 SQLite 查询、摘要 CLI、退出诊断与接线。 |
| 安装后同组检查 | `installed/preflight.json`：8 通过、0 失败；与上一行是不同层级，不合成 History 回归总数。 |
| Word 正文四层 | `installed/word-four-layer/`：前台/身份有效，第二页标记贯通系统、原生、归一化及 JSONL，无截断；它当时是屏幕外页，不能据此推断摘要输入。 |
| VS Code 正文及侧栏隐私 | `installed/code-four-layer/`：正文四层贯通，实际输入的侧栏搜索、替换值及搜索树回显均未进入生产三层；前台有效，无预算截断。 |
| Word 服务链路 | `installed/word-service-visible-page2/results.json`：5 通过、0 失败；实际翻到第二页后，正文落盘、正常停止、实际摘要请求含第二页正文、合成模型输出、生产检索命中及停止后文件稳定。 |
| VS Code 服务链路 | `installed/code-service-marker-line/results.json`：5 通过、0 失败；光标处于标记行时，上述链路贯通，侧栏隐私标记也未进入摘要请求。只证明此行，全文摘要限制见下。 |
| 系统可见范围对照 | `installed/code-visible-range-line1/` 与 `line2/`：独立探针两次均返回 HRESULT 0、一个可见范围、无诊断范围截断；原生 `visibleText` 与系统逐字相同，完整正文仍贯通四层。 |

**没有将失败尝试抹掉：**

1. `installed/word-service/` 的首轮摘要/检索断言失败。界面与 provider 均表示第一页，第二页正文虽已落盘，
   `providerOffscreen: true` 且没有 visibleText，因此共享摘要按既有规则排除。此轮测试错误地要求屏幕外标记
   进入摘要，不是采集接口失效。切到第二页后在新目录复验通过，未修改产品可见性规则。
2. `installed/code-service/` 的首轮摘要/检索断言失败。四行 DocumentRange 正文已落盘，但 `visibleText`
   只有第一行，实际摘要请求也只有第一行。屏幕同时显示四行；将光标移动至第二行后，系统可见范围与摘要
   改为第二行。补充独立 `GetVisibleRanges` 探针确认此行为：同一窗口、同一文档、同一策略、前台无切换，
   两次都只返回一个范围且分别等于光标所在行。**本机 provider 的可见范围语义 + 共享摘要优先 visibleText
   共同限制摘要覆盖面**；不是 Windows 没有正文接口，也不是 TS/文件链路丢失 DocumentRange。
   这仍是未解决的兼容限制，第二行成功不能把第一轮失败改写成“整屏摘要通过”。

服务测试脚本后来加强为等待摘要实际会采用的正文来源，再停止；模型请求先保存再断言，便于保留失败输入。
未删除正文或隐私断言。诊断探针新增的可见范围字段只在测试构建中，Release 构建成功；原生产 helper 哈希不变。
新增探针后另跑 `fixture-controls-visible-probe/results.json`，5 个阳性/阴性对照均符合预期。
`audit-installed.mjs` 对最终通过报告、失败记录、正文输入、隐私值和系统/原生范围一致性执行断言，结果见
`installed-summary.json`。这些都是**受控调用安装组件**，不是 Desktop 界面端到端或聊天检索验收；
本轮真实模型请求为 **0**，两次成功服务链路各用一次确定性合成模型响应。先前阶段真实模型证据不挪用至本轮。

Word / VS Code 合成窗口均已关闭，最终没有 recorder、worker、fixture 或 probe 残留；Memmy 仅保留原有 Memory
服务，健康检查通过。测试没有改日常 VS Code profile、实际文档或用户 Computer History 设置。

### 当前交付边界与后续条件

本阶段交付的是 **Word 页面视图和 VS Code 受限正文默认接入、独立隐私复核、包内分发及上述受控验收**。
普通输入和敏感子树保护保持，浏览器采集范围未扩展。不能宣称 Windows 与 Mac 已全量对等。

后续优先：

1. 为 VS Code 明确“正文范围”与“provider 可见范围”的产品语义；在 auto/on/off、光标移动、滚动、分屏等条件下
   对照 DocumentRange、GetVisibleRanges、实际屏幕和摘要请求。未经独立可见性/隐私验证，不用全文替代当前行。
2. 依据已确认的 Word 草稿视图外层 Document 正文，设计另一个受限范围；补齐完整替换操作、弹窗及其他 Office 版本。
3. 对 Chat/终端补真实合成输入阴性验证，完善正文不可用状态的用户提示，再执行新适配的 Desktop 界面与真实模型验收。
   分屏、插件、大文档、IME、多屏/DPI、锁屏和长稳仍需独立覆盖；Mac 本轮没有重跑原生回归。

## 2026-10-08：Word 草稿接入与 VS Code 文档上下文摘要

此节更新上一阶段的两项限制；此前报告保留为历史证据。本轮没有扩展浏览器、WPS、Chat、终端或通用输入框权限。
证据根目录为 `D:/memmy-agent/App/shell/desktop/release/document-compatibility-20261008/`，不提交合成录制、构建目录和安装器。
仍使用 Word 16.0.14334.20918、VS Code 1.139.1、禁用扩展的隔离 Code profile 与两份合成文档。

### 实现与权限边界

- Word 默认增加 `word.document`，仅匹配 `Document(_WwG) ← Pane(_WwB) ← Pane(_WwF) ← Window(OpusApp)`，
  精确深度 3→0、空且可读的 AutomationId、明确非密码状态。C++ 在读取前后核对 PID、真实 HWND/窗口类、
  Win32 父子关系及原始根窗口；worker 和 TS 通过完整树独立复核。没有使用文件名或通用空 ID 授权。
- 原来的 `Edit + Body` 规则保留；自定义规则及显式空数组优先。尝试范围正文读取后不遍历其子节点；
  内容不可用或仅为辅助提示时清空所有内容。`className` 是有界元数据并参与节点键，祖先变化会使 delta 失去正文权限。
- 用户明确授权由开发者判断并放宽摘要取材后，VS Code 可用正文由 TS 添加 `documentContext: vscode.editor`。
  这个字段不接受原生进程自行声明。完整正文以 `document context (visibility unconfirmed):` 单独进入摘要，
  可见文本仍单独处理；不会把完整正文填入 `on screen:`。模型指令禁止据此推断用户看过、写过、操作过全文或推断其意图/偏好。
- 上下文独立去重、凭据脱敏，每项最多 2,000 字符，并参与原有 12,000 字符总预算；新增的摘要字段不触发额外采集。
  旧录制没有该字段时保持原有行为。单元测试同时覆盖后续光标行进入可见证据，避免上下文去重吞掉可见性变化。

### 真实应用与诊断证据

| 场景 | 实际结论 |
|---|---|
| Word 草稿旧策略对照 | `word-draft-baseline/` 确认 UIA 有正文、生产旧策略排除；不是缺少系统接口。 |
| Word 草稿新默认 | `word-draft-supported/`：同一空 ID 外层 Document 四层贯通，前台/身份有效、无截断。 |
| Word 草稿查找 | `word-draft-find/`：正文四层贯通，合成查找值未出现在原生、归一化或 JSONL。 |
| Word 页面视图、翻页 | `word-print-page1/` 与 `word-print-page2/` 四层贯通；完整正文含两页，但 visibleText 分别只含当前页标记。 |
| Word 替换对话框 | `word-replace-dialog-retry/` 绑定真实对话框；4 个 Edit 均脱敏且无内容字段，预填查找词未泄露。替换字段为空，未执行替换。 |
| VS Code 几何信息 | `code-geometry-bounded/` 四层正文贯通；DocumentRange 含四行，但 GetVisibleRanges 与文档矩形只对应当前行，其余三行矩形为空。 |

`source-audit.json` 的 8 项证据断言通过；这是对上述报告的审计，不与自动回归或真实应用场景数相加。
页面视图首次读到屏幕外正文不能代表它应作为可见内容；此处额外对两个页面的 visibleText 做了正、反向断言。
VS Code 的几何结果说明本版本不能靠这些接口可靠补全屏幕可见范围，不代表 Windows 没有正文接口，
也没有足够证据把内部原因完全归结为 VS Code、Chromium 或某一系统层。

测试方式的错误与修正均保留：

- 初次 `code-geometry-baseline/` 的诊断逐行 Move 越过所选文档，读到了相邻状态栏；生产采集不使用这个诊断遍历。
  已在每次取文本前加入 DocumentRange 起止端点检查，`code-geometry-bounded/` 仅含四行合成正文。
- 替换对话框在桌面工具中没有独立可选窗口，输入调用重新激活主窗口，把一次合成替换标记送入正文。
  已立即撤销并确认正文恢复，未将该操作计为通过，也未执行实际替换。对话框已有的查找值可验证排除边界。
- `word-replace-dialog/` 首次清单缺少必填诊断正文选择器，虽原生输出完整，仍按 harness error 保留；
  补回原正文名称后重跑，诊断未匹配正文是该对话框的正常负对照，不能当作正文接口不支持的结论。

### 自动回归

统一报告：`regression/computer-history-validation-ZvV7vQ/results.json`。提示词加强前的
`computer-history-validation-52Qnds` 也为 571/0/8，作为中间阶段报告保留，不重复计数。

| 层级 | 通过 | 失败 | 跳过 |
|---|---:|---:|---:|
| Agent 共享 / Windows / Mac 可跨平台运行测试 | 467 | 0 | 6 |
| 前端 | 87 | 0 | 0 |
| 契约与安装包静态检查 | 14 | 0 | 1 |
| 真实生产 EXE 生命周期 | 3 | 0 | 1 |
| 统一入口合计 | **571** | **0** | **8** |

类型、lint、依赖/Agent/前端构建、core 与 mac 两个摘要 CLI 均通过。8 项跳过分别为 POSIX 子进程语义、
Windows 缺少文件 symlink 权限、2 项 Swift 原生捕获、Mac helper 可执行权限、Swift 原生 ingest、
Mac Electron/Swift 包内执行，以及统一入口按测试名称有意排除的 Windows 前台内容用例。
本轮没有把这些跳过改算通过；真实应用正文另以上表和安装版报告验证。

原生 Release：`native-release.log`，**33 通过 / 0 失败 / 0 跳过**；Debug 最终
`native-debug-retry.log`，同样 **33 / 0 / 0**。各自 unit 测试内有 49 个断言组，不再与 CTest 总数相加。
Debug 首轮 `native-debug.log` 为 **29 通过 / 2 失败 / 2 跳过**：snapshot_content 的密码焦点阶段返回
`not_foreground`，race_policy 预期策略变化却先遇到 `context_changed`，commit_races/commit_pause 未获得前台。
该轮与统一验证并行；停止并行前台测试后独立重跑通过。没有放宽断言，不能据此宣称已解决所有前台稳定性问题。

首轮定向 Word 单元测试因 fixture 根 AutomationId 沿用旧非空值出现 2 项失败，按实测空 ID 修正；
首轮统一入口 `computer-history-validation-PFPglC` 又发现新增测试的 controlType 类型过宽，已显式声明为 Text。
修复后 Word 阶段统一报告 `computer-history-validation-rS7sKZ` 为 564/0/8；后续加入文档上下文，最终为上述 571/0/8。
新增摘要逻辑及既有 Mac 摘要定向测试 `context-unit.log` 共 89 项通过，包含在最终统一基线中，不另行累加。

### 安装组件与真实模型的首轮发现

首轮包于 11:46 安装成功，版本 1.1.8 / x64 / cn / NotSigned，安装器为 355,267,036 bytes，
SHA-256 `A47EAF49FA730B3AB5B2E1FC93207044C2CA3C48A2115037EA222C876BBB3493`；
保留副本 `prompt-final/Memmy-1.1.8-before-prompt-refinement.exe`。它已含新 Word 和文档上下文功能，
但不含下述真实模型验证后补充的提示词约束，不能当作最终交付包。

首轮 `packaged/preflight.json` 与 `installed/preflight.json` 各 8 通过；三个安装文件哈希匹配。
预检采用仅含安装目录和 System32 的 PATH，并提供无效 helper 覆盖路径。两个应用
`installed/{word,code}-four-layer/` 均四层贯通。Word `installed/word-service-retry/` 与
Code `installed/code-service/` 各 5 通过：实际包内 helper、正文落盘与正常停止、真实摘要请求的合成模型响应、
生产检索、停止后文件稳定。Code 光标保持第一行，第二行标记进入 document context 而没有进入 on screen。
首次 `installed/word-service/` 的测试断言仅比较路径大小写，因 `/` 与 `\` 差异误判目标进程；
原始事件全部为 WINWORD.EXE，改为 `path.win32.normalize` 后重跑。该失败仍有一次合成模型请求，未从报告抹除。

真实模型只使用本机已有 BYOK gpt-5.5 与合成 Code 录制，读取配置但不修改凭据、观察设置或日常 profile：

- `real-model/`：调用安装版摘要及 provider 成功，但质量检查失败。模型把正文误称为文档名称，
  又把仅存在于 document context 的末句误述为可见文字。传给模型的证据标签正确，因此这是摘要归因错误，
  不能解释成采集器遗漏、Windows 权限不足或 UIA 全文被正确证明可见。
- 据此增加明确规则和反例：上下文独有事实必须用“document context contains/describes”归因；
  不从正文、标题行或标记推断文件名，只有显式 filename 元数据可以支持命名。
- `real-model-source-retry/`：使用重新编译的源码摘要实现与安装版 provider，**不是最终安装包验收**。
  新样本明确归因上下文，没有再称末句可见，但“document labeled”和“Document inspection”仍有歧义，
  质量标为 partial；不能把单样本或提示词约束当成模型绝不误述的保证。

以上各一次 provider 调用；没有统计 SDK 内部 HTTP 重试。采集、摘要传递、模型连通性、模型语义质量应分开判断。

最终代码复核去除了重复的三条提示词语句和对应重复断言，没有改变采集规则或证据格式。
`prompt-final/prompt-final-tests.log` 的 Windows 文档上下文与 Mac 共享摘要定向回归为 **48 通过 / 0 失败**，
`prompt-final/prompt-dedup-build.log` 的 Agent 构建通过；这些用例包含在前述统一测试范围内，不另外累加。
完整打包 `prompt-final/package.log` 通过后，将重新编译的摘要模块更新到同一暂存运行时，并用相同生产配置重跑
Electron Builder（`prompt-final/prompt-dedup-package.log`）；最终源码/安装模块校验负责证明交付内容一致。

### 最终安装包与安装组件验收

最终包在 12:17 安装成功，证据均在上述目录的 `prompt-final/` 内：

- 安装器：`D:/memmy-agent/App/shell/desktop/release/Memmy-1.1.8-win32-x64-cn-unsigned.exe`。
  版本 **1.1.8 / x64 / cn / NotSigned**，355,292,758 bytes（约 338.8 MiB）。
  SHA-256：`86E82190D3CC9C79DCF3F31EB885E456564DB6A58CA101FA1D08162343B85DC3`。
- 原生 helper：584,192 bytes（570.5 KiB），SHA-256
  `5E69EB89D8CEEC9B6BF8C5BB2F9C27760DB5EC3B8431337CABED282756732F24`。
- 安装目录：`C:/Users/zephyr/AppData/Local/Programs/Memmy`。
  `package-hashes.json` / `installed-hashes.json` 证明 Desktop、ASAR、helper 三项匹配；
  `installed-source-match.json` 的 6 个关键 JS 模块均与最终源码构建匹配。
  `final-asar-verification.log` 的正式 ASAR 版本与配置边界检查通过。
- `packaged/preflight.json` 与 `installed/preflight.json` 分别 **8 通过 / 0 失败**，
  使用受限 PATH 和故意无效的 helper 覆盖路径，确认优先使用 ASAR 外的包内 helper。
- `installed/word-four-layer/` 和 `installed/code-four-layer-retry/` 均四层贯通，前台与身份有效、
  无截断、无隐私阴性标记泄漏。Code 首次 `installed/code-four-layer/` 因 `not_foreground` 条件无效，
  没有计为通过；桌面工具要求刷新状态后重新激活，确认光标第一行再重跑成功。
- `installed/word-service/` 与 `installed/code-service/` 分别 **5 通过 / 0 失败**，每个一次合成模型响应。
  实际安装版默认策略完成采集→JSONL→摘要请求→检索→停止；所有带应用的事件均核对 EXE 和选定合成窗口 HWND。
  Code 第二行标记只在文档上下文中，未进入第一行 provider 可见证据。
- `real-model/` 使用最终安装版摘要和 provider，**一次**现有 BYOK gpt-5.5 调用成功；配置哈希未变。
  Codex 对照证据检查质量为 **partial**：记录部分明确归因 document context，也未声称编辑或读过全文；
  标题/描述仍沿用正文首行作为文档标签，Memory summary 中也有未明确标注来源的上下文事实。
  不能宣称已消除名称推断或所有可见性归因问题。
- `real-model/retrieval/results.json`：安装版生产检索读取隔离复制、由真实模型生成的摘要，1 项通过，
  不是聊天端到端。全轮实际 provider 调用共 3 次（两次安装版、一次源码摘要复核），未统计内部 HTTP 重试；
  与合成模型请求分开记录。
- `installed-audit.json` 汇总组件层证据；`final-cleanup.json` 确认合成应用、采集器和测试宿主均为 0，
  原有 Memory-only 服务恢复且健康检查 200。`node-abi-query.json` 确认开发 SQLite 回到 Node ABI 137，真实查询通过。

上述层级不合并计数。本轮没有执行新增适配的 Desktop 设置页面操作或聊天端到端，也没有将首轮失败、
条件无效、模型质量 partial 改算为通过。首轮与中间安装器、诊断日志、录制及摘要均保留在本机忽略目录。

### 后续验证边界

- 本轮真实应用样本覆盖当前 Word/Code 版本和两份合成文档；没有证明所有 Office 版本、编辑器布局或插件都适用。
- VS Code 仍需补 auto/on/off、分屏、滚动、光标变化和大文档矩阵，区分正文可用、provider 可见范围与实际像素可见范围。
  若后续增加文件名或编辑器标签，应独立传递有来源的元数据；不要让模型从正文推断名称或操作。
- Word 完整替换操作、真实 Chat/终端输入阴性检查、正文不可用提示、新增能力的 Desktop UI 与聊天端到端仍待补测。
- IME、多屏/DPI、锁屏、长期运行以及本轮共享摘要改动后的 Mac 实机回归仍需单独完成。
  已验证的包内组件调用和受控检索不能替代这些验收。

## 2026-10-08：文档来源证据与 VS Code 验证链路纠偏

本轮在 `06efd1aa` 后补充结构化文档证据；不是再次实现原生正文接口。
本机证据根目录：`D:/memmy-agent/App/shell/desktop/release/document-evidence-20261008/`（以下相对路径均指此目录）。
只采集指定合成文档；真实编辑器操作、四层采集、自动回归、包内受控调用和模型质量分别记账。

### 实现与自动回归

- TS 独立复核 Word/Code 正文范围后生成 `documentEvidence`，把 `uia.name` 标签、DocumentRange、
  GetVisibleRanges 和 provider 焦点来源明确传给共享摘要。原生严格协议不接受伪造的该字段。
- 摘要中的 `document observation:` 为完整 JSON，标签与正文处于同一观测；编辑器标签不是已验证的文件名。
  不从 `pretend-invoice.xlsx` 等正文首行反推文件名，不用正文补齐可见范围，不以焦点推断阅读或编辑。
  相同名称的分屏保留独立观测；同窗口 A→B→A 保留返回 A；generation 变化分段但不增加窗口编号。
  名称过长时省略并标记，预算采样保留合法 JSON、来源和截断信息。Word 的摘要取材范围未扩大。
- `regression/computer-history-validation-waC1Vw/results.json`：统一入口 **582 通过 / 0 失败 / 8 跳过**，
  Agent 478/0/6、前端 87/0/0、契约/打包 14/0/1、生产 EXE 生命周期 3/0/1；类型、lint 和构建通过。
  跳过分别为 POSIX 子进程、文件 symlink 权限、Swift 原生文本、Swift 鼠标、POSIX helper 执行位、
  Swift 隐私基线、Mac 包内双 helper，以及统一入口有意不运行的 Windows 前台 fixture 内容用例。
  未将跳过改算通过；本轮真实编辑器矩阵单独列于下表。C++ 未改动，未重复声称执行全量 CTest。
- 新文档证据与既有正文/共享摘要定向回归最终 **100 通过 / 0 失败**；首轮 94/6 的预算处理错误已修复，
  保留于 `development-checks.json`。最终窗口编号修正后再跑 `window-identity-tests.log`，
  **59 通过 / 0 失败**，Agent 构建通过；这些用例与统一入口重叠，不能累加。
- 四层诊断工具新增退出码及 64 KiB 有界 stderr，识别竞争采集器；原始系统证据同时检查有界 DocumentRange
  和成功的 GetVisibleRanges，`markerSources` 分开归因。`harness-tests.log` **12 通过 / 0 失败**。

### 验证链路问题不得归为采集功能缺陷

用户明确要求：用例、窗口、验证链路或 Codex 权限/能力问题应主动修复或告知，不能冒充产品功能问题。
本轮按此原则保留了以下失败与纠偏：

1. 新 profile 的欢迎/登录引导遮住编辑器时，UIA 仍可能返回正文。`alpha-first/` 不能代表无遮挡的真实操作验收。
   旧合成实例以 Hidden 启动后没有可操作窗口；清理自己创建的实例，改用 Normal 前台启动已有隔离 profile 后恢复。
   `welcome-overlay.json`、`new-profile-cleanup.json`、`foreground-launch.json` 保存证据。没有修改采集器来“修复登录”。
2. 最初连续录制通过一次性命令启动，stdin EOF 触发正常停止；`sequence/events.jsonl` 无活动是测试宿主生命周期问题。
   改为显式保持宿主并用 stop sentinel 正常停止，`sequence-current/` 得到完整切换证据。
3. `split-current/` 在连续采集尚未退出时启动另一采集器，原诊断只留下 `windows_collector_incomplete`，
   该次没有保存退出码，不能事后伪造确定原因。新增诊断后在 `collector-conflict/` 受控重现：
   退出码 4、`collector_already_running`，前台有效但测试前提无效。串行 `split-current-retry/` 四层通过。
4. `long-end-marker/` 正文末行已到产品各层，但旧分析器只检查探针前 2,048 字符的 DocumentRange，
   漏看同一节点 GetVisibleRanges 中的末行，误报 `product_present_probe_inconclusive`。
   修复分析器后 `long-end-marker-retry/` 四层通过，明确 `documentRange:false / visibleRanges:true`。
5. 日志目录的 Codex 写权限曾阻止定向测试启动；换用已有授权的执行方式后实际执行通过。
   这不计为产品测试失败。桌面工具的首次状态可能滞后，未确认前不重复输入或宣称操作已完成。

上述纠偏没有删断言、放宽采集范围或修改隐私规则。隔离 profile 的设置已按字节恢复；没有改用户日常 profile 的登录或辅助模式。

### 真实编辑器合成文档矩阵

VS Code 重启期间观察到版本从先前的 1.139.1 变为 **1.140.0 / 07f806f999**，记录于 `code-version-change.json`；
以下有效矩阵均为 1.140.0、禁用扩展的隔离 profile。先生产采集、后系统探针；cold 标记表示未先用桌面工具读取正文辅助树，
不代表系统从未启动辅助客户端。截图在当前任务的桌面操作记录中；文本与逐层数据保存在本机报告。

| 用例与证据 | 实际结果及含义 |
| --- | --- |
| `alpha-current/`、`mode-on-restored/` | `on` 模式正文四层贯通；最后一次恢复设置并冷启动后仍通过，未改变登录状态。 |
| `sequence-current/`、`sequence-final/` | 同一会话 13 次快照、9 条文档观测；Alpha→Beta→Alpha、分屏及焦点切换的标签与正文关联正确。后者用最终摘要模块重建证据，同一 HWND 保持 W1。 |
| `split-current-retry/` | 左 Beta、右 Alpha，各自标签包含编辑器组，正文无交叉。 |
| `split-shared/` | 两个不同目录下同名 shared.txt 各保留一条观测；组 1/2 的合成正文分别归属，不从名称推断同一文件。 |
| `long-top/` | 屏幕显示 1–37 行，接口可见范围只返回第 1 行；有界正文仍采集。 |
| `long-scrolled/` | 屏幕显示 37–73 行，原始 GetVisibleRanges 和生产输出却返回开头 10 行；多行矩形也重叠。不是 TS/落盘遗漏，且不能凭接口名称声称像素可见。 |
| `long-cursor-end/`、`long-end-marker-retry/` | 光标在空白 151 行时接口范围为零；上移到 150 行标记后范围返回末行，末行四层贯通。长文档已有明确截断，不代表全文完整。 |
| `mode-auto-cold/`、`mode-auto-repeat/`、`mode-auto-label/` | 前台/身份有效，但 auto 未启用辅助优化。按实际本地化标签修正选择器后，TextPattern 成功返回的仍是“现在无法访问编辑器”提示，没有正文；不是探针空 ID 或标签匹配失败的推断。 |
| `mode-off/` | 与 auto 对照相同，接口仅返回不可访问提示；产品把它识别为 label_only，没有把提示当正文。 |

`matrix-audit.json` 与补充同窗口编号检查后的 `matrix-final-audit.json` 各 **15 项证据断言通过**，包含正向采集、预期负向模式、锁冲突归因和设置恢复；
这个数字不是 15 项全功能支持，也不与自动测试相加。auto/off 预期结果符合不等于正文可用。
当前证据支持：本机 `on` 可读；本机 auto/off 的窗口接口未暴露正文；不支持“Windows 没有接口”或“必须登录才能采集”的结论。
最小使用条件是按需启用 VS Code 的屏幕阅读器优化（`editor.accessibilitySupport: on`）；产品不会偷偷改用户设置。
不同辅助客户端、版本和插件可能改变 auto 行为，后续需独立验证，不能从本样本概括全部环境。

### 真实模型反例与第二轮摘要修正

第一轮安装器 `Memmy-1.1.8-first-document-evidence.exe` 为 355,316,519 bytes，SHA-256
`2879440F05FC979C1CEEB82F36189C7E88B71034E81C5C0953E6CE1DEEB3A29F`；它不含下述第二轮修正。
第一轮包内/安装预检各 8 项通过，安装文件三项哈希及六个关键 JS 源码匹配；`installed/code-four-layer/`
四层通过，`installed/code-service/` 5 项通过，包含一次合成模型响应及受控生产检索。这些均非 Desktop UI 或聊天端到端。
验收时合成 alpha 缓冲区新增空行且尚未保存；按实际带 `●` 的标题绑定，未擅自丢弃缓冲区改动。

已有 BYOK gpt-5.5 的三个真实请求分别保存在 `real-model-alpha/`、`real-model-sequence/`、
`real-model-scroll/`，只提交本轮合成录制，配置哈希不变，未替换模型响应：

- Alpha 的编辑器标签与正文伪文件名分开了，但部分正文仍简称 visible string，并推测它可能是跟踪的关键引用，质量为 partial。
- 切换/分屏样本保持正确标签与同一窗口关联，但出现 “you ... viewing” 的行为归因，质量为 partial。
- 滚动样本把接口返回的开头几行称为“focused editor showed the top portion”，与实见 37–73 行矛盾，
  **该可见性质量检查失败**。系统 UIA、原生、TS、落盘四层一致，所以不是采集链路遗漏。

据此将新摘要字段从 `provider_visible_text` 改为 `provider_range_text`，增加
`pixel_visibility: unverified` 同时限定接口范围与文档上下文，并明确 VS Code 可在滚动后返回光标行/视口外文字。
各摘要部分必须使用 editor context / provider range 归因，不能从焦点或合成标记推断用户阅读、编辑或用途。
原始 JSONL 的 `visibleText` 与来源元数据没有改名或扩大权限。
`provider-range-tests.log` **59 通过 / 0 失败**，重新构建通过。
`source-real-model-scroll/` 使用重编译摘要模块和安装版 provider，一次真实请求后对照审阅通过；
它明确指出无法确定视觉显示或编辑行为，属于**源码受控复验**，不能冒充最终安装版验收。

### 最终安装交付与证据

最终报告位于本轮证据根目录的 `final/`，本机 15:45 安装完成：

- 安装器：`D:/memmy-agent/App/shell/desktop/release/Memmy-1.1.8-win32-x64-cn-unsigned.exe`。
  **1.1.8 / x64 / cn / NotSigned**，355,305,600 bytes（约 338.85 MiB）。SHA-256
  `F08DE95ACD59E7DC1AA631C6D64555961DDE7C642D6539FA0D95215961BB68EB`。
- 原生 helper 未改变，584,192 bytes，SHA-256
  `5E69EB89D8CEEC9B6BF8C5BB2F9C27760DB5EC3B8431337CABED282756732F24`。
  安装目录仍为 `C:/Users/zephyr/AppData/Local/Programs/Memmy`。
- `package-hashes.json`、`installed-hashes.json` 的 Desktop/ASAR/helper 三项匹配，
  `installed-source-match.json` 六个关键模块与最终源码构建匹配；`asar-verification.log` 的正式版本及配置边界检查通过。
- `packaged/preflight.json` 与 `installed/preflight.json` **各 8 通过 / 0 失败**，分别实际加载三个 SQLite 实例；
  PATH 不含开发工具，helper 覆盖路径故意无效，使用的是 ASAR 外包内生产 helper。
- `installed/code-four-layer/` 四层贯通、前台和身份有效、无隐私阴性标记泄漏。
  `installed/code-service/` **5 通过 / 0 失败**：实际采集、正常停止、结构化摘要请求、一次合成模型响应、生产检索和停止后文件稳定。
  摘要请求实际含有 `provider_range_text`、`pixel_visibility: unverified` 和正确 `uia.name` 标签。
- `real-model-alpha/`、`real-model-sequence/`、`real-model-scroll/`：最终安装版各一次现有 BYOK gpt-5.5 请求，
  对照标题、描述和全文审阅，**本次三个样本均通过限定的来源归因检查**，见 `model-quality-review.json`。
  没把正文伪文件名当标签，A/B/A 和分屏关联正确，滚动样本明确像素可见性未验证，未虚构阅读或编辑结果。
  这是受控样本结论，不保证所有随机输出或实际业务摘要质量。
- `real-model-retrieval/results.json`：安装版生产检索读取隔离复制的真实模型摘要，**1 项通过**，不是聊天端到端。
  本轮真实 provider 调用共 **7 次**（首轮安装版 3、源码复验 1、最终安装版 3），没有统计 SDK 内部 HTTP 重试；
  与两轮服务各一次合成模型响应分别记录。所有真实模型输入均为合成记录，配置哈希未变。
- `cleanup.json`：采集器、探针与测试宿主均已退出，原有 Memory-only 服务健康检查 200；
  `node-abi-query.json` 确认开发 SQLite 已恢复 Node ABI 137 且真实查询通过。隔离 Code profile 的设置按字节恢复。
  未保存的合成 Alpha 缓冲区保留，未自动丢弃；没有清理用户 VS Code 登录状态或日常窗口。

打包过程的失败也保留：第一次完整流程在 Builder 阶段长期读取文件但未形成 ASAR，主动停止后返回 127，
`package-interruption.json` 记录了该次任务进程。沿用已验证暂存运行时、更新最终摘要模块并执行相同生产 Builder 配置后成功。
随后第二轮快捷重打包漏掉了“恢复开发 Node ABI 后，重新准备 Electron SQLite”这一步，
`provider-range-final/packaged/preflight.json` 明确报 ABI 137/139 不匹配，**该包未安装**。
正式 `build-nsis.sh` 原本就有准备与查询门禁；这是本轮执行链路遗漏，不是新的采集或仓库打包功能缺陷。
最终 `final/repack-final.ps1` 补回相同步骤，`electron-sqlite-query.json` 先验证 Electron ABI 139 的实际查询，
再打包、包内检查、安装和复验。被拒绝的包及首轮模型输出仍保留，未用新结果覆盖。

### 尚未覆盖的下一阶段

本轮完成结构化证据、VS Code 合成真实编辑器矩阵、安装组件和真实摘要复验；没有完成新增能力的 Desktop 页面操作或聊天端到端。
下一步应在隔离合成数据下走实际设置页→开始/停止→摘要展示→聊天调用检索→结果归因，记录真实工具调用与模型请求，
不能用上述服务直调或检索直调代替。Word 新来源字段本轮有自动回归，但未新增 Word 实机矩阵；
真实 Chat/终端输入阴性、IME、多屏/DPI、锁屏、长期运行及本次共享摘要调整后的 Mac 实机回归仍待独立验收。
辅助模式或接口范围限制应作为环境/提供程序条件说明，测试权限、遮挡、宿主退出或错误选择器应作为验证问题修复，不能混为功能不支持。
