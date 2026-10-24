import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService, type CronJobCallback } from "../../src/cron/service.js";
import { CronJob, CronSchedule } from "../../src/cron/types.js";

const services: CronService[] = [];
const roots: string[] = [];
const time = (value: string) => Date.parse(`2026-10-12T${value}+08:00`);

function storePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-cron-recovery-"));
  roots.push(root);
  return path.join(root, "cron", "jobs.json");
}

async function start(file: string, onJob?: CronJobCallback, realTimer = false): Promise<CronService> {
  const service = new CronService(file, { onJob });
  services.push(service);
  if (!realTimer) vi.spyOn(service, "armTimer").mockImplementation(() => undefined);
  await service.start();
  return service;
}

function addMonitor(service: CronService): CronJob {
  return service.addJob({
    name: "monitor",
    schedule: new CronSchedule({ kind: "every", everyMs: 120_000 }),
    message: "check messages",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(time("20:03:00"));
});

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CronService restart and interval recovery", () => {
  it("retains future interval and cron deadlines across a restart", async () => {
    const file = storePath();
    const original = await start(file);
    const interval = addMonitor(original);
    const cron = original.addJob({
      name: "cron",
      schedule: new CronSchedule({ kind: "cron", expr: "*/2 * * * *", tz: "Asia/Shanghai" }),
    });
    original.stop();
    vi.setSystemTime(time("20:03:30"));
    const calls: string[] = [];
    const restarted = await start(file, (job) => { calls.push(job.name); });

    expect(restarted.getJob(interval.id)?.state.nextRunAtMs).toBe(time("20:05:00"));
    expect(restarted.getJob(cron.id)?.state.nextRunAtMs).toBe(time("20:04:00"));
    await restarted.onTimer();
    expect(calls).toEqual([]);
    vi.setSystemTime(time("20:04:00"));
    await restarted.onTimer();
    vi.setSystemTime(time("20:05:00"));
    await restarted.onTimer();
    expect(calls).toEqual(["cron", "monitor"]);
  });

  it("recovers one overdue interval run and preserves its phase without a catch-up burst", async () => {
    const file = storePath();
    const original = await start(file);
    const monitor = addMonitor(original);
    original.stop();
    vi.setSystemTime(time("20:10:30"));
    const onJob = vi.fn(() => { vi.setSystemTime(Date.now() + 22_000); });
    const restarted = await start(file, onJob);

    expect(restarted.getJob(monitor.id)?.state.nextRunAtMs).toBe(time("20:05:00"));
    await restarted.onTimer();
    await restarted.onTimer();
    expect(onJob).toHaveBeenCalledTimes(1);
    expect(restarted.getJob(monitor.id)?.state.nextRunAtMs).toBe(time("20:11:00"));

    vi.setSystemTime(time("20:11:00"));
    await restarted.onTimer();
    expect(onJob).toHaveBeenCalledTimes(2);
    expect(restarted.getJob(monitor.id)?.state.nextRunAtMs).toBe(time("20:13:00"));
    expect(new CronService(file).getJob(monitor.id)?.state.nextRunAtMs).toBe(time("20:13:00"));
  });

  it("skips intervals elapsed during a long execution and uses the first future phase", async () => {
    const service = await start(storePath(), () => { vi.setSystemTime(time("20:11:00")); });
    const monitor = addMonitor(service);
    vi.setSystemTime(time("20:05:00"));

    await service.onTimer();

    expect(service.getJob(monitor.id)?.state.nextRunAtMs).toBe(time("20:13:00"));
    expect(service.getJob(monitor.id)?.state.runHistory).toHaveLength(1);
  });

  it("restores overdue one-time tasks with missing deadlines and executes each only once", async () => {
    const file = storePath();
    const original = await start(file);
    const deleted = original.addJob({
      name: "delete after run",
      schedule: new CronSchedule({ kind: "at", atMs: time("20:05:00") }),
      deleteAfterRun: true,
    });
    const retained = original.addJob({
      name: "retain history",
      schedule: new CronSchedule({ kind: "at", at: "2026-10-12T20:06:00+08:00" }),
    });
    deleted.state.nextRunAtMs = null;
    retained.state.nextRunAtMs = null;
    original.saveStore();
    original.stop();
    vi.setSystemTime(time("20:08:00"));
    const onJob = vi.fn();
    const restarted = await start(file, onJob);

    expect(restarted.getJob(deleted.id)?.state.nextRunAtMs).toBe(time("20:05:00"));
    expect(restarted.getJob(retained.id)?.state.nextRunAtMs).toBe(time("20:06:00"));
    await restarted.onTimer();
    await restarted.onTimer();
    expect(onJob.mock.calls.map(([job]) => job.name)).toEqual(["delete after run", "retain history"]);
    expect(restarted.getJob(deleted.id)).toBeNull();
    expect(restarted.getJob(retained.id)?.enabled).toBe(false);
    expect(restarted.getJob(retained.id)?.state.nextRunAtMs).toBeNull();
    expect(new CronService(file).getJob(retained.id)?.state.runHistory).toHaveLength(1);
  });

  it("runs overdue one-time tasks in deadline order before a monitor that the stop task removes", async () => {
    const file = storePath();
    const original = await start(file);
    const monitor = addMonitor(original);
    original.addJob({ name: "stop", schedule: new CronSchedule({ kind: "at", atMs: time("20:15:00") }) });
    original.addJob({ name: "earlier once", schedule: new CronSchedule({ kind: "at", atMs: time("20:14:00") }) });
    original.stop();
    vi.setSystemTime(time("20:16:00"));
    const calls: string[] = [];
    const restarted = await start(file, (job) => {
      calls.push(job.name);
      if (job.name === "stop") expect(restarted.removeJob(monitor.id)).toBe("removed");
    });

    await restarted.onTimer();

    expect(calls).toEqual(["earlier once", "stop"]);
    expect(restarted.getJob(monitor.id)).toBeNull();
    expect(new CronService(file).getJob(monitor.id)).toBeNull();
  });

  it("rechecks newly due stop tasks after a slow monitor returns", async () => {
    const calls: string[] = [];
    let monitorId = "";
    const service = await start(storePath(), (job) => {
      calls.push(job.name);
      if (job.name === "monitor") vi.setSystemTime(time("20:15:10"));
      if (job.name === "stop") service.removeJob(monitorId);
    });
    monitorId = addMonitor(service).id;
    service.addJob({ name: "stop", schedule: new CronSchedule({ kind: "at", atMs: time("20:15:00") }) });
    vi.setSystemTime(time("20:13:00"));

    await service.onTimer();

    expect(calls).toEqual(["monitor", "stop"]);
    expect(service.getJob(monitorId)).toBeNull();
  });

  it.each(["remove", "disable", "reschedule"] as const)("rechecks a pending job after another callback chooses to %s it", async (action) => {
    let pendingId = "";
    const calls: string[] = [];
    const service = await start(storePath(), (job) => {
      calls.push(job.name);
      if (job.name !== "first") return;
      if (action === "remove") service.removeJob(pendingId);
      if (action === "disable") service.enableJob(pendingId, false);
      if (action === "reschedule") service.updateJob(pendingId, {
        schedule: new CronSchedule({ kind: "every", everyMs: 300_000 }),
      });
    });
    pendingId = addMonitor(service).id;
    service.addJob({ name: "first", schedule: new CronSchedule({ kind: "at", atMs: time("20:05:00") }) });
    vi.setSystemTime(time("20:05:00"));

    await service.onTimer();

    expect(calls).toEqual(["first"]);
    if (action === "remove") expect(service.getJob(pendingId)).toBeNull();
    if (action === "disable") expect(service.getJob(pendingId)?.state.nextRunAtMs).toBeNull();
    if (action === "reschedule") expect(service.getJob(pendingId)?.state.nextRunAtMs).toBe(time("20:10:00"));
  });

  it.each(["remove", "disable", "reschedule"] as const)("does not overwrite a running one-time task's %s action on completion", async (action) => {
    const service = await start(storePath(), (job) => {
      if (action === "remove") service.removeJob(job.id);
      if (action === "disable") service.enableJob(job.id, false);
      if (action === "reschedule") service.updateJob(job.id, {
        schedule: new CronSchedule({ kind: "every", everyMs: 300_000 }),
      });
      vi.setSystemTime(time("20:05:30"));
    });
    const job = service.addJob({
      name: "editable once",
      schedule: new CronSchedule({ kind: "at", atMs: time("20:05:00") }),
      deleteAfterRun: true,
    });
    vi.setSystemTime(time("20:05:00"));

    await service.onTimer();

    const saved = new CronService(service.storePath).getJob(job.id);
    if (action === "remove") expect(saved).toBeNull();
    if (action === "disable") {
      expect(saved?.enabled).toBe(false);
      expect(saved?.state.nextRunAtMs).toBeNull();
    }
    if (action === "reschedule") {
      expect(saved?.enabled).toBe(true);
      expect(saved?.state.nextRunAtMs).toBe(time("20:10:00"));
      expect(saved?.state.runHistory).toHaveLength(1);
    }
  });

  it("merges an external removal before starting the next due job", async () => {
    const file = storePath();
    let monitorId = "";
    const calls: string[] = [];
    const service = await start(file, (job) => {
      calls.push(job.name);
      if (job.name === "stop") new CronService(file).removeJob(monitorId);
    });
    monitorId = addMonitor(service).id;
    service.addJob({ name: "stop", schedule: new CronSchedule({ kind: "at", atMs: time("20:05:00") }) });
    vi.setSystemTime(time("20:05:00"));

    await service.onTimer();

    expect(calls).toEqual(["stop"]);
    expect(new CronService(file).getJob(monitorId)).toBeNull();
  });

  it("keeps a completed result when merging an external schedule edit made during execution", async () => {
    const file = storePath();
    const service = await start(file, (job) => {
      new CronService(file).updateJob(job.id, { schedule: new CronSchedule({ kind: "every", everyMs: 300_000 }) });
      vi.setSystemTime(time("20:05:30"));
    });
    const monitor = addMonitor(service);
    vi.setSystemTime(time("20:05:00"));

    await service.onTimer();

    const saved = new CronService(file).getJob(monitor.id);
    expect(saved?.state.nextRunAtMs).toBe(time("20:10:00"));
    expect(saved?.state.runHistory).toHaveLength(1);
    expect(saved?.state.lastStatus).toBe("ok");
  });

  it("does not start a second timer execution when a callback changes tasks while awaiting", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const onJob = vi.fn(async () => { await waiting; });
    const service = await start(storePath(), onJob, true);
    addMonitor(service);
    vi.setSystemTime(time("20:05:00"));
    const pending = service.onTimer();
    expect(onJob).toHaveBeenCalledTimes(1);

    service.addJob({ name: "new later", schedule: new CronSchedule({ kind: "every", everyMs: 300_000 }) });
    await service.onTimer();
    await vi.advanceTimersByTimeAsync(0);
    expect(onJob).toHaveBeenCalledTimes(1);
    release();
    await pending;
    expect(service.getNextWakeMs()).toBe(time("20:07:00"));
  });

  it("does not shift the interval phase when updating its label or payload", async () => {
    const service = await start(storePath());
    const monitor = addMonitor(service);
    vi.setSystemTime(time("20:04:30"));

    service.updateJob(monitor.id, { name: "renamed", message: "updated instruction" });

    expect(service.getJob(monitor.id)?.state.nextRunAtMs).toBe(time("20:05:00"));
  });

  it.each([-1, 0, NaN, Infinity, 1e-300])("leaves an invalid or unrepresentable %s interval unscheduled", async (everyMs) => {
    const onJob = vi.fn();
    const service = await start(storePath(), onJob, true);
    const job = service.addJob({ name: "invalid interval", schedule: new CronSchedule({ kind: "every", everyMs }) });

    expect(job.state.nextRunAtMs).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onJob).not.toHaveBeenCalled();
  });
});
