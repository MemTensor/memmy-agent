# Codex Computer Use PiP 原生窗口核查

核查对象：本机 `/Applications/ChatGPT.app/Contents/Resources/native/sky.node`（2026-09-28）。以下是包内二进制的 Objective-C 类元数据和 ARM64 调用参数能够直接证明的行为。它们不是 Codex 的原始源码。

## 窗口层

- `PIPStackWindow` 创建两个 `NSPanel`，标题分别是 `Computer Use` 和 `Computer Use Controls`。两者 `styleMask = 0x80`（非激活面板）、透明、无系统窗口阴影、无标题栏，不随主应用失活而隐藏。原生内容视图是 `PIPStackContentView`，而非 Electron WebView。
- 内容卡片属于 `PIPStackItem`，其图层使用 **8 pt 连续圆角**并裁切内容。`displaySizeForSourceSize:` 将最长边约束在 **200–400 pt**，保留原画面宽高比；主进程初始化值为 **200 pt**。
- `PIPStackController` 持有有序 presentation、stack item 动画、拖动、边角缩放、停靠锚点、宿主窗口位置和多任务隐藏状态。`PIPStackDragInteraction` 记录指针速度；`PIPStackResizeInteraction` 从指针位置计算新的最大尺寸。
- 控件单独位于悬浮面板，使用 **22 × 22 pt** 图层。二进制中的标识为 `hide` 和 `placement`，图标使用 SF Symbols `xmark` 和 `out.to.pet`。控件有 hover 显示、 tooltip 和根据背后画面亮度切换图标对比度的逻辑。

## 画面与点击

- 主进程调用 `startRemoteHostedPIPContentHost`、`upsertBrowserUsePIPContent`、`setRemoteHostedPIPContentNativeVideoEnabled` 和 `setRemoteHostedPIPContentNativeVideoReady`。浏览器画面可按工具结果中的截图更新；原生应用使用远程视频帧，不是“快照”标签所描述的单帧状态。
- 原生面板的 `presentationClickHandler` 和 `RemoteHostedPIPContent focus action` 表明卡片点击会进入对应 presentation 的聚焦流程。用户提供的 Codex 实机录屏进一步确认：单击小窗会把目标应用的大窗带到前台，随后点击发生在大窗中；小窗留在屏幕上并同步更新。小窗单击不会把坐标映射成一次应用内点击。
- PiP 的隐藏分为当前聊天和所有活跃聊天；主进程中有 `completeTurn` 与 `invalidateTurn` 路径。回合结束清理是 presentation 生命周期的一部分。

## Memmy 对应实现

Mac 端使用独立 N-API AppKit 模块创建内容与控件两个非激活透明面板。内容仍由现有隔离的 Electron 捕获会话提供，离屏渲染按帧送至 AppKit 面板；代理动作继续走现有受控 Computer Use 通道。Windows 使用无标题栏透明 Electron 窗口，等待其独立平台验收。

本实现保留了 8 pt 连续圆角、200–400 pt 尺寸边界、无系统标题栏、独立控件面板以及拖动、边角缩放、隐藏、归位与接管入口。多卡片动画、原生 IOSurface 视频共享、Codex 的精确宠物宿主锚点与所有细节动画尚需进一步按真实 PiP 验收，不能据此声称像素级或行为级完全相同。

进一步核查 `sky.node` 的控件标识与主进程默认文案后确认：第二个悬停控件是 `placement`，默认 tooltip 为 `Send Picture-in-Picture to Pet`，不是放大按钮；放大由卡片边角拖动处理。Memmy 原生面板现发出 `placement` 事件，并接受可选的 `ComputerUsePIPPlacementHost.onPlacement` 回调（唤醒桌宠并返回其 Electron 窗口坐标）；`syncHostPlacement(bounds)` 可在桌宠移动时更新已锚定卡片。未接入宿主回调时隐藏该控件，避免出现无效按钮。宿主需要在桌宠侧接入这两个接口，且原版宠物图标资源没有直接拷贝进产品。
主窗口退出全屏需要等待时，`onPlacement` 可能暂时返回空坐标；此时保存待归位状态，等桌宠首次报告有效 bounds 后由 `syncHostPlacement` 完成锚定。

原生面板单击或双击均请求接管目标大窗，不在小窗内合成应用点击。接管前，Agent 重新核查目标应用；若能取得新的 CGWindowID，必须与小窗所指窗口一致。原生辅助功能随后按小窗保存的 CGWindowID、所属进程和窗口边界定位并抬起对应窗口；窗口已切换、标识缺失或无法唯一匹配时拒绝接管。滚轮仍从实时视频的可见图像区计算坐标，并交给受控 Computer Use 动作验证器。实时源断开时不会发送坐标动作。

独立 Electron 烟测验证了 N-API 面板能在应用进程中创建；离屏页面持续变化时，两秒收到 28 帧。另一次测试将 TextEdit 窗口接入离屏 `getDisplayMedia`，取得 1172 × 976 视频帧，两秒内发生 59 次绘制。此前在原生面板上实点 TextEdit 实时画面的中心，回调解析为 `x=0.5,y=0.5,frameMode=live,frameWidth=1172,frameHeight=976`；这只验证了旧版坐标映射，并不符合录屏确认的接管行为。滚轮仍保留坐标和实时帧尺寸。这些烟测证明显示链路可持续工作；新的单击接管仍需在最终 Memmy 签名包中实机签收。

Windows 端没有 macOS `sky.node` 的 AppKit 窗口可移植，因此其外壳使用无系统标题栏、透明可缩放 Electron 窗口，卡片保持 8 px 圆角与同一组拖动、隐藏、放大和打开目标控件。`getDisplayMedia` 与现有目标窗口动作链保留；实时连接失败时明确显示“实时画面不可用”，不再把单帧伪装成实时画面。Windows 虚拟机仍需对安装包的帧更新、点击、滚轮、拖动与接管逐项实测。
macOS 原生模块加载失败时也使用该无标题栏 Electron 外壳，避免退回带“快照”标题栏的大窗口。
