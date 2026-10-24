# Windows 历史记录图标清晰度修复

基线：`8968ede64ae33638da0d096b8197ec04ed2a6e03`。验证日期：2026-10-16。

## 原因与改动

旧 helper 用 `SHGetFileInfoW(SHGFI_ICON | SHGFI_LARGEICON)` 取得系统指标大小的 HICON，再绘制到 64×64 PNG。Windows VM 中 Memmy、钉钉、微信、Explorer、PowerShell 的原始 HICON 均为 32×32；PNG 尺寸不能证明源图有 64px 的细节。前端显示为 24 CSS px，高 DPI 下会显露源图分辨率不足。

现在先解析 Shell 注册的图标资源及 index，再用 `SHDefExtractIconW` 明确请求 64px。exe 的 Shell IconLocation 可能成功但为空，此时从 exe 的主资源提取。自定义 Shell 图标无法按资源提取时保留原路径回退。继续使用 HICON 绘制以保留透明度，并释放成功、失败路径中的句柄。

参考：[SHGetFileInfoW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shgetfileinfow)、[SHDefExtractIconW](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shdefextracticonw)。

## 已验证

- Windows PowerShell `5.1.26100.9711`：原 helper 在多帧 ICO 测试中选中 32px 图层而失败；修复后全部通过。
- 真 64px 图层的 64 个单像素细节、全透明与半透明像素均保留；只有 32px 源图时仍可显示。
- Squirrel 同名 `.ico`、同名 `.EXE`、不同名 `.ico`，以及运行进程 exe 均通过；exe 与独立请求的 64px 原生图像逐像素一致，且测试要求其与 32px 放大结果不同。
- VM 中上述五个运行应用的新提取 HICON 均为 64×64。Memmy、钉钉、微信、Explorer、Cursor、Chrome、PowerShell 的生产 helper 输出均为有效的 64×64 PNG。
- 本地相关 4 个 Vitest 文件：75 passed / 5 skipped；Windows-only Shell 用例另在 VM 真实运行。最终测试文件调整后单独复跑图标测试：5 passed / 1 skipped。
- Windows 相关打包规则测试：8 passed，9 个其他用例按筛选排除。完整打包规则集曾因独立 worktree 缺少 Mac Electron 二进制而无法完成 Mac helper 执行用例；不据此声称完整打包验证通过。
- `git diff --check` 与独立代码审查通过。未修改 macOS 图标代码、前端样式、Excel 工具或读写逻辑。

匹配 VM 测试的文件 SHA-256：

```text
app-icon.ps1: 82b03952d561b303b36d7581c488604dc3968f533103f7ab1fc91f321504416d
application-icon-shortcuts.ps1: b44137b0975e2727e6e3f9d1727ae0d11180d580b94660a1bb8d98bac7afb2dd
```

## 用户 GUI 验收

本次只修源码和验证，不替换已安装应用、不打包、不推送。合入后需要包含此修复的 Windows 包，完整退出并重启应用及 agent，以刷新两层进程内图标缓存。

用户在 Windows 100%、150%、200% 显示缩放下查看历史记录和应用选择器，确认钉钉、Memmy、微信、Cursor 等图标边缘清晰、透明背景正常；已有历史条目也应重新取到新图标。没有高清资源的应用仍受其自身源图限制。
