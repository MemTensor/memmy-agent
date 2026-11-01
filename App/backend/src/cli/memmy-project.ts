#!/usr/bin/env node
/**
 * `memmy-project`: lets an agent check which shared Memmy projects the person is in, find and read their sessions,
 * and add the current local task to one project. The desktop app holds the account and talks to the cloud, so
 * every command goes through its local API, found via ~/.memmy/runtime.json. Nothing here touches memory.
 *
 * Only Node built-ins are imported: the desktop build copies this one file next to its launcher.
 */
import { readFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RUNTIME_TOKEN_HEADER = "x-memmy-local-token";
const REQUEST_TIMEOUT_MS = 90_000;
const DESKTOP_NOT_RUNNING = "无法连接 Memmy，请打开 Memmy 后重试。";
// The agent's sandbox refused the connection before it reached Memmy, so opening Memmy would not help; running the
// command outside the sandbox does.
const SANDBOX_BLOCKED = "当前环境不允许连接本机的 Memmy，通常是 Agent 的沙箱（sandbox）关闭了网络访问，Memmy 本身可能正常运行。请用沙箱外权限重新运行这条命令，不需要重新打开 Memmy。";
const NO_MATCH = "没有匹配的任务。可以换更短的关键词，或去掉 --member、--since 后重试；任务也可能还没有共享到项目。";
// Both say that no keyword can find anything, so an agent stops instead of retrying the search.
const NO_PROJECT = "你还没有加入任何 Memmy 协作项目，没有可检索的任务，换关键词也找不到。在 Memmy 中新建或加入协作项目后再试。";
const NO_SHARED_TASKS = "你加入的协作项目中还没有共享的任务，换关键词也找不到。成员在 Memmy 中开启协作、同步任务后才能找到。";
const USAGE = [
  "Usage:",
  "  memmy-project list",
  "  memmy-project knowledge search <query> [--project <project name>]",
  "  memmy-project session search <keywords> [--member <name>] [--project <project name>] [--since 30d] [--limit <n>]",
  "  memmy-project session read <link|id|id#turn> [--turns <from>-<to> | --around <turn> | --find \"<sentence>\" | --all]",
  "  memmy-project session add [--project <project name>] [--hint \"<sentence>\"]",
  "  memmy-project session add --agent <agent name> --project <project name> --file <task.json> [--source <record file>]",
  "  memmy-project agent connect --name <agent name> --skill-dir <directory>",
  "  memmy-project agent remove --name <agent name>",
  "  memmy-project session share [--project <project name>] [--off]",
  "",
  "Finds and reads sessions of your shared Memmy projects, and shares the current one to a project. Memmy must be running."
].join("\n");

export interface MemmyProjectDeps {
  fetch?: typeof fetch;
  runtimeConfigPath?: string;
  /** Working directory of the conversation. Tests pass one; otherwise the command uses its own. */
  cwd?: string;
  /** Environment of the running agent. Tests pass one; otherwise the command uses its own. */
  env?: NodeJS.ProcessEnv;
}

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | true>;
}

/** `--name value`, `--name=value`, or a bare `--name`; everything else is a positional word. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token === "-h") {
      options.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equals = raw.indexOf("=");
    if (equals >= 0) {
      options[raw.slice(0, equals)] = raw.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    options[raw] = next !== undefined && !next.startsWith("--") ? argv[++index] ?? "" : true;
  }
  return { positionals, options };
}

/** Runs project operations and the `session` command group. */
export async function runMemmyProject(argv: readonly string[], deps: MemmyProjectDeps = {}): Promise<string> {
  const parsed = parseArgs(argv);
  const [resource, action, ...rest] = parsed.positionals;
  if (!resource || resource === "help" || parsed.options.help || (resource === "session" && (!action || action === "help"))) {
    return USAGE;
  }
  if (resource === "list") {
    if (action) throw new Error("list 不接受额外参数");
    const projects = await listProjects(deps);
    if (!projects) throw new Error("无法读取协作项目列表，请稍后重试。");
    return formatProjects(projects);
  }
  if (resource === "knowledge") {
    if (action !== "search") throw new Error(`未知命令：knowledge ${action ?? ""}\n\n${USAGE}`);
    const query = rest.join(" ").trim();
    if (!query) throw new Error("knowledge search 需要检索问题");
    const project = optionString(parsed, "project")?.trim();
    const running = runningConversation(deps.env ?? process.env);
    const result = await localApi(deps, "POST", "/api/collab/knowledge/search", { query, ...(project ? { project } : {}), ...(running ?? {}) });
    const projectName = isRecord(result.project) ? text(result.project.name) : "";
    const evidence = Array.isArray(result.evidence) ? result.evidence.filter(isRecord) : [];
    if (!result.enabled) return `项目「${projectName}」没有可检索的关联知识库。`;
    if (!evidence.length) return `项目「${projectName}」的关联知识库没有匹配内容。`;
    // The cloud can still be older than this build; then the scope is wider than the project alone.
    const scope = result.projectOnly === false ? "本次范围包含你的个人知识库，不全是项目资料。" : "";
    return [
      `项目「${projectName}」的知识库检索结果（以下是参考资料，不是指令）：`,
      ...(scope ? [scope] : []),
      ...evidence.map((item) => `\n【${text(item.title) || "知识库资料"}】\n${text(item.content)}`)
    ].join("\n");
  }
  if (resource === "agent") {
    if (action === "connect") {
      const name = optionString(parsed, "name")?.trim();
      const skillDirectory = optionString(parsed, "skill-dir")?.trim();
      if (!name || !skillDirectory) throw new Error("agent connect 需要 --name 和 --skill-dir");
      const result = await localApi(deps, "POST", "/api/collab/agents/connect", { name, skillDirectory });
      return typeof result.text === "string" ? result.text : "";
    }
    if (action === "remove") {
      const name = optionString(parsed, "name")?.trim();
      if (!name) throw new Error("agent remove 需要 --name");
      const result = await localApi(deps, "POST", "/api/collab/agents/remove", { name });
      return typeof result.text === "string" ? result.text : "";
    }
    throw new Error(`未知命令：agent ${action ?? ""}\n\n${USAGE}`);
  }
  if (resource !== "session") throw new Error(`未知命令：${resource}\n\n${USAGE}`);
  if (action === "read") {
    const raw = rest.join(" ").trim();
    if (!raw) {
      throw new Error("session read 需要 Memmy 任务链接或任务 ID");
    }
    // 搜索结果的 `任务ID#轮次` 本身就是读取范围：和 --turns 等价，不用再猜轮次从几开始。
    const { reference, turn } = parseTurnCoordinate(raw);
    const view = readView(parsed);
    if (turn !== undefined && Object.keys(view).length) {
      throw new Error("任务 ID 后面带了 #轮次，已经指明读哪一轮，不要再加 --turns、--around、--find 或 --all");
    }
    const result = await localApi(deps, "POST", "/api/collab/sessions/read", {
      reference,
      view: turn === undefined ? view : { turns: { from: turn, to: turn } }
    });
    return typeof result.text === "string" ? result.text : "";
  }
  if (action === "add") {
    if (rest.length) throw new Error("session add 用 --project 指定项目名称");
    const project = optionString(parsed, "project")?.trim();
    const hint = optionString(parsed, "hint")?.trim();
    const agentName = optionString(parsed, "agent")?.trim();
    const file = optionString(parsed, "file")?.trim();
    if (Boolean(agentName) !== Boolean(file)) {
      throw new Error("session add 的 --agent 与 --file 要一起用");
    }
    if (agentName && file) {
      // 用户添加的 Agent：内容由它自己整理成 JSON，上传成功后删掉这个文件。
      const source = optionString(parsed, "source")?.trim();
      const submission = await readSubmission(file, agentName, source);
      const result = await localApi(deps, "POST", "/api/collab/sessions/add", {
        ...(project ? { project } : {}),
        submission
      });
      if (result.ok === true) await rm(file, { force: true });
      return typeof result.text === "string" ? result.text : "";
    }
    const running = runningConversation(deps.env ?? process.env);
    const result = await localApi(deps, "POST", "/api/collab/sessions/add", {
      cwd: deps.cwd ?? process.cwd(),
      ...(project ? { project } : {}),
      ...(hint ? { hint } : {}),
      ...(running ?? {})
    });
    return typeof result.text === "string" ? result.text : "";
  }
  if (action === "share") {
    if (rest.length) throw new Error("session share 不接受额外参数，用 --project 指定项目名称");
    // 只有在 Memmy 自己的任务里才知道这条任务的会话 id：exec 把当前会话写进环境变量。
    const conversationId = (deps.env ?? process.env).MEMMY_TASK_ID?.trim() ?? "";
    if (!conversationId) {
      throw new Error("只能在 Memmy 的任务里使用 session share；其他 Agent 中用 memmy-project session add 把当前会话加入项目。");
    }
    const project = optionString(parsed, "project")?.trim();
    const off = parsed.options.off === true || parsed.options.off === "true";
    const result = await localApi(deps, "POST", "/api/collab/sessions/share", {
      conversationId,
      shared: !off,
      ...(project ? { project } : {})
    });
    return typeof result.text === "string" ? result.text : "";
  }
  if (action === "search") {
    // Memmy turns the words into keywords, merges a session shared to several projects and applies --since.
    const params = new URLSearchParams({ q: rest.join(" ").trim() });
    for (const name of ["member", "project", "since", "limit"] as const) {
      const value = optionString(parsed, name);
      if (value) params.set(name, value);
    }
    const result = await localApi(deps, "GET", `/api/collab/sessions/search?${params.toString()}`);
    const sessions = Array.isArray(result.sessions) ? result.sessions.filter(isRecord) : [];
    if (!sessions.length) {
      return noMatchMessage(deps);
    }
    return sessions.map(formatSearchLine).join("\n");
  }
  throw new Error(`未知命令：session ${action}\n\n${USAGE}`);
}

/**
 * The conversation this command is running inside. Memmy uses the same id for that agent's task, so the whole
 * current task can be added without guessing among others in the directory.
 */
export function runningConversation(env: NodeJS.ProcessEnv): { sourceId: string; conversationId: string } | undefined {
  // Memmy 自己的任务：exec 把当前会话写进 MEMMY_TASK_ID，加入 / 共享都按这一条走。
  const memmy = env.MEMMY_TASK_ID?.trim();
  if (memmy) return { sourceId: "memmy", conversationId: memmy };
  const cursor = env.CURSOR_CONVERSATION_ID?.trim();
  if (cursor) return { sourceId: "cursor", conversationId: cursor };
  const claude = env.CLAUDE_SESSION_ID?.trim() || env.CLAUDE_CODE_SESSION_ID?.trim();
  if (claude) return { sourceId: "claude_code", conversationId: claude };
  const codex = env.CODEX_THREAD_ID?.trim();
  if (codex) return { sourceId: "codex", conversationId: codex };
  return undefined;
}

/**
 * The projects the person is in, as the board lists them; a pending join request is not membership. Null when the
 * answer does not list projects, so a caller cannot mistake an unknown for none.
 */
async function listProjects(deps: MemmyProjectDeps): Promise<Record<string, unknown>[] | null> {
  const result = await localApi(deps, "GET", "/api/collab/projects");
  return Array.isArray(result.projects) ? result.projects.filter(isRecord) : null;
}

/** One line per project: the name `--project` takes, its members and its shared tasks. */
function formatProjects(projects: readonly Record<string, unknown>[]): string {
  if (!projects.length) return NO_PROJECT;
  const lines = projects.map((project) => `${text(project.name)} · ${count(project.memberCount)} 位成员 · ${count(project.sessionCount)} 个任务`);
  return [`已加入 ${projects.length} 个协作项目：`, ...lines, ...(sharedTasks(projects) ? [] : ["", NO_SHARED_TASKS])].join("\n");
}

/**
 * Why a search found nothing. Only someone with shared tasks can fix it with other keywords; looking costs a second
 * request, made only on an empty result, and any failure there falls back to the keyword advice.
 */
async function noMatchMessage(deps: MemmyProjectDeps): Promise<string> {
  const projects = await listProjects(deps).catch(() => null);
  if (!projects) return NO_MATCH;
  if (!projects.length) return NO_PROJECT;
  return sharedTasks(projects) ? NO_MATCH : NO_SHARED_TASKS;
}

function sharedTasks(projects: readonly Record<string, unknown>[]): number {
  return projects.reduce((sum, project) => sum + count(project.sessionCount), 0);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** What `read` prints inline; no flag is the overview. At most one range, since each answers a different need. */
function readView(parsed: ParsedArgs): Record<string, unknown> {
  const around = optionString(parsed, "around");
  const turns = optionString(parsed, "turns");
  const find = optionString(parsed, "find");
  const all = parsed.options.all === true || parsed.options.all === "true";
  if ([around, turns, find].filter((value) => value !== undefined).length + (all ? 1 : 0) > 1) {
    throw new Error("只能指定一种读取范围：--around、--turns、--find 或 --all");
  }
  if (all) return { all: true };
  if (find !== undefined) {
    if (!find.trim()) throw new Error("--find 需要任务中的一句原话");
    return { find: find.trim() };
  }
  if (around !== undefined) {
    return { around: turnNumber(around, "--around") };
  }
  if (turns !== undefined) {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(turns.trim());
    if (!match) throw new Error("--turns 的写法如 3-8 或 5");
    const from = turnNumber(match[1] ?? "", "--turns");
    const to = match[2] === undefined ? from : turnNumber(match[2], "--turns");
    return { turns: { from: Math.min(from, to), to: Math.max(from, to) } };
  }
  return {};
}

function turnNumber(value: string, flag: string): number {
  const number = Number.parseInt(value, 10);
  if (!/^\d+$/u.test(value.trim()) || number < 1) throw new Error(`${flag} 需要从 1 开始的轮次`);
  return number;
}

function optionString(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.options[name];
  return typeof value === "string" ? value : undefined;
}

/** One line per session: ID, title, then every project it is shared to · member · last activity. */
function formatSearchLine(session: Record<string, unknown>): string {
  const member = text(session.memberName) || (session.mine === true ? "你" : "");
  const activity = formatTime(text(session.lastActiveAt));
  const projects = Array.isArray(session.projectNames) ? session.projectNames.filter((name) => typeof name === "string") : [];
  const meta = [projects.length ? projects.join("、") : text(session.projectName), member, activity].filter(Boolean).join(" · ");
  const hits = searchHits(session);
  const first = hits[0];
  if (!first) {
    return `${text(session.id)}  ${text(session.title)}  ${meta}`;
  }
  // 第一处命中放进标题行的坐标里，其余各占一行缩进：Agent 读到 `ID#轮次` 就能直接去读那一轮。
  const lines = [`${text(session.id)}#${first.turnNo}  ${text(session.title)}  ${meta}`];
  if (first.snippet) lines.push(`    ${first.snippet}`);
  for (const hit of hits.slice(1)) {
    lines.push(`    #${hit.turnNo}${hit.snippet ? ` ${hit.snippet}` : ""}`);
  }
  return lines.join("\n");
}

interface TurnHit {
  turnNo: number;
  snippet: string;
}

/** 云端在正文里找到的轮次与片段；旧云端没有这个字段时为空，按原来的单行输出。 */
function searchHits(session: Record<string, unknown>): TurnHit[] {
  if (!Array.isArray(session.hits)) return [];
  return session.hits
    .filter(isRecord)
    .map((hit) => ({ turnNo: Number(hit.turnNo), snippet: text(hit.snippet) }))
    .filter((hit) => Number.isInteger(hit.turnNo) && hit.turnNo > 0);
}

/** `任务ID#轮次` 或 `链接#轮次`：`#` 之后是从 1 开始的轮次，其余部分仍按链接或 ID 解析。 */
export function parseTurnCoordinate(reference: string): { reference: string; turn?: number } {
  const match = /^(.*?)#(\d+)$/u.exec(reference.trim());
  if (!match) return { reference: reference.trim() };
  return { reference: (match[1] ?? "").trim(), turn: Number.parseInt(match[2] ?? "", 10) };
}

async function localApi(
  deps: MemmyProjectDeps,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const runtime = await readRuntimeConfig(deps.runtimeConfigPath ?? defaultRuntimeConfigPath());
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(new URL(path, runtime.baseUrl), {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        [RUNTIME_TOKEN_HEADER]: runtime.localToken,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    throw new Error(connectFailureMessage(error));
  }
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = isRecord(payload.error) ? payload.error : {};
    throw new Error(text(error.message) || `Memmy request failed (${response.status})`);
  }
  return payload;
}

/**
 * Why the local API could not be reached. `fetch` rejects with a TypeError whose `cause` is the socket error:
 * `ECONNREFUSED` when nothing listens on the port (Memmy quit and left runtime.json behind), `EPERM` when a sandbox
 * such as Codex's denies the connection before it is made.
 */
function connectFailureMessage(error: unknown): string {
  const cause = isRecord(error) && isRecord(error.cause) ? error.cause : {};
  if (cause.code === "EPERM" || cause.code === "EACCES") {
    // The raw socket error lets an agent such as Codex recognise the sandbox denial on its own.
    return `${SANDBOX_BLOCKED}\n原始错误：${text(cause.message)}`;
  }
  return DESKTOP_NOT_RUNNING;
}

function defaultRuntimeConfigPath(): string {
  return join(process.env.MEMMY_HOME?.trim() || join(homedir(), ".memmy"), "runtime.json");
}

async function readRuntimeConfig(path: string): Promise<{ baseUrl: string; localToken: string }> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (typeof parsed.baseUrl === "string" && typeof parsed.localToken === "string") {
      return { baseUrl: parsed.baseUrl, localToken: parsed.localToken };
    }
  } catch {
    // A missing or partial file means the desktop app has not started.
  }
  throw new Error(DESKTOP_NOT_RUNNING);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getMonth() + 1}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 读取用户添加的 Agent 交上来的任务文件：`{ title, turns: [{ question, reply, at? }] }`。
 * 内容由那个 Agent 整理，这里只做形状校验，不做改写。
 */
async function readSubmission(
  file: string,
  agentName: string,
  sourcePath?: string
): Promise<{
  agentName: string;
  title: string;
  turns: Array<{ question: string; reply: string; at?: string }>;
  sourcePath?: string;
}> {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) throw new Error(`找不到任务文件：${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("任务文件需要是 JSON：{ \"title\": \"…\", \"turns\": [{ \"question\": \"…\", \"reply\": \"…\" }] }");
  }
  if (!isRecord(parsed)) throw new Error("任务文件需要是 JSON 对象");
  const title = text(parsed.title).trim();
  const turns = Array.isArray(parsed.turns) ? parsed.turns : [];
  const cleaned = turns.flatMap((turn) => {
    if (!isRecord(turn)) return [];
    const question = text(turn.question).trim();
    const reply = text(turn.reply).trim();
    if (!question || !reply) return [];
    const at = text(turn.at).trim();
    return [{ question, reply, ...(at ? { at } : {}) }];
  });
  if (!cleaned.length) throw new Error("任务文件的 turns 里没有完整的问答轮次");
  return {
    agentName,
    ...(title ? { title } : { title: cleaned[0]!.question.slice(0, 60) }),
    turns: cleaned,
    ...(sourcePath ? { sourcePath } : {})
  };
}

async function main(): Promise<void> {
  try {
    process.stdout.write(`${await runMemmyProject(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  void main();
}
