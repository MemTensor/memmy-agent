# 中文用户文档中的应用示例

以下组件由 Memmy-Web 的 `src/mdx-components.tsx` 注册：

| 组件 | 用途 |
| --- | --- |
| `<MemmyWorkflowDemo scenario="file|history|handoff" />` | 三条核心教程的材料、请求与结果示例 |
| `<MemmyComposerDemo />` | 输入任务、添加示例附件、切换示例模型 |
| `<MemmySetupMode />` | 展示桌面前端当前欢迎页的实际截图 |
| `<MemmyMemoryPermission />` | 按桌面端源码展示首次授权弹窗截面 |
| `<MemmyMemoryDemo />` | 搜索、筛选和查看示例记忆 |
| `<MemmyHistoryDemo />` | 演示电脑历史记录开关与摘要时间线 |
| `<MemmySourceDemo />` | 演示同步与 Agent 接入状态 |

交互组件会标明示意状态；需要重复操作的示例提供重置按钮。不要在 MDX 中缩放组件或覆盖它们的字号。组件只使用本地状态，不连接真实模型、账户、历史或接入配置。

网站的组件注册、源码、样式和资源必须与引用它们的文档配套发布。详细来源与维护方式见网站 `src/components/docs/README.md`。

本地预览使用网站脚本 `node scripts/prepare-local-docs.mjs <文档源目录>` 同步；它会同时补入网站维护的中英文更新日志及导航。不要仅覆盖 `content/docs`，否则会遗漏更新日志。
