---
title: "从个人 History 生成：帮妈妈配置 iPhone 并加入购物袋"
kind: cua_workflow
source_history_id: DEMO_HISTORY_ID
source_history_path: DEMO_HISTORY_PATH
user_request: DEMO_USER_REQUEST
generated_from: computer_history
status: ready
---

# Workflow：帮妈妈配置 iPhone 并加入购物袋

## 用户当前请求

> DEMO_USER_REQUEST_TEXT

这份 Workflow 是 Agent 读取 Computer History 后生成的下游产物，不是旧操作的坐标回放。当前请求本身没有给出具体配置；下列槽位来自微信 History，执行时必须通过 CUA 根据实时界面重新定位并验证。

## History 恢复出的上下文

| 槽位 | 恢复值 | 来源 |
| --- | --- | --- |
| `model` | `iPhone 17 Pro`（不是 Pro Max） | 微信 History |
| `color` | `银色` | 微信 History |
| `storage` | `512GB` | 微信 History |
| `trade_in` | `不换购` | 微信 History |
| `payment_preference` | `一次性购买` | 微信 History |
| `applecare` | `不添加` | 微信 History |
| `allowed_last_step` | `加入购物袋` | 微信 History + 当前请求 |

## Semantic steps

1. 先在执行日志中说明：已从 Computer History 恢复 `iPhone 17 Pro / 银色 / 512GB`，并确认“加入购物袋即停止，不登录、不结账、不支付”。
2. 用 CUA 列出应用和窗口，定位已有 Google Chrome。Chrome 已运行时不要创建新的 application instance。
3. 优先调用 CUA `launch_app`，传入 `bundle_id=com.google.Chrome`、`creates_new_application_instance=false` 和 `urls=[https://www.apple.com.cn/shop/buy-iphone/iphone-17-pro]`，让 Driver 直接在现有 Chrome 中打开配置页；这允许新建标签页，但不能启动第二个 Chrome 进程。随后重新列出 Chrome 窗口，验证域名为 `apple.com.cn`，页面标题或正文包含“购买 iPhone 17 Pro”。
4. 如果 `launch_app` 没有完成导航，才使用一次键盘回退：先对 Chrome 主窗口发送 foreground `cmd+l` 使 Chrome 成为前台应用，再使用 desktop-scope foreground 完整执行 `cmd+l → 输入 URL → return`。不要通过 background AX 只改地址栏文本后再发送 window-scoped `return`；地址栏显示 URL 不代表已经提交导航。
5. 从这里开始维护严格检查表：`G1 机型 → G2 颜色 → G3 容量 → G4 换购 → G5 购买方式 → G6 AppleCare+ → G7 最终摘要 → G8 加入购物袋`。只有当前 Gate 有点击后的 UI 证据，才允许寻找下一 Gate。不得因为页面下方出现“加入购物袋”就跳过未完成项。
6. **G1 机型**：查询或观察“机型/哪一款适合你/iPhone 17 Pro”，选择标准尺寸 `iPhone 17 Pro`，不是 Pro Max。重新读取状态，验证卡片选中样式或页面摘要明确显示 `iPhone 17 Pro`，记录 `G1 verified`。
7. **G2 颜色**：只有 G1 verified 后，向下移动最多一个视口并重新观察，直到“外观/颜色”区域可见；选择 `银色`。点击后重新读取状态，验证选中名称、色样标签或摘要明确显示“银色”，记录 `G2 verified`。如果一次滚动越过颜色区域，立即向上回到颜色区域，不能处理容量或后续选项。
8. **G3 容量**：只有 G2 verified 后，向下移动最多一个视口并观察“存储容量/容量”区域；选择 `512GB`。重新读取状态并验证 `512GB` 出现在选中控件或摘要中，记录 `G3 verified`。
9. **G4 换购**：只有 G3 verified 后寻找换购区域并选择“不折抵换购/不换购”。验证该选项处于选中状态，记录 `G4 verified`。
10. **G5 购买方式**：只有 G4 verified 后处理购买/付款方案；选择“一次性购买/全额付款”，不要选择分期。验证当前选择后记录 `G5 verified`。如果页面没有独立询问，记录“页面未询问”并保留页面证据。
11. **G6 AppleCare+**：只有 G5 verified 后选择“不加 AppleCare+ 服务计划/不添加”。验证选中状态后记录 `G6 verified`。
12. 所有滚动都只是为了让**当前 Gate 或紧邻的下一 Gate**进入视野；每次最多一个视口并立即重新观察。禁止 `amount > 1` 的 page scroll，禁止从机型区域一次跳到换购、AppleCare+ 或页面底部。
13. **G7 最终摘要**：在寻找“添加到购物袋/加入购物袋”前，重新读取当前页面摘要，必须同时取得 `iPhone 17 Pro`、`银色`、`512GB`、不换购、不添加 AppleCare+ 的当前 UI 证据。如果任何一项不一致或缺失，回到第一个未验证 Gate；不能选择近似配置，也不能点击购物袋按钮。
14. **G8 加入购物袋**：先检查当前购物袋是否已存在完全相同的 `iPhone 17 Pro / 银色 / 512GB`。如果已存在，只验证结果，不重复添加；否则点击一次“添加到购物袋”或含义相同的按钮。
15. 使用 Chrome 目标窗口的定向状态、页面标题和截图验证购物袋或加入成功区域明确显示目标机型、银色与 512GB。目标 Chrome 窗口被 Memmy/Electron 遮挡不代表失败。
16. 验证成功后立即停止。不得点击“结账”“查看结账”“使用 Apple 账户结账”“访客结账”“支付”或任何继续购买流程的按钮。

## Safety boundary

- 本次明确允许把一件正确配置加入购物袋；除此之外，不得更改购物袋中的其他商品或数量。
- 登录、结账、提交订单、支付、输入密码、验证码、收货地址或支付信息都不在授权范围内。
- 如果目标配置缺货、页面结构无法可靠识别、出现地区跳转，或官网选项与 History 不一致，停止并报告，不猜测替代选项。
- 购物袋里已存在相同配置时不得重复添加，以便这个 Demo 可以安全重试。

## Success criteria

- Chrome 中的 Apple 中国大陆官方购物袋或加入成功区域，经过定向验证后显示 `iPhone 17 Pro`、`银色`和 `512GB`。
- 最多新增一件目标配置；购物袋中的其他内容未被修改。
- 没有进入登录、结账、提交订单或支付步骤，也没有输入任何账户或支付信息。

只有三条成功判据都得到实际 UI 证据时才算成功；仅打开 Apple 首页、仅进入配置页或仅点击按钮都不算完成。
