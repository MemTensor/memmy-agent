import { spawn, type SpawnOptions } from "node:child_process";
import { OutboundMessage } from "../core/runtime-messages/events.js";
import { setRestartNoticeToEnv } from "../utils/restart.js";
import { handlePairingCommand } from "../integrations/channel-auth/store.js";
import { buildStatusContent } from "../utils/helpers.js";
import { fetchSearchUsage } from "../utils/searchusage.js";
import { buildHistoryDagPayload, renderHistoryDagSummary, SessionDagStore } from "../session-dag/index.js";
import { CommandContext, CommandRouter } from "./router.js";

const VERSION = "0.0.1-beta.1";

export class BuiltinCommandSpec {
  constructor(
    public command: string,
    public title: string,
    public description: string,
    public icon: string,
    public argHint = "",
  ) {}

  asDict(): Record<string, string> {
    return { command: this.command, title: this.title, description: this.description, icon: this.icon, arg_hint: this.argHint };
  }
}

export const BUILTIN_COMMAND_SPECS = [
  new BuiltinCommandSpec("/new", "New chat", "Stop the current task and start a fresh conversation.", "square-pen"),
  new BuiltinCommandSpec("/stop", "Stop current task", "Cancel the active agent turn for this chat.", "square"),
  new BuiltinCommandSpec("/restart", "Restart memmy", "Restart the bot process in place.", "rotate-cw"),
  new BuiltinCommandSpec("/status", "Show status", "Display runtime, provider, and channel status.", "activity"),
  new BuiltinCommandSpec("/model", "Switch model preset", "Show or switch the active model preset.", "brain", "[preset]"),
  new BuiltinCommandSpec("/history", "Show conversation history", "Print the last N persisted conversation messages.", "history", "[n]"),
  new BuiltinCommandSpec("/history-dag", "Show history DAG", "Show the task-state DAG for this chat.", "git-branch"),
  new BuiltinCommandSpec("/goal", "Start long-running goal", "Tell the agent to treat the request as a long-running goal.", "activity", "<goal>"),
  new BuiltinCommandSpec("/dream", "Run Dream", "Manually trigger memory consolidation.", "sparkles"),
  new BuiltinCommandSpec("/dream-log", "Show Dream log", "Show what the last Dream consolidation changed.", "book-open"),
  new BuiltinCommandSpec("/dream-restore", "Restore memory", "Revert memory to a previous Dream snapshot.", "undo-2"),
  new BuiltinCommandSpec("/help", "Show help", "List available slash commands.", "circle-help"),
  new BuiltinCommandSpec("/pairing", "Manage pairing", "List, approve, deny or revoke pairing requests.", "shield", "[list|approve <code>|deny <code>|revoke <user_id>]"),
];

export function builtinCommandPalette(options: { sessionDagEnabled?: boolean } = {}): Record<string, string>[] {
  return BUILTIN_COMMAND_SPECS
    .filter((spec) => options.sessionDagEnabled !== false || spec.command !== "/history-dag")
    .map((spec) => spec.asDict());
}

export function buildHelpText(): string {
  const lines = ["memmy commands:"];
  for (const spec of BUILTIN_COMMAND_SPECS) {
    const cmd = spec.argHint ? `${spec.command} ${spec.argHint}` : spec.command;
    lines.push(`${cmd} - ${spec.description}`);
  }
  return lines.join("\n");
}

function reply(ctx: CommandContext, content: string, metadata: Record<string, any> = {}): OutboundMessage {
  return new OutboundMessage({
    channel: ctx.msg.channel,
    chatId: ctx.msg.chatId,
    content,
    metadata: { ...(ctx.msg.metadata ?? {}), ...metadata },
  });
}

type RestartChild = { unref?: () => void };

export type RestartCommandRuntime = {
  scheduler?: (callback: () => void, delayMs: number) => unknown;
  launcher?: (command: string, args: string[], options: SpawnOptions) => RestartChild;
  exit?: (code?: number) => void;
  execPath?: string;
  argv?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
};

let restartCommandRuntimeForTests: RestartCommandRuntime | null = null;

export function setRestartCommandRuntimeForTests(runtime: RestartCommandRuntime | null): void {
  restartCommandRuntimeForTests = runtime;
}

function warnRestartCommandFailure(runtime: RestartCommandRuntime, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const warn = runtime.warn ?? ((warning: string) => console.warn(warning));
  warn(`Failed to restart memmy: ${message}`);
}

export function scheduleRestartForCommand(delayMs = 1000): void {
  const runtime: RestartCommandRuntime = restartCommandRuntimeForTests ?? {};
  const scheduler: (callback: () => void, delayMs: number) => unknown =
    runtime.scheduler ?? ((callback, ms) => setTimeout(callback, ms));

  try {
    scheduler(() => {
      try {
        const command = runtime.execPath ?? process.execPath;
        const argv = runtime.argv ?? process.argv;
        const args = argv.slice(1);
        if (!args.length) throw new Error("missing CLI entrypoint");
        const launcher: (command: string, args: string[], options: SpawnOptions) => RestartChild =
          runtime.launcher ?? ((cmd, cmdArgs, options) => spawn(cmd, cmdArgs, options));
        const child = launcher(command, args, {
          cwd: runtime.cwd ?? process.cwd(),
          env: runtime.env ?? process.env,
          stdio: "inherit",
          detached: true,
        });
        child.unref?.();
        (runtime.exit ?? process.exit)(0);
      } catch (error) {
        warnRestartCommandFailure(runtime, error);
      }
    }, delayMs);
  } catch (error) {
    warnRestartCommandFailure(runtime, error);
  }
}

export async function cmdStop(ctx: CommandContext): Promise<OutboundMessage> {
  const total = ctx.loop?.cancelActiveTasks ? await ctx.loop.cancelActiveTasks(ctx.key) : 0;
  return reply(ctx, total ? `Stopped ${total} task(s).` : "No active task to stop.");
}

export async function cmdRestart(ctx: CommandContext): Promise<OutboundMessage> {
  setRestartNoticeToEnv({
    channel: ctx.msg.channel,
    chatId: ctx.msg.chatId,
    metadata: { ...(ctx.msg.metadata ?? {}) },
  });
  scheduleRestartForCommand();
  return reply(ctx, "Restarting...");
}

export async function cmdNew(ctx: CommandContext): Promise<OutboundMessage> {
  await ctx.loop?.cancelActiveTasks?.(ctx.key, { excludeSignal: ctx.abortSignal });
  const session = ctx.session ?? ctx.loop?.sessions?.getOrCreate?.(ctx.key);
  if (session) {
    const snapshot = (session.messages ?? []).slice(session.lastConsolidated ?? 0);
    await ctx.loop?.emitSessionEnd?.(session, session.key ?? ctx.key, "reset");
    session.clear?.();
    ctx.loop?.sessions?.save?.(session);
    ctx.loop?.sessions?.invalidate?.(session.key);
    if (snapshot.length) ctx.loop?.scheduleBackground?.(ctx.loop?.consolidator?.archive?.(snapshot));
  }
  return reply(ctx, "New session started.");
}

function formatPresetNames(names: string[]): string {
  return names.length ? names.map((name) => `\`${name}\``).join(", ") : "(none configured)";
}

function modelPresetNames(loop: any): string[] {
  const names = new Set(Object.keys(loop.modelPresets ?? {}));
  names.add("default");
  return ["default", ...[...names].filter((name) => name !== "default").sort()];
}

function activeModelPresetName(loop: any): string {
  return loop.modelPreset ?? "default";
}

function modelCommandStatus(loop: any): string {
  return [
    "## Model",
    `- Current model: \`${loop.model}\``,
    `- Current preset: \`${activeModelPresetName(loop)}\``,
    `- Available presets: ${formatPresetNames(modelPresetNames(loop))}`,
  ].join("\n");
}

export async function cmdModel(ctx: CommandContext): Promise<OutboundMessage> {
  const loop = ctx.loop;
  const args = ctx.args.trim();
  const metadata = { renderAs: "text" };
  if (!args) return reply(ctx, modelCommandStatus(loop), metadata);
  const parts = args.split(/\s+/);
  if (parts.length !== 1) return reply(ctx, "Usage: `/model [preset]`", metadata);

  try {
    loop.setModelPreset(parts[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply(ctx, `Could not switch model preset: ${message}\n\nAvailable presets: ${formatPresetNames(modelPresetNames(loop))}`, metadata);
  }

  const maxTokens = loop.provider?.generation?.max_tokens ?? loop.provider?.generation?.maxTokens;
  const lines = [
    `Switched model preset to \`${activeModelPresetName(loop)}\`.`,
    `- Model: \`${loop.model}\``,
    `- Context window: ${loop.contextWindowTokens}`,
  ];
  if (maxTokens != null) lines.push(`- Max output tokens: ${maxTokens}`);
  return reply(ctx, lines.join("\n"), metadata);
}

const GOAL_PROMPT_TEMPLATE = `The user declared a sustained objective for this thread.

Inspect or clarify if needed, then call \`long_task\` with the refined objective (and optional short uiSummary). Work proceeds as normal assistant turns using your usual tools. When the objective is fully done and verified, call \`complete_goal\` with a brief recap. If the user later cancels or changes direction, still call \`complete_goal\` with an honest recap (then \`long_task\` again only after there is no active goal). Do not use \`long_task\` / \`complete_goal\` for trivial one-shot answers.

Goal:
{goal}
`;

export async function cmdGoal(ctx: CommandContext): Promise<OutboundMessage | null> {
  const goal = ctx.args.trim();
  if (!goal) return reply(ctx, "Usage: /goal <long-running task description>", { renderAs: "text" });
  if (ctx.session == null) {
    return reply(ctx, "A task is already running for this chat. Use `/stop` first, then send `/goal <long-running task description>` again.", { renderAs: "text" });
  }
  ctx.msg.metadata = {
    ...(ctx.msg.metadata ?? {}),
    originalCommand: "/goal",
    originalContent: ctx.raw,
    goalStartedAt: Date.now() / 1000,
  };
  ctx.msg.content = ctx.msg.text = GOAL_PROMPT_TEMPLATE.replace("{goal}", goal);
  return null;
}

function extractChangedFiles(diff: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith("diff --git ")) continue;
    const parts = line.split(/\s+/);
    let file = parts[3] ?? "";
    if (file.startsWith("b/")) file = file.slice(2);
    if (file && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }
  return files;
}

function formatChangedFiles(diff: string): string {
  const files = extractChangedFiles(diff);
  return files.length ? files.map((file) => `\`${file}\``).join(", ") : "No tracked memory files changed.";
}

function formatDreamLogContent(commit: any, diff: string, requestedSha?: string): string {
  const lines = [
    "## Dream Update",
    "",
    requestedSha ? "Here is the selected Dream memory change." : "Here is the latest Dream memory change.",
    "",
    `- Commit: \`${commit.sha}\``,
    `- Time: ${commit.timestamp}`,
    `- Changed files: ${formatChangedFiles(diff)}`,
  ];
  if (diff) lines.push("", `Use \`/dream-restore ${commit.sha}\` to undo this change.`, "", "```diff", diff.trimEnd(), "```");
  else lines.push("", "Dream recorded this version, but there is no file diff to display.");
  return lines.join("\n");
}

export async function cmdDreamLog(ctx: CommandContext): Promise<OutboundMessage> {
  const store = ctx.loop?.consolidator?.store;
  const git = store?.git;
  if (!git?.isInitialized?.()) {
    const content = store?.getLastDreamCursor?.() === 0
      ? "Dream has not run yet. Run `/dream`, or wait for the next scheduled Dream cycle."
      : "Dream history is not available because memory versioning is not initialized.";
    return reply(ctx, content, { renderAs: "text" });
  }
  const args = ctx.args.trim();
  if (args) {
    const sha = args.split(/\s+/)[0];
    const result = git.showCommitDiff(sha);
    const content = result
      ? formatDreamLogContent(result[0], result[1], sha)
      : `Couldn't find Dream change \`${sha}\`.\n\nUse \`/dream-restore\` to list recent versions, or \`/dream-log\` to inspect the latest one.`;
    return reply(ctx, content, { renderAs: "text" });
  }
  const commits = git.log(1) ?? [];
  const result = commits.length ? git.showCommitDiff(commits[0].sha) : null;
  return reply(ctx, result ? formatDreamLogContent(result[0], result[1]) : "Dream memory has no saved versions yet.", { renderAs: "text" });
}

function formatDreamRestoreList(commits: any[]): string {
  const lines = ["## Dream Restore", "", "Choose a Dream memory version to restore. Latest first:", ""];
  for (const commit of commits) lines.push(`- \`${commit.sha}\` ${commit.timestamp} - ${String(commit.message).split(/\r?\n/)[0]}`);
  lines.push("", "Preview a version with `/dream-log <sha>` before restoring it.", "Restore a version with `/dream-restore <sha>`.");
  return lines.join("\n");
}

export async function cmdDreamRestore(ctx: CommandContext): Promise<OutboundMessage> {
  const git = ctx.loop?.consolidator?.store?.git;
  if (!git?.isInitialized?.()) return reply(ctx, "Dream history is not available because memory versioning is not initialized.", { renderAs: "text" });
  const args = ctx.args.trim();
  if (!args) {
    const commits = git.log(10) ?? [];
    return reply(ctx, commits.length ? formatDreamRestoreList(commits) : "Dream memory has no saved versions to restore yet.", { renderAs: "text" });
  }
  const sha = args.split(/\s+/)[0];
  const result = git.showCommitDiff(sha);
  const changed = result ? formatChangedFiles(result[1]) : "the tracked memory files";
  const newSha = git.revert(sha);
  const content = newSha
    ? `Restored Dream memory to the state before \`${sha}\`.\n\n- New safety commit: \`${newSha}\`\n- Restored files: ${changed}\n\nUse \`/dream-log ${newSha}\` to inspect the restore diff.`
    : `Couldn't restore Dream change \`${sha}\`.\n\nIt may not exist, or it may be the first saved version with no earlier state to restore.`;
  return reply(ctx, content, { renderAs: "text" });
}

export async function cmdPairing(ctx: CommandContext): Promise<OutboundMessage> {
  return reply(ctx, handlePairingCommand(ctx.msg.channel, ctx.args), { pairingCommand: true });
}

export async function cmdHelp(ctx: CommandContext): Promise<OutboundMessage> {
  return reply(ctx, buildHelpText(), { renderAs: "text" });
}

export async function cmdStatus(ctx: CommandContext): Promise<OutboundMessage> {
  const loop = ctx.loop;
  const session = ctx.session ?? loop?.sessions?.getOrCreate?.(ctx.key);
  let contextEstimate = 0;
  try {
    const estimated = loop?.consolidator?.estimateSessionPromptTokens?.(session);
    contextEstimate = Array.isArray(estimated) ? estimated[0] : Number(estimated ?? 0);
  } catch {
    contextEstimate = 0;
  }
  const lastUsage = loop?.lastUsage ?? {};
  if (contextEstimate <= 0) contextEstimate = Number(lastUsage.prompt_tokens ?? 0);

  let searchUsageText: string | null = null;
  try {
    const searchCfg = loop?.webConfig?.search ?? loop?.config?.tools?.webSearch;
    if (searchCfg) {
      const usage = await fetchSearchUsage(searchCfg.provider ?? "duckduckgo", searchCfg.apiKey ?? null);
      searchUsageText = usage.format();
    }
  } catch {
    searchUsageText = null;
  }

  const activeTasks = loop?.activeTasks;
  const pending = activeTasks instanceof Map ? activeTasks.get(ctx.key) ?? [] : activeTasks?.[ctx.key] ?? [];
  const isDone = (task: any): boolean => (typeof task?.done === "function" ? Boolean(task.done()) : Boolean(task?.done));
  let taskCount = Array.isArray(pending) ? pending.filter((task: any) => !isDone(task)).length : 0;
  try {
    taskCount += Number(loop?.subagents?.getRunningCountBySession?.(ctx.key) ?? 0);
  } catch {
    // Status should never fail just because an optional subsystem is absent.
  }

  const sessionCount =
    typeof session?.getHistory === "function"
      ? session.getHistory({ maxMessages: 0 }).length
      : session?.messages?.filter((message: any) => !message.commandMessage).length ?? 0;
  const maxCompletionTokens = loop?.provider?.generation?.max_tokens ?? loop?.provider?.generation?.maxTokens ?? loop?.config?.agents?.defaults?.maxTokens ?? 8192;

  return reply(
    ctx,
    buildStatusContent({
      version: VERSION,
      model: loop?.model ?? loop?.provider?.getDefaultModel?.() ?? null,
      startTime: loop?.startTime ?? Date.now() / 1000,
      lastUsage,
      contextWindowTokens: loop?.contextWindowTokens ?? 0,
      sessionMsgCount: sessionCount,
      contextTokensEstimate: contextEstimate,
      searchUsageText,
      activeTaskCount: taskCount,
      maxCompletionTokens,
    }),
    { renderAs: "text" },
  );
}

export async function cmdDream(ctx: CommandContext): Promise<OutboundMessage> {
  const loop = ctx.loop;
  const msg = ctx.msg;
  const publish = async (content: string) => {
    const outbound = new OutboundMessage({ channel: msg.channel, chatId: msg.chatId, content });
    await loop?.bus?.publishOutbound?.(outbound);
  };
  const task = (async () => {
    const started = Date.now();
    try {
      const didWork = await loop?.dream?.run?.();
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      await publish(didWork ? `Dream completed in ${elapsed}s.` : "Dream: nothing to process.");
    } catch (err) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const message = err instanceof Error ? err.message : String(err);
      await publish(`Dream failed after ${elapsed}s: ${message}`);
    }
  })();
  loop?.scheduleBackground?.(task);
  return reply(ctx, "Dreaming...");
}

const HISTORY_DEFAULT_COUNT = 10;
const HISTORY_MAX_COUNT = 50;
const HISTORY_MAX_CONTENT_CHARS = 200;

function formatHistoryMessage(msg: Record<string, any>): string | null {
  const role = msg.role;
  if (role !== "user" && role !== "assistant") return null;
  let content = msg.content ?? "";
  if (Array.isArray(content)) {
    content = content
      .filter((block) => block && typeof block === "object" && block.type === "text")
      .map((block) => block.text ?? "")
      .join(" ");
  }
  content = String(content).trim();
  if (!content) return null;
  if (content.length > HISTORY_MAX_CONTENT_CHARS) content = `${content.slice(0, HISTORY_MAX_CONTENT_CHARS)}...`;
  return `${role === "user" ? "👤 You" : "🤖 Bot"}: ${content}`;
}

export async function cmdHistory(ctx: CommandContext): Promise<OutboundMessage> {
  let count = HISTORY_DEFAULT_COUNT;
  const raw = ctx.args.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (!/^[+-]?\d+$/.test(raw) || !Number.isFinite(parsed)) {
      return reply(ctx, "Usage: /history [count] - e.g. /history 5 (default: 10, max: 50)");
    }
    count = Math.max(1, Math.min(parsed, HISTORY_MAX_COUNT));
  }

  const session = ctx.session ?? ctx.loop?.sessions?.getOrCreate?.(ctx.key);
  const history =
    typeof session?.getHistory === "function"
      ? session.getHistory({ maxMessages: 0 })
      : (session?.messages ?? []);
  const filtered = history.filter((message: any) => !message.commandMessage);
  const visible = filtered.map(formatHistoryMessage).filter((message: string | null): message is string => Boolean(message));
  const recent = visible.slice(-count);
  if (!recent.length) return reply(ctx, "No conversation history yet.");
  return reply(ctx, `Last ${recent.length} message(s):\n${recent.join("\n")}`, { renderAs: "text" });
}

export async function cmdHistoryDag(ctx: CommandContext): Promise<OutboundMessage> {
  if (ctx.loop?.config?.sessionDag?.enabled === false) {
    return reply(ctx, "Session DAG is disabled.", { renderAs: "text" });
  }
  let store: SessionDagStore | null = null;
  try {
    store = new SessionDagStore({ sessionKey: ctx.key });
    const graph = store.readGraphForHistoryDag();
    return reply(ctx, renderHistoryDagSummary(graph), {
      renderAs: "historyDag",
      agentUi: {
        historyDag: buildHistoryDagPayload(graph),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply(ctx, `Could not read history DAG: ${message}`, { renderAs: "text" });
  } finally {
    store?.close();
  }
}

export function registerBuiltinCommands(router: CommandRouter): void {
  router.priority("/stop", cmdStop);
  router.priority("/restart", cmdRestart);
  router.priority("/status", cmdStatus);
  router.exact("/new", cmdNew);
  router.exact("/status", cmdStatus);
  router.exact("/model", cmdModel);
  router.prefix("/model ", cmdModel);
  router.exact("/history", cmdHistory);
  router.prefix("/history ", cmdHistory);
  router.exact("/history-dag", cmdHistoryDag);
  router.exact("/goal", cmdGoal);
  router.prefix("/goal ", cmdGoal);
  router.exact("/dream", cmdDream);
  router.exact("/dream-log", cmdDreamLog);
  router.prefix("/dream-log ", cmdDreamLog);
  router.exact("/dream-restore", cmdDreamRestore);
  router.prefix("/dream-restore ", cmdDreamRestore);
  router.exact("/help", cmdHelp);
  router.exact("/pairing", cmdPairing);
  router.prefix("/pairing ", cmdPairing);
}
