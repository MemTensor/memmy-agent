# Memmy 1.1.9 集成与验收记录

更新于 2026-09-29。集成分支为 `codex/memmy-release-integration`，基线是
`v1.1.9` 的 `39462d6e`，桌面版本为 `1.1.9-rc.1`。本记录区分源码、
已打包二进制和实机行为。当前应用源码冻结于 `aea38c02`，包含浏览器逐站点
Browsing/Downloads/Uploads/Debug-CDP 策略、受控标签上的原始 CDP 命令与事件、
回合绑定 PiP、Windows 输入介入保护，以及默认关闭的 Mac 锁屏恢复 guardian。
下表保留旧包的验收证据，旧包的实机结果不套用到当前源码。`aea38c02` 的最终 Mac/Windows 包已重新构建；Mac DMG 已完成 Apple notarization、staple、镜像校验和 Gatekeeper 验证，Windows 包静态检查通过。Mac 最新包 GUI 需在解锁后再安装复验，Windows VM 的客户机输入仍被 CUA 通道阻塞。
公证或构建通过也不等于功能验收完成。

## 已合入范围

- 9 月 23 日以来的桌面 UI、独立任务、Knowledge、宠物、History、Memory、Skill、
  浏览器侧栏与 Computer Use 变更，采用 `v1.1.9` 基线整合。
- History 与 Memory 删除状态对账、跨用户命名空间隔离、首次开启提示；个人微信
  History 所需 SQLCipher 作为 Mac 独立资源进入打包链路。本轮验收没有打开或读取
  用户的私人 IM。
- 自有源码构建的 Mac/Windows Computer Use helper；独立浏览器资料目录的
  Chrome/Edge 扩展自动安装与手动安装引导；原生应用逐项审批与撤销列表。
- Windows Memory CLI 指向 `resources/memory-runtime`；Mac/Windows 均只在
  `extraResources` 中保留一份 Memory 运行时。
- 右侧浏览器是可直接点击、输入和导航的 Electron `webview`，使用持久分区、下载目录
  与网站授权。`94514574` 为桌面 Agent 加入了指向这个真实 `webview` 的控制通道，
  并在关闭右栏或切换工作区页面后保留它。`58e0c11f` 增加多标签选择、精确标签 ID
  控制以及 Agent 新开页路径。`162e8553` 加入四字段精确标签引用、过期拒绝和
  Agent 临时页回合清理。`299146c5` 增加标签枚举，`7d151ae7` 保留可见的
  `about:blank` 标签并禁止向它签发网页动作引用；相关定向测试与 Agent、Desktop
  类型检查通过。最终 GUI 验收仍待进行。
  同页与标签生命周期来自 [Codex 安装包及黑盒核查](architecture/codex-browser-unpack.md)，
  不是将用户口头描述推演成实现要求；并发焦点策略仍须按实机结果判断。
- 原生应用 PiP 点击改为唤出精确匹配的目标窗口供用户接管，并补齐权限面板跟随
  macOS 系统设置窗口的行为。
- 核对了 9 月 23 日两条未按原提交哈希合并的 Cursor UI 分支：知识库主体和控件
  已使用常规字重，本轮补齐分组标题的中等字重；聊天过程里的工具失败已留在展开
  卡片并使用中性色，现行实现还保留了文件编辑失败的可读提示。旧提交与新布局有
  冲突，因此按实际行为核对，没有用旧样式覆盖当前侧栏与消息列表。

## 当前验证结果

| 区域 | 结果 | 验证边界 |
| --- | --- | --- |
| TypeScript | Frontend、Agent、Desktop 三处检查通过 | 包含最终 History、SQLCipher 与 UI 整合。 |
| Memory/History | Memory 116 个测试文件、1059 项通过、1 项跳过；外部证据 4 项、History 适配 11 项通过 | Node 25 本地 SQLite 原生模块匹配后完整重跑；仅用模拟数据。 |
| Frontend | 199 个测试文件、1852 项通过；桌宠动画定向回归 2 个文件、6 项通过 | 本机 Node 25 测试使用 `NODE_OPTIONS=--no-experimental-webstorage`；最终包的桌宠变化已纳入构建。 |
| Agent | `350371c2` 完整回归：365 个测试文件、5762 项通过；1 个文件和 3 项测试跳过。DAG 队列用例在全量负载下超过原 10 秒测试等待窗，单独复跑 16/16 通过；仅延长该用例测试等待窗后，全量复跑通过。 | Agent 源码未被后续桌宠/浏览器表面改动触及；最终统一安装包仍需回归。 |
| Backend | 129 个测试文件、963 项通过 | 浏览器站点授权与原始 CDP 门禁纳入本轮完整回归。 |
| Desktop | 59 个文件、487 项通过；5 个文件和 106 项跳过 | 安全浏览器登录、凭据保护和两层 iframe 定向测试已纳入；最终包 GUI 仍按平台分别记录。 |
| Browser auth | 内置 webview 和已连接 Chrome/Edge 均支持安全表单、登录方式选项、可选提交、页面/控件二次验证；两层 iframe（含跨源子目标）在 37 项定向测试中通过 | 密码、验证码只在隔离表单与桌面主进程/扩展 worker 内流转，Agent 只收到状态；需真实 Chrome/Edge 安装扩展和最终包 GUI 验收。 |
| Mac `aea38c02` 统一包 | [已公证 DMG](</Users/lvbubu/Desktop/Memmy/Memmy业务代码/App/shell/desktop/release/Memmy-1.1.9-rc.1-darwin-arm64-cn-signed.dmg>) SHA-256 `575f497b325dd5e0173428b628d5cbefc624f9e13b7fd55cc187112f0e2bdab4`；ASAR SHA-256 `eaa607edc4785ee250b4676b3ca958d64998d3970efba4e905cdae93dbaba677` | Apple notarization submission `87a480bb-48d0-49d4-97dd-1be1d01322f1` accepted；staple、hdiutil verify、Gatekeeper 均通过。helper 为 arm64，扩展 manifest/background 文件已进入包；Mac 在安装复验前锁屏，最新包尚未安装运行。 |
| Windows `aea38c02` 统一包 | [本地 EXE](</Users/lvbubu/Desktop/Memmy/Memmy业务代码/App/shell/desktop/release/Memmy-1.1.9-rc.1-win32-x64-cn-unsigned.exe>) SHA-256 `c8ab99ed3090ac756c625a5bde65f9be5aa8f2706601d0d4751917758baa1541`；ASAR SHA-256 `62e73dd83a3a2606be71785aae7257780a0cac7708010b2b5f61a324044ea740`；ISO `App/shell/desktop/release/Memmy-1.1.9-rc.1-win32-x64-cn-unsigned.iso` SHA-256 `281e03d69b87fc50c096b2853166c02011f173e341a8582abc1edca148467711` | 交叉构建验证 helper、Memory 与 SQLite 原生模块均为 Windows x64，安装器未签名；VMware ARM64 客户机无法接收 CUA 输入（`noWindowsAvailable`），因此未安装运行这份最终 EXE。 |
| Mac 最新包 GUI 冒烟 | `8d36ed05` 安装到 `/Applications/Memmy.app` 后真实启动；内置浏览器打开 `https://example.com/?memmy-qa=8d36ed05`，读到标题 `Example Domain`，复用既有标签并列出 2 个标签及 URL | 该包与最终 `aea38c02` 只差后续桌宠动画提交；最终包因 Mac 锁屏尚未换装复验。原生计算器焦点保护在此前签名包中已出现“目标应用正在使用，暂停发送动作”。 |
| Windows 最终包 GUI | 未签收 | 新 ISO 已生成但 VMware CUA 对客户机输入返回 `noWindowsAvailable`；只能观察旧客户机画面，不能把最终 EXE 的安装/运行写成通过。 |
| Mac 旧包 | `14ced42c` 基线 arm64 应用通过 Developer ID 签名、公证、staple、校验与 Gatekeeper；SHA-256 `ee4bf70a182d54db86e789c3037adf6ec2f72a331dc8bcaf193791cf5cd816e6` | 已从 Finder 安装至 `/Applications/Memmy.app` 并运行；安装后 ASAR SHA-256 `09d129735d52eed69954c090e4f03a8ac2258dfed1fc957bc8d93023f0a25ee6` 与当时产物一致。新包须重验。 |
| Mac 新包 | `94514574` 基线签名 DMG 已通过 Apple 公证、staple、镜像校验与 Gatekeeper；SHA-256 `79b90cdcfc6fb466d8f7106bb43bc5ed5653b10727ebbafd9c26c97c7d11004f` | 镜像中应用的签名复验通过，ASAR SHA-256 `fe8cd59054cce2fa6f90886426b99264226034b27bd23f581069b57ebe6d9c3f`；尚未运行新 GUI。 |
| Mac 多标签包 | `58e0c11f` 基线签名 DMG 已获 Apple 公证并 stapled，Gatekeeper 接受；SHA-256 `9aab00b04943e71496b7d84cafefa10b42340b57f9735b1cd0eeca86d69af5b9` | 包含真实多标签与离屏视口保持；后发现的设置页新标签路由修复尚未包含，安装前须再构建。 |
| Mac 当前源码测试包 | `57823390` 基线 arm64 签名 DMG 已获 Apple 公证并 stapled，Gatekeeper 接受；SHA-256 `5c48b4dfec6b77bbbebe4fab0a67d82bdbc2d9e659d37b3925ded123c2b25899` | 从 Finder 安装到 `/Applications/Memmy.app` 后，ASAR SHA-256 `5e229e245cfd9dc5619f1825d00318ed64cca5c3339e58be1efaa931b403a352` 与镜像一致，签名及 Gatekeeper 复验通过。但包内 `desktop-edition.json` 标记 `signed-local`，缺少 `MEMMY_TEST_PROFILE_ROOT` 与 `MEMMY_ENABLE_SIGNED_TEST_PROFILE=1` 时初始化会失败。它只能用隔离测试资料启动，不能作为普通升级包验收。Mac 后续自动锁屏，最终 GUI 未签收。原安装包备份于 `/Applications/Memmy.old-09d129.app.app`。 |
| Mac 普通签名包 | `57823390` 应用源码在独立工作树重新构建；DMG SHA-256 `0e2ef21f2714c450b6e208db37c0906469427ce831da120653a3c4066f264cbe`，ASAR SHA-256 `b0bc00d9e4ceb58d22d51f654ab7140cf0ffb920cfae3994a95d5735fc250223` | `desktop-edition.json` 为 `signing=signed` 且无 `localTestProfile`，镜像校验、应用深度签名、staple 与 Gatekeeper 独立复验通过。已安装启动，旧聊天完整；原长聊天再次压缩时仍显示“压缩失败”，日志为 `Session DAG snapshot has no remaining token budget`。需纳入后续预算修复再重打包。该包早于 `b057a231` 的宠物更新和 `162e8553` 的标签页生命周期改动。 |
| Mac 长聊天压缩修复包 | `10bdf1f6` 加 `ce0f50cf` 的签名 `.app` 已安装到 `/Applications/Memmy.app`，并在原出错长聊天连续 8 次调用 `get_app_state(TextEdit)` | 8/8 成功，界面显示「压缩已完成」，最终回复正常，DAG snapshot 数为 1。此包尚未包含浏览器冷启动修复 `0294a93e`，后续统一包已重测浏览器。 |
| Mac `704f8d80` 公证包 | 统一源码 arm64 DMG 已获 Apple 公证、staple，Gatekeeper 接受；DMG SHA-256 `c4fb93d6a98e16dd8dfeeca78253c83c37f1bbac07d1df23c524c99f5d08d930`；镜像及安装后的 ASAR SHA-256 均为 `492621e7b5647c2bd9078fdd3a37a5e07421beb253a1212b67cc1ba289402338` | `/Applications/Memmy.app` 已安装启动，旧聊天和压缩成功记录保留。此包晚于压缩预算及浏览器冷启动修复，早于 `299146c5` 标签枚举工具。 |
| Mac `299146c5` 阶段统一包 | 独立工作树精确检出 `299146c5`，普通 arm64 签名 DMG 完成 Apple 公证、staple、镜像校验与 Gatekeeper 接受；DMG SHA-256 `984863b5122d104b4f8b768a723e409eec9a7eb4a59f06b887f55b168a8c8793`，挂载镜像中 ASAR SHA-256 `9783a3b789256561f776c0f1fec36c61530046939cdfd14cf4e0c1234e3df9c6` | 镜像内应用深度签名与 Gatekeeper 再验通过；`desktop-edition.json` 为 `signing=signed`，没有 `signed-local` 隔离资料标记；从 ASAR 直接核对 Agent 构建产物包含 `browser_list_tabs`。当前安装的仍是 `704f8d80`，新包 GUI 回归尚未开始；这个阶段包尚无 `about:blank` 枚举修复。 |
| Mac `7d151ae7` 最新统一包 | arm64 签名 DMG 完成 Apple 公证、staple、镜像校验与 Gatekeeper 接受；DMG SHA-256 `a590fc7e57c209e5af4361951d2e0370496e420ba2ec25c1a4e8d834fb89c4df`，挂载镜像中 ASAR SHA-256 `0e646c8ad809fe1b542c5320f15544939b993996e536fc05e3d9d19d23ab2fec` | 从 Finder 安装至 `/Applications/Memmy.app` 后，安装 ASAR 与镜像 SHA-256 一致，已启动并保留旧聊天。Agent 在右栏真实 `webview` 打开 `https://example.com/`，`browser_snapshot` 返回标题 `Example Domain`，`browser_list_tabs` 返回运行时的两个标签、URL 与选中 ID。首轮站点审批等待约 55 秒后自动拒绝，第二轮及时允许后成功；本包原生应用与空白标签枚举仍在回归。 |
| Mac 旧包 GUI | 右栏按钮存在，内置浏览器可输入 `https://example.com`、点击网页链接、跳转到 IANA、后退和查看历史；Computer Use 设置显示应用审批、扩展安装与锁屏控制。在专用 TextEdit 文档中，Agent 实际调用 `get_app_state` 和 `type_text`，成功追加 `MARKER-B`；Finder 保持前台，文档已保存。新任务中 Agent 又调用 `browser_navigate`、`browser_snapshot`、`browser_click` 跳转到 IANA；网站访问分别选择“仅本次允许”。 | 旧包的 Agent 浏览器与右栏 `webview` 仍为两个页面；20:35 对同一 TextEdit 文档只读调用八次 `get_app_state`，8/8 读到 MARKER-A/B，仍再次出现“压缩失败”。新同页通道和 DAG 修复尚未安装验收。 |
| Mac `10bdf1f6` 包内置浏览器 | 新任务中 Agent 请求 `https://example.com/?memmy-qa=10bdf1f6`，右栏真实 `webview` 显示 Example Domain；下一轮要求对当前选中标签只读 `browser_snapshot`，Agent 读到相同 URL 与标题，且没有新开页 | 首次 `openTab` 报 `Memmy browser tab did not open`，实际页面已打开，重试产生重复标签。源码发现等待循环只检查第一个新 guest；右栏首次挂载时初始空白 guest 排在目标页前，导致误报。修复已加入新源码并有定向测试，仍需重新打包实测。 |
| Mac `10bdf1f6` 包原生应用 | 新任务中 Agent 使用 Memmy 电脑操控读取计算器显示 `0`，依次点击 `7 + 5 =`，报告 `12`；任务结束后独立读取 macOS 计算器 AX，确认表达式 `7+5` 与结果 `12` | 本轮只批准「计算器」当前消息，并且没有接触其他应用；证明应用操控主链路有效。连续视频小窗、焦点保护和用户接管仍需分别验收。 |
| Mac `704f8d80` 浏览器 GUI | 新任务让 Agent 在一个新标签打开 `https://example.com/?memmy-qa=704f8d80`，右栏真实 `webview` 显示 Example Domain，`browser_snapshot` 报告相同 URL 和标题；任务结束后 Agent 临时标签关闭，旧的用户标签仍在 | 首次打开没有再出现 `tab did not open` 或重复标签。界面当时显示两个标签，但 Agent 无枚举工具，诚实报告无法得总数；缺口已在 `299146c5` 接入 `browser_list_tabs`，仍须新包 GUI 验收。 |
| Mac `704f8d80` 原生连续读取与介入 | 在最终安装应用中对计算器再次连续 8 次 `get_app_state`，8/8 成功、值均为 0；另一次十步点击任务在第 2 步后由测试者向计算器输入额外数字，Agent 通过状态从 11 变到 119 发现异常并停止后续点击 | 这是模型比对状态后停止；底层工具没有给出明确的物理输入介入信号。测试者通过电脑操控工具注入的点击也不能替代真实物理 HID 验收。PiP 连续视频与焦点恢复仍未签收。 |
| Mac `704f8d80` 长序列读取 | 新任务仅允许计算器当前消息，Agent 连续 20 次调用 `get_app_state`，20/20 成功，显示值均为 `1,199`，未修改计算器 | 验证持续状态读取及模型回报；工具的应用窗口截图不包含另一个原生 PiP 面板，因此仍没有直接画面证据证明最终安装包的 PiP 连续视频与接管交互。 |
| Mac BYOK 模型 | 已有 OpenAI 兼容配置的地址及密钥尾号与用户提供值一致；设置页“测试”返回“连接成功”，保存后模型库也显示连接成功。新建任务选择 `gpt-5.5`，实际发送英文烟测指令，回复严格为 `BYOK-OK`。 | 只验证一次文本会话主链路；未将记忆摘要或技能进化模型切换到该配置。密钥不写入本记录。 |
| Mac 模型顺序 | 旧包设置页实际显示「记忆摘要」在「技能进化」之前；两者均有独立选择框。 | 新包仍需回归选择、保存与重启后保持；不能仅用排列截图证明服务调用顺序。 |
| Mac 原生 helper | 阶段签名包的实际 `get_app_state(TextEdit)` 返回有效 PNG，人工检查确认测试文档内容；History event tap 启动成功且只核对事件类型。此前包也完成了 TextEdit 状态、截图、输入 | 不同启动路径/进程的 `CGPreflightScreenCaptureAccess` 结果曾不一致，不能只据 `doctor` 或系统设置列表判断权限；最终安装路径需再实测截图。测试没有读取私人 IM。 |
| 浏览器扩展加载 | 实际 `ManagedBrowserExtensionInstaller.install` 用隔离配置启动 Mac Chrome 154 和 Edge 116，均返回 `installed`。Chrome 走 `Extensions.loadUnpacked`；Edge 116 没有该 CDP 方法，改用独立配置目录的启动加载，并核对 Memmy 扩展 MV3 后台进程 | 两个独立浏览器进程已关闭，未使用个人浏览器资料；最终 Memmy GUI 的授权和标签页连接仍需实测。 |
| 扩展设置界面 | 旧包 GUI 有 Chrome/Edge 的「自动安装到独立浏览器」和「手动步骤」按钮；Chrome 手动步骤包含 `chrome://extensions`、开发者模式、安装包内扩展目录和逐页连接说明。 | 尚未从新包 GUI 实际点击自动安装；未向个人浏览器资料写入扩展。 |
| Windows 交叉打包 | 本轮 x64 NSIS EXE 构建成功，SHA-256 `f3b7d30cd794d22773b7e2999ff2da24c13b120620bf3085e89eb79de9ce4baa`；包内原生 helper 和 SQLite DLL 均为 x64，ASAR 与版本校验通过 | `Memmy-1.1.9-rc.1-win32-x64-cn-unsigned.exe`，尚未签名。新 ISO 已挂载到 Windows 11 VM 的 D:，文件管理器已显示构建说明和安装器；尚未运行。 |
| Windows 新包 | `94514574` 基线 x64 NSIS EXE 交叉构建成功，SHA-256 `cee3a852cf45b7fb82a44fe2e2661e869f6c9b0a3dcb4b0daf374d0b4de2a531`；包内 helper 与 SQLite DLL 都是 x64，ASAR SHA-256 `b481e6b45c23509dd3a42459b65666ea813e8ac1544effedb0eaf182b01942b5` | 新 ISO `/private/tmp/memmy-win-94514574.iso` 已挂载到虚拟机 D:；在客户机 PowerShell 中对 D: 安装器运行 `Get-FileHash`，与主机 SHA-256 完全一致。尚未运行安装器。 |
| Windows 最终源码测试包 | `58e0c11f` 基线 x64 NSIS EXE 交叉构建成功，SHA-256 `5a133fb15c1d3273494654c60cccbfdb719c5ac30feaa8e06dbaf5370c31e4d4`；包内 helper 与 SQLite DLL 均为 x64，ASAR 边界和版本检查通过 | 只读 ISO `/private/tmp/memmy-win-58e0c11f.iso` 已挂载 Windows 11 ARM64 虚拟机 D:；客户机 `Get-FileHash` 与主机 SHA-256 一致。安装与运行仍待电脑操控工具的当次确认。 |
| Windows 当前源码测试包 | `57823390` 基线 x64 NSIS EXE 交叉构建成功，SHA-256 `5be3d9d604fe4de54340cb23fe8433d27b0b0754454289019c85bab35520e8c3`；包内原生 helper 与 SQLite DLL 均为 x64，ASAR 边界和版本检查通过 | 先复制到虚拟机 `Downloads`，客户机 `Get-FileHash` 与主机一致；用默认 `%TEMP%` 运行 NSIS，安装进度正常完成。安装目录 `resources/app.asar` SHA-256 `00322fe6b163a47cb9fde298ea6d9ef3ae1cfd6e100647e69ddcdf502b640563` 与主机构建产物一致。应用启动并进入已登录的新任务页面，打开最近任务后，右上角按钮成功展开右侧概览面板。尚未验证 Computer Use、浏览器同页、Memory CLI 与主链路。 |
| Windows 已安装包浏览器 GUI | `57823390` 包中，新任务要求 Agent 用内置浏览器打开 `https://example.com` 并报告标题；右侧真实浏览器页面显示 Example Domain，Agent 最终正确报告标题 | 首次 `openTab` 工具返回 `Memmy browser tab did not open`，但右侧页面已出现；Agent 重试后产生第二个 Example Domain 标签。须在 `10bdf1f6` 新包复测冷启动导航，若仍复现则修正超时或确认逻辑。 |
| Windows 最新合并源码测试包 | `10bdf1f6` 基线 x64 NSIS EXE 交叉构建成功；SHA-256 `d55665481b15251a5595a7ba659b7c20ae0d1aaabbe20270f09c4a432c4de7db`，包内原生 helper 与 SQLite DLL 均为 x64 | 只读 ISO 已挂载到 Windows 11 ARM64 虚拟机；EXE 复制到客户机 `Downloads` 后用 `Get-FileHash` 与主机逐字节对账一致。新 EXE 尚未运行，等待电脑操控工具要求的当次确认。 |
| Windows `704f8d80` 最新测试包 | x64 NSIS EXE 交叉构建成功；SHA-256 `22607850c94ec9763c1116e5894d8f217f9d351eb2985737d391da6b50a744b8`；包含截图预算与浏览器冷启动修复，包内 helper 与 SQLite DLL 均为 x64 | ISO `/private/tmp/memmy-win-704f8d80.iso` 已通过 VMware 挂载到 Windows 11 ARM64 虚拟机 D:，安装器复制到 `C:\Users\Grace\Downloads\Memmy-704f8d80.exe`；客户机 PowerShell `Get-FileHash` 与主机 SHA-256 完全一致。尚未运行，待电脑操控工具要求的当次确认。 |
| Windows `299146c5` 阶段测试包 | x64 NSIS EXE 交叉构建成功；SHA-256 `7bb921aa3687d99c463279a8e8ee7f6e5452669bf093cdefc85856ee2db0172e`；包内 x64 helper 与 SQLite DLL、ASAR 边界和版本检查通过 | ISO `/private/tmp/memmy-win-299146c5.iso` 已挂载 Windows 11 ARM64 虚拟机 D:，安装器复制到 `C:\Users\Grace\Downloads\Memmy-299146c5.exe`；客户机 PowerShell `Get-FileHash` 与主机 SHA-256 一致。尚未运行，等待电脑操控工具对这份新构建未签名 EXE 的当次确认；这个阶段包尚无 `about:blank` 枚举修复。 |
| Windows `7d151ae7` 最新统一包 | x64 NSIS EXE 交叉构建成功；SHA-256 `c3c653d2b5102559531838d68834cf68171da34c33b2c156b527702ac6091f31`；包内 x64 helper 与 SQLite DLL，ASAR SHA-256 `d0a107bf1218062f88dbb10dc5fa3e4ea82f2c84d0dd3668d792886729e4d751` | ISO `/private/tmp/memmy-win-7d151ae7.iso` 已挂载到 Windows 11 ARM64 虚拟机 D:，EXE 已复制到 `C:\Users\Grace\Downloads\Memmy-7d151ae7.exe`；客户机 PowerShell `Get-FileHash` 与主机 SHA-256 一致。通过安装器升级并成功启动，旧 Notepad 测试记录保留。Agent 在右栏真实 `webview` 打开 `https://example.com/`、读取标题和正文；Notepad 逐项审批后 3 次 `get_app_state` 均读到 `TEST 123`，未输入或修改文本。安装目录 ASAR 尚未在客户机独立哈希。 |
| Mac 系统权限 | 辅助功能中 Memmy.app、Memmy Computer Use.app 均开启；录屏与系统录音中 Memmy.app 开启 | 当前签名 helper 的 `get_app_state(TextEdit)` 返回有效 1172×976 PNG，并匹配目标窗口 ID；最终安装包中的 Agent 也已调用该工具并读到 TextEdit 测试文档。连续视频仍须单独验收。 |
| Windows 安装与原生操控 | ARM64 Windows 11 虚拟机内，旧版 x64 NSIS 包已运行并升级 Memmy；应用启动，原生 helper `doctor`、`list-apps`、Notepad `get_app_state` 成功。PowerShell 保持前台时，helper 以 `type_text` 向后台 Notepad 输入 `Memmy background test`，工具返回 `isError=false`；随后人工切换到 Notepad，核对显示完整的 21 个字符。 | 默认 `%TEMP%` 下安装器报 `Can't initialize plug-ins directory`；将本次安装进程的 `TEMP/TMP` 指向用户 Downloads 下可写测试目录后完成安装。具体环境根因待查。当前包不是最终源码；本项只证明 Notepad 的后台输入和焦点保持，不覆盖所有应用。 |
| Windows `57823390` 原生 GUI 基线 | 虚拟机内已安装旧包的 Agent 接到“打开 Notepad，在新标签输入 `TEST 123` 并读取状态”任务后，调用原生 `list_apps` 与窗口操作；授权面板按“仅本次允许”后，Notepad 新标签实际显示精确文本 `TEST 123`，旧的未保存标签内容仍在。执行期间，Windows 桌面右下出现独立的目标窗口缩略小窗；任务结束后消失，并弹出完成通知。 | 这一轮证明旧包能真实操作 Notepad 且有独立小窗，不能证明连续视频帧率、可拖动缩放、物理介入识别或 `299146c5` 新包效果。尝试拖动时 Agent 已完成，小窗已消失，拖动只落在 Notepad 空白区。 |
| Windows `57823390` 持续读取和小窗 | 新任务仅允许当前消息读取 Notepad。Agent 调用 20 次 `get_app_state` 后汇报 20/20 成功，内容始终为 `TEST 123`；界面中的工具调用与最终分组结果均可见。读取期间，独立的目标窗口缩略小窗持续覆盖在 Memmy 右下角，任务完成后消失，Notepad 本文未改变。 | 这是旧安装包的持续状态和小窗存在性证据。期间两次尝试从小窗上沿拖动，小窗位置未改变；没有确定是否命中拖动把手，因此拖动、放大及连续视频仍未签收。 |
| Windows 默认临时目录 | 虚拟机 `%TEMP%` 为 `C:\Users\Grace\AppData\Local\Temp`；目录存在，当前用户能在其中创建并删除测试子目录 | 旧 NSIS 从只读 ISO 运行曾报插件目录初始化失败；本轮安装器复制到本地 `Downloads` 后用默认 `%TEMP%` 安装成功。不能据此认定所有从只读媒介启动的安装场景已修复。 |
| Excel 宿主 | Mac Microsoft Excel 已安装并能打开空白工作簿；Windows VM 仍需在客户机内确认 Office 安装状态 | 当前源码已生成 manifest、TLS 桥接和 `excel_live` 工具；Mac 本轮授权安装在 macOS `security add-trusted-cert` 阶段失败，尚未完成任务窗格连接与真实工作簿读写。 |
| SQLCipher | 本机暂存、签名校验、`ctypes` 动态加载通过 | 没有读取微信数据库；最终签名包仍需复查。 |

## 尚未签收的行为

2026-09-29 后续源码按 Codex 的设置结构恢复了「始终允许的应用」持久化列表与撤销路径；控制区保留「任意应用」总开关、Chrome/Edge 手动扩展安装、Excel 单开关和锁屏开关。锁屏仍默认关闭，只有明确同意后才让辅助程序启动锁屏 broker。小窗透明边距和控制条也可以拖动、右下角可以缩放。这些仍要在解锁后的签名包和 Windows 虚拟机里复验，不能把源码改动写成实机通过。

1. 最新 `aea38c02` Mac 包已通过构建链、公证、staple、镜像校验与 Gatekeeper；Mac 随后锁屏，未能再次用 CUA 换装并启动该最终包。已安装的 `8d36ed05` 包完成了浏览器真实 GUI 冒烟；原生计算器焦点保护在此前签名包中实测出现暂停发送动作。上面的设置页和小窗改动晚于该包，尚未打进这份 DMG。
2. Chrome/Edge 扩展的真实用户浏览器安装、站点审批、下载/上传、原始 CDP 与 iframe 子目标仍以静态/定向测试为主，未把个人浏览器资料作为验收对象。
3. Mac/Windows Computer Use 小窗连续视频、拖动与缩放、物理介入中止、Excel 宿主仍未完成最终跨平台实机签收；VMware 客户机输入被 CUA 的 `noWindowsAvailable` 阻塞，不能用宿主观察替代 Windows GUI 操作。
4. Windows 客户机为 ARM64，安装包为 x64 仿真。Mac 现在能看到 Microsoft Excel.app，当前源码的本地 HTTPS 加载项服务已能启动，manifest、task pane、token 心跳和命令轮询均已实测；仍缺真实 Office.js 工作簿写入/读回证据。Windows 虚拟机里的 Excel 也还没做同样的实机验证。
5. 当前集成分支将归档至本地 `App/shell/desktop/release/Memmy-v1.1.9-integration-final.bundle`，包含完整 Git 历史；未推送或发布远程版本。

只有这些行为完成并再次做 Mac/Windows 回归后，才可声明 Computer Use 的具体
能力已复刻并可发布。专有 Codex 实现的内部算法无法仅靠解包获得源码级等价证明；
验收应以用户可见行为和异常场景为准。
