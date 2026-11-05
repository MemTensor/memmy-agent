/**
 * 协助会话里的完整执行过程：执行方 Agent 的说明文字与每一步工具调用，按发生顺序排列。
 *
 * <p>双方在项目看板里打开一次协助时看到的就是它。这里统一上限：单段文字（说明、命令或参数、输出）16KB，
 * 单次请求合计 1MB，提示词与发起方收到的内容各 64KB。云端（memmy-backend 的 {@code CollabLimits}）用同一组数字兜底，
 * 本机先裁好再上传，避免每次推送都被云端截断。</p>
 */

export type AssistTranscriptItem =
  | { kind: "text"; text: string; truncated?: boolean }
  | { kind: "tool"; name: string; input: string; output: string; status: "running" | "done" | "failed"; truncated?: boolean }
  | { kind: "omitted"; count: number };

/** 单段文字的上限：说明、命令或参数、输出各自不超过 16KB。 */
export const ASSIST_TRANSCRIPT_PART_BYTES = 16 * 1024;
/** 单次请求的执行过程合计不超过 1MB。 */
export const ASSIST_TRANSCRIPT_BYTES = 1024 * 1024;
/** 执行方 Agent 收到的提示词与隐藏的格式要求：各自不超过 64KB。 */
export const ASSIST_PROMPT_BYTES = 64 * 1024;
/** 发起方收到的内容与发起方 Agent 的回复：各自不超过 64KB。 */
export const ASSIST_DELIVERY_BYTES = 64 * 1024;

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** 按 UTF-8 字节截断，保留换行，只在字符边界处截；截过的末尾注明「（已截断）」。 */
export function clipBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const suffix = "\n…（已截断）";
  const budget = Math.max(0, maxBytes - byteLength(suffix));
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = byteLength(char);
    if (bytes + size > budget) break;
    bytes += size;
    end += char.length;
  }
  return `${value.slice(0, end)}${suffix}`;
}

/** 一项的各段按 16KB 截断，截过的标上 {@code truncated}。 */
export function clipItem(item: AssistTranscriptItem): AssistTranscriptItem {
  if (item.kind === "omitted") return item;
  if (item.kind === "text") {
    const text = clipBytes(item.text, ASSIST_TRANSCRIPT_PART_BYTES);
    return { kind: "text", text, ...(item.truncated || text !== item.text ? { truncated: true } : {}) };
  }
  const input = clipBytes(item.input, ASSIST_TRANSCRIPT_PART_BYTES);
  const output = clipBytes(item.output, ASSIST_TRANSCRIPT_PART_BYTES);
  const truncated = item.truncated || input !== item.input || output !== item.output;
  return { kind: "tool", name: item.name, input, output, status: item.status, ...(truncated ? { truncated: true } : {}) };
}

function stepCount(item: AssistTranscriptItem): number {
  return item.kind === "omitted" ? item.count : 1;
}

/**
 * 合计超过 1MB 时保留开头约四分之一与最近的部分，中间用一项 {@code omitted} 注明省略了几步。
 */
export function fitTranscript(items: readonly AssistTranscriptItem[], maxBytes: number = ASSIST_TRANSCRIPT_BYTES): AssistTranscriptItem[] {
  const clipped = items.map(clipItem);
  const sizes = clipped.map((item) => byteLength(JSON.stringify(item)) + 1);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= maxBytes) return clipped;
  const budget = maxBytes - 128;
  const headBudget = Math.floor(budget / 4);
  let head = 0;
  let used = 0;
  while (head < clipped.length && used + sizes[head]! <= headBudget) used += sizes[head++]!;
  let tail = clipped.length;
  while (tail > head && used + sizes[tail - 1]! <= budget) used += sizes[--tail]!;
  const omitted = clipped.slice(head, tail).reduce((sum, item) => sum + stepCount(item), 0);
  return [...clipped.slice(0, head), { kind: "omitted", count: omitted }, ...clipped.slice(tail)];
}

/**
 * 回复正文另有一段展示：执行过程末尾与回复重复的说明文字（Agent 最后那段回答）不再列进过程里。
 */
export function withoutFinalReply(items: readonly AssistTranscriptItem[], reply: string): AssistTranscriptItem[] {
  const result = [...items];
  const target = reply.trim();
  if (!target) return result;
  while (result.length) {
    const last = result[result.length - 1]!;
    if (last.kind !== "text") break;
    const text = last.text.trim();
    if (!text || !(target === text || target.endsWith(text) || text.endsWith(target))) break;
    result.pop();
  }
  return result;
}

/** 摘要步骤（任务页协助条、命令行）由完整过程得出：只取工具调用，产出压成一行。 */
export function stepsFromTranscript(items: readonly AssistTranscriptItem[]): Array<{ text: string; output?: string }> {
  const steps: Array<{ text: string; output?: string }> = [];
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const output = item.output.replace(/\s+/gu, " ").trim().slice(0, 1_500);
    steps.push({ text: item.name || "执行了一步", ...(output ? { output: item.status === "failed" ? `${output}（失败）` : output } : {}) });
  }
  return steps.slice(-60);
}

/** 云端返回的执行过程转成本机结构；不认识的项丢掉。 */
export function toTranscript(value: unknown): AssistTranscriptItem[] {
  if (!Array.isArray(value)) return [];
  const items: AssistTranscriptItem[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const truncated = item.truncated === true ? { truncated: true } : {};
    if (item.kind === "text" && typeof item.text === "string") items.push({ kind: "text", text: item.text, ...truncated });
    else if (item.kind === "tool") {
      const status = item.status === "running" || item.status === "failed" ? item.status : "done";
      items.push({
        kind: "tool",
        name: typeof item.name === "string" ? item.name : "",
        input: typeof item.input === "string" ? item.input : "",
        output: typeof item.output === "string" ? item.output : "",
        status,
        ...truncated
      });
    } else if (item.kind === "omitted" && typeof item.count === "number") items.push({ kind: "omitted", count: item.count });
  }
  return items;
}
