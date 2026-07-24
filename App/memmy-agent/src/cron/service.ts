import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CronExpressionParser } from "cron-parser";
import * as lockfile from "proper-lockfile";
import { CronJob, CronJobState, CronPayload, CronRunRecord, CronSchedule, CronStore } from "./types.js";

export type CronJobCallback = (job: CronJob) => Promise<void | string | null> | void | string | null;

export class ValueError extends Error {}
export class RuntimeError extends Error {}

function nowMs(): number {
  return Date.now();
}

function isJsonPath(value: string): boolean {
  return value.endsWith(".json");
}

function validTimezone(tz: string | null | undefined): boolean {
  if (!tz) return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function computeCronNextRun(expr: string, baseMs: number, timeZone?: string | null): number | null {
  if (expr.trim().split(/\s+/).length !== 5) return null;
  try {
    const interval = CronExpressionParser.parse(expr, {
      currentDate: new Date(baseMs),
      tz: timeZone ?? undefined,
    });
    const next = interval.next().getTime();
    return Number.isFinite(next) ? next : null;
  } catch {
    return null;
  }
}

function validateScheduleForAdd(schedule: CronSchedule): void {
  if (schedule.tz && schedule.kind !== "cron") throw new ValueError("tz can only be used with cron schedules");
  if (schedule.kind === "cron" && schedule.tz && !validTimezone(schedule.tz)) {
    throw new ValueError(`unknown timezone '${schedule.tz}'`);
  }
}

function computeNextRun(schedule: CronSchedule, baseMs = nowMs()): number | null {
  if (schedule.kind === "at") {
    const at = schedule.atMs ?? (schedule.at ? Date.parse(schedule.at) : null);
    return at != null && !Number.isNaN(at) && at > baseMs ? at : null;
  }
  if (schedule.kind === "every") {
    if (!schedule.everyMs || schedule.everyMs <= 0) return null;
    return baseMs + schedule.everyMs;
  }
  if (schedule.kind === "cron" && schedule.expr) {
    return computeCronNextRun(schedule.expr, baseMs, schedule.tz);
  }
  return null;
}

function closeQuietly(fd: number | null): void {
  if (fd != null) {
    try {
      fs.closeSync(fd);
    } catch {
      // Best-effort fsync path.
    }
  }
}

type CronServiceOptions = {
  onJob?: CronJobCallback;
  maxSleepMs?: number;
};

const OMIT = Symbol("omit");
const ACTION_LOCK_STALE_MS = 10_000;
const ACTION_LOCK_TIMEOUT_MS = 10_000;
const ACTION_LOCK_RETRY_MS = 20;
const ACTION_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(ACTION_LOCK_SLEEP, 0, 0, ms);
}

function isLockHeldError(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ELOCKED";
}

export class CronService {
  static readonly maxRunHistory = 20;

  storePath: string;
  root: string;
  private actionPath: string;
  onJob?: CronJobCallback;
  store: CronStore | null = null;
  private timerTask: NodeJS.Timeout | null = null;
  running = false;
  private timerActive = false;
  maxSleepMs: number;

  constructor(storePath: string, options: CronServiceOptions | CronJobCallback = {}, maxSleepMs = 300_000) {
    this.storePath = path.resolve(String(storePath));
    if (!isJsonPath(this.storePath)) this.storePath = path.join(this.storePath, "jobs.json");
    this.root = path.dirname(this.storePath);
    this.actionPath = path.join(this.root, "action.jsonl");

    if (typeof options === "function") {
      this.onJob = options;
      this.maxSleepMs = maxSleepMs;
    } else {
      this.onJob = options.onJob;
      this.maxSleepMs = options.maxSleepMs ?? maxSleepMs;
    }
  }

  loadJobs(): [CronJob[], number] | null {
    const jobs: CronJob[] = [];
    let version = 1;
    if (!fs.existsSync(this.storePath)) return [jobs, version];

    try {
      const data = JSON.parse(fs.readFileSync(this.storePath, "utf8"));
      const rawJobs = Array.isArray(data) ? data : (data.jobs ?? []);
      version = Array.isArray(data) ? 1 : (data.version ?? 1);
      for (const raw of rawJobs) jobs.push(new CronJob(raw));
      return [jobs, version];
    } catch {
      const backup = `${this.storePath}.corrupt-${Math.floor(Date.now() / 1000)}`;
      try {
        fs.renameSync(this.storePath, backup);
      } catch {
        // Preserve the signal by returning null even if the rename fails.
      }
      return null;
    }
  }

  private mergeAction(): void {
    const store = this.store;
    if (!store || !fs.existsSync(this.actionPath)) return;
    this.withActionLock(() => {
      if (!fs.existsSync(this.actionPath)) return;
      const jobs = new Map(store.jobs.map((job) => [job.id, job]));
      let changed = false;

      for (const rawLine of fs.readFileSync(this.actionPath, "utf8").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          const action = entry.action;
          const params = entry.params ?? {};
          if (action === "del") {
            const jobId = params.jobId;
            if (jobId) jobs.delete(jobId);
          } else if (action === "add" || action === "update") {
            const job = CronJob.fromObject(params);
            jobs.set(job.id, job);
          } else {
            continue;
          }
          changed = true;
        } catch {
          continue;
        }
      }

      store.jobs = [...jobs.values()];
      if (this.running && changed) {
        fs.writeFileSync(this.actionPath, "", "utf8");
        this.saveStore();
      }
    });
  }

  loadStore(): CronStore | null {
    if (this.timerActive && this.store) return this.store;
    const loaded = this.loadJobs();
    if (loaded === null) return this.store ?? null;
    const [jobs, version] = loaded;
    this.store = new CronStore({ version, jobs });
    this.mergeAction();
    return this.store;
  }

  private atomicWrite(target: string, content: string): void {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(tmp, "w");
      fs.writeFileSync(fd, content, "utf8");
      fs.fsyncSync(fd);
      closeQuietly(fd);
      fd = null;
      fs.renameSync(tmp, target);
      if (os.platform() !== "win32") {
        let dirFd: number | null = null;
        try {
          dirFd = fs.openSync(path.dirname(target), "r");
          fs.fsyncSync(dirFd);
        } catch {
          // Directory fsync is not universally available.
        } finally {
          closeQuietly(dirFd);
        }
      }
    } catch (err) {
      closeQuietly(fd);
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Ignore absent temp files.
      }
      throw err;
    }
  }

  saveStore(): void {
    if (!this.store) return;
    const body = JSON.stringify(this.store.toObject(), null, 2);
    this.atomicWrite(this.storePath, body);
  }

  private withActionLock<T>(fn: () => T): T {
    fs.mkdirSync(this.root, { recursive: true });
    const started = performance.now();
    let release: (() => void) | null = null;
    while (!release) {
      try {
        release = lockfile.lockSync(this.root, {
          realpath: false,
          stale: ACTION_LOCK_STALE_MS,
        });
      } catch (err) {
        const elapsed = performance.now() - started;
        if (!isLockHeldError(err) || elapsed >= ACTION_LOCK_TIMEOUT_MS) throw err;
        sleepSync(Math.min(ACTION_LOCK_RETRY_MS, ACTION_LOCK_TIMEOUT_MS - elapsed));
      }
    }
    try {
      return fn();
    } finally {
      release();
    }
  }

  async start(): Promise<void> {
    this.running = true;
    const loaded = this.loadStore();
    if (loaded === null) {
      this.running = false;
      throw new RuntimeError(`cron store at ${this.storePath} is corrupt and was preserved; refusing to start`);
    }
    this.recomputeNextRuns();
    this.saveStore();
    this.armTimer();
  }

  stop(): void {
    this.running = false;
    if (this.timerTask) clearTimeout(this.timerTask);
    this.timerTask = null;
  }

  recomputeNextRuns(): void {
    if (!this.store) return;
    const now = nowMs();
    for (const job of this.store.jobs) {
      if (job.enabled) job.state.nextRunAtMs = computeNextRun(job.schedule, now);
    }
  }

  getNextWakeMs(): number | null {
    if (!this.store) return null;
    const times = this.store.jobs
      .filter((job) => job.enabled && job.state.nextRunAtMs != null)
      .map((job) => job.state.nextRunAtMs as number);
    return times.length ? Math.min(...times) : null;
  }

  armTimer(): void {
    if (this.timerTask) clearTimeout(this.timerTask);
    this.timerTask = null;
    if (!this.running) return;

    const nextWake = this.getNextWakeMs();
    const delayMs = nextWake == null ? this.maxSleepMs : Math.min(this.maxSleepMs, Math.max(0, nextWake - nowMs()));
    this.timerTask = setTimeout(() => {
      void this.onTimer();
    }, delayMs);
    this.timerTask.unref?.();
  }

  async onTimer(): Promise<void> {
    this.loadStore();
    if (!this.store) {
      this.armTimer();
      return;
    }

    this.timerActive = true;
    try {
      const now = nowMs();
      const dueJobs = this.store.jobs.filter(
        (job) => job.enabled && job.state.nextRunAtMs != null && now >= job.state.nextRunAtMs,
      );
      for (const job of dueJobs) await this.executeJob(job);
      this.saveStore();
    } finally {
      this.timerActive = false;
    }
    this.armTimer();
  }

  async executeJob(job: CronJob): Promise<void> {
    const started = nowMs();
    try {
      await this.onJob?.(job);
      job.state.lastStatus = "ok";
      job.state.lastError = null;
    } catch (err) {
      job.state.lastStatus = "error";
      job.state.lastError = err instanceof Error ? err.message : String(err);
    }

    const ended = nowMs();
    job.state.lastRunAtMs = started;
    job.updatedAtMs = ended;
    job.state.runHistory.push(
      new CronRunRecord({
        runAtMs: started,
        status: job.state.lastStatus ?? "ok",
        durationMs: Math.max(0, ended - started),
        error: job.state.lastError,
      }),
    );
    job.state.runHistory = job.state.runHistory.slice(-CronService.maxRunHistory);

    if (job.schedule.kind === "at") {
      if (job.deleteAfterRun && this.store) {
        this.store.jobs = this.store.jobs.filter((row) => row.id !== job.id);
      } else {
        job.enabled = false;
        job.state.nextRunAtMs = null;
      }
    } else {
      job.state.nextRunAtMs = computeNextRun(job.schedule, nowMs());
    }
  }

  private appendAction(action: "add" | "del" | "update", params: Record<string, any>): void {
    this.withActionLock(() => {
      fs.appendFileSync(this.actionPath, `${JSON.stringify({ action, params })}\n`, "utf8");
    });
  }

  listJobs(options: { includeDisabled?: boolean } | boolean = {}): CronJob[] {
    const includeDisabled = typeof options === "boolean" ? options : (options.includeDisabled ?? false);
    const store = this.loadStore();
    const jobs = store?.jobs ?? [];
    return jobs
      .filter((job) => includeDisabled || job.enabled)
      .toSorted((a, b) => (a.state.nextRunAtMs ?? Number.POSITIVE_INFINITY) - (b.state.nextRunAtMs ?? Number.POSITIVE_INFINITY));
  }

  list(): CronJob[] {
    return this.listJobs({ includeDisabled: true });
  }

  add(job: CronJob): void {
    const store = this.loadStore() ?? new CronStore();
    this.store = store;
    store.jobs = store.jobs.filter((row) => row.id !== job.id);
    store.jobs.push(job);
    this.saveStore();
    this.armTimer();
  }

  addJob({
    name,
    schedule,
    message = "",
    deliver = false,
    channel = null,
    to = null,
    deleteAfterRun = false,
    channelMeta = null,
    sessionKey = null,
  }: {
    name: string;
    schedule: CronSchedule;
    message?: string;
    deliver?: boolean;
    channel?: string | null;
    to?: string | null;
    deleteAfterRun?: boolean;
    channelMeta?: Record<string, any> | null;
    sessionKey?: string | null;
  }): CronJob {
    validateScheduleForAdd(schedule);
    const now = nowMs();
    const job = new CronJob({
      id: randomUUID().slice(0, 8),
      name,
      enabled: true,
      schedule,
      payload: new CronPayload({
        kind: "agentTurn",
        message,
        prompt: message,
        deliver,
        channel,
        to,
        channelMeta: channelMeta ?? {},
        sessionKey,
      }),
      state: new CronJobState({ nextRunAtMs: computeNextRun(schedule, now) }),
      createdAtMs: now,
      updatedAtMs: now,
      deleteAfterRun,
    });

    if (this.running) {
      const store = this.loadStore() ?? new CronStore();
      this.store = store;
      store.jobs.push(job);
      this.saveStore();
      this.armTimer();
    } else {
      this.appendAction("add", job.toObject());
    }
    return job;
  }

  registerSystemJob(job: CronJob): CronJob {
    const store = this.loadStore() ?? new CronStore();
    this.store = store;
    const now = nowMs();
    job.system = true;
    job.state = new CronJobState({ nextRunAtMs: computeNextRun(job.schedule, now) });
    job.createdAtMs = now;
    job.updatedAtMs = now;
    store.jobs = store.jobs.filter((row) => row.id !== job.id);
    store.jobs.push(job);
    this.saveStore();
    this.armTimer();
    return job;
  }

  unregisterSystemJob(jobId: string): boolean {
    const store = this.loadStore();
    if (!store) return false;
    const jobs = store.jobs.filter(
      (job) =>
        job.id !== jobId ||
        (job.payload.kind !== "systemEvent" && job.system !== true),
    );
    if (jobs.length === store.jobs.length) return false;
    store.jobs = jobs;
    this.saveStore();
    this.armTimer();
    return true;
  }

  removeJob(jobId: string): "removed" | "protected" | "not_found" {
    const store = this.loadStore();
    const job = store?.jobs.find((row) => row.id === jobId);
    if (!store || !job) return "not_found";
    if (job.payload.kind === "systemEvent" || job.system) return "protected";
    store.jobs = store.jobs.filter((row) => row.id !== jobId);
    if (this.running) {
      this.saveStore();
      this.armTimer();
    } else {
      this.appendAction("del", { jobId });
    }
    return "removed";
  }

  remove(jobId: string): boolean {
    return this.removeJob(jobId) === "removed";
  }

  enableJob(jobId: string, options: { enabled?: boolean } | boolean = true): CronJob | null {
    const enabled = typeof options === "boolean" ? options : (options.enabled ?? true);
    const store = this.loadStore();
    const job = store?.jobs.find((row) => row.id === jobId);
    if (!store || !job) return null;
    job.enabled = enabled;
    job.updatedAtMs = nowMs();
    job.state.nextRunAtMs = enabled ? computeNextRun(job.schedule, nowMs()) : null;
    if (this.running) {
      this.saveStore();
      this.armTimer();
    } else {
      this.appendAction("update", job.toObject());
    }
    return job;
  }

  updateJob(
    jobId: string,
    {
      name,
      schedule,
      message,
      deliver,
      channel = OMIT,
      to = OMIT,
      deleteAfterRun,
    }: {
      name?: string | null;
      schedule?: CronSchedule | null;
      message?: string | null;
      deliver?: boolean | null;
      channel?: string | null | typeof OMIT;
      to?: string | null | typeof OMIT;
      deleteAfterRun?: boolean | null;
    } = {},
  ): CronJob | "not_found" | "protected" {
    const store = this.loadStore();
    const job = store?.jobs.find((row) => row.id === jobId);
    if (!store || !job) return "not_found";
    if (job.payload.kind === "systemEvent" || job.system) return "protected";

    if (schedule != null) {
      validateScheduleForAdd(schedule);
      job.schedule = schedule;
    }
    if (name != null) job.name = name;
    if (message != null) {
      job.payload.message = message;
      job.payload.prompt = message;
    }
    if (deliver != null) job.payload.deliver = deliver;
    if (channel !== OMIT) job.payload.channel = channel;
    if (to !== OMIT) {
      job.payload.to = to;
      job.payload.chatId = to;
    }
    if (deleteAfterRun != null) {
      job.deleteAfterRun = deleteAfterRun;
    }

    job.updatedAtMs = nowMs();
    if (job.enabled) job.state.nextRunAtMs = computeNextRun(job.schedule, nowMs());
    if (this.running) {
      this.saveStore();
      this.armTimer();
    } else {
      this.appendAction("update", job.toObject());
    }
    return job;
  }

  async runJob(jobId: string, options: { force?: boolean } | boolean = {}): Promise<boolean> {
    const force = typeof options === "boolean" ? options : (options.force ?? false);
    const wasRunning = this.running;
    this.running = true;
    try {
      const store = this.loadStore();
      const job = store?.jobs.find((row) => row.id === jobId);
      if (!store || !job) return false;
      if (!force && !job.enabled) return false;
      await this.executeJob(job);
      this.saveStore();
      return true;
    } finally {
      this.running = wasRunning;
      if (wasRunning) this.armTimer();
    }
  }

  getJob(jobId: string): CronJob | null {
    const store = this.loadStore();
    return store?.jobs.find((row) => row.id === jobId) ?? null;
  }

  status(): { enabled: boolean; jobs: number; nextWakeAtMs: number | null } {
    const store = this.loadStore();
    const next = this.getNextWakeMs();
    return {
      enabled: this.running,
      jobs: store?.jobs.length ?? 0,
      nextWakeAtMs: next,
    };
  }
}
