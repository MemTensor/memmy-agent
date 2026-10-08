# macOS Computer Use 与 Computer History 权限归属

2026-09-28 核查。此文区分 macOS 系统授权、Memmy 内的功能开关和逐应用操作同意。

## 已确认事实

| 功能 | 当前执行系统调用的位置 | 需要的系统权限 | 目前的产品行为 |
| --- | --- | --- | --- |
| Memmy 普通“看屏幕” | Electron 主进程 `desktopCapturer` | Memmy 的屏幕录制 | 用户请求截图时才检查。 |
| 原生 Computer Use 的 AX 树与操作 | 单独启动的 `Memmy Computer Use.app` | 该 app 的辅助功能 | `list_apps` 不需要；首次操作目标应用前有 Memmy 内的逐应用同意。 |
| 原生 Computer Use 的目标窗口图片 | 同一原生 app 的 ScreenCaptureKit | 该 app 的屏幕录制 | `get_app_state` 默认可只返回 AX 树；`require_screenshot=true` 才强制图片和缺权引导。 |
| Computer Use 悬浮窗连续视频 | Electron 主进程 | Memmy 的屏幕录制 | 目前仍需签名包上的完整 GUI 验收。 |
| Memmy 产品版 Computer History | `Memmy Computer Use.app` 同一 LaunchServices 进程内的 Swift 录制器 | 该 app 的辅助功能、输入监控；产品启动参数为 `--no-screenshots` | 不要求屏幕录制。只有用户开启 History 才安装事件 tap；停止录制时移除。 |

本机 Codex 的 `computer-history` 插件启动器调用 `~/.codex/computer-use/Codex Computer Use.app` 内的 `SkyComputerUseClient`；原生服务二进制同时包含 Computer History 组件。官方 [Computer Use 文档](https://learn.chatgpt.com/docs/computer-use)要求 macOS 给 **Codex Computer Use** 辅助功能和屏幕录制；[Computer History 文档](https://learn.chatgpt.com/docs/customization/computer-history)明确说 History 不保存截图，也不要求屏幕录制。这些证据支持“同一原生服务承载两项能力”，不证明分进程是历史遗留。

Apple 的 [AXIsProcessTrustedWithOptions 文档](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions)明确检查当前进程的辅助功能信任状态。[ScreenCaptureKit 文档](https://developer.apple.com/documentation/screencapturekit)要求截图前取得用户授权。Apple 还解释了多进程应用的“负责程序”归属可能影响系统权限显示；不能通过把两个 bundle ID 改成相同字符串来保证共用授权，必须在签名安装包里验证实际 TCC 行为。

2026-09-28 的阶段签名包实测：同一 `Memmy Computer Use.app` 在隔离 socket 中报告辅助功能和输入监听运行态可用，启动 History event tap 后收到 `session.started`，随即停止，未保存事件内容。此时系统设置“输入监控”列表未显示该 app，故不能仅凭列表里没有条目要求用户重复授权；以该进程的预检和实际 tap 创建结果为准。临时工作树中的 helper 曾报告录屏预检为 false，同一轮阶段签名包经真实 TextEdit 目标窗口截图返回图片，说明 TCC 结果需以当前运行路径与实际操作复核。最终安装路径的截图仍须另验。

## 已实施的架构边界

保留第一方原生 `Memmy Computer Use.app`。Computer Use 与 History 共用其进程、稳定的 bundle ID 和签名身份；不再打包独立 `human-recorder` 可执行文件。History 通过同一受用户私有权限保护的 app-agent socket 请求权限状态和事件流，连接断开即移除 event tap。History 的产品开关、来源规则、脱敏和停止能力依旧由 Memmy 控制。Electron 主程序不获得辅助功能与输入监控。苹果也把[不同权限的组件分离](https://developer.apple.com/documentation/security/applying-launch-environment-and-library-constraints)列为安全实践。

录屏权限有两个真实执行者：用户要求 Memmy 普通看屏幕，以及 Electron 悬浮窗视频，由 **Memmy** 使用；原生目标窗口截图由 **Memmy Computer Use** 的 ScreenCaptureKit 使用。每次都按实际执行路径检查权限，不能只看另一进程的预检结果。macOS 的“负责程序”归属可能让系统设置把 helper 的截图授权显示在 Memmy 一行，不能从列表推断所有安装路径都会共用一行。把连续视频强行搬入原生服务会更换采集协议和性能边界，并不会减少系统所需的授权种类；当前双身份清晰且各自最小化。History 不采截图，因此不申请录屏。首次使用新 helper 时，Memmy 会终止同一安装目录中旧版遗留的 `Open Computer Use` app-agent；其他位置的独立工具不受影响。系统设置中旧的 `Open Computer Use` 行来自旧 bundle 的授权记录，不是新版执行者；清理旧授权须以系统设置的实际条目为准。

最终签名测试包的实机现象：系统设置“录屏与系统录音”里 **Memmy.app** 已开启，
没有单列 **Memmy Computer Use.app**；该包内的 helper 仍报告录屏预检可用，且
`get_app_state(TextEdit)` 实际返回 1172×976 PNG。这证明这台机器、这个签名和
启动路径下无需用户再开一条独立录屏开关；不构成全新 macOS 用户或其他启动路径的
普遍保证。若实际截图收到缺权错误，客户端仍按当前执行者的结果引导用户授权。

启动原生服务和读取无权限能力时保持静默。只有用户启动 History 或操作需要 AX、输入监控、真实截图时，才在 Memmy 内解释该项权限并引导系统授权。History 的“去开启”由原生服务先调用对应系统请求，再打开对应设置页；macOS 不保证输入监控请求一定把应用列入列表，因此界面同时说明可点“添加”手动选择 **Memmy Computer Use.app**。权限更新后重启原生服务，再开始采集。

## 立即执行的正确性规则

1. `doctor` 只把当前运行进程的 `AXIsProcessTrusted`／`CGPreflightScreenCaptureAccess` 结果算作有效授权；旧 TCC 数据库行不能覆盖当前进程的拒绝结果。
2. AX 树和元素索引动作可在缺少屏幕录制时继续。需要真实图片时设置 `require_screenshot=true`；缺权时由 Memmy 引导授权。
3. 坐标点击与拖动必须基于有效的当前截图。没有图片时停止操作；如果缺少屏幕录制，返回可被权限引导识别的错误。
4. 验收截图必须记录截图来源、授权主体、`doctor` 状态、图片是否真实存在和尺寸。AX 文本、悬浮窗空白或 API 可调用都不算截图通过。

## 签名包验收

- 在全新 macOS 用户或干净虚拟机中分别验证：只开辅助功能、只开屏幕录制、两者都开、撤销其中之一、升级签名包。
- 同时核对 Memmy 和 Memmy Computer Use 的实际系统设置条目，确认 History 与 Use 的辅助功能／输入监控均归属后者，且安装包不含独立 `human-recorder`。
- History 无截图运行应完全不请求屏幕录制；开启 History 才可请求输入监控，关闭后必须停止事件采集。
- 重打最终签名包后，端到端验证真实目标窗口图片、坐标动作、连续视频、权限引导和 Win11 原生操控。Windows 没有 macOS TCC 开关，按平台能力单独验收。
