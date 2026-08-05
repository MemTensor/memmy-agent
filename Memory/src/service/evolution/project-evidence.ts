import type { ToolCallPayload } from "../../types.js";
import { stableHash, stableStringify } from "../../utils/id.js";

export type ProjectEvidenceKind = "fact" | "decision" | "procedure" | "outcome" | "noise";

export interface ProjectEvidence {
  kind: ProjectEvidenceKind;
  eligible: boolean;
  confidence: number;
  subject: string;
  claim: string;
  sourceText: string;
  stableKey: string;
  reasons: string[];
}

export interface ProjectEvidenceInput {
  id: string;
  userText?: string;
  agentText?: string;
  reflection?: string | null;
  toolCalls?: ToolCallPayload[];
  tags?: string[];
  value?: number;
}

const INJECTED_CONTEXT_RE = /<\/?(?:codex_internal_context|memmy_memory_context|objective|current_user_request)\b/i;
const CHILD_AGENT_RE = /(?:focused child agent|spawned by a parent agent|child-agent instruction|subagent instruction)/i;
const META_NOISE_RE = /^(?:continue|keep working|go on|看看|继续|再看看|有了吗|什么情况|下一步(?:怎么|是什么)?工作)\s*[?？!！。.]?$/i;
const QUESTION_RE = /[?？]\s*$/;
const RESULT_RE = /(?:成功|失败|通过|报错|error|failed|passed|fixed|修复|完成|created|updated|deleted|exit code|status\s*[:=])/i;
const PROCEDURE_RE = /(?:run|执行|使用|调用|install|测试|部署|重启|patch|修改|命令|procedure|步骤|步骤|must|should|不要|必须)/i;

export function extractProjectEvidence(input: ProjectEvidenceInput): ProjectEvidence {
  const user = normalize(input.userText);
  const agent = normalize(input.agentText);
  const reflection = normalize(input.reflection);
  const tools = input.toolCalls ?? [];
  const reasons: string[] = [];
  const sourceText = [user && `USER: ${user}`, agent && `AGENT: ${agent}`, reflection && `REFLECTION: ${reflection}`]
    .filter(Boolean)
    .join("\n");
  let kind: ProjectEvidenceKind = "fact";
  if (!sourceText || INJECTED_CONTEXT_RE.test(sourceText)) {
    reasons.push("injected_or_empty");
  } else if (CHILD_AGENT_RE.test(sourceText)) {
    reasons.push("agent_instruction_noise");
  } else if (META_NOISE_RE.test(user) || (QUESTION_RE.test(user) && !agent && tools.length === 0 && !reflection)) {
    reasons.push("question_or_meta_noise");
  }
  if (tools.length > 0 || PROCEDURE_RE.test(`${user}\n${agent}`)) kind = "procedure";
  if (RESULT_RE.test(`${agent}\n${reflection}`) || tools.some((tool) => Boolean(tool.output || tool.error))) kind = "outcome";
  if (/(?:we will|we decided|adopt|use|采用|决定|约定|规范|架构事实)/i.test(`${user}\n${agent}`)) kind = "decision";
  if (reasons.length > 0) kind = "noise";
  const confidence = kind === "noise" ? 0 : Math.min(1, 0.45 + (agent.length > 40 ? 0.2 : 0) + (tools.length > 0 ? 0.2 : 0) + (reflection ? 0.15 : 0));
  const claim = normalize(agent || user);
  const subject = normalize(user).slice(0, 160);
  const stableKey = `evidence:${stableHash(stableStringify({ kind, subject, claim }))}`;
  return { kind, eligible: kind !== "noise" && confidence >= 0.6, confidence, subject, claim, sourceText, stableKey, reasons };
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
