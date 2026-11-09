/**
 * 发起方一侧的记录：发起这次协助的那一轮里，发起方的用户、Agent 的思考、说明与工具调用。
 *
 * <p>协助会话要让双方看到完整链条：发起方 Agent 里的原始内容 → 发出的请求 → 执行方的执行 → 发起方收到的结果 →
 * 收到之后的过程与回复。执行方那一段由执行方上传；这里从发起方本机的 Agent 记录里按事件顺序切出发起方的两段：</p>
 *
 * <ul>
 *   <li><b>origin</b>（发起前）：发起这次请求的那一轮从头开始（同一轮里先有别的请求时，从这次请求那一步开始），
 *       到第一次拿到终态结果之前，包含 {@code assist ask} 本身与中间几次「还没结束」的 {@code assist wait}。
 *       终态出现在后面的轮次时，中间等过这次请求的轮次整轮放进来，与它无关的轮次跳过。</li>
 *   <li><b>followup</b>（收到后）：从第一次拿到终态结果的那一步开始（这一步标 {@code delivery}），到这一轮结束；
 *       同一轮里又发了下一次请求时截到那次请求开始之前。终态在另一轮时，从那一轮的用户消息开始。</li>
 * </ul>
 *
 * <p>只给这次协助涉及的轮次，更早的历史一律不给；用户消息里宿主注入的上下文（记忆、知识库、项目背景、运行时信息）剥掉，
 * 技能正文不展示，所有文字过一遍脱敏。读两种记录：Memmy 任务（{@code websocket_<id>.jsonl}）与
 * DeepSeek Harness 会话（{@code session.v4.jsonl.zstd}，事件带 seq）。</p>
 */
import { readFile } from "node:fs/promises";

import { loadDeepseekHarnessEvents, redactSecrets } from "@memmy/agent-source-core";

import { isInternalUserMessage, stripInjectedContext } from "../../adapters/outbound/agent-source/session-reference/local-session-reader.js";
import { fitTranscript, type AssistTranscriptItem } from "./transcript.js";

/** 能读到发起方记录的两种 Agent。 */
export type RequesterSource = "memmy" | "deepseek_harness";

/** 记录里的一条，按发生顺序。{@code turn} 是第几轮（从 0 起），{@code step} 是同一次模型回复产生的条目共用的编号。 */
export type RecordEntry =
  | { type: "user"; text: string; turn: number; step: number; resultFor?: string }
  | { type: "thinking" | "text"; text: string; turn: number; step: number }
  | {
    type: "tool";
    name: string;
    input: string;
    output: string;
    status: "running" | "done" | "failed";
    turn: number;
    step: number;
    /** 命令行工具的原始命令：用来认出 memmy-project assist 的那几次调用。 */
    command: string;
    /** 技能正文：不展示输出。 */
    skill?: boolean;
  };

export interface RequesterRecord {
  entries: RecordEntry[];
  /** 已经结束的轮次。 */
  ended: Set<number>;
}

export interface RequesterSlice {
  /** 记录里是否找到了这次请求的 {@code assist ask}：没找到（还没写盘、或不是在这里发起的）时两段都不上传。 */
  found: boolean;
  origin: AssistTranscriptItem[];
  /** 还没拿到终态结果时为 null。 */
  followup: AssistTranscriptItem[] | null;
  /** followup 所在的那一轮已经结束（或被下一次请求截断）：之后不会再有新内容。 */
  complete: boolean;
}

/** 读一份发起方记录；文件不存在或读不了时返回 null。 */
export async function readRequesterRecord(source: RequesterSource, path: string): Promise<RequesterRecord | null> {
  if (source === "deepseek_harness") {
    const events = await loadDeepseekHarnessEvents(path).catch(() => null);
    return events ? parseDeepseekRecord(events as unknown as Array<Record<string, unknown>>) : null;
  }
  const content = await readFile(path, "utf8").catch(() => null);
  return content === null ? null : parseMemmyRecord(content);
}

/**
 * Memmy 任务记录：第一行是 metadata，之后按序是 user（一轮的开始）、assistant（{@code content}、
 * {@code reasoning_content}、{@code tool_calls}）、tool（{@code tool_call_id} 对应的输出）。
 * Memmy 没有轮次结束标记：一轮里最后一条是没有工具调用的回复，或者后面已经有下一轮，就算结束。
 */
export function parseMemmyRecord(content: string): RequesterRecord {
  const entries: RecordEntry[] = [];
  const ended = new Set<number>();
  const tools = new Map<string, Extract<RecordEntry, { type: "tool" }>>();
  let turn = -1;
  let step = 0;
  let finalReply = false;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let raw: Record<string, unknown>;
    try {
      raw = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (text(raw.recordType) === "metadata") continue;
    const role = text(raw.role);
    if (role === "user") {
      if (turn >= 0) ended.add(turn);
      turn += 1;
      step += 1;
      finalReply = false;
      const body = messageText(raw.content);
      const resultFor = /^\s*<memmy_assist_result\s+request="([^"]+)"/u.exec(body)?.[1];
      entries.push({ type: "user", text: body, turn, step, ...(resultFor ? { resultFor } : {}) });
      continue;
    }
    if (turn < 0) turn = 0;
    if (role === "assistant") {
      step += 1;
      const reasoning = text(raw.reasoning_content).trim();
      if (reasoning) entries.push({ type: "thinking", text: reasoning, turn, step });
      const reply = messageText(raw.content).trim();
      if (reply) entries.push({ type: "text", text: reply, turn, step });
      const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls.map(record) : [];
      for (const call of calls) {
        const fn = record(call.function);
        const name = text(fn.name) || text(call.name) || "tool";
        const entry = toolEntry(name, parseArguments(fn.arguments ?? call.arguments), turn, step);
        entries.push(entry);
        const id = text(call.id);
        if (id) tools.set(id, entry);
      }
      finalReply = calls.length === 0 && Boolean(reply);
      continue;
    }
    if (role === "tool") {
      const entry = tools.get(text(raw.tool_call_id));
      const output = messageText(raw.content);
      if (entry) {
        entry.output = output;
        entry.status = "done";
      } else {
        entries.push({ ...toolEntry(text(raw.name) || "tool", {}, turn, step), output, status: "done" });
      }
    }
  }
  if (turn >= 0 && finalReply) ended.add(turn);
  return { entries, ended };
}

/**
 * DeepSeek Harness 的会话事件：{@code turn/start} 开始一轮，{@code user/message} 里 {@code source.kind === "user"}
 * 的才是用户说的话（记忆、项目说明、运行时信息、技能目录也以 user/message 注入，不展示）；
 * {@code assistant/message} 的内容块里有 reasoning 与 text，工具调用以 {@code tool/call} / {@code tool/result} 事件为准；
 * {@code turn/end} 结束一轮。
 */
export function parseDeepseekRecord(events: ReadonlyArray<Record<string, unknown>>): RequesterRecord {
  const entries: RecordEntry[] = [];
  const ended = new Set<number>();
  const tools = new Map<string, Extract<RecordEntry, { type: "tool" }>>();
  const ordered = [...events].sort((left, right) => num(left.seq) - num(right.seq));
  let turn = 0;
  for (const event of ordered) {
    const type = text(event.type);
    const data = record(event.data);
    const eventTurn = typeof data.turn === "number" ? data.turn : turn;
    if (type === "turn/start") {
      turn = eventTurn;
      continue;
    }
    if (type === "turn/end") {
      ended.add(eventTurn);
      continue;
    }
    // 一轮内的 step 编号从 1 开始重计：加上轮次换算成全局唯一的编号。
    const step = (typeof data.step === "number" ? data.step : 0) + eventTurn * 10_000;
    if (type === "user/message") {
      if (text(record(data.source).kind) !== "user") continue;
      const body = contentText(data.content);
      if (body.trim()) entries.push({ type: "user", text: body, turn, step: turn * 10_000 });
      continue;
    }
    if (type === "assistant/message") {
      const message = record(data.message);
      for (const block of Array.isArray(message.content) ? message.content.map(record) : []) {
        const kind = text(block.type);
        const body = text(block.text).trim();
        if (kind === "reasoning" && body) entries.push({ type: "thinking", text: body, turn: eventTurn, step });
        else if (kind === "text" && body) entries.push({ type: "text", text: body, turn: eventTurn, step });
      }
      continue;
    }
    if (type === "tool/call") {
      const entry = toolEntry(text(data.name) || "tool", parseArguments(data.arguments), eventTurn, step);
      entries.push(entry);
      const id = text(data.callId);
      if (id) tools.set(id, entry);
      continue;
    }
    if (type === "tool/result") {
      const message = record(data.message);
      const id = text(record(message.source).callId) || text(message.toolCallId);
      const entry = tools.get(id);
      if (!entry) continue;
      entry.output = contentText(message.content);
      entry.status = message.isError === true ? "failed" : "done";
    }
  }
  return { entries, ended };
}

/** 一次工具调用：命令行工具以命令为参数、以说明（没有时取命令第一行）为名字；读文件等以路径为名字。 */
function toolEntry(name: string, args: Record<string, unknown>, turn: number, step: number): Extract<RecordEntry, { type: "tool" }> {
  const command = typeof args.command === "string" ? args.command
    : typeof args.cmd === "string" ? args.cmd
      : Array.isArray(args.command) ? args.command.filter((part) => typeof part === "string").join(" ") : "";
  const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
  const skill = name === "skill" || /(^|\/)SKILL\.md$/u.test(path);
  const label = command
    ? text(args.description).trim() || firstLine(command)
    : path ? `${name} ${path}` : typeof args.name === "string" && args.name ? `${name} ${args.name}` : name;
  const input = command || (Object.keys(args).length ? JSON.stringify(args, null, 2) : "");
  return { type: "tool", name: label, input, output: "", status: "running", turn, step, command, ...(skill ? { skill: true } : {}) };
}

const ASSIST_COMMAND = /\bassist\s+(ask|wait|status)\b/u;

/** 这一步是不是 memmy-project assist 的调用；是的话返回子命令。 */
function assistAction(entry: RecordEntry): "ask" | "wait" | "status" | null {
  if (entry.type !== "tool" || !entry.command || !/memmy-project/u.test(entry.command)) return null;
  const match = ASSIST_COMMAND.exec(entry.command);
  return match ? match[1] as "ask" | "wait" | "status" : null;
}

/** {@code assist wait|status <id>} 等的是哪一次请求：命令行里写的短 id 或完整 id。 */
function targetOf(entry: Extract<RecordEntry, { type: "tool" }>): string {
  const match = /\bassist\s+(?:wait|status)\s+["']?([A-Za-z0-9-]+)/u.exec(entry.command);
  return match?.[1] ?? "";
}

/**
 * 命令行输出里说明这次已经结束的那几种写法（见 collab-assist-service 的 resultText）。Agent 常在命令后接 {@code | head} / {@code | tail}，
 * 所以开头与结尾各认一处：开头是「已完成：孙落的 … 在孙落的电脑上执行」，结尾是「…assist ask --continue <短 id> 发出」。
 * 「还没结束」的输出里也有单独一行「已完成：」（下面列着做完的步骤），它不算。
 */
const TERMINAL_OUTPUT = /(^|\n)\s*已完成：[^\s]|assist\s+ask\s+--continue\s+[0-9A-Za-z-]+\s*发出|不要自动重发|这次请求已撤回|这次请求已过期/u;

function isTerminalOutput(output: string): boolean {
  return !/(^|\n)\s*还没结束：/u.test(output) && TERMINAL_OUTPUT.test(output);
}

function sameRequest(token: string, requestId: string, short: string): boolean {
  if (!token) return false;
  return token.toUpperCase() === short || token.toLowerCase() === requestId.toLowerCase();
}

/** 记录里的锚点：哪一次请求在哪一步发出、在哪一步拿到终态结果。 */
interface Anchor {
  index: number;
  requestId: string | null;
  kind: "ask" | "wait" | "result";
  terminal: boolean;
}

/** {@code assist ask} 的输出里写着发出的是哪一次：「已发送协助请求 <短 id>」。 */
function askedShortId(entry: Extract<RecordEntry, { type: "tool" }>): string {
  return /已发送协助请求\s+([0-9A-Za-z-]+)/u.exec(entry.output)?.[1]?.toUpperCase() ?? "";
}

/**
 * 按这次请求切出 origin 与 followup。{@code shortId} 是命令行里显示的 6 位短 id。
 */
export function sliceRequesterRecord(recordValue: RequesterRecord, requestId: string, short: string): RequesterSlice {
  const { entries, ended } = recordValue;
  const anchors: Anchor[] = [];
  entries.forEach((entry, index) => {
    if (entry.type === "user" && entry.resultFor) {
      anchors.push({ index, requestId: entry.resultFor, kind: "result", terminal: true });
      return;
    }
    const action = assistAction(entry);
    if (!action || entry.type !== "tool") return;
    if (action === "ask") {
      const asked = askedShortId(entry);
      const id = asked && sameRequest(asked, requestId, short) ? requestId : asked || null;
      anchors.push({ index, requestId: id, kind: "ask", terminal: Boolean(asked) && isTerminalOutput(entry.output) });
      return;
    }
    const target = targetOf(entry);
    anchors.push({
      index,
      requestId: sameRequest(target, requestId, short) ? requestId : target || null,
      kind: "wait",
      terminal: isTerminalOutput(entry.output)
    });
  });
  const ask = anchors.find((anchor) => anchor.kind === "ask" && anchor.requestId === requestId);
  if (!ask) return { found: false, origin: [], followup: null, complete: false };
  const terminal = anchors.find((anchor) => anchor.index >= ask.index && anchor.requestId === requestId && anchor.terminal) ?? null;
  const others = anchors.filter((anchor) => anchor.requestId !== requestId);

  const turnOf = (index: number) => entries[index]!.turn;
  const turnStart = (turn: number) => entries.findIndex((entry) => entry.turn === turn);
  const turnEnd = (turn: number) => {
    let last = -1;
    entries.forEach((entry, index) => {
      if (entry.turn === turn) last = index;
    });
    return last + 1;
  };
  /** 一次 ask 的那一步从哪里开始：同一次模型回复里的思考与说明算进去；写请求文件的那一步也算进去。 */
  const boundary = (askIndex: number): number => {
    const entry = entries[askIndex] as Extract<RecordEntry, { type: "tool" }>;
    const turn = entry.turn;
    const start = turnStart(turn);
    const stepStart = (index: number) => {
      let first = index;
      while (first - 1 >= start && entries[first - 1]!.step === entries[index]!.step) first -= 1;
      return first;
    };
    let result = stepStart(askIndex);
    const file = /--file\s+["']?([^\s"']+)/u.exec(entry.command)?.[1];
    if (file) {
      for (let index = result - 1; index >= start; index -= 1) {
        if (anchors.some((anchor) => anchor.index === index)) break;
        const candidate = entries[index]!;
        if (candidate.type === "tool" && candidate.input.includes(file)) {
          result = stepStart(index);
          break;
        }
      }
    }
    return result;
  };
  /** 同一轮里 {@code after} 之后另一次请求的开始：本次的这一段截到它之前。 */
  const nextAskBoundary = (after: number, turn: number): number | null => {
    const next = others.find((anchor) => anchor.kind === "ask" && anchor.index > after && turnOf(anchor.index) === turn);
    return next ? Math.max(after + 1, boundary(next.index)) : null;
  };

  // origin：发起这一轮的开头，或同一轮里前面已经有别的请求时，从这次请求那一步开始。
  const askTurn = turnOf(ask.index);
  const askTurnStart = turnStart(askTurn);
  const ownBoundary = boundary(ask.index);
  const earlier = anchors.some((anchor) => anchor.index >= askTurnStart && anchor.index < ownBoundary && anchor.requestId !== requestId);
  const originStart = earlier ? ownBoundary : askTurnStart;
  const ranges: Array<[number, number]> = [];
  if (terminal && turnOf(terminal.index) === askTurn) {
    ranges.push([originStart, terminal.index]);
  } else {
    const cut = nextAskBoundary(ask.index, askTurn);
    ranges.push([originStart, cut ?? turnEnd(askTurn)]);
    // 终态在后面的轮次：中间等过这次请求的轮次整轮放进来，与它无关的轮次跳过。
    const lastTurn = terminal ? turnOf(terminal.index) : Number.POSITIVE_INFINITY;
    const waited = new Set(anchors
      .filter((anchor) => anchor.requestId === requestId && anchor.kind === "wait" && !anchor.terminal)
      .map((anchor) => turnOf(anchor.index))
      .filter((turn) => turn > askTurn && turn < lastTurn));
    for (const turn of [...waited].sort((left, right) => left - right)) ranges.push([turnStart(turn), turnEnd(turn)]);
  }
  const origin = toItems(ranges.flatMap(([from, to]) => entries.slice(from, to)), null);

  if (!terminal) return { found: true, origin, followup: null, complete: false };
  const resultTurn = turnOf(terminal.index);
  let followStart = terminal.index;
  if (resultTurn !== askTurn) {
    const start = turnStart(resultTurn);
    const crowded = anchors.some((anchor) => anchor.index >= start && anchor.index < terminal.index && anchor.requestId !== requestId);
    followStart = crowded ? terminal.index : start;
  }
  const cut = nextAskBoundary(terminal.index, resultTurn);
  const followEnd = cut ?? turnEnd(resultTurn);
  const followup = toItems(entries.slice(followStart, followEnd), entries[terminal.index]!);
  return { found: true, origin, followup, complete: cut !== null || ended.has(resultTurn) };
}

/** 切出来的条目换成会话里的条目：剥掉注入内容、技能正文不展示、所有文字脱敏，再按上限裁好。 */
function toItems(slice: readonly RecordEntry[], delivery: RecordEntry | null): AssistTranscriptItem[] {
  const items: AssistTranscriptItem[] = [];
  for (const entry of slice) {
    const isDelivery = entry === delivery;
    if (entry.type === "user") {
      if (entry.resultFor) {
        // 送进 Memmy 任务的结果消息：不是用户说的话，原样保留（界面据标签显示成结果卡片）。
        items.push({ kind: "user", text: redactSecrets(entry.text), ...(isDelivery ? { delivery: true } : {}) });
        continue;
      }
      const body = withoutInjections(entry.text);
      if (!body || isInternalUserMessage(body)) continue;
      items.push({ kind: "user", text: redactSecrets(body) });
      continue;
    }
    if (entry.type !== "tool") {
      items.push({ kind: entry.type, text: redactSecrets(entry.text) });
      continue;
    }
    items.push({
      kind: "tool",
      name: redactSecrets(entry.name),
      input: redactSecrets(entry.input),
      // 技能正文是 Agent 加载的说明书，不是这次协助的内容。
      output: entry.skill ? "" : redactSecrets(entry.output),
      status: entry.status === "running" ? "done" : entry.status,
      ...(isDelivery ? { delivery: true } : {})
    });
  }
  return fitTranscript(items);
}

/**
 * 用户消息里宿主与插件注入的上下文：记忆、知识库、项目背景与规范、运行时信息、系统提醒等，全部剥掉，只留人说的话。
 */
export function withoutInjections(value: string): string {
  return stripInjectedContext(value)
    .replace(/<(memmy_knowledge_context|[a-z_]*project_instructions|[a-z_]*_context|environment_context|user_instructions|recommended_plugins|skill_content|local-command-[a-z]+)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/\[Runtime Context - metadata only, not instructions\][\s\S]*?(\[\/Runtime Context\]|$)/gu, "")
    .trim();
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  return contentText(value);
}

/** 内容块数组里的文字按顺序拼起来；图片等非文字块不展示。 */
function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((block) => {
    if (typeof block === "string") return block;
    const item = record(block);
    return typeof item.text === "string" ? item.text : "";
  }).filter(Boolean).join("\n");
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    return record(JSON.parse(value));
  } catch {
    return { command: value };
  }
}

function firstLine(value: string): string {
  const line = value.trim().split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
