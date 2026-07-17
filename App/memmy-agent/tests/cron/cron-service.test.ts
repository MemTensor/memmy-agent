import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronSchedule as CronScheduleFromIndex, CronService as CronServiceFromIndex } from "../../src/cron/index.js";
import { CronService, ValueError } from "../../src/cron/service.js";
import { CronJob, CronPayload, CronSchedule } from "../../src/cron/types.js";

const services: CronService[] = [];
const roots: string[] = [];

function storePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-cron-service-"));
  roots.push(root);
  return path.join(root, "cron", "jobs.json");
}

async function waitUntil(predicate: () => boolean, timeout = 1000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  expect(predicate()).toBe(true);
}

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CronService", () => {
  it("exports service and schedule classes from the cron package entrypoint", () => {
    expect(CronServiceFromIndex).toBe(CronService);
    expect(CronScheduleFromIndex).toBe(CronSchedule);
  });

  it("rejects unknown cron timezones without adding a job", () => {
    const service = new CronService(storePath());

    expect(() =>
      service.addJob({
        name: "tz typo",
        schedule: new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "America/Vancovuer" }),
        message: "hello",
      }),
    ).toThrow(/unknown timezone 'America\/Vancovuer'/);
    expect(service.listJobs({ includeDisabled: true })).toEqual([]);
  });

  it("accepts valid cron timezones", () => {
    const service = new CronService(storePath());

    const job = service.addJob({
      name: "tz ok",
      schedule: new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "America/Vancouver" }),
      message: "hello",
    });

    expect(job.schedule.tz).toBe("America/Vancouver");
    expect(job.state.nextRunAtMs).not.toBeNull();
  });

  it("computes cron next runs from the expression and timezone", () => {
    vi.setSystemTime(new Date("2026-05-29T13:03:00.000Z")); // Friday 21:03 in Asia/Shanghai.
    const service = new CronService(storePath());

    const weekly = service.addJob({
      name: "weekly",
      schedule: new CronSchedule({ kind: "cron", expr: "0 17 * * 5", tz: "Asia/Shanghai" }),
      message: "hello",
    });
    const everyTwoHours = service.addJob({
      name: "two-hour",
      schedule: new CronSchedule({ kind: "cron", expr: "0 */2 * * *", tz: "UTC" }),
      message: "hello",
    });

    expect(new Date(weekly.state.nextRunAtMs!).toISOString()).toBe("2026-06-05T09:00:00.000Z");
    expect(new Date(everyTwoHours.state.nextRunAtMs!).toISOString()).toBe("2026-05-29T14:00:00.000Z");
  });

  it("computes cron next runs from weekday and month names", () => {
    vi.setSystemTime(new Date("2026-05-29T13:03:00.000Z")); // Friday.
    const service = new CronService(storePath());

    const weekdayName = service.addJob({
      name: "weekday-name",
      schedule: new CronSchedule({ kind: "cron", expr: "0 9 * * MON", tz: "UTC" }),
      message: "hello",
    });
    const monthName = service.addJob({
      name: "month-name",
      schedule: new CronSchedule({ kind: "cron", expr: "0 9 * JAN MON", tz: "UTC" }),
      message: "hello",
    });

    expect(new Date(weekdayName.state.nextRunAtMs!).toISOString()).toBe("2026-06-01T09:00:00.000Z");
    expect(new Date(monthName.state.nextRunAtMs!).toISOString()).toBe("2027-01-04T09:00:00.000Z");
  });

  it("leaves invalid and non-five-field cron expressions unscheduled", () => {
    const service = new CronService(storePath());

    const invalid = service.addJob({
      name: "invalid",
      schedule: new CronSchedule({ kind: "cron", expr: "not a cron", tz: "UTC" }),
      message: "hello",
    });
    const sixField = service.addJob({
      name: "six-field",
      schedule: new CronSchedule({ kind: "cron", expr: "0 0 0 1 1 *", tz: "UTC" }),
      message: "hello",
    });

    expect(invalid.state.nextRunAtMs).toBeNull();
    expect(sixField.state.nextRunAtMs).toBeNull();
  });

  it("preserves channel metadata and session key on added jobs", () => {
    const service = new CronService(storePath());
    const meta = { slack: { thread_ts: "1234567890.123456", channel_type: "channel" } };

    const job = service.addJob({
      name: "thread test",
      schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }),
      message: "hello",
      deliver: true,
      channel: "slack",
      to: "C123",
      channelMeta: meta,
      sessionKey: "slack:C123:1234567890.123456",
    });

    const reloaded = service.getJob(job.id);
    expect(job.payload.channelMeta).toEqual(meta);
    expect(job.payload.sessionKey).toBe("slack:C123:1234567890.123456");
    expect(reloaded?.payload.channelMeta).toEqual(meta);
    expect(reloaded?.payload.sessionKey).toBe("slack:C123:1234567890.123456");
  });

  it("persists channel metadata and session key through store reload", async () => {
    const file = storePath();
    const service = new CronService(file);
    services.push(service);
    await service.start();
    const meta = { slack: { thread_ts: "1234567890.123456", channel_type: "channel" } };

    const job = service.addJob({
      name: "thread test",
      schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }),
      message: "hello",
      deliver: true,
      channel: "slack",
      to: "C123",
      channelMeta: meta,
      sessionKey: "slack:C123:1234567890.123456",
    });
    service.stop();

    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.jobs[0].payload.channelMeta).toEqual(meta);
    expect(raw.jobs[0].payload.sessionKey).toBe("slack:C123:1234567890.123456");
    const reloaded = new CronService(file).getJob(job.id);
    expect(reloaded?.payload.channelMeta).toEqual(meta);
    expect(reloaded?.payload.sessionKey).toBe("slack:C123:1234567890.123456");
  });

  it("records successful run history", async () => {
    const service = new CronService(storePath(), { onJob: async () => undefined });
    const job = service.addJob({ name: "hist", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "hello" });

    await service.runJob(job.id);

    const loaded = service.getJob(job.id)!;
    expect(loaded.state.runHistory).toHaveLength(1);
    expect(loaded.state.runHistory[0].status).toBe("ok");
    expect(loaded.state.runHistory[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(loaded.state.runHistory[0].error).toBeNull();
  });

  it("records run history errors", async () => {
    const service = new CronService(storePath(), {
      onJob: async () => {
        throw new Error("boom");
      },
    });
    const job = service.addJob({ name: "fail", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "hello" });

    await service.runJob(job.id);

    const record = service.getJob(job.id)!.state.runHistory[0];
    expect(record.status).toBe("error");
    expect(record.error).toBe("boom");
  });

  it("trims run history to the maximum record count", async () => {
    const service = new CronService(storePath(), { onJob: async () => undefined });
    const job = service.addJob({ name: "trim", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "hello" });

    for (let i = 0; i < 25; i += 1) await service.runJob(job.id);

    expect(service.getJob(job.id)?.state.runHistory).toHaveLength(CronService.maxRunHistory);
  });

  it("persists run history to disk and reloads it", async () => {
    const file = storePath();
    const service = new CronService(file, { onJob: async () => undefined });
    const job = service.addJob({ name: "persist", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "hello" });

    await service.runJob(job.id);

    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const history = raw.jobs[0].state.runHistory;
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe("ok");
    expect(history[0].runAtMs).toBeDefined();
    expect(history[0].durationMs).toBeDefined();
    expect(new CronService(file).getJob(job.id)?.state.runHistory[0].status).toBe("ok");
  });

  it("does not run disabled jobs manually or flip running state", async () => {
    const service = new CronService(storePath(), { onJob: async () => undefined });
    const job = service.addJob({ name: "disabled", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "hello" });
    service.enableJob(job.id, false);

    expect(await service.runJob(job.id)).toBe(false);
    expect(service.running).toBe(false);
  });

  it("preserves running service state around forced manual runs", async () => {
    const service = new CronService(storePath(), { onJob: async () => undefined });
    service.running = true;
    const job = service.addJob({ name: "manual", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "hello" });

    expect(await service.runJob(job.id, true)).toBe(true);
    expect(service.running).toBe(true);
    service.stop();
  });

  it("honors an external disable while the service is running", async () => {
    const file = storePath();
    const called: string[] = [];
    const service = new CronService(file, { onJob: async (job) => { called.push(job.id); }, maxSleepMs: 50 });
    services.push(service);
    const job = service.addJob({ name: "external-disable", schedule: new CronSchedule({ kind: "every", everyMs: 200 }), message: "hello" });
    await service.start();

    const updated = new CronService(file).enableJob(job.id, false);
    expect(updated?.enabled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(called).toEqual([]);
  });

  it("refuses to remove system jobs", () => {
    const service = new CronService(storePath());
    service.registerSystemJob(
      new CronJob({
        id: "dream",
        name: "dream",
        schedule: new CronSchedule({ kind: "cron", expr: "0 */2 * * *", tz: "UTC" }),
        payload: new CronPayload({ kind: "systemEvent" }),
      }),
    );

    expect(service.removeJob("dream")).toBe("protected");
    expect(service.getJob("dream")).not.toBeNull();
  });

  it("running services see jobs added by another instance", async () => {
    const file = storePath();
    const called: string[] = [];
    const service = new CronService(file, { onJob: async (job) => { called.push(job.name); }, maxSleepMs: 100 });
    services.push(service);
    await service.start();
    expect(service.listJobs()).toHaveLength(0);

    new CronService(file).addJob({ name: "hist", schedule: new CronSchedule({ kind: "every", everyMs: 100 }), message: "hello" });

    expect(service.listJobs()).toHaveLength(1);
    await waitUntil(() => called.length > 0, 800);
  });

  it("does not delay subsecond jobs to one second", async () => {
    const called: string[] = [];
    const service = new CronService(storePath(), { onJob: async (job) => { called.push(job.name); }, maxSleepMs: 5000 });
    services.push(service);
    service.addJob({ name: "fast", schedule: new CronSchedule({ kind: "every", everyMs: 100 }), message: "hello" });

    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(called).not.toEqual([]);
  });

  it("running services pick up externally added due jobs", async () => {
    const file = storePath();
    const called: string[] = [];
    const service = new CronService(file, { onJob: async (job) => { called.push(job.name); }, maxSleepMs: 100 });
    services.push(service);
    service.addJob({ name: "heartbeat", schedule: new CronSchedule({ kind: "every", everyMs: 100 }), message: "tick" });
    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 50));

    new CronService(file).addJob({ name: "external", schedule: new CronSchedule({ kind: "every", everyMs: 100 }), message: "ping" });

    await waitUntil(() => called.includes("external"), 800);
  });

  it("detects jobs added while another job is executing", async () => {
    const file = storePath();
    let runOnce = true;
    const service = new CronService(file, {
      onJob: async () => {
        if (!runOnce) return;
        new CronService(file, { onJob: async () => undefined }).addJob({
          name: "test",
          schedule: new CronSchedule({ kind: "every", everyMs: 150 }),
          message: "tick",
        });
        runOnce = false;
      },
      maxSleepMs: 100,
    });
    services.push(service);
    service.addJob({ name: "heartbeat", schedule: new CronSchedule({ kind: "every", everyMs: 100 }), message: "tick" });
    expect(service.listJobs()).toHaveLength(1);

    await service.start();
    await waitUntil(() => service.listJobs().length === 2, 800);
    expect(service.listJobs().map((job) => job.name)).toContain("test");
  });

  it("preserves run history across external updates", async () => {
    const file = storePath();
    const service = new CronService(file, { onJob: async () => undefined });
    const job = service.addJob({ name: "history", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "hello" });
    await service.runJob(job.id, true);

    expect(new CronService(file).enableJob(job.id, false)).not.toBeNull();
    const fresh = new CronService(file);
    const loaded = fresh.getJob(job.id);

    expect(loaded?.state.runHistory[0].status).toBe("ok");
    fresh.running = true;
    fresh.saveStore();
  });

  it("does not roll timer execution back when listJobs reloads during a timer", async () => {
    const file = storePath();
    const calls: string[] = [];
    const service = new CronService(file, {
      onJob: async (job) => {
        calls.push(job.id);
        service.listJobs({ includeDisabled: true });
        await Promise.resolve();
      },
    });
    service.running = true;
    service.loadStore();
    service.armTimer = () => undefined;
    const job = service.addJob({ name: "race", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "hello" });
    job.state.nextRunAtMs = job.state.nextRunAtMs = Math.max(1, Date.now() - 1000);
    service.saveStore();

    await service.onTimer();
    await service.onTimer();

    expect(calls).toEqual([job.id]);
    const loaded = service.getJob(job.id)!;
    expect(loaded.state.lastRunAtMs).not.toBeNull();
    expect(loaded.state.nextRunAtMs).not.toBeNull();
    expect(loaded.state.nextRunAtMs!).toBeGreaterThan(loaded.state.lastRunAtMs!);
  });

  it("updates job names without changing the message", () => {
    const service = new CronService(storePath());
    const job = service.addJob({ name: "old name", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "hello" });

    const result = service.updateJob(job.id, { name: "new name" });

    expect(result).toBeInstanceOf(CronJob);
    expect((result as CronJob).name).toBe("new name");
    expect((result as CronJob).payload.message).toBe("hello");
  });

  it("updates schedules and recomputes next run", () => {
    const service = new CronService(storePath());
    const job = service.addJob({ name: "sched", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "hello" });
    const oldNext = job.state.nextRunAtMs;

    const result = service.updateJob(job.id, { schedule: new CronSchedule({ kind: "every", everyMs: 120_000 }) });

    expect(result).toBeInstanceOf(CronJob);
    expect((result as CronJob).schedule.everyMs).toBe(120_000);
    expect((result as CronJob).state.nextRunAtMs).not.toBe(oldNext);
  });

  it("updates job messages", () => {
    const service = new CronService(storePath());
    const job = service.addJob({ name: "msg", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "old message" });

    const result = service.updateJob(job.id, { message: "new message" });

    expect(result).toBeInstanceOf(CronJob);
    expect((result as CronJob).payload.message).toBe("new message");
  });

  it("updates cron expressions", () => {
    const service = new CronService(storePath());
    const job = service.addJob({ name: "cron-job", schedule: new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }), message: "hello" });

    const result = service.updateJob(job.id, { schedule: new CronSchedule({ kind: "cron", expr: "0 18 * * *", tz: "UTC" }) });

    expect(result).toBeInstanceOf(CronJob);
    expect((result as CronJob).schedule.expr).toBe("0 18 * * *");
    expect((result as CronJob).state.nextRunAtMs).not.toBeNull();
  });

  it("returns not_found when updating an unknown job", () => {
    expect(new CronService(storePath()).updateJob("nonexistent", { name: "x" })).toBe("not_found");
  });

  it("rejects updates to system jobs", () => {
    const service = new CronService(storePath());
    service.registerSystemJob(
      new CronJob({
        id: "dream",
        name: "dream",
        schedule: new CronSchedule({ kind: "cron", expr: "0 */2 * * *", tz: "UTC" }),
        payload: new CronPayload({ kind: "systemEvent" }),
      }),
    );

    expect(service.updateJob("dream", { name: "hacked" })).toBe("protected");
    expect(service.getJob("dream")?.name).toBe("dream");
  });

  it("validates updated schedules", () => {
    const service = new CronService(storePath());
    const job = service.addJob({ name: "validate", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "hello" });

    expect(() => service.updateJob(job.id, { schedule: new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "Bad/Zone" }) })).toThrow(ValueError);
  });

  it("preserves run history when updating a job", async () => {
    const service = new CronService(storePath(), { onJob: async () => undefined });
    const job = service.addJob({ name: "hist", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "hello" });
    await service.runJob(job.id);

    const result = service.updateJob(job.id, { name: "renamed" });

    expect(result).toBeInstanceOf(CronJob);
    expect((result as CronJob).state.runHistory).toHaveLength(1);
    expect((result as CronJob).state.runHistory[0].status).toBe("ok");
  });

  it("writes an offline update action", () => {
    const file = storePath();
    const service = new CronService(file);
    const job = service.addJob({ name: "offline", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "hello" });

    service.updateJob(job.id, { name: "updated-offline" });

    const actionPath = path.join(path.dirname(file), "action.jsonl");
    const lines = fs.readFileSync(actionPath, "utf8").trim().split(/\n/).filter(Boolean);
    const last = JSON.parse(lines.at(-1)!);
    expect(last.action).toBe("update");
    expect(last.params.name).toBe("updated-offline");
  });

  it("uses sentinel semantics for channel and to updates", () => {
    const service = new CronService(storePath());
    const job = service.addJob({ name: "sentinel", schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }), message: "hello", channel: "telegram", to: "user123" });

    expect((service.updateJob(job.id, { name: "renamed" }) as CronJob).payload.channel).toBe("telegram");
    const cleared = service.updateJob(job.id, { channel: null, to: null });

    expect(cleared).toBeInstanceOf(CronJob);
    expect((cleared as CronJob).payload.channel).toBeNull();
    expect((cleared as CronJob).payload.to).toBeNull();
  });

  it("does not stale-reload jobs when listJobs is called during onJob execution", async () => {
    const file = storePath();
    let executionCount = 0;
    const service = new CronService(file, {
      onJob: async () => {
        executionCount += 1;
        service.listJobs();
      },
      maxSleepMs: 100,
    });
    services.push(service);
    await service.start();
    const now = Date.now();
    for (const name of ["job-a", "job-b"]) {
      service.addJob({ name, schedule: new CronSchedule({ kind: "every", everyMs: 3_600_000 }), message: "test" });
    }
    for (const job of service.store!.jobs) job.state.nextRunAtMs = job.state.nextRunAtMs = now - 1000;
    service.saveStore();
    service.armTimer();

    await new Promise((resolve) => setTimeout(resolve, 300));
    service.stop();

    expect(executionCount).toBe(2);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const job of raw.jobs) expect(job.state.nextRunAtMs).toBeGreaterThan(now);
  });
});
