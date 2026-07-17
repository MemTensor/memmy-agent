import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RequestContext } from "../../src/core/agent-runtime/tools/context.js";
import { CronTool } from "../../src/core/agent-runtime/tools/cron.js";
import { CronService } from "../../src/cron/service.js";
import { CronJob, CronJobState, CronPayload, CronSchedule } from "../../src/cron/types.js";

const roots: string[] = [];

function makeTool(tz = "UTC"): CronTool {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-cron-tool-"));
  roots.push(root);
  return new CronTool(new CronService(path.join(root, "cron", "jobs.json")), tz);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CronTool list formatting", () => {
  it("formats schedule timing variants", () => {
    const tool = makeTool("Asia/Shanghai");

    expect(tool.formatTiming(new CronSchedule({ kind: "cron", expr: "0 9 * * 1-5", tz: "America/Denver" }))).toBe(
      "cron: 0 9 * * 1-5 (America/Denver)",
    );
    expect(tool.formatTiming(new CronSchedule({ kind: "cron", expr: "*/5 * * * *" }))).toBe("cron: */5 * * * *");
    expect(tool.formatTiming(new CronSchedule({ kind: "every", everyMs: 7_200_000 }))).toBe("every 2h");
    expect(tool.formatTiming(new CronSchedule({ kind: "every", everyMs: 1_800_000 }))).toBe("every 30m");
    expect(tool.formatTiming(new CronSchedule({ kind: "every", everyMs: 30_000 }))).toBe("every 30s");
    expect(tool.formatTiming(new CronSchedule({ kind: "every", everyMs: 90_000 }))).toBe("every 90s");
    expect(tool.formatTiming(new CronSchedule({ kind: "every", everyMs: 200 }))).toBe("every 200ms");
    expect(tool.formatTiming(new CronSchedule({ kind: "at", atMs: 1773684000000 }))).toMatch(/^at 2026-.*Asia\/Shanghai\)$/);
    expect(tool.formatTiming(new CronSchedule({ kind: "every" }))).toBe("every");
  });

  it("formats state lines", () => {
    const tool = makeTool();

    expect(tool.formatState(new CronJobState(), new CronSchedule({ kind: "every" }))).toEqual([]);
    expect(
      tool.formatState(new CronJobState({ lastRunAtMs: 1773673200000, lastStatus: "ok" }), new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" })).join("\n"),
    ).toContain("ok");
    expect(
      tool.formatState(new CronJobState({ lastRunAtMs: 1773673200000, lastStatus: "error", lastError: "timeout" }), new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" })).join("\n"),
    ).toContain("timeout");
    expect(
      tool.formatState(new CronJobState({ nextRunAtMs: 1773684000000 }), new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" })).join("\n"),
    ).toContain("Next run:");
    expect(
      tool.formatState(new CronJobState({ lastRunAtMs: 1773673200000, lastStatus: null }), new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" })).join("\n"),
    ).toContain("unknown");
  });

  it("lists empty and populated jobs", () => {
    const tool = makeTool("Asia/Shanghai");
    expect(tool.listJobs()).toBe("No scheduled jobs.");

    tool.cron.addJob({ name: "Morning scan", schedule: new CronSchedule({ kind: "cron", expr: "0 9 * * 1-5", tz: "America/Denver" }), message: "scan" });
    tool.cron.addJob({ name: "Frequent check", schedule: new CronSchedule({ kind: "every", everyMs: 1_800_000 }), message: "check" });
    tool.cron.addJob({ name: "One-shot", schedule: new CronSchedule({ kind: "at", atMs: 1773684000000 }), message: "fire" });

    const result = tool.listJobs();
    expect(result).toContain("cron: 0 9 * * 1-5 (America/Denver)");
    expect(result).toContain("every 30m");
    expect(result).toContain("at 2026-");
    expect(result).toContain("Asia/Shanghai");
  });

  it("adds jobs with context metadata and default timezone", () => {
    const tool = makeTool("Asia/Shanghai");
    const meta = { slack: { thread_ts: "111.222", channel_type: "channel" } };
    tool.setContext(new RequestContext({ channel: "slack", chatId: "C99", metadata: meta, sessionKey: "slack:C99:111.222" }));

    expect(tool.addJob("test", "say hi", null, "0 8 * * *", null, null)).toMatch(/^Created job/);
    const job = tool.cron.listJobs()[0];
    expect(job.schedule.tz).toBe("Asia/Shanghai");
    expect(job.payload.deliver).toBe(true);
    expect(job.payload.channelMeta).toEqual(meta);
    expect(job.payload.sessionKey).toBe("slack:C99:111.222");
  });

  it("parses naive at datetimes in the tool timezone", () => {
    const tool = makeTool("Asia/Shanghai");
    tool.setContext(new RequestContext({ channel: "telegram", chatId: "chat-1" }));

    expect(tool.addJob(null, "morning", null, null, null, "2026-03-25T08:00:00")).toMatch(/^Created job/);
    expect(tool.cron.listJobs()[0].schedule.atMs).toBe(Date.UTC(2026, 2, 25, 0, 0, 0));
  });

  it("lists protected dream jobs and returns clear removal feedback", () => {
    const tool = makeTool();
    tool.cron.registerSystemJob(
      new CronJob({
        id: "dream",
        name: "dream",
        schedule: new CronSchedule({ kind: "cron", expr: "0 */2 * * *", tz: "UTC" }),
        payload: new CronPayload({ kind: "systemEvent" }),
      }),
    );

    const listed = tool.listJobs();
    expect(listed).toContain("Dream memory consolidation for long-term memory.");
    expect(listed).toContain("cannot be removed");
    expect(tool.removeJob("dream")).toContain("Cannot remove job `dream`.");
  });
});

describe("CronTool memmy list parity cases", () => {
  it("formats cron timing with an explicit timezone", () => {
    const tool = makeTool();
    expect(tool.formatTiming(new CronSchedule({ kind: "cron", expr: "0 9 * * 1-5", tz: "America/Denver" }))).toBe(
      "cron: 0 9 * * 1-5 (America/Denver)",
    );
  });

  it("formats cron timing without an explicit timezone", () => {
    expect(makeTool().formatTiming(new CronSchedule({ kind: "cron", expr: "*/5 * * * *" }))).toBe(
      "cron: */5 * * * *",
    );
  });

  it("formats hourly intervals", () => {
    expect(makeTool().formatTiming(new CronSchedule({ kind: "every", everyMs: 7_200_000 }))).toBe("every 2h");
  });

  it("formats minute intervals", () => {
    expect(makeTool().formatTiming(new CronSchedule({ kind: "every", everyMs: 1_800_000 }))).toBe("every 30m");
  });

  it("formats second intervals", () => {
    expect(makeTool().formatTiming(new CronSchedule({ kind: "every", everyMs: 30_000 }))).toBe("every 30s");
  });

  it("formats non-minute second intervals", () => {
    expect(makeTool().formatTiming(new CronSchedule({ kind: "every", everyMs: 90_000 }))).toBe("every 90s");
  });

  it("formats millisecond intervals", () => {
    expect(makeTool().formatTiming(new CronSchedule({ kind: "every", everyMs: 200 }))).toBe("every 200ms");
  });

  it("formats one-shot at schedules", () => {
    const result = makeTool("Asia/Shanghai").formatTiming(new CronSchedule({ kind: "at", atMs: 1773684000000 }));
    expect(result).toContain("Asia/Shanghai");
    expect(result).toMatch(/^at 2026-/);
  });

  it("formats fallback schedule kinds", () => {
    expect(makeTool().formatTiming(new CronSchedule({ kind: "every" }))).toBe("every");
  });

  it("formats empty state lines", () => {
    expect(makeTool().formatState(new CronJobState(), new CronSchedule({ kind: "every" }))).toEqual([]);
  });

  it("formats successful last run state", () => {
    const lines = makeTool().formatState(
      new CronJobState({ lastRunAtMs: 1773673200000, lastStatus: "ok" }),
      new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Last run:");
    expect(lines[0]).toContain("ok");
  });

  it("formats failed last run state", () => {
    const lines = makeTool().formatState(
      new CronJobState({ lastRunAtMs: 1773673200000, lastStatus: "error", lastError: "timeout" }),
      new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("error");
    expect(lines[0]).toContain("timeout");
  });

  it("formats next run state", () => {
    const lines = makeTool().formatState(
      new CronJobState({ nextRunAtMs: 1773684000000 }),
      new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Next run:");
  });

  it("formats last and next run state", () => {
    const lines = makeTool().formatState(
      new CronJobState({ lastRunAtMs: 1773673200000, lastStatus: "ok", nextRunAtMs: 1773684000000 }),
      new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }),
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Last run:");
    expect(lines[1]).toContain("Next run:");
  });

  it("formats unknown last run status", () => {
    const lines = makeTool().formatState(
      new CronJobState({ lastRunAtMs: 1773673200000, lastStatus: null }),
      new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }),
    );
    expect(lines[0]).toContain("unknown");
  });

  it("lists an empty schedule set", () => {
    expect(makeTool().listJobs()).toBe("No scheduled jobs.");
  });

  it("lists hourly interval jobs", () => {
    const tool = makeTool();
    tool.cron.addJob({ name: "Hourly check", schedule: new CronSchedule({ kind: "every", everyMs: 7_200_000 }), message: "check" });
    expect(tool.listJobs()).toContain("every 2h");
  });

  it("lists second interval jobs", () => {
    const tool = makeTool();
    tool.cron.addJob({ name: "Fast check", schedule: new CronSchedule({ kind: "every", everyMs: 30_000 }), message: "check" });
    expect(tool.listJobs()).toContain("every 30s");
  });

  it("lists non-minute second interval jobs", () => {
    const tool = makeTool();
    tool.cron.addJob({ name: "Ninety-second check", schedule: new CronSchedule({ kind: "every", everyMs: 90_000 }), message: "check" });
    expect(tool.listJobs()).toContain("every 90s");
  });

  it("lists millisecond interval jobs", () => {
    const tool = makeTool();
    tool.cron.addJob({ name: "Sub-second check", schedule: new CronSchedule({ kind: "every", everyMs: 200 }), message: "check" });
    expect(tool.listJobs()).toContain("every 200ms");
  });

  it("lists last run state", () => {
    const tool = makeTool();
    tool.cron.running = true;
    const job = tool.cron.addJob({ name: "Stateful job", schedule: new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }), message: "test" });
    job.state.lastRunAtMs = job.state.lastRunAtMs = 1773673200000;
    job.state.lastStatus = job.state.lastStatus = "ok";
    tool.cron.saveStore();
    const result = tool.listJobs();
    expect(result).toContain("Last run:");
    expect(result).toContain("ok");
    expect(result).toContain("(UTC)");
  });

  it("lists failed run messages", () => {
    const tool = makeTool();
    tool.cron.running = true;
    const job = tool.cron.addJob({ name: "Failed job", schedule: new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }), message: "test" });
    job.state.lastRunAtMs = job.state.lastRunAtMs = 1773673200000;
    job.state.lastStatus = job.state.lastStatus = "error";
    job.state.lastError = job.state.lastError = "timeout";
    tool.cron.saveStore();
    const result = tool.listJobs();
    expect(result).toContain("error");
    expect(result).toContain("timeout");
  });

  it("lists next run state", () => {
    const tool = makeTool();
    tool.cron.addJob({ name: "Upcoming job", schedule: new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }), message: "test" });
    const result = tool.listJobs();
    expect(result).toContain("Next run:");
    expect(result).toContain("(UTC)");
  });

  it("delivers added jobs by default", () => {
    const tool = makeTool();
    tool.setContext(new RequestContext({ channel: "telegram", chatId: "chat-1" }));
    expect(tool.addJob(null, "Morning standup", 60, null, null, null)).toMatch(/^Created job/);
    expect(tool.cron.listJobs()[0].payload.deliver).toBe(true);
  });

  it("can disable delivery for added jobs", () => {
    const tool = makeTool();
    tool.setContext(new RequestContext({ channel: "telegram", chatId: "chat-1" }));
    expect(tool.addJob(null, "Background refresh", 60, null, null, null, false)).toMatch(/^Created job/);
    expect(tool.cron.listJobs()[0].payload.deliver).toBe(false);
  });

  it("advertises action-specific schema requirements", () => {
    const params = makeTool().parameters;
    expect(params.required).toEqual(["action"]);
    for (const disallowed of ["oneOf", "anyOf", "allOf", "not"]) expect(params).not.toHaveProperty(disallowed);
    expect(params.properties.message.description).toContain("REQUIRED");
    expect(params.properties.message.description).toContain("action='add'");
    expect(params.properties.job_id.description).toContain("REQUIRED");
    expect(params.properties.job_id.description).toContain("action='remove'");
  });

  it("requires message only for add during parameter validation", () => {
    const tool = makeTool();
    expect(tool.validateParams({ action: "add" })).toContain("message is required when action='add'");
    expect(tool.validateParams({ action: "list" })).toEqual([]);
    expect(tool.validateParams({ action: "remove" })).toContain("job_id is required when action='remove'");
  });

  it("returns an actionable error for an empty add message", () => {
    const tool = makeTool();
    tool.setContext(new RequestContext({ channel: "telegram", chatId: "chat-1" }));
    const result = tool.addJob(null, "", 60, null, null, null);
    expect(result).toContain("action='add' requires a non-empty 'message'");
    expect(result).toContain("Retry including message=");
  });

  it("captures metadata and session key when adding a job", () => {
    const tool = makeTool();
    const meta = { slack: { thread_ts: "111.222", channel_type: "channel" } };
    tool.setContext(new RequestContext({ channel: "slack", chatId: "C99", metadata: meta, sessionKey: "slack:C99:111.222" }));
    expect(tool.addJob("test", "say hi", 60, null, null, null)).toMatch(/^Created job/);
    const job = tool.cron.listJobs()[0];
    expect(job.payload.channelMeta).toEqual(meta);
    expect(job.payload.sessionKey).toBe("slack:C99:111.222");
  });

  it("excludes disabled jobs from the list", () => {
    const tool = makeTool();
    const job = tool.cron.addJob({ name: "Paused job", schedule: new CronSchedule({ kind: "cron", expr: "0 9 * * *", tz: "UTC" }), message: "test" });
    tool.cron.enableJob(job.id, false);
    const result = tool.listJobs();
    expect(result).not.toContain("Paused job");
    expect(result).toBe("No scheduled jobs.");
  });

  it("defaults cron jobs to the tool timezone", () => {
    const tool = makeTool("Asia/Shanghai");
    tool.setContext(new RequestContext({ channel: "telegram", chatId: "chat-1" }));
    expect(tool.addJob(null, "Morning standup", null, "0 8 * * *", null, null)).toMatch(/^Created job/);
    expect(tool.cron.listJobs()[0].schedule.tz).toBe("Asia/Shanghai");
  });
});
