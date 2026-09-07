---
title: "微信里妈妈想要的 iPhone 配置"
source_type: demo_fixture
demo_id: wechat_mom_iphone
captured_at: 2026-09-01T09:20:00+08:00
applications: ["com.tencent.xinWeChat"]
privacy: "Demo fixture distilled from a fictional WeChat conversation; no chat screenshots, raw messages, credentials, or payment data."
status: completed
---

# Computer History

这是一条为了产品演示而人工注入的 History。它模拟用户授权 Computer History 后，从微信里的真实操作和对话语义中蒸馏出的个人上下文；不包含聊天截图、逐字聊天记录或点击坐标，也不是可直接逐击回放的宏。

## Timeline

### 20:14 · 微信 · 与妈妈的对话

妈妈请用户帮忙在 Apple 官方商店准备一台新 iPhone。她不熟悉官网配置流程，但已经把偏好说清楚：

- 机型：iPhone 17 Pro，标准尺寸，不要 Pro Max
- 颜色：银色
- 容量：512GB
- 换购：没有旧设备参与换购
- 购买方式：一次性购买，不选择分期
- AppleCare+：这次不添加
- 渠道：Apple 中国大陆官方在线商店
- 授权边界：可以把准确配置加入购物袋，方便稍后一起确认
- 禁止动作：不要登录账户，不要进入结账，不要提交订单或支付

用户回复“好，我晚点帮你配好放进购物袋，付款前再找你确认”。

### 20:18 · 微信 · 用户确认待办

用户把这件事概括为“帮妈妈准备手机”，没有另外抄写型号、颜色和容量，预期之后的 Agent 能从个人 History 找回这些上下文，而不是再次追问。

## Personal context distilled

### 可用于后续任务的事实

- “妈妈之前说的那台 iPhone”指 `iPhone 17 Pro / 银色 / 512GB`。
- 购买偏好为不换购、一次性购买、不添加 AppleCare+。
- 本次允许的最高动作是加入购物袋；结账、登录、提交订单和支付始终需要新的明确授权。

### 使用规则

- 只有当用户请求明确提到“妈妈之前说的 iPhone”时，才应用这组配置。
- 如果官网没有完全相同的机型、颜色或容量，必须停止并说明差异，不能猜测替代品。
- 执行前先向用户展示从 History 恢复出的关键配置和停止边界。

## Outcome

需求已经从一次微信对话蒸馏成可检索的个人上下文；尚未打开 Apple 商店，也没有发生购物或支付行为。
