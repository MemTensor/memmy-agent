# 1.2.3 浏览器安装状态与配置拒读恢复增量包（2026-10-16）

以上轮交付 `1953ad9ca188a46d48520f5de7138a2a6dba5a79` 为基线，合入 `c0877620eb39c29f196f9a9bbcb6616c751f5af2` 与后续 `679b052c7536d548f62f92b437a9cefa3379d6ea`。证据见[状态现场记录](../investigations/2026-10-16-browser-install-status-denied.md)及[配置拒读与恢复调查](../investigations/2026-10-16-browser-protected-data-recovery.md)。

设置页之前使用旧布尔列表，读取 Chrome/Edge 配置失败被折叠为空列表，误报未安装。本次将 installed/enabled 三态探针接通主窗口专用 main IPC、preload 和共享设置入口；未知、停用、明确缺失分别呈现，实时连接优先。

后续修复 Agent 与 Shell 双层恢复条件：明确交互任务请求且确认运行的 Chrome/Edge，在配置未知时允许不带 URL 的 OS 唤醒，随后最多等待 45 秒真实扩展握手。明确缺失或停用仍阻止恢复，进程未知只短暂被动等待；非交互、未指定浏览器不唤醒，取消与轮次身份校验保留。没有修改浏览器配置、系统权限或自动启用扩展。

保留上一轮 Cursor 最终样式、技能审批样式、History 分隔线和高清图标。扩展仍为 1.0.12；Excel 专用工具/读写/指导、微信、Memory runtime/schema无本轮变更。Agent仅修改浏览器恢复条件及对应电脑操控指导。保留旧正式版及1.2.3候选覆盖升级，排除1.2.4降级场景。

源码复核覆盖三态探针、main/preload边界、设置共享入口、Agent/Shell恢复条件与取消，以及两端类型检查。跨层回归覆盖 Mac/Windows × Chrome/Edge × EPERM/EACCES，从断开到唤醒后真实WebSocket握手；OS激活由fixture控制。未变模块保留实际测试提交和无差异证明。按同一最终提交重建Mac arm64签名公证包、Windows x64未签名包，核对新增IPC/preload方法、Agent恢复代码、完整renderer、原生组件、扩展、NSIS与DMG。原工作区及上一轮包保留。

用户验收：配置受限时显示无法读取而非未安装，真实连接后显示已连接；Chrome/Edge后台状态下明确请求使用对应浏览器，应激活并恢复连接；禁用、卸载、进程停止和任务取消保持对应边界；Mac/Windows、双聊天不串目标，管理入口、原样式、正常浏览器任务与覆盖升级作冒烟。Windows两次1001关闭的具体触发原因仍不确定。真实GUI和安装验收由用户执行，静态检查与受控OS测试不代替后台浏览器恢复证明。
