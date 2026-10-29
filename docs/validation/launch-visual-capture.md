# 1.2.5 弹窗视觉取图记录

- 来源：`upstream/v1.2.5` 的独立工作树，本地交互预览 `App/frontend/desktop/launch-visuals-preview.html`；取图时工作区有未提交改动。
- 素材：录音和插件商店来自 1.2.5 的真实 React 组件，Office 文件图标来自应用组件；对话文字为演示数据。文献综述前两页来自用户提供的 `review(5).pdf`，用 Poppler 直接渲染为 1485×2100 PNG，再放入预览；没有把低像素 PDF 缩略图放大。
- 方法：`scripts/capture_launch_visuals.mjs` 使用本机 Playwright 和 Chromium Headless Shell，以 480×400 CSS 视口、100% 缩放、DPR 4 重新渲染源 DOM。等待页面、字体和图片稳定后，对原生 `.launch-visual-canvas` 截图，输出 1920×1600 真 PNG。中英文分别渲染；产品实际引用 `App/frontend/desktop/src/assets/launch/launch-visual-*.png`。
- 取图范围：Token（新、老用户）、录音、插件商店、文献综述、Office；每种均有 `zh-CN` 和 `en-US` 图。输出文件无账号凭证或真实业务数据。
- 交互检查：本地翻页 mock 可打开、前后翻页；自动赠送仅由云端接口支持，mock 不发放额度。客户端与本地后端类型检查及相关测试通过。
- 视觉检查：已在浏览器逐张检查中英文右图，并在弹窗实际显示宽度检查首图；后续发版打包或云端联调后仍需对正式客户端再验收一次。
- 当前限制：这批图用于 1.2.5 原型与桌面发布弹窗，不能证明云端已发额度或插件已在正式环境可用；以服务端和插件目录上线状态为准。
