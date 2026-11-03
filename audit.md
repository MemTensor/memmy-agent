# Skill 结晶验证与模型调用错误可观测性审计

## 1. 文档目的

本文记录对以下用户反馈的代码级核查结果，并给出与当前仓库实现相匹配的修复建议：

- `skill.crystallize` 验证失败率高，可能由跨语言 `resonance`、工具白名单污染和重复触发共同造成。

此外，核查模型调用链路时发现账号网关的业务错误会被 Memory 吞掉（R1），一并记录。

本文只把经过当前代码调用链核对**并实际复现**的问题列为“已确认”。线上环境（用户实际运行的桌面 App + 账号模型网关）中的调用占比、失败次数和失败率属于运行数据，无法仅凭仓库源码验证。

术语说明：

- **线上环境**：用户真实使用的 App 运行时，以及 Memory 通过账号模型访问的 `memmy-backend` 网关（`/api/agentexternal/` → `AgentExternalChatController`）。
- **网关**：`/Users/jiang/MyProject/memmy-backend`，Java/Spring 实现，负责鉴权、额度、路由并把请求透传到下游模型服务。

## 2. 核查基线与方法

- 核查日期：2026-11-02
- 客户端仓库：`memmy-agent`，分支 `main`，提交 `5161848a`，根包 `memmy-agent@1.2.4`，`@memmy/memory@2.1.7`
- 网关仓库：`memmy-backend`，提交 `5808fa58`

核查方法：

1. 阅读 Skill 结晶 Prompt、语言选择、工具提取、验证器、任务调度、去重、冷却、日志和前端时间线代码。
2. 阅读 `retrieval.filter`、各 LLM provider、HTTP 请求与错误解析代码，以及网关 `AgentExternalChatController`、`ExternalChatServiceImpl`、`GlobalExceptionHandler`。
3. 单元级最小复现：用 `tsx` 直接调用 `verifySkillDraft()`、`extractToolNamesFromTraces()`。
4. 端到端复现：在 `Memory/tests/` 下临时编写 vitest 用例，用真实 `MemoryDb`、worker、`RuntimeRepository.enqueueJob()`（带真实 dedupe key）和本地 HTTP 服务模拟网关响应，跑完后已删除，未修改任何业务代码。
5. 运行相关现有测试，3 个文件共 135 项全部通过：

   ```text
   Memory/tests/algorithm/plugin-algorithms.test.ts
   Memory/tests/service/evolution/skill-lifecycle.test.ts
   Memory/tests/model-http.test.ts
   ```

   现有测试通过不代表问题不存在：它们没有覆盖“中文证据 + 英文草稿”“JSON 字符串工具参数”“网关 HTTP 200 错误体”这几种组合。

## 3. 结论摘要

| 编号 | 问题                                          | 当前结论                                                                                                     | 建议优先级 |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------- |
| S1   | 跨语言草稿导致 `resonance=0`                  | **已端到端复现**。宿主界面语言为 `en-US` 时，中文证据生成英文 Skill，验证必然以 `resonance=0` 失败           | P0         |
| S2   | JSON 字符串参数污染 `EVIDENCE_TOOLS`          | **已复现**，且比原描述更严重：紧凑 JSON 会把**整段工具参数**写进白名单和 Prompt                              | P1         |
| S3   | 结晶失败后重复调用、缺少有效退避              | **已端到端复现**。同一 policy 每次入队都通过去重、都调用 LLM；cooldown 默认关闭，开启后重启即失效             | P0         |
| S4   | 结晶失败不可观测                              | **已端到端复现**。change log 有 `policyId`，但 api_logs 中没有任何失败记录；`llm-failed` 等分支同样缺失     | P1         |
| S5   | 每次 reward 更新重跑所有合格策略              | 常规路径中不成立；按目标 L2 策略触发，但同一策略每次被更新都会重新结晶                                       | 说明项     |
| S6   | 旧 L2→Skill 路径与 trace-direct 路径同时运行  | **新增**。`directFromTrace=true` 并不会关闭旧路径，两条路径都会消耗 LLM                                       | P1         |
| R1   | 网关 HTTP 200 业务错误体被吞掉                | **新增，已复现**。网关除额度外的业务异常均以 HTTP 200 返回，Memory 只能报 `missing choices[0].message.content` | P1         |

如果“Skill 结晶占 LLM 调用约 68%、失败率约 92.6%”的线上数据准确，S1 与 S3 叠加正好能解释：使用英文界面但用中文对话的用户，每次 policy 更新都会触发一次必然失败的结晶调用，且没有任何抑制。

## 4. Skill 结晶问题

### 4.1 S1：跨语言 `resonance` 必然失败

#### 4.1.1 当前 Prompt 的语言选择

当前实现已不再无条件强制英文：

- `SKILL_CRYSTALLIZE_PROMPT` 接收 `OUTPUT_LANGUAGE`（`Memory/src/algorithm/plugin-algorithms.ts:1461-1515`）。
- `SkillPipeline.enhanceSkillDraft()` 从 policy 和证据文本收集语言样本（`Memory/src/service/evolution/skill-pipeline.ts:788-798`）。
- `algorithm.skill.outputLanguageMode` 默认 `follow_policy`（`Memory/src/config/index.ts:473-485`）。

但语言判定的优先级是**宿主界面语言优先，内容检测兜底**：

```ts
export function steeredPromptLanguage(language, samples) {
  return pinnedPromptLanguage(language) ?? detectPromptLanguage(samples);
}
```

位置：`Memory/src/algorithm/plugin-algorithms.ts:3766-3771`。桌面 App 会把界面语言作为 `config.language` 传给 Memory（`memmy-memory/discovery`），所以英文界面用户的 Skill 一定用英文生成，与对话内容是什么语言无关。

补充：L2 policy 归纳（`policy-induction.ts:534`）也用同一函数，因此这类用户的 policy 文本本身也是英文，而证据（原始对话）是中文。

#### 4.1.2 验证器只做字面重合

`verifySkillDraft()` 默认要求 `resonance >= 0.5`。`skillEvidenceResonance()` 的算法：

1. 从草稿的 summary、steps、invocation guide 提取 token。
2. 从每条证据的 user、agent、reflection、summary 提取 token。
3. ASCII 取至少 4 个字符的词；CJK 取连续双字滑窗。
4. 一条证据至少共享 2 个 token 才算命中。
5. `resonance` = 命中证据数 / 证据总数。

位置：`Memory/src/algorithm/plugin-algorithms.ts:4101-4143`、`5023-5073`。

这个算法只能判断字面重合，无法判断中文证据和英文草稿在语义上是否一致。

#### 4.1.3 复现结果

**单元级**：证据为 `请执行代码并检查输出结果`、`使用执行代码工具完成任务`，草稿为 `Run the code and inspect the output before completing the task.`：

```json
{ "ok": false, "coverage": 1, "resonance": 0, "unmappedTokens": [], "reason": "resonance=0.00<0.5" }
```

同样的证据，草稿换成中文 `执行代码并检查输出结果，完成任务` 时：`ok: true, resonance: 1`。

**端到端**：`config.language = "en-US"`，中文对话证据，经 worker 跑完整个 `skill_crystallization` job：

- 实际注入的语言指令：`All natural-language answers MUST be in English.`
- 每次结晶的 change log：`{"policyId":"policy_audit","verdict":{"coverage":1,"resonance":0,"reason":"resonance=0.00<0.5"}}`

#### 4.1.4 影响范围的修正

- “稳定为 0”只对纯自然语言任务成立。如果证据和草稿里都有代码、路径、命令等 ASCII 词（≥4 字符），跨语言时仍可能部分命中，所以编程类任务的失败率会低一些。
- 触发条件按影响面从大到小：
  1. 宿主界面语言固定为英文（或其他语言），而对话使用中文。**这是最主要的来源**。
  2. `outputLanguageMode` 显式设置为 `en` 或 `zh`，且与证据语言不一致。
  3. 未固定界面语言时，证据中英混杂、CJK 占比低于 20%，被判成英文。
  4. 模型没有遵守语言指令。
- trace-direct 路径（`skill-cluster-pipeline.ts:473-474`）使用同一套语言逻辑，它的 `stepsPointAtSuccess()`（`trace-direct-skill.ts:880-892`）同样基于 token 重合，只是阈值更宽（≥1 个 token）。所以跨语言问题在两条路径上都存在，只是 trace-direct 更不容易触发。

#### 4.1.5 修复建议

不建议删除 `resonance` gate 或把阈值降为 0，这会失去仅有的证据约束。

**第一步（低成本，建议先做）：把“生成语言”和“验证语言”解耦。**

输出语言是产品选择：英文界面用户可能确实希望拿到英文 Skill，不应为了让验证器通过而改变它。应该改的是验证器：

1. 计算 resonance 前先检测草稿主语言和证据主语言（复用 `detectDominantLanguage()`）。
2. 语言相同时，保持现有 token resonance 和 0.5 阈值不变。
3. 语言不同时，不把自然语言 token 重合作为硬失败条件，改为同时满足：
   - `coverage` 通过，且草稿至少声明了 1 个工具；或者草稿与证据共享至少 1 个跨语言稳定的 token（工具名、命令、文件名、路径、代码标识符，即现有 ASCII token 中带 `_`、`.`、`/` 或出现在工具集合中的那些）。
   - 其余情况记为 `cross_language_unverifiable`，而不是 `resonance=0.00<0.5`，以便单独统计。
4. 在 verdict 中新增 `draftLanguage`、`evidenceLanguage` 字段，写入 change log 和 api_logs（见 S4）。

**第二步（结构性）：用证据 ID 绑定替代文案字面匹配。**

仓库里已有先例：L3 抽象 Prompt（`l3.abstraction`）要求每条结论附带 `evidenceIds`，并且必须从输入中逐字复制（`plugin-algorithms.ts:1364-1458`）。Skill Prompt 可以照此要求：

```json
{
  "steps": [
    { "title": "...", "body": "...", "evidence_ids": ["trace_xxx"] }
  ]
}
```

验证器检查：

- `evidence_ids` 必须全部来自本次输入证据。
- 每个 step 至少有 1 个证据 ID（若 policy 本身无 step 级证据，允许整体至少引用一半证据）。
- 同语言时 token resonance 作为辅助指标；跨语言时只看证据绑定。
- `evidence_ids` 不进入最终 Skill 文案，只写入 `internal.skill.verification`。

旧 L2 路径和 trace-direct 路径应共用这套验证逻辑。

**不建议**的做法：把 Skill 输出语言强制跟随证据语言。这会改变英文界面用户已经看到的 Skill 语言，属于产品决策，需要单独确认。

#### 4.1.6 回归测试

- 中文证据 + 中文草稿：通过，`resonance` 与当前一致。
- 中文证据 + 合法英文草稿（含共同的工具名或命令）：通过。
- 中文证据 + 无关英文草稿（无共同工具/标识符）：失败，reason 为 `cross_language_unverifiable`。
- `evidence_ids` 含伪造 ID：失败。
- `config.language = "en-US"` + 中文证据的端到端用例：不再必然失败。
- 两条 Skill 路径对同一组输入给出一致的验证结论。

### 4.2 S2：`EVIDENCE_TOOLS` 被 JSON 字符串参数污染

#### 4.2.1 代码行为

`extractToolNamesFromTraces()` 除了读取 `call.name`，还会把字符串型 `call.input` 按空白切分后的第一个 token 加入工具集合：

```ts
if (typeof call.input === "string") {
  const first = call.input.trim().split(/\s+/)[0]?.toLowerCase();
  if (first && first.length >= 2) out.add(first);
}
```

位置：`Memory/src/algorithm/plugin-algorithms.ts:5008-5020`。

#### 4.2.2 线上会触发

`input` 是不是字符串取决于来源适配器。OpenAI 风格的 `function.arguments` 本身就是 JSON 字符串，以下适配器直接把它作为 `input`：

- `AgentSourceCore/src/hermes-source-turn.ts:217`：`input: fn?.arguments ?? entry.arguments ?? entry.input`
- `AgentSourceCore/src/deepseek-source-turn.ts:128`：`input: data.arguments`
- `Memory/src/service/turn/turn-normalization.ts:72`：`firstDefined(value.input, value.args, value.arguments, fn.arguments)`

#### 4.2.3 复现结果（修正原描述）

原文认为得到的是 `{"code":`，前提是 JSON 中有空格。实际上 `JSON.stringify` 和多数模型输出的 `arguments` 都是紧凑格式，没有空格，所以**整段参数都会被当成一个“工具名”**：

```text
输入: execute_code + '{"code":"print(1)"}'、execute_code + '{"code":"print(2)"}'
结果: ["execute_code", "{\"code\":\"print(1)\"}", "{\"code\":\"print(2)\"}"]
```

而 `shell` + `apk add openssl-dev` 的结果是 `["shell", "apk"]`，这是这段逻辑原本想要的能力。

#### 4.2.4 实际影响

1. **Prompt 污染与数据外泄风险**：`evidence_tools` 原样写进 `skill.crystallize` 的输入（`skill-pipeline.ts:878`）。工具参数（代码、文件内容、可能包含的密钥）会以“工具名”的形式进入 Prompt，不受 `traceCharCap` 截断。
2. **白名单扩大**：模型如果把其中某段字符串原样输出到 `tools`，验证器会视为合法。
3. **与 `coverage=0` 的关系**：污染只会扩大允许集合，不会直接导致 `coverage=0`。`coverage=0` 说明草稿中的工具不在提取出的集合里，要从模型输出或证据缺失另找原因。

#### 4.2.5 两条路径行为不一致

trace-direct 路径只用正式工具名：`packRawTurnEvidence()` 通过 `toolCallName()` 只读 `name/tool/toolName/tool_name`（`trace-direct-skill.ts:481-500`、`927-931`），`evidenceToolNames()` 只收集 `tool.name`（`trace-direct-skill.ts:502-510`）。比较时用 `normalizeFeature()`，而旧路径用 `toLowerCase()`。

#### 4.2.6 修复建议

新增一个共享工具名提取器，旧路径和 trace-direct 路径都用它：

1. 始终保留正式工具名。
2. 只有 shell 类工具（如 `shell`、`bash`、`terminal`、`exec_command`、`run_command`、`execute_command`，以显式列表维护）才从参数推断命令。
3. 参数是合法 JSON 对象时，只从 `command` / `cmd` 字段取命令；没有这两个字段就不推断。
4. 推断出的命令必须匹配 `^[a-z0-9][a-z0-9._+-]{1,63}$`，拒绝以 `{`、`[`、引号开头或包含 `:`、`=` 的 token。
5. 比较时统一用同一个规范化函数。

```ts
const SHELL_LIKE_TOOLS = new Set(["shell", "bash", "terminal", "exec_command", "run_command", "execute_command"]);
const COMMAND_TOKEN = /^[a-z0-9][a-z0-9._+-]{1,63}$/;

function inferredCommandName(toolName: string, input: unknown): string | undefined {
  if (!SHELL_LIKE_TOOLS.has(toolName)) return undefined;
  let command: unknown = input;
  if (typeof input === "string") {
    const parsed = tryParseJsonObject(input.trim());
    if (parsed) command = parsed.command ?? parsed.cmd;
  } else if (isRecord(input)) {
    command = input.command ?? input.cmd;
  }
  if (typeof command !== "string") return undefined;
  const first = command.trim().split(/\s+/)[0]?.toLowerCase();
  return first && COMMAND_TOKEN.test(first) ? first : undefined;
}
```

不能直接删除命令推断，否则 `shell` + `apk add openssl-dev` 将无法再得到 `apk`。

#### 4.2.7 回归测试

- `execute_code` + `{"code":"..."}`（紧凑与带空格两种）只产生 `execute_code`。
- `skill_manage` + `{"operations":[...]}` 只产生 `skill_manage`。
- `shell` + `apk add openssl-dev` 产生 `shell`、`apk`。
- `shell` + `{"command":"apk add openssl-dev"}`（字符串和对象两种）产生 `shell`、`apk`。
- 非 shell 工具的自由文本参数不产生额外工具名。
- 两条 Skill 路径对同一 tool call 得到相同的工具集合。
- `skill.crystallize` 的 Prompt 输入中 `evidence_tools` 不包含任何参数内容。

### 4.3 S3：失败抑制和退避不完整

#### 4.3.1 cooldown 已接入但作用有限

`SkillPipeline` 会在 LLM 调用前检查 cooldown（`skill-pipeline.ts:257-280`、`610-628`），也有对应测试（`skill-lifecycle.test.ts:512-639`）。原反馈说“没有任何地方读取 `cooldownMs`”不符合当前代码。

限制：

1. 默认 `cooldownMs: 0`，即关闭（`config/index.ts:478`）。
2. 记录存在 `skillCrystallizationRuns` 内存 `Map` 里，进程重启后丢失。
3. key 只有 `policy.id`，不区分 policy 内容、证据、Prompt 或验证器是否变化。
4. 记录在 LLM 调用**之前**写入：开启后，证据真的更新了也会被延后。
5. 验证失败和 `enhanceSkillDraft()` 内部的 `llm-failed: ...`（`skill-pipeline.ts:947-949`）都走 `continue`，handler 正常返回，job 被标成 `succeeded`，`maxAttempts` 不起作用。

#### 4.3.2 job 去重挡不住重复调用

dedupe key 为 `skill_crystallization:<skillId|targetMemoryId|policyId>`（`job-handlers.ts:718-720`）。但仓储只把 `queued`、`leased`、`failed` 当作活动 job（`repositories.ts:3560-3572`），`succeeded` 的 job 不会阻止下一次同 key 入队。由于验证失败会让 job 变成 `succeeded`，下一次 policy 更新照样会进入 LLM。

#### 4.3.3 端到端复现结果

默认配置（`cooldownMs=0`）下，同一 policy 先后 3 次入队，每次都走真实 dedupe key：

| 轮次 | dedupe key                         | job 状态    | 累计 skill LLM 调用 |
| ---- | ---------------------------------- | ----------- | ------------------- |
| 1    | `skill_crystallization:policy_audit` | `succeeded` | 1                   |
| 2    | `skill_crystallization:policy_audit` | `succeeded` | 2                   |
| 3    | `skill_crystallization:policy_audit` | `succeeded` | 3                   |

三次的 verdict 完全相同（`resonance=0.00<0.5`），输入也没有变化。

`cooldownMs=3600000` 时：

| 场景                            | 本进程 skill LLM 调用 |
| ------------------------------- | --------------------- |
| 第 1 次入队                     | 1                     |
| 1 小时内第 2 次入队             | 1（被 cooldown 拦下） |
| 用同一个数据库新建服务（模拟重启）后入队 | 1（cooldown 丢失，再次调用） |

#### 4.3.4 触发范围（S5）

常规 reward 链路：

```text
reward.updated
  -> l2_association / l2_induction
  -> 更新目标 L2 policy（policy_stats_update）
  -> 只要 policy 仍为 active，就调度以该 policy 为 target 的 skill_crystallization
```

相关代码：`reward-pipeline.ts:298-330`、`policy-induction.ts:746-763`。`crystallizeSkill()` 有 L2 target 时只处理该 target，缺少有效 target 时才回退到列举最多 1000 个 activated L2 policy（`skill-pipeline.ts:196-202`）。

所以“每个 episode 重跑全部合格策略”不是常规路径。但只要某个 active policy 被关联到新 trace，就会触发一次结晶；对已有 Skill 的 policy，这意味着一次 rebuild LLM 调用，**即便成功路径也没有“输入未变化则跳过”的判断**。

#### 4.3.5 修复建议

**持久化尝试账本**，不需要新建表：仓库已有 `runtime_kv` 表和 `RuntimeRepository.getKv()/setKv()`（`repositories.ts:1873-1890`）。key 建议为 `skill_crystallization_attempt:<policyId>`。

注意不要用 `memory_change_log` 充当账本：它有 10000 行的保留上限，会被裁剪（`repositories.ts:98-103`）。

输入指纹至少包含：

```text
skillPolicyContentHash(policy)                 // 仓库已有
+ 排序后的证据 trace ID 及其 updated_at
+ 目标 skill ID（rebuild 时）
+ prompt.id + prompt.version
+ verifier 版本号（新增常量）
+ 输出语言
```

账本内容：

```ts
interface SkillCrystallizationAttempt {
  policyId: string;
  inputFingerprint: string;
  status: "verified" | "rejected" | "transient_failed";
  failureKind?: "verification" | "llm_invalid" | "llm_refusal" | "llm_transport";
  failureReason?: string;
  failureCount: number;
  lastAttemptAt: string;
  nextEligibleAt?: string;
}
```

策略：

- 调用 LLM 前计算指纹。若与账本相同：
  - `verified`：直接跳过（成功路径的重复 rebuild 也一并省掉）。
  - `rejected`：在 `nextEligibleAt` 之前跳过；退避 `1h → 6h → 24h`；连续 3 次后在指纹变化前不再自动重试。
  - `transient_failed`：短退避（如 5 分钟、15 分钟、1 小时）。
- 指纹变化（policy、证据、Prompt、验证器或语言变化）时立即允许重试，并把 `failureCount` 归零。
- `enhanceSkillDraft()` 区分失败类型：网络超时、限流、5xx 记为 `llm_transport`；输出不合法、拒答、验证失败记为确定性失败。
- 确定性失败不交给 worker 重试；瞬时失败也由账本退避控制，不抛给 worker，以免影响无 target 时的批量回退循环。

**紧急止损**：先把默认 `cooldownMs` 改为 1 小时，可以在一个进程生命周期内把同一 policy 的重复调用压到每小时最多一次。它不能替代账本：重启后失效，而且会延后真正有新证据的 rebuild。

#### 4.3.6 回归测试

- 相同指纹连续入队 3 次，只调用 1 次 LLM。
- 用同一数据库重建服务后，退避仍然有效。
- policy 内容、证据集合、Prompt 版本、验证器版本、输出语言任一变化后立即重试。
- 确定性失败 3 次后停止自动重试，直到指纹变化。
- 瞬时错误按短退避重试。
- 已 `verified` 的相同指纹不再触发 rebuild。

### 4.4 S4：结晶失败不可观测

#### 4.4.1 已具备的字段

验证失败时，`logEvolutionDecision()` 收到 `policyId` 和完整 verdict，`memory_change_log` 中的 `skill_verification_failed` 记录也包含 `policyId` 和 verdict（`skill-pipeline.ts:313-329`）。“失败事件在所有地方都没有 `policyId`”不符合当前代码。

#### 4.4.2 缺口与复现

只有成功分支调用 `recordApiLog()`（`skill-pipeline.ts:426-440`）。端到端复现中 3 次验证失败后：

```text
api_logs WHERE tool_name IN ('skill_generate','skill_evolve')  →  0 行
```

原文只提到验证失败，实际上以下分支同样已经花了一次 LLM 调用，也都没有 api log：

- `enhanceSkillDraft()` 返回的 `llm-failed: ...`（传输错误或输出缺字段，`skill-pipeline.ts:947-949`、`1449-1458`）
- `llm-refusal`（`skill-pipeline.ts:911-913`）
- `verification_failed`（`skill-pipeline.ts:313-329`）

另外，桌面端 Skill 时间线只认带 `skillId` 的 api log（`App/frontend/desktop/src/pages/memory/skills-sub-page.tsx:807-842`）。首次结晶失败时还没有 Skill，所以即使补了日志，也不会出现在任何 Skill 的时间线上。

#### 4.4.3 修复建议

在所有“已调用 LLM 但未产出 Skill”的分支统一写 api log：

```ts
recordApiLog(
  this.deps.repos.runtime,
  existingSkill ? "skill_evolve" : "skill_generate",
  {
    phase: "failed",
    policyId: policy.id,
    ...(existingSkill ? { skillId: existingSkill.id } : {}),
  },
  {
    kind: "skill.crystallize.failed",
    failureKind,                 // verification | llm_invalid | llm_refusal | llm_transport
    reason,
    policyId: policy.id,
    ...(existingSkill ? { skillId: existingSkill.id } : {}),
    ...(verdict ? { coverage: verdict.coverage, resonance: verdict.resonance, unmappedTokens: verdict.unmappedTokens } : {}),
    outputLanguage,
    promptVersion: prompt.version,
    inputFingerprint,
  },
  elapsedApiLogMs(startedAt),
  false,
  nowIso(),
);
```

冷却/退避命中时不调用 LLM，不写 api log，只写 change log（已有），避免 api_logs 被跳过记录刷满。

界面侧：

- Memory 概览或演化视图增加按 `policyId` 聚合的失败列表，用于展示首次结晶失败。
- Skill 详情只在存在真实 `skillId` 时展示 rebuild 失败。
- 不要用 policy ID 或占位符冒充 `skillId`。
- `toolName` 沿用 `skill_generate` / `skill_evolve`。需同步检查概览里按 `toolName` 统计“生成次数”的地方，按 `success` 区分，避免把失败计入生成数。

#### 4.4.4 回归测试

- 首次结晶验证失败：api log 含 `policyId`、`success=false`，不含 `skillId`。
- rebuild 验证失败：同时含 `policyId` 和真实 `skillId`。
- `llm-failed`、`llm-refusal` 分支同样产生失败 api log。
- cooldown/退避跳过时不产生 api log。
- Skill 时间线不会把其他 policy 的失败关联到当前 Skill。

### 4.5 S6：两条 Skill 生成路径同时运行

`algorithm.skill.directFromTrace` 默认 `true`，但它只控制是否调度 `skill_cluster_assign`（`reward-pipeline.ts:332-347`）。`policy-induction.ts:746-763` 在 policy 更新后调度 `skill_crystallization` 时**不检查这个开关**，所以旧 L2→Skill 路径与 trace-direct 路径会同时消耗 LLM。

建议：

1. 确认产品预期：trace-direct 上线后，旧路径是否仍需要为每个 active policy 生成或 rebuild Skill。
2. 如果旧路径只作为兜底，在 `directFromTrace=true` 时只对没有 trace-direct Skill 覆盖的 policy 调度结晶，或者直接关闭旧路径的自动调度。
3. 线上分别统计 `skill.crystallize` / `skill.rebuild` 与 trace-direct 相关 operation 的调用量，确认用户反馈中的 68% 具体来自哪条路径。

## 5. 模型调用错误信息丢失（账号网关）

### 5.1 调用链

```text
RetrievalService.filterRecallHits()
  -> filterLlm.completeJson()              // summary LLM，失败时回退 evolution LLM
  -> HttpLlmClient.completeResult()
  -> completeOpenAiCompatible() 等各 provider
  -> postJsonWithRetry()                   // 所有 provider 都通过全局 fetch()
  -> 账号模式：memmy-backend /api/agentexternal/ → 下游模型
```

相关代码：

- `Memory/src/service/retrieval/retrieval-service.ts:2400-2544`
- `Memory/src/model/llm.ts:133-188`、`339-422`
- `Memory/src/model/http.ts:21-99`、`139-200`
- `memmy-backend/.../controller/AgentExternalChatController.java:145-333`
- `memmy-backend/.../service/impl/ExternalChatServiceImpl.java:315-354`
- `memmy-backend/.../model/exception/GlobalExceptionHandler.java:43-246`

`retrieval.filter` 外层 catch 会退回到 candidate cap（`retrieval-service.ts:2532-2543`），召回本身不会整体失败。影响在于日志和概览看不到真正的失败原因。

### 5.2 R1：网关 HTTP 200 业务错误体被吞掉（新增）

#### 5.2.1 网关行为

网关透传下游响应时，保留下游的状态码和响应体（`ExternalChatServiceImpl.java:336-348`）；网络异常时返回 `500 {"error":"upstream request failed"}`（`:350-353`）。这两种情况 Memory 都能正确识别。

但网关**自身**抛出的 `BusinessException`、`RuntimeException` 等由 `GlobalExceptionHandler` 处理，统一返回 **HTTP 200**：

```java
return ResponseEntity.ok(resultUtils.error(code, message));   // GlobalExceptionHandler.java:245
// 响应体：{"code": <int>, "data": null, "message": "<翻译后的消息>"}
```

`agentexternal` 链路上会走到这里的情况包括：

- 未登录或登录失效：`/agentExternal/**` 在 `SecurityConfig` 中被放行、不经过 Spring Security 拦截，鉴权由 `AgentPrincipalServiceImpl.requireCurrentUser()` 完成，失败时抛 `NOT_LOGIN_ERROR`，因此也是 HTTP 200
- 不支持的模型：`unsupported model: xxx`（`AgentExternalChatController.java:1437`）
- 额度服务抛出的、错误码不是 40309 的其他 `BusinessException`（`:540-542`）
- 任意 `RuntimeException`：`message` 是异常消息，可能为空
- 任意其他 `Exception`：`message` 固定为空字符串（`GlobalExceptionHandler.java:233`）

只有额度不足（40309）会被 Memory 专门识别（`http.ts:175`、`192-193`）。

#### 5.2.2 复现结果

用本地 HTTP 服务模拟网关，Memory 以 `openai_compatible` 调用 `/api/agentexternal/v1`：

| 网关响应                                                        | Memory 最终错误                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `200 {"code":40100,"data":null,"message":"未登录或登录已过期"}` | `Error: openai_compatible response missing choices[0].message.content` |
| `200 {"code":50000,"data":null,"message":""}`                   | `Error: openai_compatible response missing choices[0].message.content` |
| `500 {"error":"upstream request failed"}`                       | `ModelHttpError: openai_compatible HTTP 500: upstream request failed`  |

前两种情况下真正的原因完全丢失，也无法和“模型返回空内容”区分开。这是账号模式下 `retrieval.filter`（以及所有 Memory LLM 调用）**可以确认会发生**的错误信息丢失。

#### 5.2.3 修复建议

**网关侧（根本修复，`memmy-backend`）**：`/agentExternal/**` 是 OpenAI 兼容接口，错误应按 OpenAI 约定返回：

1. 为 `AgentExternalChatController` 增加专用的 `@ExceptionHandler`（或在 `GlobalExceptionHandler` 中按请求路径区分），返回非 2xx 状态码和 OpenAI 风格的错误体，与该 Controller 已有的额度错误格式（`AgentExternalChatController.java:581-594`）保持一致：

   ```json
   { "error": { "message": "未登录或登录已过期", "type": "authentication_error", "code": "40100" } }
   ```

2. 建议的状态码映射：未登录 → 401；参数错误或不支持的模型 → 400；额度不足 → 429（客户端已兼容 40309，迁移时需保留 `code`）；其他 → 500。
3. 通用 `Exception` 分支不要返回空 `message`，至少返回稳定的错误类型和 traceId，便于对照网关日志。

**Memory 侧（防御，兼容旧网关和第三方服务）**：

1. 在 `completeOpenAiCompatible()` 等发现缺少 `choices`/`content` 时，检查响应体是否是 `{code, message}` 错误体。若是，抛出 `ModelHttpError`，消息中包含 `code` 和 `message`，`isBusinessError` 置为 true。
2. 判定条件要收紧，避免把正常响应误判为错误：只有 HTTP 2xx、**不含** `choices`/`output`/`candidates`/`content`/`text` 等成功字段、且含数值或字符串 `code`（非 0/200）时才视为错误体。不要只因为响应里有 `message` 字段就判错。
3. `message` 为空时，退回为 `memmy gateway error code=<code>`，至少保留错误码。

### 5.3 回归测试

- 网关 `200 {"code":40100,"data":null,"message":"..."}`：错误消息包含 `40100` 和原始 message。
- 网关 `200 {"code":50000,"message":""}`：错误消息至少包含 `code=50000`。
- 正常的 OpenAI 成功响应（包括带有 `message` 字段的变体）不会被误判为错误。
- 网关侧：未登录、不支持的模型、运行时异常分别返回 401/400/500 + OpenAI 错误体。
- `retrieval.filter` 在上述各种失败下仍执行 candidate cap fallback。

## 6. 推荐实施顺序

### 第一批：止损与可观测性（低风险）

1. 默认 `skill.cooldownMs` 调整为 1 小时（S3 临时安全阀）。
2. 修复工具名提取，两条 Skill 路径共用一个提取器（S2）。
3. 所有已调用 LLM 但未产出 Skill 的分支补写 api log（S4）。
4. Memory 侧识别网关 HTTP 200 错误体；网关 `agentexternal` 返回 OpenAI 风格错误与正确状态码（R1）。

### 第二批：结构性修复

1. 基于 `runtime_kv` 的持久化结晶尝试账本，覆盖失败抑制和“输入未变则跳过 rebuild”（S3）。
2. 区分瞬时 LLM 错误和确定性失败，使用不同的退避（S3）。
3. 验证器支持跨语言：先做语言检测与跨语言判定，再引入 `evidence_ids` 绑定（S1）。
4. 明确旧 L2→Skill 路径在 `directFromTrace=true` 时的定位（S6）。

### 第三批：线上验证

上线后至少监控：

- `skill.crystallize` / `skill.rebuild` 与 trace-direct 各自的调用数和成功率。
- 按 `failureKind`、`reason` 聚合的失败数。
- `draftLanguage` 与 `evidenceLanguage` 不一致的比例，以及 `cross_language_unverifiable` 数量。
- 相同指纹的尝试次数，以及账本/冷却命中次数。
- `retrieval.filter` fallback 次数，以及按错误码、错误类型聚合的分布。
- 是否仍出现 `missing choices[0].message.content`。

## 7. 不建议采用的修复方式

- 只把 `minResonance` 降为 0：会移除证据约束，而语言问题仍在。
- 为了让验证通过而强制 Skill 输出语言跟随证据：改变了英文界面用户可见的 Skill 语言，属于产品决策，需单独确认。
- 只依赖内存 cooldown：重启即失效，而且无法判断输入是否变化。
- 用 `memory_change_log` 充当结晶账本：该表有 10000 行保留上限，会被裁剪。
- 完全删除字符串命令推断：会破坏 shell 工具的命令级证据。
- 只要响应里有 `message` 字段就判为错误：会误伤正常响应。
- 为首次结晶失败伪造 `skillId`：应使用真实 `policyId`，只有 rebuild 才关联已有 Skill。
- 把确定性的验证失败交给 worker 立即重试：同样的输入只会重复消耗 LLM。

## 8. 最终判断

需要修复。“减少无效 LLM 调用”和“恢复真实错误可观测性”应作为两个独立目标处理。

已经端到端确认的核心问题：

1. 宿主界面语言固定时，跨语言 Skill 在验证阶段必然失败（S1）。
2. 失败后没有持久化、感知输入变化的抑制机制，同一输入会反复调用 LLM（S3），而且两条 Skill 路径同时运行（S6）。
3. 失败没有写入 api_logs，界面上看不到（S4）。
4. 账号网关的业务错误以 HTTP 200 返回，Memory 会把真实原因变成 `missing choices[0].message.content`（R1）。

完成上述修复后，才能判断剩余的 coverage/resonance 失败究竟来自模型质量、Prompt 约束还是证据本身不足。
