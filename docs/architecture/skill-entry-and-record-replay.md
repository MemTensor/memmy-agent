# Memmy Skill 多入口与演示学习方案

## 目标

用户可以通过一次有意的操作演示创建可复用 Skill，也可以从 Computer History 的重复工作建议、手工编写、现有 `SKILL.md` 或对话进入同一 Skill 管理体验。上传操作视频可作为后续的草稿来源。所有入口最终都要说明适用场景、可变输入、操作步骤、验证方法和来源；启用后由现有工具执行，并根据当前界面状态决定下一步。

## 当前代码基线（2026-09-28）

| 能力 | 当前实现 | 缺口 |
| --- | --- | --- |
| Agent 文件 Skill | `App/memmy-agent/src/core/agent-runtime/skills.ts` 从 workspace 和内置目录读取 `SKILL.md`；workspace 同名文件优先。`skill-creator` 可直接创建文件。 | 与 Memory Skill 列表没有统一的创建、版本和试跑体验。 |
| Memory Skill | `Memory/src/service/evolution/skill-pipeline.ts` 从 Policy/trace 结晶；`skill-cluster-pipeline.ts` 从有结果评分的 episode 聚合。`Memory/src/service/import/import-job-processor.ts` 还能将外部 Agent 的 `SKILL.md` 导入为只读 Skill。 | 结晶只是来源之一，但桌面端 `skills-sub-page.tsx` 目前主要是列表、详情、批准观察候选和删除。 |
| Computer History | `computer-history-api.ts` 可将完整的显式操作录制写成 `computer_use_workflow` Markdown。已关闭的多段 History 可经 `POST /api/v1/evidence/skills/suggest` 生成待审阅 Memory Skill 候选。 | 显式录制是命令行演示工具，未串成桌面端“教一次→草稿→试跑→启用”。观察候选接口要求至少两段来源，不适合单次有意演示。 |
| 视频附件 | 桌面聊天和会话记录能表示视频附件，模型能力表列出部分支持视频的模型。 | 尚无“视频→带时间戳的步骤证据→Skill 草稿”路径；显示附件不等于可靠地学习操作。 |

## 产品入口

将 Skill 作为独立的用户对象呈现。主入口是“技能”页面和聊天中的“创建技能”；Memory 管理页继续显示 Skill 的记忆投影与证据详情，Computer History 时间线继续显示来源及建议。

创建菜单先提供四项：

1. **演示一次**：用户先描述目标、可变输入和完成标志，然后明确开始/停止局部录制。适合“教它怎么做”。
2. **从历史建议创建**：展示支持该建议的时间窗、可确认步骤和缺口。证据不足时引导用户补录一次演示。
3. **手工/对话创建**：从自然语言草稿或 `SKILL.md` 建立可编辑草稿。
4. **导入 Skill**：读取本地 `SKILL.md`，保留原始来源、版本和依赖；不把导入误称为 Memmy 自己结晶的经验。

“上传操作视频”作为第五个入口迭代。视频只能证明画面和解说中看得见、听得见的内容；隐藏状态、点击目标和成功结果必须由用户补充或通过试跑确认。

## 统一 Skill 生命周期

每个 Skill 使用稳定 ID、版本、来源类型与来源引用。草稿至少有 `name`、`description/trigger`、`inputs`、`preconditions`、`steps`、`verification`、`toolDependencies`。来源类型包括 `demonstration`、`computer_history`、`conversation`、`file_import`、`video` 和现有的 `memory_evolution`。

状态从 `draft` 进入 `review_required`，试跑通过后由用户启用为 `active`；后续可停用、修订或删除。试跑记录具体输入、执行轨迹、成功检查与失败原因，不以“模型认为学会了”作为验证。来源片段和 Skill 版本要有双向链接；删除来源时遵守现有撤回规则，并阻止已删除证据被重新同步。

生成的 Skill 以一个版本化记录为准，`SKILL.md` 是供 Agent 加载的投影；外部导入的 `SKILL.md` 标注“由外部文件管理”，Memory 中的只读副本不得反向覆盖原文件。不要让 History workflow Markdown 和 Memory Skill 各自成为可执行的权威副本。

## 三条学习路径的证据门槛

| 来源 | 可生成什么 | 启用条件 |
| --- | --- | --- |
| 有意演示一次 | 带步骤、输入占位符和成功检查的草稿。录制可包含事件、AX 语义和用户单独授权的关键画面。 | 用户检查草稿；至少一次使用不同输入的受控试跑。无需伪造第二段来源。 |
| 被动 Computer History | “你可能经常做这件事”的建议，以及有来源的观察候选。后台 History 本身不录屏。 | 现有多来源核验后审阅；缺少步骤或结果时补录演示。不会自动成为可执行 Skill。 |
| 上传视频 | 带时间戳画面、字幕/语音、OCR 和不确定步骤的草稿。 | 用户补足变量、操作对象与结果，并在实时界面试跑后启用。不能按录制坐标盲播。 |

执行时优先使用已有结构化连接器，其次浏览器或 Computer Use；每一步读取当前状态并核对目标。示范中的授权不自动变成未来执行时的应用权限，也不授权付款、发送或删除等实际操作。

## 第一版实现顺序

1. 为显式录制增加桌面端开始、状态、停止入口，复用 `record-human-history.ts` 的本地事件与语义步骤抽取；将“录制技能”与持续运行的 Computer History 开关分开。
2. 新增单次演示草稿接口。沿用 Memory Skill 的 ID、namespace、审阅和来源追踪，但不要调用要求 2–12 个被动来源的 `evidence/skills/suggest`。把现有 `createWorkflow` 的 Markdown 改为草稿素材，避免第二套可执行 Skill 身份。
3. 新增草稿编辑、试跑、启用；启用时输出给 `SkillsLoader` 可发现的 `SKILL.md`，并检查名称冲突、工具依赖和版本。
4. 把 History 已有候选、手工创建、导入文件汇入“技能”页；保留“来源于历史/演示/文件/记忆结晶”的清晰标识。
5. 再接视频分析入口。先做短视频与可见桌面操作，按时间戳抽帧并提取语音；低置信步骤必须在草稿中标出。

第一版完成标准：一次明确的演示能产生可编辑草稿；用户试跑并启用后，在新会话用不同输入可被发现和执行；目标界面变化时能停下来重新定位；停止录制、关闭 History、删除来源各自有可核验的行为；History 未开启时演示学习仍可独立使用。
