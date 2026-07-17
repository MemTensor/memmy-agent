import { CronJob, CronJobState, CronSchedule } from "../../../cron/types.js";
import { CronService } from "../../../cron/service.js";
import { RequestContext, RequestContextStore } from "./context.js";
import { Tool } from "./base.js";

const CRON_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", description: "Action to perform" },
    name: {
      type: "string",
      description: "Optional short human-readable label for the job. Defaults to first 30 chars of message.",
    },
    message: {
      type: "string",
      description:
        "REQUIRED when action='add'. Instruction for the agent to execute when the job triggers. Not used for action='list' or action='remove'.",
    },
    every_seconds: { type: "integer", description: "Interval in seconds (for recurring tasks)" },
    cron_expr: { type: "string", description: "Cron expression like '0 9 * * *' (for scheduled tasks)" },
    tz: {
      type: "string",
      description:
        "Optional IANA timezone for cron expressions. When omitted with cron_expr, the tool's default timezone applies.",
    },
    at: {
      type: "string",
      description: "ISO datetime for one-time execution. Naive values use the tool's default timezone.",
    },
    deliver: {
      type: "boolean",
      description: "Whether to deliver the execution result to the user channel (default true)",
      default: true,
    },
    job_id: { type: "string", description: "REQUIRED when action='remove'. Job ID to remove." },
  },
  required: ["action"],
  description:
    "Action-specific parameters: add requires a non-empty message plus one schedule; remove requires job_id; list only needs action.",
};

const OMITTED = Symbol("omitted");

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function validateTimezone(tz: string): string | null {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return null;
  } catch {
    return `Error: unknown timezone '${tz}'`;
  }
}

function zonedParts(ms: number, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const out: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out;
}

function offsetMs(timeZone: string, utcMs: number): number {
  const p = zonedParts(utcMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - utcMs;
}

function parseNaiveIsoInZone(value: string, timeZone: string): number | null {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/,
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s = "0", frac = "0"] = match;
  const localAsUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(frac.padEnd(3, "0")),
  );
  let utc = localAsUtc - offsetMs(timeZone, localAsUtc);
  utc = localAsUtc - offsetMs(timeZone, utc);
  return utc;
}

export class CronTool extends Tool {
  static scopes = new Set(["core"]);
  cron: CronService;
  defaultTimezone: string;
  channel = "";
  chatId = "";
  metadata: Record<string, any> = {};
  sessionKey = "";
  inCronContext = false;
  private readonly requestContext = new RequestContextStore();

  constructor(cronService?: CronService, defaultTimezone = "UTC") {
    super();
    this.cron = cronService ?? new CronService(process.cwd());
    this.defaultTimezone = defaultTimezone;
  }

  static enabled(ctx: any): boolean {
    return ctx.cronService != null;
  }

  static create<T extends typeof CronTool>(this: T, ctx: any): InstanceType<T> {
    return new (this as any)(ctx.cronService, ctx.timezone ?? "UTC") as InstanceType<T>;
  }

  setContext(ctx: RequestContext): void {
    this.requestContext.set(ctx);
    this.channel = ctx.channel ?? "";
    this.chatId = ctx.chatId ?? "";
    this.metadata = { ...(ctx.metadata ?? {}) };
    this.sessionKey = ctx.sessionKey ?? `${this.channel}:${this.chatId}`;
  }

  setCronContext(active: boolean): boolean {
    const previous = this.inCronContext;
    this.inCronContext = active;
    return previous;
  }

  resetCronContext(token: boolean): void {
    this.inCronContext = token;
  }

  get name(): string {
    return "cron";
  }

  get description(): string {
    return `Schedule reminders and recurring tasks. Actions: add, list, remove. If tz is omitted, cron expressions and naive ISO times default to ${this.defaultTimezone}.`;
  }

  get parameters() {
    return structuredClone(CRON_PARAMETERS);
  }

  validateParams(params: Record<string, any>): string[] {
    const errors = super.validateParams(params);
    const action = params.action;
    if (action === "add" && !String(params.message ?? "").trim()) {
      errors.push("message is required when action='add'");
    }
    if (action === "remove" && !String(params.job_id ?? params.jobId ?? "").trim()) {
      errors.push("job_id is required when action='remove'");
    }
    return errors;
  }

  async execute(params: {
    action?: string;
    name?: string | null;
    message?: string;
    every_seconds?: number | null;
    everySeconds?: number | null;
    cron_expr?: string | null;
    cronExpr?: string | null;
    tz?: string | null;
    at?: string | null;
    job_id?: string | null;
    jobId?: string | null;
    deliver?: boolean;
  } = {}): Promise<string> {
    const action = params.action ?? "list";
    if (action === "add") {
      if (this.inCronContext) return "Error: cannot schedule new jobs from within a cron job execution";
      return this.addJob(
        params.name ?? null,
        params.message ?? "",
        params.every_seconds ?? params.everySeconds ?? null,
        params.cron_expr ?? params.cronExpr ?? null,
        params.tz ?? null,
        params.at ?? null,
        params.deliver ?? true,
      );
    }
    if (action === "list") return this.listJobs();
    if (action === "remove") return this.removeJob(params.job_id ?? params.jobId ?? null);
    return `Unknown action: ${action}`;
  }

  addJob(
    name: string | null,
    message: string,
    everySeconds: number | null,
    cronExpr: string | null,
    tz: string | null,
    at: string | null,
    deliver = true,
  ): string {
    const requestContext = this.requestContext.get();
    const channel = requestContext?.channel ?? this.channel;
    const chatId = requestContext?.chatId ?? this.chatId;
    const metadata = requestContext ? { ...(requestContext.metadata ?? {}) } : this.metadata;
    const sessionKey = requestContext ? (requestContext.sessionKey ?? `${channel}:${chatId}`) : this.sessionKey;
    if (!message) {
      return (
        "Error: cron action='add' requires a non-empty 'message' parameter describing what to do when the job triggers " +
        '(e.g. the reminder text). Retry including message="...".'
      );
    }
    if (!channel || !chatId) return "Error: no session context (channel/chatId)";
    if (tz && !cronExpr) return "Error: tz can only be used with cron_expr";
    if (tz) {
      const err = validateTimezone(tz);
      if (err) return err;
    }

    let schedule: CronSchedule;
    let deleteAfterRun = false;
    if (everySeconds) {
      schedule = new CronSchedule({ kind: "every", everyMs: everySeconds * 1000 });
    } else if (cronExpr) {
      const effectiveTz = tz || this.defaultTimezone;
      const err = validateTimezone(effectiveTz);
      if (err) return err;
      schedule = new CronSchedule({ kind: "cron", expr: cronExpr, tz: effectiveTz });
    } else if (at) {
      let atMs: number | null = null;
      if (/[zZ]|[+-]\d{2}:\d{2}$/.test(at)) {
        const parsed = Date.parse(at);
        atMs = Number.isNaN(parsed) ? null : parsed;
      } else {
        const err = validateTimezone(this.defaultTimezone);
        if (err) return err;
        atMs = parseNaiveIsoInZone(at, this.defaultTimezone);
      }
      if (atMs == null) return `Error: invalid ISO datetime format '${at}'. Expected format: YYYY-MM-DDTHH:MM:SS`;
      schedule = new CronSchedule({ kind: "at", atMs });
      deleteAfterRun = true;
    } else {
      return "Error: either every_seconds, cron_expr, or at is required";
    }

    const job = this.cron.addJob({
      name: name || message.slice(0, 30),
      schedule,
      message,
      deliver,
      channel,
      to: chatId,
      deleteAfterRun,
      channelMeta: metadata,
      sessionKey: sessionKey || null,
    });
    return `Created job '${job.name}' (id: ${job.id})`;
  }

  displayTimezone(schedule: CronSchedule): string {
    return schedule.tz || this.defaultTimezone;
  }

  static formatTimestamp(ms: number, tzName: string): string {
    const p = zonedParts(ms, tzName);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} (${tzName})`;
  }

  formatTimestamp(ms: number, tzName: string): string {
    return CronTool.formatTimestamp(ms, tzName);
  }

  formatTiming(schedule: CronSchedule): string {
    if (schedule.kind === "cron") {
      const tz = schedule.tz ? ` (${schedule.tz})` : "";
      return `cron: ${schedule.expr}${tz}`;
    }
    if (schedule.kind === "every" && schedule.everyMs) {
      const ms = schedule.everyMs;
      if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`;
      if (ms % 60_000 === 0) return `every ${ms / 60_000}m`;
      if (ms % 1000 === 0) return `every ${ms / 1000}s`;
      return `every ${ms}ms`;
    }
    if (schedule.kind === "at" && schedule.atMs) {
      return `at ${this.formatTimestamp(schedule.atMs, this.displayTimezone(schedule))}`;
    }
    return schedule.kind;
  }

  formatState(state: CronJobState, schedule: CronSchedule): string[] {
    const lines: string[] = [];
    const displayTz = this.displayTimezone(schedule);
    if (state.lastRunAtMs) {
      let info = `  Last run: ${this.formatTimestamp(state.lastRunAtMs, displayTz)} - ${state.lastStatus || "unknown"}`;
      if (state.lastError) info += ` (${state.lastError})`;
      lines.push(info);
    }
    if (state.nextRunAtMs) lines.push(`  Next run: ${this.formatTimestamp(state.nextRunAtMs, displayTz)}`);
    return lines;
  }

  static systemJobPurpose(job: CronJob): string {
    if (job.name === "dream") return "Dream memory consolidation for long-term memory.";
    return "System-managed internal job.";
  }

  listJobs(): string {
    const jobs = this.cron.listJobs();
    if (!jobs.length) return "No scheduled jobs.";
    const lines: string[] = [];
    for (const job of jobs) {
      const parts = [`- ${job.name} (id: ${job.id}, ${this.formatTiming(job.schedule)})`];
      if (job.payload.kind === "systemEvent" || job.system) {
        parts.push(`  Purpose: ${CronTool.systemJobPurpose(job)}`);
        parts.push("  Protected: visible for inspection, but cannot be removed.");
      }
      parts.push(...this.formatState(job.state, job.schedule));
      lines.push(parts.join("\n"));
    }
    return `Scheduled jobs:\n${lines.join("\n")}`;
  }

  removeJob(jobId: string | null): string {
    if (!jobId) return "Error: job_id is required for remove";
    const result = this.cron.removeJob(jobId);
    if (result === "removed") return `Removed job ${jobId}`;
    if (result === "protected") {
      const job = this.cron.getJob(jobId);
      if (job?.name === "dream") {
        return (
          "Cannot remove job `dream`.\n" +
          "This is a system-managed Dream memory consolidation job for long-term memory.\n" +
          "It remains visible so you can inspect it, but it cannot be removed."
        );
      }
      return `Cannot remove job \`${jobId}\`.\nThis is a protected system-managed cron job.`;
    }
    return `Job ${jobId} not found`;
  }
}
