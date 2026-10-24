import type { MemoryRow } from "../../types.js";
import { isRecord } from "../../utils/json.js";
import { stableHash } from "../../utils/id.js";
import { externalEvidenceSourceMatchesMemory } from "../external-evidence-source.js";
import { parse as parseYaml } from "yaml";
import { normalizeMemoryLanguage } from "../../config/index.js";

/** History is observed procedural knowledge; activation never authorizes replay. */
export const HISTORY_SKILL_INITIAL_ETA = 0.3;

/** Future locales use the already localized model summary without a translation call. */
export function historySkillObservationSummary(language: string | undefined, generatedSummary: string): string {
  const locale = normalizeMemoryLanguage(language);
  if (locale === "zh-CN") return "根据观察整理的操作方法；执行结果尚未验证。";
  if (!locale || locale === "en-US") return "Procedure learned from observed actions; execution outcome is not verified.";
  return generatedSummary;
}

export function isSubstantiveHistoryAction(text: string): boolean {
  const action = text.trim();
  return action.length >= 4 && ![
    /^Activate .* and verify its main content window is visible\.?$/iu,
    /^Confirm the front browser page .* is now /iu,
    /move .*only far enough to reveal the next recorded semantic target/iu,
    /element was activated but its semantic label was unavailable/iu,
    /^Text was entered .* intentionally redacted/iu,
    /^(?:Switch (?:to|between|windows)|(?:Open|Browse|Visit|View) (?:the )?(?:page|window|app|application|browser|website|tab)(?:\b|$))/iu,
    /^(?:切换(?:到|应用|窗口|页面)|(?:打开|浏览|查看)(?:应用|窗口|页面|网页|浏览器|标签页))(?:[。.!！]?|\s.*)$/u,
    /^(?:window|accessibility)[._ ](?:changed|snapshot)(?:\b|$)/iu
  ].some((pattern) => pattern.test(action));
}

export function isHistoryEvidenceSkill(memory: MemoryRow): boolean {
  return memory.memoryLayer === "Skill" && externalEvidenceSourceMatchesMemory(memory, "computer_history");
}

export function externalSkillGeneration(memory: MemoryRow): string | undefined {
  const origin = memory.properties.internal_info.external_evidence_candidate;
  return isRecord(origin) && typeof origin.content_generation === "string" ? origin.content_generation : undefined;
}

export function externalSkillJobPayload(memory: MemoryRow): Record<string, unknown> {
  return { contentHash: memory.contentHash, ...(externalSkillGeneration(memory)
    ? { externalSkillGeneration: externalSkillGeneration(memory) } : {}) };
}

export function historySkillDraftIsUnmodified(memory: MemoryRow): boolean {
  const internal = memory.properties.internal_info;
  const origin = internal.external_evidence_candidate;
  if (!isHistoryEvidenceSkill(memory) || !isRecord(origin) || origin.human_modified === true
    || origin.edited_at || internal.generated_by_memory_base !== true || internal.read_only === true) return false;
  if (typeof origin.generated_content_hash === "string") return origin.generated_content_hash === stableHash(memory.memoryValue);
  // Pre-marker candidates never had vector jobs. Any later mutation makes
  // their original authorship uncertain, so leave them available for editing.
  return memory.version === 1 && memory.createdAt === memory.updatedAt && internal.source === "external-evidence";
}

export function historySkillProcedure(memory: MemoryRow): Record<string, unknown> | undefined {
  const skill = memory.properties.internal_info.skill;
  return isRecord(skill) && isRecord(skill.procedure_json) ? skill.procedure_json : undefined;
}

export function historySkillSteps(memory: MemoryRow): string[] {
  const procedure = historySkillProcedure(memory);
  return Array.isArray(procedure?.steps) ? procedure.steps.flatMap((step) =>
    isRecord(step) && typeof step.body === "string" && step.body.trim() ? [step.body.trim()] : []) : [];
}

/** Read display fields from both ordinary Markdown and SKILL.md frontmatter. */
export function editedSkillDisplay(body: string): { title?: string; summary?: string; trigger?: string } {
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  let frontmatter: Record<string, unknown> = {};
  if (match) { try { const parsed: unknown = parseYaml(match[1]!); if (isRecord(parsed)) frontmatter = parsed; } catch { /* Keep an editable Markdown body even with invalid YAML. */ } }
  const field = (name: string): string | undefined => {
    const raw = frontmatter[name];
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };
  const prose = match ? body.slice(match[0].length).trim() : body;
  const title = field("name") || prose.match(/^#\s+(.+)$/mu)?.[1]?.trim();
  const summary = field("description") || prose.split(/\r?\n/u).map((line) => line.trim())
    .find((line) => line && !/^#|^\*\*|^[-*]\s|^\d+[.)]\s/u.test(line));
  const trigger = prose.match(/(?:^\*\*When to use\*\*|^#{1,4}\s+(?:When to use|适用场景|何时使用))\s*\r?\n([^\n]+)/imu)?.[1]?.trim();
  return { title: title?.slice(0, 160), summary: summary?.slice(0, 1_200), trigger: trigger?.slice(0, 500) };
}
