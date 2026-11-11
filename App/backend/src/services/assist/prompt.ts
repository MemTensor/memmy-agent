/**
 * 协助请求交给执行方 Agent 时说的话，以及把它的回答整理成「结果」。
 *
 * <p>请求本身是一张卡片式的说明：谁在排查什么、要拿到什么。这里只把它写成一段话，并约定回答的最后
 * 附一段逐项结果，执行方的 Memmy 据此填「结果」表格。约定写得宽一点：没有那一段也能用，
 * 整条回答就是结果正文。</p>
 */
export interface AssistPromptInput {
  /** 发起人的名字，回答里用它称呼对方。 */
  requesterName: string;
  /** 项目的名字：让 Agent 知道这是工作里的哪一处。 */
  projectName: string;
  /** 要做的事的标题。 */
  title: string;
  /** 背景：为什么请对方的电脑协助。 */
  reason?: string;
  /** 逐条要做的事。 */
  items: readonly string[];
  /** 同一次排查里前面几次的结论：续跑时不必重新交代。 */
  earlier?: readonly string[];
  /**
   * 随请求附带的文本与脚本：执行前已经落在执行方 Agent 能读到的目录里，这里给出目录、文件名与发起方写的用途说明。
   * 脚本要原样执行，提示词里写明不要改写内容。
   */
  attachments?: readonly AssistPromptAttachment[];
  /** 附件所在的目录（绝对路径）：提示词里给出它，执行方 Agent 才知道文件在哪。 */
  attachmentsDirectory?: string;
}

/** 一个已落盘的附件：路径是执行方 Agent 实际能读到的那个。 */
export interface AssistPromptAttachment {
  name: string;
  path: string;
  /** 发起方写的用途说明：这个文件是什么、要怎么用。旧请求没有，按文件类型给一句通用的。 */
  note?: string;
  /** 脚本类：提示词里写明要原样执行，不要改写内容。 */
  executable?: boolean;
}

/**
 * 结果的写法。外部 Agent 把它写在请求正文末尾；由 Memmy 执行时它不出现在任务里，
 * 而是作为不显示的上下文交给模型（运行时放进系统提示词），任务页上只看到请求本身。
 */
export const ASSIST_RESULT_FORMAT = [
  "请直接在这台电脑上完成请求里的事，然后把查到的内容整理成结果。",
  "结论用中文写，最后另起一段，以「结果：」开头，逐项写成一行的「- 名称：内容」，不要写别的格式。"
].join("\n");

/** 由 Memmy 执行时，请求正文包在这个标签里：任务页据此把它显示成请求卡片，而不是一大段文字。 */
export interface AssistEnvelope {
  requestId: string;
  via: string;
  attempt: number;
}

/**
 * 写给执行方 Agent 的指令。给了 {@link AssistEnvelope} 时（由 Memmy 执行），正文包进
 * `<memmy_assist_request>`，且不带结果的写法——那一段由 {@link ASSIST_RESULT_FORMAT} 作为不显示的上下文交给模型。
 */
export function assistPrompt(input: AssistPromptInput, options: { envelope?: AssistEnvelope } = {}): string {
  const body = requestBody(input);
  const envelope = options.envelope;
  if (!envelope) return [...body, "", ASSIST_RESULT_FORMAT].join("\n");
  const attrs = [
    `request="${attr(envelope.requestId)}"`,
    `from="${attr(input.requesterName)}"`,
    `via="${attr(envelope.via)}"`,
    `attempt="${envelope.attempt}"`
  ].join(" ");
  return [`<memmy_assist_request ${attrs}>`, ...body, "</memmy_assist_request>"].join("\n");
}

/** 标签属性里的值：去掉引号与尖括号，避免把标签写坏。 */
function attr(value: string): string {
  return value.replace(/["<>\n\r]/gu, " ").trim();
}

function requestBody(input: AssistPromptInput): string[] {
  const lines: string[] = [];
  lines.push(`${input.requesterName}正在排查一个问题，需要这台电脑上的信息。`);
  if (input.projectName) lines.push(`这件事发生在协作项目「${input.projectName}」里。`);
  if (input.reason) pushFolded(lines, "背景：", input.reason);
  lines.push("");
  pushFolded(lines, "要做的事：", input.title);
  for (const item of input.items) pushFolded(lines, "- ", item);
  // 附件紧跟在要做的事后面：事项里提到的文件，接着就能看到它是什么、怎么用。
  if (input.attachments?.length) {
    lines.push("");
    const directory = input.attachmentsDirectory ?? directoryOf(input.attachments[0]!.path);
    lines.push(`随请求附带的 ${input.attachments.length} 个文件已放在 ${directory}：`);
    for (const attachment of input.attachments) lines.push(`- ${attachment.name}：${attachmentLine(attachment)}`);
  }
  if (input.earlier?.length) {
    lines.push("");
    lines.push("同一次排查里，前面已经完成的几次：");
    for (const summary of input.earlier) pushFolded(lines, "- ", summary);
    lines.push("这次接着上次的结果继续，不必重复前面的步骤。");
  }
  return lines;
}

/** 脚本都要加的一句：发起方带脚本，就是要对方跑这一份，而不是让对方的 Agent 看懂意图后自己重写。 */
const SCRIPT_AS_IS = "运行时直接用这个文件，不要改写内容，也不要另写一份代替它。";

/**
 * 一个附件在提示词里的说明：发起方写的用途，脚本再加上「原样运行」。
 * 没有用途说明的旧请求按类型给一句通用的，让它到要做的事里找用法。说明按一行写：附件段里的续行界面不读。
 */
function attachmentLine(attachment: AssistPromptAttachment): string {
  const note = attachment.note?.replace(/\s+/gu, " ").trim();
  const what = note
    ? sentence(note)
    : attachment.executable
      ? "发起方附带的脚本，用法见上面要做的事。"
      : "发起方附带的资料，用法见上面要做的事。";
  return attachment.executable ? `${what}${SCRIPT_AS_IS}` : what;
}

/** 补上句末标点：后面还要接「运行时直接用这个文件……」。 */
function sentence(value: string): string {
  return /[。！？.!?]$/u.test(value) ? value : `${value}。`;
}

/**
 * 多行内容按界面认的协议写：第一行带前缀，其余行缩进两个空格。
 * 界面（`collab-assist-protocol`）先看前导空格再 trim，把缩进行接回上一条；
 * 不这么写，正文放宽后一条多行事项在卡片上只剩第一行。
 */
function pushFolded(lines: string[], prefix: string, value: string): void {
  const [first = "", ...rest] = value.split(/\r?\n/u);
  lines.push(`${prefix}${first}`);
  for (const line of rest) lines.push(`  ${line}`);
}

/** 从附件路径里取目录：只为旧调用不传 attachmentsDirectory 时兜底。 */
function directoryOf(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at > 0 ? path.slice(0, at) : path;
}

/** 从回答里取「结果」那一段：`- 名称：内容` 的逐项说明。 */
export function parseResultItems(reply: string): Array<{ key: string; value: string }> {
  const items: Array<{ key: string; value: string }> = [];
  const lines = reply.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim().startsWith("结果：") || line.trim() === "结果:");
  const region = start >= 0 ? lines.slice(start + 1) : lines;
  for (const line of region) {
    const match = /^\s*[-*]\s*([^：:]{1,40})[：:]\s*(.+)$/u.exec(line);
    if (!match) continue;
    items.push({ key: match[1]!.trim(), value: match[2]!.trim() });
    if (items.length >= 20) break;
  }
  return items;
}

/**
 * 把「结果」那一段从正文里去掉：正文是给人读的解释，逐项结果另有表格，不必重复一遍。
 * 没有那一段时原样返回。
 */
export function replyWithoutItems(reply: string): string {
  const at = reply.search(/^\s*结果[：:]\s*$/mu);
  return (at >= 0 ? reply.slice(0, at) : reply).trim();
}