# Chrome 已安装但设置页显示未安装：现场定位与修复

日期：2026-10-16；日志时间为 Asia/Shanghai。修复基线：`1953ad9ca188a46d48520f5de7138a2a6dba5a79`。

## 确认原因

macOS 拒绝 Memmy 主进程读取 Chrome/Edge 安装记录。设置页仍调用旧的布尔列表探针，读取错误被吞掉并变成空列表，再被当作明确的“未安装”。这不是 Chrome 应用缺失，也不能通过浏览器进程存在与否判断扩展连接是否在线。

内核日志直接记录了同一主进程的拒读，并在设置页下一轮 3 秒轮询重现：

| 时间 | 进程 | 被拒绝的读取 |
| --- | --- | --- |
| 16:10:39.293 | Memmy PID 4665 | Chrome `Local State`、`Default/Secure Preferences`、`Default/Preferences` |
| 16:10:39.304 | Memmy PID 4665 | Edge `Local State` |
| 16:10:42.356 | Memmy PID 4665 | 上述 Chrome 三项 |
| 16:10:42.371 | Memmy PID 4665 | Edge `Local State` |

Chrome 根目录是 `~/Library/Application Support/Google/Chrome`，Edge 根目录是 `~/Library/Application Support/Microsoft Edge`。日志为 `System Policy: Memmy(4665) deny(1) file-read-data ...`。对应 TCC 日志记录 `/Applications/Memmy.app/Contents/MacOS/Memmy` 的 `kTCCServiceSystemPolicyAppDataDetailed` 请求被拒绝，`authValue=0`。

15:46:14 另有该应用的 Full Disk Access 记录删除事件。该记录只证明权限状态变化，不证明操作人，也不能据此归因于安装器或本次代码。

## 排除与范围

- 现场 Chrome 主进程存在；Chrome 和 Edge 的 Memmy 扩展记录均指向有效的应用包内扩展目录，manifest 版本为 1.0.12。只读取目标扩展的状态与路径，没有读取网页、历史或凭据内容。
- 实际 `/Applications/Memmy.app/Contents/Resources/app.asar` 中 preload、main IPC 与 renderer 的方法名一致，没有发现漏打包桥接方法。
- 从实际安装包抽取纯检测模块，在诊断进程中读取同一配置会返回 Chrome/Edge 已安装。诊断进程与 Memmy 的系统访问权限不同；此结果不否定内核拒读证据。
- 对实际包模块注入 EPERM/EACCES：旧 `installedExternalBrowsers()` 返回 `[]`；新 `probeExternalBrowserInstallation()` 返回每浏览器 `{ installed: null, enabled: null }`。
- 新三态探针在先前的连接恢复改动中只接到了 Agent 链路；设置页仍走旧 IPC。最近删除“检查/修复连接”按钮没有改变这个探针。
- gateway 日志显示 Chrome 1.0.12 曾连接，后以 closeCode 1001 断开。该关闭码不能独立证明断开原因；本修复不宣称已解决后台配置卸载、浏览器关闭或扩展工作进程休眠。

## 修复

- 增加独立的只读 installation IPC 和 preload 方法，复用已有三态探针；仍只允许主窗口调用。
- 两个共享的浏览器扩展设置入口使用新状态接口，每个浏览器分别保存安装与启用状态。
- 只有明确检测为 absent 才显示“未安装 Memmy 扩展”；拒读、IPC 不可用与启用状态未知均保留未知，不能降级为空列表。
- 禁用显示“Memmy 扩展已停用”；有效在线连接优先于配置文件未知。未知或停用时使用管理入口，避免引导用户重复安装。
- 保留已删除连接检查/修复按钮的决定。未修改浏览器配置、系统权限或安装中的 Memmy，未新增全面磁盘访问依赖。

## 验证与交付边界

自动化验证：桌面端 4 个测试文件 73 项通过，前端 3 个测试文件 71 项通过，两端 TypeScript `--noEmit` 与 `git diff --check` 通过。新增 IPC 回归通过实际 main handler 和 preload API，在 macOS/Windows fixture 下模拟 EPERM/EACCES；前端覆盖未知、停用、明确缺失、实时连接及接口缺失。保留旧设置页的 Linux 检测能力，新增默认 `.config` 与 `XDG_CONFIG_HOME` fixture，覆盖正常、停用、缺失和拒读；不扩大浏览器唤醒范围。

两个 shell/frontend 测试组分别在 `App/shell/desktop` 与 `App/frontend/desktop` 下执行：

```sh
node ../../../node_modules/vitest/vitest.mjs run tests/browser-extension-installation-ipc.test.ts tests/installed-external-browsers.test.ts tests/running-external-browsers.test.ts tests/external-browser-recovery-ipc.test.ts
NODE_OPTIONS=--no-experimental-webstorage node ../../../node_modules/vitest/vitest.mjs run src/pages/tests/external-browser-settings.interaction.test.tsx src/pages/tests/computer-use-settings.interaction.test.tsx src/pages/tests/computer-history-browser-enhancement.interaction.test.tsx
```

独立只读复审没有发现阻断缺陷。Excel 生产代码、专用工具和指导文件均无差异。主工作区仍为 `c4020ddc3dcd8dfe1acde62dfa8cfb6945b4a61e` 且工作区干净。

修复位于独立工作区，不覆盖其他工作区。真实 GUI 与安装升级由用户验收。此次没有打包或替换正在运行的应用。

建议新包验收：在未授予浏览器配置读取权限的情况下，打开设置页不应显示“未安装”；让已启用的扩展连上后应显示已连接；停用、卸载扩展时分别核对对应状态。Windows 同样覆盖读取失败、禁用、卸载和重连。只读失败时允许显示无法确认，不能伪造“已连接”。

后续调查已确定此前 FDA 授权由清洁卸载重置，并修复配置拒读阻断按需唤醒的问题，见[浏览器配置拒读与断连恢复](2026-10-16-browser-protected-data-recovery.md)。本文件保留第一阶段调查当时的范围。
