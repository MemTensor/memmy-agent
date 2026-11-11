/**
 * 成员协助消息的协议：Memmy 写进任务的两类消息怎么认、怎么拆。
 *
 * 标签里的正文是交给 Agent 读的协议文本，写法与本机后端 `assistPrompt`、`assistResultMessage`
 * 逐字对应（起因：、要做的事：、结果：、逐项：）。这里只按这些标记把它拆成界面卡片要的字段，
 * 不是界面文案，界面上显示的说法都在 i18n 里。
 */
export interface AssistEnvelope {
  kind: "request" | "result";
  attrs: Record<string, string>;
  lines: string[];
}

const ENVELOPE = /^\s*<memmy_assist_(request|result)\b([^>]*)>\n?([\s\S]*?)\n?<\/memmy_assist_\1>\s*$/u;

/** 认出协助消息；不是时返回 null，按普通消息显示。 */
export function parseAssistEnvelope(content: string): AssistEnvelope | null {
  if (!content.includes("<memmy_assist_")) return null;
  const match = ENVELOPE.exec(content);
  if (!match) return null;
  const attrs: Record<string, string> = {};
  for (const pair of match[2]!.matchAll(/([a-z]+)="([^"]*)"/gu)) attrs[pair[1]!] = pair[2]!;
  return { kind: match[1] as "request" | "result", attrs, lines: match[3]!.split(/\r?\n/u) };
}

/** 续行按协议缩进两个空格：去掉这两个空格，其余缩进原样保留。 */
const CONTINUATION = /^ {2}/u;
/** 逐条事项以后的内容（前面几次的结论、附件说明）不算进这次要做的事。 */
const TRAILER_PREFIXES = ["同一次排查里，前面已经完成的几次", "随请求附带的"] as const;

/**
 * 请求正文里的背景、要做的事与逐条事项。
 *
 * <p>多行事项按协议写成「第一行 `- 内容`、续行缩进两个空格」，所以先看原始行的前导空格再 trim：
 * 两个空格以上开头的行是续行，接回上一条（缩进的 `- ` 也算续行，嵌套列表不会被拆成同级事项）。
 * 正文放宽到每条 4000 字、保留换行之后，这一步决定卡片上会不会只剩每条的第一行。</p>
 */
export function readAssistRequestBody(lines: readonly string[]): { reason: string; title: string; items: string[] } {
  let reason = "";
  let title = "";
  const items: string[] = [];
  let inTrailer = false;
  /** 续行接到哪里：当前是多行事项、多行背景、多行标题，还是什么都没得接。 */
  let target: "item" | "reason" | "title" | null = null;
  for (const raw of lines) {
    // 先看前导空格：续行的判断不能等到 trim 之后。
    const continuation = CONTINUATION.test(raw);
    const line = raw.trim();
    if (continuation && !inTrailer) {
      // 去掉共同的 2 空格前缀，其余缩进原样保留；段内空行（只有两个空格）也要留住。
      const content = raw.replace(CONTINUATION, "");
      if (target === "item" && items.length) {
        items[items.length - 1] += `\n${content}`;
        continue;
      }
      if (target === "reason") {
        reason += `\n${content}`;
        continue;
      }
      if (target === "title") {
        title += `\n${content}`;
        continue;
      }
    }
    if (!line) continue;
    // 这一段之后不再有要做的事：判断在归属之前，附件与前面几次的条目不会被当成同级事项。
    if (TRAILER_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      inTrailer = true;
      target = null;
      continue;
    }
    // 「背景：」是现在的写法；「起因：」是旧写法，已经写进任务里的消息还要能读出来。
    if (line.startsWith("背景：")) {
      reason = line.slice(3).trim();
      target = "reason";
    } else if (line.startsWith("起因：")) {
      reason = line.slice(3).trim();
      target = "reason";
    } else if (line.startsWith("要做的事：")) {
      title = line.slice(5).trim();
      inTrailer = false;
      target = "title";
    } else if (line.startsWith("- ") && !inTrailer) {
      items.push(line.slice(2).trim());
      target = "item";
    }
  }
  return { reason, title, items };
}

/** 结果正文：说明、逐项与文件。 */
export function readAssistResultBody(lines: readonly string[]): { reply: string; items: Array<{ key: string; value: string }> } {
  const start = lines.findIndex((line) => line.trim() === "结果：");
  if (start < 0) {
    // 没有完成时只有一句原因，在「没有完成：」之后。
    const line = lines.find((item) => item.includes("没有完成：")) ?? lines[0] ?? "";
    return { reply: line.slice(line.indexOf("没有完成：") >= 0 ? line.indexOf("没有完成：") + 5 : 0).trim(), items: [] };
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim().startsWith("请结合这份结果"));
  const body = end >= 0 ? rest.slice(0, end) : rest;
  // 「逐项：」之后才是逐项结果；正文里的列表原样留在正文里。
  const split = body.findIndex((line) => line.trim() === "逐项：");
  const reply = split >= 0 ? body.slice(0, split) : body;
  const items: Array<{ key: string; value: string }> = [];
  for (const raw of split >= 0 ? body.slice(split + 1) : []) {
    const match = /^-\s*([^：:]{1,40})[：:]\s*(.+)$/u.exec(raw.trim());
    if (match) items.push({ key: match[1]!.trim(), value: match[2]!.trim() });
  }
  return { reply: reply.join("\n").trim(), items };
}