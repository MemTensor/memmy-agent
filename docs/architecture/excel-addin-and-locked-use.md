# Excel 加载项与锁屏操作：本地复核和实现

2026-09-28。本机 Codex 设置页把 Excel 映射到独立 marketplace plugin
`microsoft-excel-document-control-app`，而不是 `@oai/sky` 的通用桌面操作。
当前安装包没有 Excel 加载项的 manifest 或网页资源，因此不能从包内得到该
plugin 的实际协议。Memmy 使用 Microsoft 的 Office.js 公共接口实现一个本地
Excel 任务窗格；未复制 Codex 的私有二进制或服务代码。

## Memmy 的 Excel 路径

- 用户在「电脑操控」设置页明确授权后，Memmy 为当前账户准备专用的
  `localhost` TLS 证书和 Excel 加载项登记。以后 Agent 启动时读取这份设置，单独在
  `https://localhost:32177` 启动 Office.js 服务（可用
  `MEMMY_EXCEL_ADDIN_PORT` 改端口）。该服务仅监听 `127.0.0.1`。
- Mac 将 manifest 复制到当前账户的 Excel `wef` 目录；Windows 把它登记到
  当前账户的 Office 开发加载项注册表项。设置页也提供 manifest 下载与手动说明。
  用户仍须在 Excel 中打开 Memmy 任务窗格。任务窗格每秒向 Memmy 报告心跳；
  设置页只有收到一个活跃连接才显示「已连接」。完成本机准备或打开 Excel 本身
  都不会被误报为已连接。
- Agent 的 `excel_live` 工具提供 `status`、`selection`、
  `read_range`、`write_range`。这些操作由打开的 Excel 工作簿中的
  Office.js `Excel.run` 执行，不会自动打开任何文件、枚举账号或读取其他
  工作簿。若有多个任务窗格同时连接，工具拒绝猜测目标。
- 地址只能是 Excel 工作表内的有限 A1 范围（最多到 XFD1048576）；单次最多
  10,000 个单元格；写入矩阵必须与地址尺寸一致。Office.js 将以 `+`、`-` 或
  `=` 开头的字符串视为公式，因此桥接拒绝这三类字符串。
  发出的动作超时后视作结果未知，不自动重放。任务窗格与服务用临时随机 token
  通信，服务拒绝跨源和无 token 请求。

### 显式安装步骤

Office 加载项的网页入口必须是 HTTPS，且本地证书必须可信。准备过程会修改当前
账户的证书信任及 Excel 加载项登记，因此只能由设置页的明确授权操作触发：

1. 在 Memmy「电脑操控」设置页点击「授权安装 Excel 加载项」，阅读并确认
   证书信任与加载项登记提示。macOS 钥匙串可能再次要求本机密码。
2. 等待设置页显示「本机桥接已启动」，重启 Excel，在「主页 → 加载项」中打开
   Memmy。Windows 上可从 Office 的开发加载项入口打开；如果该入口未出现，
   可下载设置页给出的 `Memmy-Excel.xml`，按微软的侧载说明手动导入。
   某些 Windows WebView 环境还需要按微软的说明允许 localhost loopback。
3. 仅在希望 Memmy 操作的工作簿里打开任务窗格。设置页出现一个已连接工作簿后，
   才向 Agent 请求 Excel 操作。Memmy 不会代用户登录 Office 或打开工作簿。

高级手动配置仍支持在启动前提供证书路径：Mac 使用
`MEMMY_EXCEL_ADDIN_TLS_CERT`、`MEMMY_EXCEL_ADDIN_TLS_KEY`；Windows 使用
`MEMMY_EXCEL_ADDIN_TLS_PFX`、`MEMMY_EXCEL_ADDIN_TLS_PFX_PASSWORD`。这些
变量只提供 HTTPS 服务所需材料，不代表证书已获系统信任或 manifest 已在
Office 登记。自动准备若失败，可下载 manifest 并依
[Mac 侧载说明](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-an-office-add-in-on-mac)
或 [Windows 侧载说明](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-office-add-in-for-testing)
完成剩余步骤。

manifest 的网页内容、Office.js `Excel.run` 和本地 HTTPS 要求遵循
[微软 Excel 加载项教程](https://learn.microsoft.com/en-us/office/dev/add-ins/tutorials/excel-tutorial)、
[Mac 侧载说明](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/sideload-an-office-add-in-on-mac)
、[Office 加载项 manifest 说明](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/add-in-manifests)
及 [Excel.Range.values 文档](https://learn.microsoft.com/en-us/javascript/api/excel/excel.range?view=excel-js-preview)。
Windows 上也需要运行 Excel 的实际宿主测试，不能只以 Node 模拟证明可用。

### 验证边界

自动测试已覆盖 manifest、A1 与写入边界、单任务窗格路由、超时不重放，以及
临时证书下的真实 HTTPS 请求往返。模拟请求不是 Excel 宿主，未验证 Mac 或
Windows 上的 Office.js 加载、安装与单元格读写。2026-09-28 现场检查：当前
Mac 已安装 Microsoft Excel.app，Windows 11 测试虚拟机仍需在客户机内确认
Excel。当前 Mac 本地 HTTPS 服务已经能返回 manifest/task pane，并接受真实
task pane token 的心跳与轮询；Office.js 宿主里的工作簿写入/读回仍待实测，
测试期间没有打开私人文档。

同一 Windows 虚拟机的默认 `%TEMP%` 是
`C:\Users\Grace\AppData\Local\Temp`：PowerShell 显示目录存在，试写文件并
读回 `ok` 成功。旧 NSIS 安装器的 “Can't initialize plug-ins directory” 错误
不能归因于 Temp 目录不存在或一般写权限不足；具体原因仍未查明。

## 锁屏操作

Codex 包含独立的 `CUALockScreenGuardian.app`（Bundle ID
`com.openai.sky.CUAService.guardian`）。可见原生符号有
`LockScreenAutoUnlockCoordinator`、
`LockScreenLoginAuthorizationBroker`、
`SAILockScreenGuardianXPCProtocol`、按线程的 unlock lease 和物理输入
介入检测。这是带授权的解锁/重锁服务，不等同于已授予的辅助功能与屏幕录制权限。
Mac 的 Memmy 已有**默认未启用的**签名插件、授权 broker、单独的用户同意、
HID 介入监控和重锁流程源码；独立 Guardian 源码已补齐，但当前安装包尚未
进行真实锁屏和崩溃恢复验收。Windows 的活动桌面路径不支持锁屏后操作。
设置页继续明确显示实验链路未验收/不支持；不会模拟已授权或尝试凭据绕过。

### 2026-09-28 本机安装包和系统策略复核

本机 Codex 安装包还附带独立的 `CodexComputerUseAuthorizationPlugin.bundle`
及安装工具。安装工具支持 `install|uninstall|status`，安装位置是
`/Library/Security/SecurityAgentPlugins`，安装前备份
`system.login.screensaver` 授权规则。当前 Mac 上该规则的候选项依次为
Codex 的远端授权 mechanism 与系统 `use-login-window-ui`；原有密码界面
保留为后备。该插件通过 Unix socket 询问签名匹配的 Codex Computer Use 服务，
而不是直接读取用户密码；守护进程还保留按对话线程的短时 lease，并在检测到
真实物理输入时暂停自动解锁。以上为对本地二进制、bundle 元数据及只读
`security authorizationdb read` 的观察，**未**修改系统授权规则，也未锁屏测试。

Memmy 已补入原生会话锁状态门禁：`get_app_state` 和所有依赖快照的动作在
锁定或不能确认当前是已登录控制台时直接返回错误，不把输入发送到登录窗口。
这只防止误操作，**不等于**锁屏自动解锁已接入。按 Apple 的
[Authorization Services 插件说明](https://developer.apple.com/documentation/security/extending-authorization-services-with-plug-ins)，
真正的自动解锁需要另一个由用户明确安装的签名插件和受信服务。当前源码见
`App/native-computer-use/lock-screen/README.md`；插件与 broker 已可编译并通过
离线授权规则模拟。签名 helper 可启动一个默认拒绝的 broker，但运行时
**默认不授予 lease**。Memmy 路径
必须同时满足以下约束，才能打开设置页开关：

1. 用独立签名的 `MemmyLockScreenAuthorizationPlugin.bundle` 参与
   `system.login.screensaver`，安装前保存原规则，卸载时仅在规则仍包含
   本插件时移除并恢复原有机制；始终保留 `use-login-window-ui` 后备。
2. 插件对 Memmy 服务做代码签名与 Team ID 校验；服务只对明确授权的当前
   交互对话、单次锁屏事件及短时一次性 lease 回答允许，拒绝自动任务和
   身份不明的连接。不能依赖环境变量或普通配置文件表示用户授权。
3. 监测键盘、鼠标的真实物理输入，用户介入立即撤销 lease；自动解锁后
   在任务结束时重锁，并在异常、超时、服务退出时回收授权。密码不能经过
   Agent、日志、插件 socket 或 Memmy 设置；用户的系统管理员授权仅用于
   审核安装，不交由模型保存。
4. 在隔离的 macOS 测试账户/设备上做真实锁屏、手动锁屏优先级、密码后备、
   安装失败回滚、卸载恢复、并发对话、用户介入和崩溃恢复验收。当前正在
   使用的 Mac 尚未进行这些破坏性系统登录流程测试，因此不能标为完整复刻。

### 2026-09-29 静态复核

本机 `/Applications/ChatGPT.app` 内的 `@oai/sky/Codex Computer Use.app`
确有独立签名的 `CUALockScreenGuardian.app`、授权插件及 installer。只读
`security authorizationdb read system.login.screensaver` 显示 Codex 的
remote right 后仍有 `use-login-window-ui`。这证明包内组件及当前规则的存在，
不证明本机锁屏运行行为。Memmy broker 已补上「自动解锁后、release 前先发生
重锁」时的 lease 清理，并在 helper 正常退出时尝试重锁。随后补入独立签名
Guardian：SecurityAgent 得到允许前，Guardian 必须确认同一个 lease 已预置且
被消费；helper 突然退出后，它会在短时窗口内检测实际解锁并重试锁屏，物理输入
则停止自动重锁。当前只有离线状态测试与编译验证，尚未证明事件 tap 在锁屏时
可用、Touch ID 等用户解锁能否准确区分、异常退出后快捷键能否实际重锁。
实验门控继续默认关闭，待隔离 Mac 实测。
