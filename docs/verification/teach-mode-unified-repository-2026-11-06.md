# Teach Mode 阶段一、二统一仓库验收

## 结论与范围

本轮仓库范围内验收通过。用户明确限定“不构建 App”，因此没有执行 App / Agent 构建、产品原生录制器构建、安装、真机操作、外部业务发送或推送。浏览器用例仅使用独立测试 Chromium、临时用户目录和本机测试网页；跨仓联测使用当前 Host 源码、插件测试包、受控事件与草稿，不等同于安装包或真实模型验收。

代码基线：

| 仓库 | 本地开发线 | 本轮修复提交 |
| --- | --- | --- |
| App | `codex/pr766-stage2` | `5299da88bc14b8c4f4faaf2b76811101e42d6888` |
| Teach Mode | `codex/teach-event-only-stage1` | `6ff8df0b1f16cb9f5f987ed3f04d22634824de8f` |

App 组合包含阶段一 `0f589e6b`、目标分支 merge `aa2630a8`、关闭等待修复 `1fbe039d`；插件组合包含阶段一 `58a309e7`。未刷新或替换本轮已固定的目标分支快照，不引用旧 fork CI 作为本轮结果。

## 本轮修复

1. 公共 Cloud 夹具补齐登录 `invitationResult` 和配额 `sceneUsages`；继续类型检查时发现并补齐遗漏的 `ensureInvitationCode`、`transcribeAudio` 方法。默认夹具不发放虚构邀请奖励，ASR 返回空测试文本。
2. 公共 Memory 夹具补齐召回证据、任务列表和删除任务接口，沿用既有失败模拟，并去掉重复 `createdAt`。
3. 登录联测改用当前 `verificationCode` / `loginSource` 参数。新增公共夹具响应的真实 schema 校验及失败模拟回归。
4. Backend 和 Agent 的 Vitest 直接引用当前 API contracts 源码，避免“不构建 App”时误用旧 `dist` 接口。首次 Agent 回归的五项 CDP 失败来自旧构建接口；源码中的修复未被回滚。
5. Notepad 的旧受限测试显式选择 `captureText:false`，另覆盖默认通用采集。保留上游默认行为和 #766 兼容路径。
6. TeX 测试修正“安装 TeX 即必然存在可选用户 texmf 目录”的断言；没有修改产品目录或权限行为。
7. 测试 Host 支持显式使用仓库内 Skill Creator，补齐空闲任务/更新租约夹具。插件跨仓测试验证更新等待两个录制租约释放后完成，替代旧的立即拒绝预期。

本轮更改限于测试夹具、测试配置和用例，没有追加产品架构重构。

## 最终结果

| 检查 | 通过 | 条件跳过 | 结果 |
| --- | ---: | ---: | --- |
| Agent 仓库回归（514 个文件通过） | 8,152 | 12 | 通过 |
| 独立 Chromium 扩展完整流程 | 1 | 0 | 通过 |
| Backend 插件 / MCP / 更新 / 关闭 / 公共夹具 | 287 | 2 | 通过 |
| 前端插件 / 会话 / 录制 | 304 | 3 | 通过 |
| Shell 退出、生命周期、打包边界和工作流源码 | 227 | 4 | 通过 |
| API contracts 与打包规则夹具 | 241 | 5 | 通过 |
| Teach Mode 单元测试 | 43 | 0 | 通过 |
| Teach Mode 分发与发布规则单元测试 | 4 | 0 | 通过 |
| 两仓源码 Host + 实际 MCP 插件进程联测 | 9 | 0 | 通过 |

各组存在少量重复选择的用例，不把表中数字相加作为独立测试总量。关闭等待新增的 8 个组合层场景全部通过，含下载、任务、录制、工具调用、激活、回滚及清理异常；调度关闭后的停止检查和停止配置发布也通过。

静态检查全部通过：

- Agent、Backend、前端、Shell、contracts 的常规 TypeScript `--noEmit --incremental false`。
- Agent、Backend、前端、Shell 及公共夹具另以当前 contracts 源码映射检查，排除旧声明缓存掩盖接口差异。
- 公共夹具、关闭回归与登录联测的独立 TypeScript 检查，原四项错误和随后暴露的接口缺失已消除。
- 相关 Agent、Backend、前端的定向 lint，插件类型检查，以及 Swift 语法解析。
- 两仓 `git diff --check`。

## 跳过项与构建边界

Agent 主回归显式排除三个会构建 Agent 或原生媒体程序的文件：`tests/build-assets.test.ts`、`tests/skills/office-skills.test.ts`、`tests/tools/computer-recordings/macos-native.test.ts`。浏览器扩展流程从主回归分离后单独运行，已通过，未遗漏。

条件跳过包括 Windows 原生平台/AppContainer 用例、真实飞书业务用例、依赖其他插件 UI 制品的用例及现成产品原生二进制检查。详单在证据目录的 `conditional-skips.json`；它们不计入通过数。未为本轮创建 App 产物来填补这些条件。

跨仓运行只打包了 Teach Mode 插件测试包，没有构建 Host kit 或 App：用 TypeScript 源码加载器接入仓库 Host，显式指定源码 Skill Creator。测试包是未发布开发产物，构建时带 dirty 标记；未把它作为正式发布包。联测验证浏览器/桌面两种受控事件、会话隔离、技能生成校验、旧执行器撤下及文件保留、卸载重装和下载失败等。它不证明 Windows 原生运行、真实模型整理或 Skill 独立业务执行。

## 证据

本机目录：`/Users/jovian/workspace/memmy-agent-pr766-evidence/2026-11-06-unified-repo/`。

- `results.json`：最终范围、提交、各组数量、排除项和插件测试包哈希。
- 各组 `*-final.json` / `.log`，以及前端、Shell、contracts 的独立报告。
- `static-types.json`、`static-source-types.json` 与各项类型/lint 日志。
- `cross-repo-source.log`：9 项 Node 测试的完整记录；`source-check-configs/` 保留无 App 构建的配置和源码 Host 入口。
- `app-tested.patch`、`teach-tested.patch`：对上一阶段提交的实际修复差异。首次失败报告也保留，最终结论以最终结果为准。

仓库源码验收已完成；App 构建、安装包、平台真机和真实模型验收不属于本轮授权范围。未推送。
