# Teach Mode 阶段二：本地合并与退出等待修复

## 范围

按本轮指令，先提交阶段一，再刷新远端、普通 merge 目标分支并修复 Backend 退出等待。仅修改源码和执行本地静态检查。没有推送、触发远端 CI、执行测试、构建、打包、安装或真机验收。阶段一与阶段二的最终组合留待后续统一验收。

Teach Mode 继续调用 App 内置 CH 和 CU；保留事件片段管理与 Skill 生成工作流，不另行重构采集接口或权限架构。

## 本地开发线

| 仓库 | 分支 / 提交 | 说明 |
| --- | --- | --- |
| Teach Mode | `codex/teach-event-only-stage1` / `58a309e71e6ee7feb750681695bb8ef2abb93a47` | 阶段一插件修改已本地提交；独立仓库提交，不属于 App PR 的文件 diff |
| App | `0f589e6b9142ae74fbc40b8979fceb9e9a6aa237` | 阶段一 Host 修改已本地提交，直接承接 #766 远端 head |
| App | `codex/pr766-stage2` / `aa2630a817520206508a15765c2036ab41a15570` | 普通 merge；父提交为阶段一提交与本轮刷新后的 `upstream/v1.2.7` |
| App | `codex/pr766-stage2` 后续修复提交 | 关闭顺序、回归用例源码、合并带入的重复测试夹具清理与本文 |

本轮刷新时：

- #766 源分支 `origin/pxlin/dev` 为 `6e0c8b13cf80ef6de66e119b7815158de0236f76`，已是本地开发线祖先。
- 合并的目标 `upstream/v1.2.7` 为 `9078cc010c744758e305fb493c6171c468a2cba8`；按这一快照完成本地合并。
- Teach Mode `origin/main` 为 `3924e6ac3bd0784cd808a31d6151db002dc7df60`。
- GitHub #766 刷新时仍为 `CONFLICTING` / `CHANGES_REQUESTED`。本地修复未推送，因此不会改变远端 PR 状态。
- fork 的 Teach Host、Windows History、通用插件 Host、macOS 任务录制四项检查均为上述旧 PR head 的成功结果，不能用于本地新组合。对应 [Teach Host 旧运行](https://github.com/Jovianix/memmy-agent/actions/runs/41840285280)。

## 合并处理

共处理 39 个冲突文件，并清理自动合并产生的重复声明与测试 mock。

- 保留阶段一移除 `recording`、`collector`、`window-focus` 插件 Host 服务的修改；Host 仍提供 `plugin-context`、`event-sessions`、`skills`。
- 合并上游 Windows 通用采集、浏览器与共享观察设置，同时保留 #766 的 Notepad 兼容适配、事件检查点、录制轮转、窗口绑定和操作证据。
- Windows 原生遍历同时保留批量缓存与上游聚焦分支优先策略；缓存视图随 Control/Raw View 选择一致切换。
- 保留上游历史保留/延迟清理行为；事件会话持有期间延后清理，避免删除教学片段所需原始事件。
- macOS 录制沿用上游 60,000 编码时间刻度，证据时钟仍为纳秒；保留跳过零样本控制标记的修复及已有检查源码。
- 合并前端文案、录制入口、退出逻辑、打包配置及 CI 定义。App 主动录屏和任务执行录屏继续保留。

## 关闭等待修复

问题发生于自动更新下载期间出现新的 Agent 任务、录制租约或工具调用：下载后更新等待空闲，而旧的 Backend 关闭顺序先等待更新结束，导致后面的 `plugins.shutdown()` 无法触发取消。

本次仅调整组合层顺序：

1. 调用 `pluginUpdates.close()`，同步停止新检查和定时调度，保存排空 Promise。
2. 立即调用 `plugins.shutdown()`，通过现有取消机制释放下载/空闲等待；已进入激活或回滚的事务仍等其收尾。
3. 等更新循环结束，最后调用 `native.close()`。插件关闭抛错时仍执行该收尾路径。
4. 关闭已开始时，不再发布更新后的工具配置，也不把预期的取消打印为更新失败。

新增组合层回归用例源码覆盖空闲、下载中、等待 Agent 任务/录制/工具调用、激活中、回滚中和插件关闭异常。另补充更新调度立即停止、关闭后不发布工具配置的用例。**这些用例尚未运行。**

## 静态检查

已通过：

- Agent、Backend、前端、桌面 Shell、共享 API contracts 的 TypeScript `--noEmit --incremental false` 检查。使用本地现有依赖；未运行包含依赖构建的 npm typecheck 包装脚本。
- 冲突相关 Agent/前端 TypeScript，以及 Backend 修复和新增回归用例的定向 ESLint。
- macOS `task-recorder.swift` 的 Swift 语法解析（`-frontend -parse`）。未生成原生二进制，未验证 Windows 原生编译。
- 冲突涉及的 YAML 与 package JSON 解析、冲突标记扫描及 `git diff --check`。

新增 Backend 回归用例另做了包含测试源码的 TypeScript 检查。检查仍报告现有公共测试夹具的四项错误：

- `mock-cloud-client.ts` 的登录返回缺少 `invitationResult`，配额返回缺少 `sceneUsages`。
- `mock-memory-client.ts` 缺少三个当前接口方法，并含重复对象属性。

同一配置检查已有 `plugin-account-tool-sync.test.ts` 时完整复现上述四项诊断；该已有用例另有 `code` / `verificationCode` 不匹配。公共夹具文件与阶段一提交的内容完全相同，新增用例文件自身没有类型诊断。本轮不扩展修改这些无关夹具，也不将此项记录为通过。

诊断原文保存在本机 `/Users/jovian/workspace/memmy-agent-pr766-evidence/2026-11-06-stage2/static-checks/`。临时类型检查配置已删除。

## 后续统一验收

以本地阶段二最终 App 提交和 Teach Mode `58a309e7` 为共同起点，再统一处理测试环境/夹具基线，运行回归、构建两仓制品并进行 Windows/macOS 真实教学、Skill 生成与独立执行验收。测试、制品、安装和业务完成状态分别记录；此前 fork CI 或旧验收结果不代替本次组合验收。推送与发布仍待后续指令。
