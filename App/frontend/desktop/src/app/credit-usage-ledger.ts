/** Local display fixtures and ledger projections. Never mutate balances or create charges. */
import { agentMockInput, memoryMockInput } from "./credit-usage-mock-inputs.js";
import { formatDayKey } from "./credits-preview-quota.js";

export type UsageTab = "agent" | "memory";
export type UsageOperation = "reply" | "title" | "summary" | "embedding" | "evolution" | "search";
export type UsageCall = {
  id: string; requestId: string; source: UsageTab; operation: UsageOperation;
  prompt: string; promptEn: string; modelInput: string;
  model: string; at: string; credits: number; inputTokens: number; outputTokens: number;
  status: "settled" | "processing" | "interrupted";
};
export type UsageRow = {
  id: string; source: UsageTab; date: string; at: string; calls: UsageCall[];
  credits: number; models: string[]; operation: UsageOperation;
  status: UsageCall["status"];
};
export const usageTotal = (calls: UsageCall[]) => calls.reduce((sum, c) => sum + Math.round(c.credits * 100), 0) / 100;

export function usageRange(start: string, end: string): { start: Date; end: Date } | null {
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [y,m,d] = value.split("-").map(Number);
    const date = new Date(y!,m!-1,d!);
    return formatDayKey(date) === value ? date : null;
  };
  const from = parse(start), through = parse(end);
  if (!from || !through || from > through) return null;
  through.setDate(through.getDate()+1);
  return { start: from, end: through }; // exclusive upper bound, including DST calendar days
}

export function filterUsageCalls(calls: UsageCall[], source: UsageTab, range: { start: Date; end: Date }, now: Date) {
  const seen = new Set<string>();
  return calls.filter(c => {
    const at = Date.parse(c.at);
    if (c.status === "processing" || c.source !== source || at < range.start.getTime() || at >= range.end.getTime() || at > now.getTime() || seen.has(c.id)) return false;
    seen.add(c.id); return true;
  }).sort((a,b) => Date.parse(b.at)-Date.parse(a.at));
}

export function groupUsageCalls(calls: UsageCall[]): UsageRow[] {
  const groups = new Map<string, UsageCall[]>();
  for (const c of calls) {
    const day = formatDayKey(new Date(c.at));
    const key = c.source === "agent" ? `agent:${c.id}` : `memory:${day}:${c.operation}:${c.model}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups].map(([id, items]): UsageRow => {
    const ordered = [...items].sort((a,b) => Date.parse(b.at)-Date.parse(a.at));
    const first = ordered[0]!;
    return { id, source:first.source, date:formatDayKey(new Date(first.at)), at:first.at, calls:ordered,
      credits:usageTotal(ordered), models:[...new Set(ordered.map(c => c.model))], operation:first.operation,
      status:ordered.some(c => c.status === "processing") ? "processing" : ordered.some(c => c.status === "interrupted") ? "interrupted" : "settled" };
  }).sort((a,b) => Date.parse(b.at)-Date.parse(a.at) || a.id.localeCompare(b.id));
}

const PROMPTS = [
  ["帮我整理这份会议记录\n\n请按以下结构整理：\n1. 本次讨论的背景与目标\n2. 已经达成一致的结论\n3. 仍有分歧、需要继续确认的问题\n4. 后续待办、负责人和时间\n\n保留讨论中的具体数字与约束，不要把尚未确认的想法写成结论。\n如果材料里没有负责人或截止时间，请直接标注未明确。", "Organize these meeting notes\n\nInclude the context, agreed decisions, open questions, and action items.\nPreserve concrete numbers and constraints. Do not present proposals as decisions.\nMark missing owners or deadlines as unspecified."],
  ["看下这版积分方案有什么问题", "Review this credit plan"],
  ["对比两个方案，整理成表格", "Compare the two proposals in a table"],
  ["根据讨论内容补充产品文档", "Update the product document from our discussion"],
  ["查找上周的项目决策", "Find last week's project decisions"],
  ["把录音转写整理成待办", "Turn the transcript into action items"]
] as const;

export function createUsageMock(anchor: Date): UsageCall[] {
  const calls: UsageCall[] = [];
  for (let d=0; d<18; d++) {
    // Anchor-relative, persisted dates: refreshing does not invent new requests or charges.
    const day = new Date(anchor); day.setDate(day.getDate()-d);
    const at = (minutes: number) => new Date(day.getTime()-minutes*60000).toISOString();
    for (let r=0; r<3; r++) {
      const prompt = PROMPTS[(d+r)%PROMPTS.length]!;
      const id = `sample-agent-${d}-${r}`;
      const count = r===0 ? 3 : 1;
      for (let i=0; i<count; i++) calls.push({
        id:`${id}-${i}`, requestId:id, source:"agent", operation:"reply", prompt:prompt[0], promptEn:prompt[1],
        modelInput:agentMockInput(prompt[0]), model:i===1 ? "Qwen3-32B" : "DeepSeek-V3",
        at:at(r*35+i*2), credits:Math.round((3.2+r*4+d*.7+i*1.15)*100)/100,
        inputTokens:2400+d*130+r*250+i*500, outputTokens:480+i*110,
        status:d===2 && r===2 ? "interrupted" : "settled"
      });
    }
    calls.push({ id:`sample-title-${d}`, requestId:`sample-title-${d}`, source:"agent", operation:"title",
      prompt:PROMPTS[d%PROMPTS.length]![0], promptEn:PROMPTS[d%PROMPTS.length]![1],
      modelInput:agentMockInput(PROMPTS[d%PROMPTS.length]![0], true), model:"Qwen3-32B", at:at(4), credits:0, inputTokens:260,outputTokens:18,status:"settled" });
    for (const operation of ["embedding","summary","evolution","search"] as const) {
      const count = operation==="embedding" ? 24 : operation==="summary" ? 12 : 3;
      for (let i=0;i<count;i++) calls.push({
        id:`sample-memory-${d}-${operation}-${i}`, requestId:`sample-memory-task-${d}-${operation}-${i}`,
        source:"memory", operation, prompt:"",promptEn:"",
        modelInput:memoryMockInput(operation,i,at(6+i*3)),
        model:operation==="embedding" ? "text-embedding-v3" : d===0 && operation==="summary" && i>=4 && i<8 ? "DeepSeek-V3" : "Qwen3-32B", at:at(6+i*3),
        credits:Math.round((operation==="embedding" ? .15+i*.03 : .6+i*.12)*100)/100,
        inputTokens:800+i*80,outputTokens:operation==="embedding" ? 0 : 120+i*10,status:"settled"
      });
    }
  }
  return calls;
}

/** One actual request per export row; safe quoting and spreadsheet formula neutralization. */
export function usageCsv(headers: string[], rows: (string | number)[][]): string {
  const escape = (value: string | number) => {
    let text = String(value);
    if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"','""')}"`;
  };
  return '\uFEFF'+[headers,...rows].map(row => row.map(escape).join(",")).join("\r\n");
}
