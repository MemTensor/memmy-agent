# 浏览器配置拒读与断连恢复：继续调查和修复

日期：2026-10-16，时间均为 Asia/Shanghai。工作区：`browser-install-status-20261016`；本次继续修复基于 `c0877620eb39c29f196f9a9bbcb6616c751f5af2`，此前的状态修复保留。

## 为什么之前可读、清洁重装后拒读

现场机器为 macOS 27.0.1（26A434）。Apple 的 [macOS 27 发布说明](https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes) 明确说明：跨开发团队的受保护应用数据/容器访问默认拒绝，不再自动弹出授权；部分常被攻击的应用数据也可能受到 XProtect 保护，通过隐私设置管理。

同日系统记录证明了权限变化：

| 时间 | 证据 | 结论 |
| --- | --- | --- |
| 12:13:46 | System Settings 修改 Memmy 的 Full Disk Access 记录 | 当时进行过授权 |
| 12:14:03.031 | Memmy 主进程的 SystemPolicyAllFiles 查询返回 authValue=2、authReason=4 | 当时允许全面磁盘访问 |
| 15:46:14.634–638 | tccutil PID603 请求重置，删除 Accessibility、ScreenCapture、SystemPolicyAllFiles 记录 | 清洁卸载清除了此前授权 |
| 16:10:39.293–304 | 重装后的 Memmy 主进程 PID4665 读取 Chrome/Edge 配置被 kernel 拒绝；TCC AppDataDetailed authValue=0 | 重装后不再有此前的数据访问能力 |

已核对卸载会话：15:45 用户要求 Mac/Windows 清洁卸载；随后实际执行了 `tccutil reset All cn.memtensor.memmy`。这属于当时获授权的清洁卸载，不能描述成更新安装器自行重置权限，也不能责怪用户没有保留旧授权。

安装应用 `codesign --verify --deep --strict` 通过，bundle ID/Team/designated requirement 稳定。没有发现签名损坏或此次样式、连接检查按钮改动删除数据权限。`NSAppDataUsageDescription` 是用途说明，缺省会使用默认说明；增加这个字符串不能修复 macOS 27 默认拒绝策略。无需为了普通浏览器控制引入全面磁盘访问、私有 entitlement、保护属性修改或权限数据库修改。

## 为什么进程在后台，扩展仍断连

当前 gateway 从 16:09:14.405 开始监听 47321。与多次 Chrome 生命周期变化相邻的连接日志如下：

| 时间 | 现场证据 |
| --- | --- |
| 16:21:19.959 | WebSocket closeCode 1001；16:21:22 Chrome 自动终止 eligibility 变为 1 |
| 16:22:04.684–16:22:10.768 | 短暂重连后再次 1001；16:22:11 再次出现自动终止 eligibility |
| 16:26:20.607–16:26:22.945 | 重连后约 2.3 秒断开；16:26:23 OS 撤销 Chrome 的 AppVisible 和 WindowState visible 断言 |
| 16:37:35.859 | 同一 Chrome 主进程 PID5808 下重新连接 |

Chrome 的 Service Worker 与 Extension State 两个数据库均在 16:26:20、16:37:35 重新打开。目标 Memmy 扩展的 reconnect alarm 连续 LevelDB 序列 649586→649587 中，下次执行时间从 16:26:46.592 跳到 16:37:46.592，间隔 11 分钟；前一段也有 4.5 分钟跳跃。扩展运行环境恢复后，诊断记录 boot 16:37:35.855→connected .859，约 4ms 即完成握手。

这些证据支持浏览器配置/扩展运行环境被释放后重新加载的机制；浏览器主进程存活不代表其 profile 或扩展 worker 仍在运行。不能从这些记录直接断定用户关闭了最后一个窗口。Gateway 也可能产生 1001，但此处没有新 listening/启动事件，且断开与 Chrome 可见性和配置数据库生命周期变化相邻，不支持 gateway 重启解释。

安装包、注册 worker 与源码都是扩展 1.0.12，`background.js` SHA256 均为 `cc3e4a0acea15dd3959745653e318f9a2807f457d33db385be3a085f2d75a23f`。未发现旧脚本残留或握手拒绝；1001 与扩展主动 heartbeat/connect timeout 使用的 4000/4001、gateway 无效握手使用的 1008 不同。现有 JS 重试与 alarm 无法在已释放的 profile/worker 环境执行。

## 确认的恢复缺陷与修复

旧因果链：

1. 清洁重装后系统拒绝读取安装配置，安装与启用状态为 unknown。
2. 用户明确请求 Chrome/Edge 时，Agent 仍要求 installed/enabled/running 全部为 true，才请求 OS 唤醒；unknown 只被动等待 2 秒。
3. Shell 也重复要求 installed/enabled 都为 true，因此即使发起请求也会被阻止。
4. 当 profile/worker 被释放时，JS alarm 无法自行执行，而旧恢复条件也无法按需激活它。现场时间线与这一机制一致，但没有直接记录具体停用/激活动作。

本次修改两个实际恢复条件：明确交互任务请求的 Chrome/Edge、且浏览器进程确认运行时，安装配置 unknown 不再阻止无 URL、无 profile 参数的 OS 激活；随后最多等待 45 秒真实扩展握手。配置探针是辅助证据，控制功能不再依赖它可读。

明确未安装或停用、进程停止或无法确认时仍不自动唤醒；进程未知只保留短暂被动等待。非交互、system/cron、未指定浏览器的发现请求不唤醒。取消、结束轮次和 IPC child 身份校验继续生效。唤醒不安装/启用/重载扩展、不清除用户暂停、不导航或修改 profile；只有真实握手才表示连接成功，失败时 unknown 仍保留。

## Windows 现场与覆盖

通过 `memmy-win` SSH 只读核查：Memmy 1.2.3、扩展 1.0.12，Chrome 主进程和 47321 的 ESTABLISHED 连接存在，Chrome 的目标扩展记录与 payload 有效、配置可读，Edge 无该扩展。Windows 16:20:58、16:21:01 两次 1001 后于 16:21:52 重连；没有足够的 worker/profile 证据判断这两次关闭的具体触发原因。

Windows 实际包也包含旧的双 true 恢复条件。此次共享 Agent/Shell 修复同样覆盖 ACL 拒读、临时不可读等 unknown 场景，不把 Mac TCC 结论套到 Windows。Windows 实际包 main.js SHA256 为 `c57e1c1cadf98621a85afedc34245fdbffe23e5d105348073f31de3a288395bc`。

## 因果回归与验收

- Agent 新增 unknown 场景对旧源码红测 6/6 失败，证明旧代码不请求唤醒；修复后 browser-external-routing 38 项通过。
- 跨层测试使用真实随机端口 Bridge、WebSocket、Router、Manager、browser_list_tabs 与安装探针：先真实握手、1001 关闭，注入 EPERM/EACCES，确认进程仍运行，再用受控 OS 激活恢复真实握手。Mac/Windows×Chrome/Edge×EPERM/EACCES 共 8 项通过。将旧 browser.ts 以内存加载方式带入相同测试，Chrome/Edge 两项都约 2 秒失败且唤醒次数为 0；未覆盖或临时改写源码。
- OS 启动与进程枚举由 fixture 控制，这不是已安装包 GUI 或真实后台 profile 释放/恢复的验收。测试不占用正式 47321–47323 端口，不接触个人浏览器。
- 最终聚焦验证：Agent 7 个测试文件 184 项通过（含上述 8 项跨层测试），Shell 5 个测试文件 80 项通过；Agent/Shell TypeScript `--noEmit`、`git diff --check` 通过。前端没有新增改动，此前 c0877620 的 71 项前端回归结果保持适用。
- 独立只读复审未发现生产代码阻断问题；核对了取消、明确否定状态、握手事实与验收边界。

继续使用原独立工作区；主工作区及其它整合、打包工作区未改。Excel 专用工具、读写代码和指导无差异；未操作 GUI、修改系统授权、个人浏览器配置或当前安装包。

用户验收重点：Mac 清洁重装后保持未授予全面磁盘访问，Chrome/Edge 留后台且没有可操作窗口，明确请求使用对应浏览器，应激活并恢复扩展连接；Windows 相同场景及配置读取失败也应恢复。禁用/移除扩展、停止任务后不应自动启用/安装或执行迟到操作；双聊天同时使用两个浏览器不得串目标。重新打包后需按最终源码验证。
