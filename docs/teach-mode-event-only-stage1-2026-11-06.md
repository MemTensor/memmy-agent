# Teach Mode 事件链路清理：本地阶段一

## 范围与状态

阶段一结束时仅修改源码并做本地静态检查，尚未推送、提交 Git commit 或同步远端目标分支，也未运行测试、打包、安装或真机验收。本文记录该阶段结束时的状态；后续本地提交与合并见阶段二记录，最终组合统一验收。

| 仓库 | 工作目录 | 本地分支 | 修改起点 |
| --- | --- | --- | --- |
| Teach Mode | `/Users/jovian/workspace/teach-mode` | `codex/teach-event-only-stage1` | `3924e6ac3bd0784cd808a31d6151db002dc7df60` |
| App / PR #766 | `/Users/jovian/workspace/memmy-agent-pr766` | `codex/teach-event-only-stage1` | `6e0c8b13cf80ef6de66e119b7815158de0236f76` |

## 已修改

- 插件仅保留 `record_and_replay` 与 `create_skill`。删除旧 Web → Notepad 模块、`teach_session` 路由、未公开的 `teach_manage` 实现、旧面板及专用脚本。
- 插件 Host 调用类型只允许 `plugin-context`、`event-sessions`、`skills`。清单删除 `recording`、`collector`、`window-focus` 授权。
- 插件打包删除 Playwright 运行依赖及旧脚本。源码版本调整为 `0.5.0`，同步锁文件、发布路径和文档；这不代表已构建或发布该版本。
- 插件初始化新增旧技能注册撤下逻辑：根据 `memmy.teach-export/v1` / `v2` 元信息及身份匹配，通过 Host 的 `skills.remove` 撤下旧执行器贡献。原技能、证据及视频文件不删除；事件技能和原型事件数据迁移保留。此逻辑尚未对用户安装数据执行。
- 删除已无运行用途的 `outputDirectory` 配置 schema。Host 可继续接受安装记录中的旧配置对象，插件不读取该字段。
- App 删除上述三个旧插件服务的注册、转发及原生处理，包括插件专属录像实例、旧外层采集租约和窗口聚焦适配。
- App 保留 `event-sessions` 的订阅、关闭、心跳回收和更新占用判断。桌面事件继续经 Computer History 采集，浏览器事件继续经宿主扩展采集。
- App 的主动录屏 HTTP 接口、`task_recording` 执行录屏、媒体驱动、共享采集互斥以及系统权限逻辑均未修改。
- 更新测试源码：旧服务拒绝、插件生命周期仅调用事件/技能服务、旧技能注册撤下与文件保留、重装以及制品内容检查。删除专属旧执行器的测试；保留现有事件教学与 App 任务录屏测试。

## 本轮静态检查

- Teach Mode：`tsc --noEmit --incremental false -p tsconfig.json` 通过（含插件测试源码）。补充 `types: ["node"]`，显式声明移除旧依赖后的 Node 类型需求。
- App Agent：同一 `tsc --noEmit` 检查通过（含 Agent 测试源码）。
- App Backend：同一 `tsc --noEmit` 检查通过（项目配置不包含测试源码）。
- App 修改的 TypeScript 文件：定向 ESLint 通过，包含修改的后端测试源码。
- 插件修改的五份 JavaScript 脚本：`node --check` 通过，仅解析语法，没有执行脚本。
- 插件清单、包清单、锁文件及 TypeScript 配置：JSON 语法读取通过。
- 两仓 `git diff --check` 通过。

这些结果仅说明静态检查通过，不构成运行、制品或真机验收结论。

## 后续衔接

1. 讨论阶段二，再按普通 merge 同步 PR #766 的目标分支，处理冲突及实际 CI 问题。不得把此前提交的 CI 结果计入本轮。
2. 在最终源码组合上执行单元测试、事件会话/生命周期/更新回归及 App 主动录屏回归。
3. 构建并固定两仓制品，执行真实 MCP 插件联测，检查服务调用、旧能力退出、数据保留及重装行为。
4. 在 Windows/macOS 完成桌面、浏览器、Skill 生成与独立执行验收；用调用轨迹、原生启动模式和输出文件证明 Teach 未启动视频录制。录屏权限已授予不构成失败。
5. 推送与发布仍待后续指令。
