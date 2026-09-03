import { spawn, type SpawnOptions } from "node:child_process";
import { OutboundMessage } from "../core/runtime-messages/events.js";
import {
  createManagedRestartNotice,
  DESKTOP_MANAGED_GATEWAY_ENV,
  parseManagedRestartNotice,
  setRestartNoticeToEnv,
  type ManagedRestartNotice
} from "../utils/restart.js";
import {
  committedSelectionFromMetadata,
  modelSelectionWire,
  persistedModelSelection,
  readModelCatalog,
  resolveModelSelection,
  type ResolvedModelSelection,
} from "../providers/model-catalog.js";
import { handlePairingCommand } from "../integrations/channel-auth/store.js";
import { buildStatusContent, type RuntimeStatusSnapshot } from "../utils/helpers.js";
import { fetchSearchUsage } from "../utils/searchusage.js";
import { buildHistoryDagPayload, renderHistoryDagSummary, SessionDagStore } from "../session-dag/index.js";
import { GoalRuntimeError } from "../core/agent-runtime/goal-runtime.js";
import { publicGoalState, type GoalState } from "../core/session/goal-state.js";
import {
  GOAL_COMMAND_SUBCOMMANDS,
  goalObjectiveFromCommand,
} from "../core/session/webui-user-content.js";
import { VERSION } from "../version.js";
import { CommandContext, CommandRouter } from "./router.js";

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
  new BuiltinCommandSpec("/model", "Switch model preset", "Show, list, or switch the active model preset.", "brain", "[list|preset]"),
  new BuiltinCommandSpec("/history", "Show conversation history", "Print the last N persisted conversation messages.", "history", "[n]"),
  new BuiltinCommandSpec("/history-dag", "Show history DAG", "Show the task-state DAG for this chat.", "git-branch"),
  new BuiltinCommandSpec(
    "/goal",
    "Manage persistent goal",
    "Create, inspect, pause, resume, edit, budget, or clear a persistent Goal.",
    "activity",
    "[status|help|create <objective>|pause|resume|edit <objective>|budget <n|none>|clear]",
  ),
  new BuiltinCommandSpec("/dream", "Run Dream", "Manually trigger memory consolidation.", "sparkles"),
  new BuiltinCommandSpec("/dream-log", "Show Dream log", "Show what the last Dream consolidation changed.", "book-open"),
  new BuiltinCommandSpec("/dream-restore", "Restore memory", "Revert memory to a previous Dream snapshot.", "undo-2"),
  new BuiltinCommandSpec("/help", "Show help", "List available slash commands.", "circle-help"),
  new BuiltinCommandSpec("/pairing", "Manage pairing", "List, approve, deny or revoke pairing requests.", "shield", "[list|approve <code>|deny <code>|revoke <user_id>]"),
];

type BuiltinCommandOptions = {
  sessionDagEnabled?: boolean;
  fileMemoryEnabled?: boolean;
};

const DREAM_COMMANDS = new Set(["/dream", "/dream-log", "/dream-restore"]);
const FILE_MEMORY_DISABLED_MESSAGE =
  "File memory is disabled by fileMemory.enabled=false.";

function filteredBuiltinCommandSpecs(
  options: BuiltinCommandOptions = {},
): BuiltinCommandSpec[] {
  return BUILTIN_COMMAND_SPECS
    .filter((spec) => options.sessionDagEnabled !== false || spec.command !== "/history-dag")
    .filter(
      (spec) =>
        options.fileMemoryEnabled === true ||
        !DREAM_COMMANDS.has(spec.command),
    );
}

export function builtinCommandPalette(
  options: BuiltinCommandOptions = {},
): Record<string, string>[] {
  return filteredBuiltinCommandSpecs(options).map((spec) => spec.asDict());
}

export function buildHelpText(
  options: Pick<BuiltinCommandOptions, "fileMemoryEnabled"> = {},
): string {
  const lines = ["memmy commands:"];
  for (const spec of filteredBuiltinCommandSpecs(options)) {
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
  sendIpc?: (message: ManagedRestartNotice, callback: (error: Error | null) => void) => boolean;
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
  const activeGoal = ctx.loop?.goalRuntime?.get?.(ctx.key);
  if (activeGoal?.status === "active") {
    try {
      const result = await ctx.loop.goalRuntime.pauseAndCancel(ctx.key, activeGoal.goalId);
      return reply(
        ctx,
        result.warning ? "Goal paused. Warning: turn_cancel_failed" : "Goal paused.",
      );
    } catch (error) {
      const code = error instanceof GoalRuntimeError ? error.code : String(error);
      return reply(ctx, `Could not pause Goal: ${code}`);
    }
  }
  const total = ctx.loop?.cancelActiveTasks ? await ctx.loop.cancelActiveTasks(ctx.key) : 0;
  return reply(ctx, total ? `Stopped ${total} task(s).` : "No active task to stop.");
}

export async function cmdRestart(ctx: CommandContext): Promise<OutboundMessage> {
  const runtime: RestartCommandRuntime = restartCommandRuntimeForTests ?? {};
  const env = runtime.env ?? process.env;
  const managed = env[DESKTOP_MANAGED_GATEWAY_ENV] === "1";
  if (managed) {
    const notice = parseManagedRestartNotice(createManagedRestartNotice({
      channel: ctx.msg.channel,
      chatId: ctx.msg.chatId,
      metadata: { ...(ctx.msg.metadata ?? {}) }
    }));
    if (!notice || !await sendManagedRestartNotice(runtime, notice)) {
      return reply(ctx, "Failed to restart memmy: Desktop supervisor unavailable.");
    }
    scheduleManagedRestartExit(runtime);
    return reply(ctx, "Restarting...");
  }

  setRestartNoticeToEnv({
    channel: ctx.msg.channel,
    chatId: ctx.msg.chatId,
    metadata: { ...(ctx.msg.metadata ?? {}) },
  });
  scheduleRestartForCommand();
  return reply(ctx, "Restarting...");
}

async function sendManagedRestartNotice(runtime: RestartCommandRuntime, notice: ManagedRestartNotice): Promise<boolean> {
  const sender = runtime.sendIpc ?? (typeof process.send === "function"
    ? ((message, callback) => process.send!(message, callback))
    : null);
  if (!sender) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, 500);
    try {
      sender(notice, (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(!error);
      });
    } catch {
      settled = true;
      clearTimeout(timer);
      resolve(false);
    }
  });
}

function scheduleManagedRestartExit(runtime: RestartCommandRuntime, delayMs = 1000): void {
  const scheduler = runtime.scheduler ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  scheduler(() => (runtime.exit ?? process.exit)(75), delayMs);
}

export async function cmdNew(ctx: CommandContext): Promise<OutboundMessage> {
  await ctx.loop?.cancelActiveTasks?.(ctx.key, { excludeSignal: ctx.abortSignal });
  await ctx.loop?.closeBrowserSession?.(
    ctx.key,
    ctx.msg.channel,
    ctx.msg.chatId,
  );
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

function modelPresetNames(): string[] {
  return readModelCatalog().items
    .filter((item) => item.available)
    .map((item) => item.preset);
}

function modelCommandList(): string {
  const items = readModelCatalog().items.filter((item) => item.available);
  return [
    "## Model presets",
    ...(items.length
      ? items.map((item) => `- \`${item.preset}\` -> \`${item.provider} / ${catalogModelName(item)}\``)
      : ["- (none configured)"]),
  ].join("\n");
}

function catalogModelName(selection: {
  preset?: string;
  presetId?: string;
  model: string;
  source: "account" | "byok";
  capabilities: readonly string[];
}): string {
  if (selection.source === "account" && selection.capabilities.includes("agent")) return "General text";
  return selection.model.trim() || selection.presetId || selection.preset || "(unavailable)";
}

function resolveCurrentSessionModel(
  ctx: CommandContext,
  sessionOverride: any | null = null,
): ResolvedModelSelection | null {
  const session = sessionOverride ?? ctx.session ?? ctx.loop?.sessions?.get?.(ctx.key);
  const committedSelection = committedSelectionFromMetadata(session?.metadata);
  const input = committedSelection
    ? { committedSelection }
    : {
        sessionPreset: typeof session?.metadata?.modelPreset === "string"
          ? session.metadata.modelPreset
          : null,
      };
  try {
    return typeof ctx.loop?.resolveTurnModelSelection === "function"
      ? ctx.loop.resolveTurnModelSelection(input)
      : resolveModelSelection(input);
  } catch {
    return null;
  }
}

function modelCommandStatus(ctx: CommandContext): string {
  const selection = resolveCurrentSessionModel(ctx);
  return [
    "## Model",
    `- Current model: \`${selection ? `${selection.provider} / ${catalogModelName(selection)}` : "(none configured)"}\``,
    `- Current preset: \`${selection?.preset ?? "(none configured)"}\``,
    `- Available presets: ${formatPresetNames(modelPresetNames())}`,
  ].join("\n");
}

export async function cmdModel(ctx: CommandContext): Promise<OutboundMessage> {
  const loop = ctx.loop;
  const args = ctx.args.trim();
  const metadata = { renderAs: "text" };
  if (!args) return reply(ctx, modelCommandStatus(ctx), metadata);
  const parts = args.split(/\s+/);
  if (parts.length !== 1) return reply(ctx, "Usage: `/model [list|preset]`", metadata);
  if (parts[0]?.toLowerCase() === "list") {
    return reply(ctx, modelCommandList(), metadata);
  }

  try {
    const session = ctx.session ?? loop?.sessions?.get?.(ctx.key);
    if (!session) throw new Error("No active Session is available");
    const selection = typeof loop?.applySessionModelPresetLocked === "function"
      ? loop.applySessionModelPresetLocked(session, parts[0])
      : resolveAndPersistSessionModel(loop, session, parts[0]);
    await publishSessionModelUpdate(ctx, selection);
    const lines = [
      `Switched this Session to \`${selection.preset}\`.`,
      `- Model: \`${selection.provider} / ${catalogModelName(selection)}\``,
      `- Context window: ${selection.snapshot.contextWindowTokens}`,
    ];
    const maxTokens = selection.snapshot.provider?.generation?.maxTokens;
    if (maxTokens != null) lines.push(`- Max output tokens: ${maxTokens}`);
    return reply(ctx, lines.join("\n"), metadata);
  } catch (err) {
    void err;
    return reply(ctx, `Could not switch model preset: model_selection_unavailable\n\nAvailable presets: ${formatPresetNames(modelPresetNames())}`, metadata);
  }
}

async function publishSessionModelUpdate(
  ctx: CommandContext,
  selection: ResolvedModelSelection,
): Promise<void> {
  const clientRequestId = ctx.msg.metadata?.client_request_id;
  const wire = modelSelectionWire(selection);
  if (ctx.msg.channel !== "websocket" || typeof clientRequestId !== "string" || !wire) return;
  await ctx.loop?.bus?.publishOutbound?.(new OutboundMessage({
    channel: "websocket",
    chatId: ctx.msg.chatId,
    content: "",
    metadata: {
      runtimeModelUpdated: true,
      webuiRequestSessionKey: ctx.key,
      clientRequestId,
      modelSelection: wire,
    },
  }));
}

function resolveAndPersistSessionModel(loop: any, session: any, preset: string) {
  const selection = resolveModelSelection({ requestedPreset: preset });
  const requested = readModelCatalog().items.find((item) => item.preset === preset && item.available);
  if (!selection || !requested || selection.preset !== preset) {
    throw new Error(`Unknown or unavailable model preset '${preset}'`);
  }
  session.metadata.modelPreset = selection.preset;
  session.metadata.modelSelection = persistedModelSelection(selection);
  loop.sessions.save(session, { fsync: true });
  loop.guiTranscriptMirror?.sessionUpdated?.(session.key);
  return selection;
}

function goalActions(goal: GoalState | null): string {
  if (!goal) return "create <objective>";
  if (goal.status === "active") return "pause, clear";
  if (goal.status === "budget_limited") return "edit, budget <n|none>, clear";
  if (goal.status === "completed") return "clear, create <objective>";
  return "resume, edit, budget <n|none>, clear";
}

function goalStatusText(goal: GoalState | null): string {
  return [
    "## Goal",
    JSON.stringify(publicGoalState(goal), null, 2),
    `Available: ${goalActions(goal)}`,
  ].join("\n");
}

function goalHelpText(): string {
  return [
    "/goal — show status",
    "/goal status — show status",
    "/goal <objective> — create a Goal",
    "/goal create <objective> — create a Goal",
    "/goal pause — pause and stop the current Goal turn",
    "/goal resume — resume a paused, blocked, or usage-limited Goal",
    "/goal edit <objective> — edit a non-active Goal",
    "/goal budget <positive-int|none> — set or remove the cumulative token budget",
    "/goal clear — cancel and remove the Goal",
    "usage_limited requires provider capacity before resume; budget_limited requires a larger or removed budget, then resume.",
  ].join("\n");
}

export async function cmdGoal(ctx: CommandContext): Promise<OutboundMessage> {
  const runtime = ctx.loop?.goalRuntime;
  if (!runtime) return reply(ctx, "Goal runtime is unavailable.", { renderAs: "text" });
  const rawArgs = ctx.args.trim();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rawArgs);
  const first = match?.[1] ?? "";
  const command = first.toLowerCase();
  const explicitSubcommand = GOAL_COMMAND_SUBCOMMANDS.has(command);
  const argument = explicitSubcommand ? (match?.[2] ?? "").trim() : rawArgs;
  const current = runtime.get(ctx.key);
  try {
    if (!rawArgs || command === "status") {
      return reply(ctx, goalStatusText(current), { renderAs: "text" });
    }
    if (command === "help") return reply(ctx, goalHelpText(), { renderAs: "text" });
    if (command === "pause") {
      if (argument) throw new GoalRuntimeError("invalid_transition");
      if (!current) throw new GoalRuntimeError("goal_not_found");
      const result = await runtime.pauseAndCancel(ctx.key, current.goalId);
      const warning = result.warning ? "\nWarning: turn_cancel_failed" : "";
      return reply(ctx, `Goal paused.${warning}\n${goalStatusText(result.goal)}`, { renderAs: "text" });
    }
    if (command === "resume") {
      if (argument) throw new GoalRuntimeError("invalid_transition");
      if (!current) throw new GoalRuntimeError("goal_not_found");
      const goal = await runtime.resume(ctx.key, current.goalId);
      return reply(ctx, `Goal resumed.\n${goalStatusText(goal)}`, { renderAs: "text" });
    }
    if (command === "edit") {
      if (!current) throw new GoalRuntimeError("goal_not_found");
      const goal = await runtime.edit(ctx.key, current.goalId, argument);
      return reply(ctx, `Goal updated.\n${goalStatusText(goal)}`, { renderAs: "text" });
    }
    if (command === "budget") {
      if (!current) throw new GoalRuntimeError("goal_not_found");
      const budget = argument.toLowerCase() === "none"
        ? null
        : /^\d+$/.test(argument)
          ? Number(argument)
          : Number.NaN;
      const goal = await runtime.setBudget(ctx.key, current.goalId, budget);
      return reply(ctx, `Goal budget updated.\n${goalStatusText(goal)}`, { renderAs: "text" });
    }
    if (command === "clear") {
      if (argument) throw new GoalRuntimeError("invalid_transition");
      if (!current) throw new GoalRuntimeError("goal_not_found");
      await runtime.clear(ctx.key, current.goalId);
      return reply(ctx, `Goal cleared.\n${goalStatusText(null)}`, { renderAs: "text" });
    }

    const objective = command === "create" ? argument : rawArgs;
    const turnId = String(ctx.turnId ?? ctx.msg.metadata?.turn_id ?? "").trim();
    if (!turnId) throw new GoalRuntimeError("goal_route_unavailable");
    const goal = await runtime.create({
      sessionKey: ctx.key,
      objective,
      route: { channel: ctx.msg.channel, chatId: ctx.msg.chatId },
      turnId,
    });
    ctx.loop.scheduleGoalWork?.(ctx.key, goal);
    return reply(ctx, `Goal created.\n${goalStatusText(goal)}`, {
      renderAs: "text",
      ...(ctx.msg.channel === "websocket" && ctx.msg.metadata?.webui === true
        ? { webuiGoalCreateAck: true }
        : {}),
    });
  } catch (error) {
    const code = error instanceof GoalRuntimeError ? error.code : String(error);
    return reply(ctx, `Goal command failed: ${code}`, { renderAs: "text" });
  }
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
  if (ctx.loop?.fileMemoryEnabled !== true) {
    return reply(ctx, FILE_MEMORY_DISABLED_MESSAGE, { renderAs: "text" });
  }
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
  if (ctx.loop?.fileMemoryEnabled !== true) {
    return reply(ctx, FILE_MEMORY_DISABLED_MESSAGE, { renderAs: "text" });
  }
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
  return reply(
    ctx,
    buildHelpText({
      fileMemoryEnabled: ctx.loop?.fileMemoryEnabled === true,
    }),
    { renderAs: "text" },
  );
}

function countConversationUserTurns(session: any | null | undefined): number {
  if (!Array.isArray(session?.messages)) return 0;
  return session.messages.reduce((count: number, message: any) => {
    if (message?.role !== "user" || message.internal_context === "goal_continuation") {
      return count;
    }
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (message.commandMessage === true) {
      return goalObjectiveFromCommand(content) ? count + 1 : count;
    }
    const hasMedia = Array.isArray(message.media) && message.media.length > 0;
    return content || hasMedia ? count + 1 : count;
  }, 0);
}

export async function cmdStatus(ctx: CommandContext): Promise<OutboundMessage> {
  const loop = ctx.loop;
  const session = ctx.session ?? loop?.sessions?.getOrCreate?.(ctx.key);
  const selection = resolveCurrentSessionModel(ctx, session);
  const model: RuntimeStatusSnapshot["model"] = selection
    ? {
        state: "ok",
        value: {
          provider: selection.provider,
          displayModel: catalogModelName(selection),
        },
      }
    : { state: "error", reason: "session_model_selection_unavailable" };

  let context: RuntimeStatusSnapshot["context"];
  if (!selection) {
    context = { state: "error", reason: "session_model_selection_unavailable" };
  } else if (
    !Number.isFinite(selection.snapshot.contextWindowTokens)
    || selection.snapshot.contextWindowTokens <= 0
  ) {
    context = { state: "error", reason: "invalid_model_context_window" };
  } else {
    try {
      const scopedConsolidator = loop?.consolidator?.withProviderSnapshot?.(
        selection.snapshot.provider,
        selection.snapshot.model,
        selection.snapshot.contextWindowTokens,
      );
      if (!scopedConsolidator?.estimateSessionPromptTokens) {
        throw new Error("status_token_estimator_unavailable");
      }
      const estimated = scopedConsolidator.estimateSessionPromptTokens(session);
      const estimatedTokens = Number(Array.isArray(estimated) ? estimated[0] : estimated);
      if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
        throw new Error("status_token_estimate_invalid");
      }
      context = {
        state: "ok",
        value: {
          estimatedTokens: Math.floor(estimatedTokens),
          windowTokens: Math.floor(selection.snapshot.contextWindowTokens),
        },
      };
    } catch {
      context = { state: "error", reason: "token_estimation_failed" };
    }
  }

  const hasUsage = loop?.lastUsageBySession?.has?.(ctx.key) === true;
  const lastUsage = hasUsage ? loop.lastUsageBySession.get(ctx.key) : null;
  const usage: RuntimeStatusSnapshot["usage"] = hasUsage
    ? {
        state: "reported",
        promptTokens: Number(lastUsage?.prompt_tokens ?? 0),
        completionTokens: Number(lastUsage?.completion_tokens ?? 0),
        cachedTokens: Number(lastUsage?.cached_tokens ?? 0),
      }
    : { state: "missing" };

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

  return reply(
    ctx,
    buildStatusContent({
      version: VERSION,
      model,
      usage,
      context,
      conversationUserTurns: countConversationUserTurns(session),
      agentStartTime: loop?.startTime ?? Date.now() / 1000,
      searchUsageText,
    }),
    { renderAs: "text" },
  );
}

export async function cmdDream(ctx: CommandContext): Promise<OutboundMessage> {
  if (ctx.loop?.fileMemoryEnabled !== true) {
    return reply(ctx, FILE_MEMORY_DISABLED_MESSAGE);
  }
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
  const filtered = history.filter(
    (message: any) => !message.commandMessage && message.internal_context !== "goal_continuation",
  );
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
