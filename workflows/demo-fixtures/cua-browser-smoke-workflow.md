---
title: "CUA 基础冒烟测试：打开 Example Domain"
kind: cua_smoke_test
source_history_id: null
generated_from: built_in_smoke_test
status: ready
---

# CUA 基础冒烟测试

这是基础能力检查，不是最终的 Computer History Demo。目标只是在现有 Chrome 主窗口中打开一个稳定的静态页面并验证结果。

## Semantic steps

1. 使用 CUA 列出应用，找到现有 Google Chrome。Chrome 已运行时不要创建新实例。
2. 将 Chrome 切到前台。不要依赖 Accessibility 窗口树：直接对 Chrome 发送 foreground `cmd+l`。
3. 输入 `https://example.com`，按回车。
4. 再次列出 Chrome 窗口，选择标题包含 `Example Domain`、尺寸最大的主内容窗口。窗口被 Memmy/Electron 遮挡并不代表导航失败。
5. 对这个 Chrome 主窗口调用 window-scoped `get_window_state`，查询 `Example Domain` 并包含截图。即使 Accessibility 返回 `elements=0`，只要目标窗口截图或窗口标题明确显示 `Example Domain`，仍可作为成功证据。
6. 只有目标窗口截图不可用时，才重新以前台模式激活 Chrome，再获取主屏状态验证；不能因为主屏截图当前显示 Electron 就直接判定失败。

## Success criteria

- Chrome 地址栏完成了向 `https://example.com` 的导航。
- Chrome 主窗口标题或该窗口的定向截图中清晰可见 `Example Domain`。
- 没有操作其他应用，也没有执行下载、登录、购买或提交动作。

任何一条未确认都算失败，不能仅因为 Chrome 已打开就报告成功；同样也不能仅因为 Chrome 被其他窗口遮挡就报告失败。
