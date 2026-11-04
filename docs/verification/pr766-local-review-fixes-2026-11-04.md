# PR #766 本地修复与验证（2026-11-04）

## 状态与范围

PR：[MemTensor/memmy-agent #766](https://github.com/MemTensor/memmy-agent/pull/766)。原始提交为 `af1b58742fe67653776af6e08356faa84a7aa9a3`，实际来源为 `Jovianix/memmy-agent:pxlin/dev`。

本地分支：`codex/pr766-review-fixes`；工作区：`/Users/jovian/workspace/memmy-agent-pr766`。
已合并上游 `v1.2.7@df5f2ba99bf7fcd398aeb42ec159eefca7339142`，保留 Teach 快捷入口和上游录音附件行为，解决两处冲突。

**代码验证提交：`4adade5ac5fdee81150a974d50ae0c28785ce1f0`。统一验证报告确认验证期间源码没有变化。** 本文后续提交只记录证据，不改变被测代码。

五条审查意见涉及的代码与测试修改已完成；完整自动化验收仍因一项原生媒体自测失败而未通过。未推送、未修改远程 PR 描述或评论、未将审查线程标记为 resolved；未做桌面操作或安装版实机验收。

## 审查意见对应修复

| 意见 | 本地修改 | 验证 |
|---|---|---|
| [扩展最终资源校验](https://github.com/MemTensor/memmy-agent/pull/766#discussion_r4453140833) | 显式允许所需 `webNavigation`；分别约束 History、Teach 的匹配范围、隔离环境、帧范围和时机；Teach 资源纳入哈希；原始扩展测试加入根目录打包守卫 | 正常资源通过；额外权限、MAIN world、扩大匹配范围、about/来源回退、缺失/篡改资源被拒绝；Mac/Windows 最终脚本调用同一校验器 |
| [自动更新期间的新任务](https://github.com/MemTensor/memmy-agent/pull/766#discussion_r4453175232) | 下载保持旧插件可用；切换前重新等待整轮任务、活动调用和录制租约；Agent 侧保留互斥租约，CLI 启动使用共享文件锁；完成/回滚后释放；等待支持取消、关闭及后台进程退出恢复 | 真实 PluginService + 临时 SQLite 的自动更新入口回归；下载中新任务、两次调用间隙、录制占用、停用、回滚、取消及释放异常测试 |
| [cloud-skills 元数据](https://github.com/MemTensor/memmy-agent/pull/766#discussion_r4453190314) | 恢复本地插件桥 `memmy.dev/cloud-skills: "1"` 断言；保留外部 MCP 不接收本地元数据的约束 | MCP 工具测试与 Agent 全量回归 |
| [Responses strict](https://github.com/MemTensor/memmy-agent/pull/766#discussion_r4453200993) | 完整请求测试覆盖默认 false、显式 false、显式 true；保留追加的 web_search 工具 | Provider 转换器、请求集成与 Agent 全量回归 |
| [录制验证 lint](https://github.com/MemTensor/memmy-agent/pull/766#discussion_r4453209854) | 两处表达式改为 if/else；信号监听器改为明确类型；清理无效禁用项 | 原有录制验证的 Agent 和前端 lint 均通过；完整流程仍被下述媒体失败阻断 |

## 防止再次漏检

新增 `npm run validate:teach-host` 和 `.github/workflows/teach-host-validation.yml`，统一运行依赖构建、Agent/后端/前端类型检查、相关 lint、Agent 全量测试、插件宿主、扩展及打包守卫、相关界面测试。

报告保存提交号、源码指纹、脏工作区状态、每阶段结果与原始日志；运行期间源码变化会判失败。独立阶段的结果全部保留，有失败即返回非零退出码。CI 配置仅在本地，尚未线上运行。

## 最终结果

| 检查 | 结果 |
|---|---|
| 依赖构建、Agent 构建 | 通过 |
| Agent / Backend / Frontend 类型检查 | 通过 |
| 相关 Agent / Backend lint | 通过 |
| Agent 全量 | **8039 通过，1 失败，13 跳过** |
| 插件宿主、更新和管理接口 | 59 通过 |
| 打包守卫（含扩展） | 152 通过，1 跳过 |
| 相关录制/插件/会话界面 | 41 通过 |
| 原有 History 验证 | 前置构建、类型检查、Agent/前端 lint 通过；Agent 子集 **1060 通过，1 失败，5 跳过**，因此原脚本未继续后续阶段 |
| 单独补跑 History 后续资源/媒体代理/退出契约 | 34 通过，5 跳过 |
| 单独补跑 History 后续前端用例 | 163 通过 |
| 两条 summary CLI 帮助入口、前端生产构建 | 通过 |

这些测试范围存在重叠，数量不能相加。平台条件跳过不等于对应平台验收通过。自动化使用测试夹具与合成媒体，没有录制用户桌面或安装/启动产品进行实机操作。

### 唯一剩余失败

`App/memmy-agent/tests/tools/computer-recordings/macos-native.test.ts` 的合成 AVFoundation 自测返回 `part_finalize_failed`。它在本次全量、原有录制验证以及原始 PR 提交的独立复跑中均失败。原生 recorder 文件在原始 PR 与本次验证提交的 Git blob 相同：`bfb4aa5e04e43c4265d41df714162d27e0c65387`。

这证明该失败在本轮修复前已存在；尚未确定是原生实现还是本机媒体环境导致。没有删除/跳过断言或将失败标记为成功，所以当前不能宣称完整自动化或媒体验收通过。

全量初次还发现两类既有测试环境依赖，并在原始 PR 上复现：OpenAdapt 导出夹具未规范化 macOS `/var` 路径别名（2 项）；默认端口测试依赖一个假定不可达的域名（1 项）。现已仅修正测试夹具：使用真实规范路径，以及受控 socket 验证 HTTP/HTTPS 默认端口；未放宽产品路径校验或修改网络配置。最终这些测试通过。

## 本地证据

- 统一验证：`/Users/jovian/workspace/memmy-agent-pr766-evidence/2026-11-04/teach-host-validation-MMOSBW/results.json`
- 原有录制验证：`/Users/jovian/workspace/memmy-agent-pr766-evidence/2026-11-04/computer-history-validation-Fy54Kz/results.json`
- 原始 PR 对照：`/Users/jovian/workspace/memmy-agent-pr766-evidence/2026-11-04/baseline/pr766-original-extra-failures.json`（14 通过，4 失败；复用相同依赖，三个失败测试对应的原始源码独立检出）
- 修复前扩展、lint、Provider/MCP、自动更新竞态日志：`/Users/jovian/workspace/memmy-agent-pr766-evidence/2026-11-04/baseline/`
- 后续阶段 JSON、CLI 和构建日志、提交元信息：`/Users/jovian/workspace/memmy-agent-pr766-evidence/2026-11-04/`

## 后续跟进

1. 单独定位并修复原生媒体 `part_finalize_failed`，恢复原有录制验证完整通过；必要时明确需要的环境条件。
2. 按用户后续安排执行 macOS/Windows 桌面与安装版实机验收。
3. 获得推送安排后，先重新核对 PR 源分支是否变化，再将本地修复更新到 `Jovianix/memmy-agent:pxlin/dev`。当前 `origin` 指向另一个仓库，不能直接假定它就是 PR 来源。
4. 更新原 PR 的提交与验证证据，逐条回复审查意见，跟进线上 CI 和复审；未解决的验收项继续明确列出。
