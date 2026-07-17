import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronService, RuntimeError } from "../../src/cron/service.js";
import { CronSchedule } from "../../src/cron/types.js";

const roots: string[] = [];

function storePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-cron-persistence-"));
  roots.push(root);
  return path.join(root, "cron", "jobs.json");
}

function seededStore(): [CronService, string] {
  const file = storePath();
  const service = new CronService(file);
  service.addJob({
    name: "Daily Loving Message",
    schedule: new CronSchedule({ kind: "cron", expr: "0 10 * * *", tz: "Asia/Kuwait" }),
    message: "hello",
  });
  service.running = true;
  try {
    service.loadStore();
  } finally {
    service.running = false;
  }
  expect(fs.existsSync(file)).toBe(true);
  return [service, file];
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CronService persistence", () => {
  it("saves stores atomically without leaving temp files", () => {
    const [service, file] = seededStore();

    service.saveStore();

    expect(JSON.parse(fs.readFileSync(file, "utf8")).jobs).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not corrupt the existing file when atomic save fails", () => {
    const [service, file] = seededStore();
    const original = fs.readFileSync(file);
    const originalWrite = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target: any, ...args: any[]) => {
      if (String(target).endsWith(".tmp") || typeof target === "number") throw new Error("simulated disk full");
      return (originalWrite as any)(target, ...args);
    });

    expect(() => service.saveStore()).toThrow(/simulated disk full/);
    expect(fs.readFileSync(file)).toEqual(original);
  });

  it("moves corrupt stores aside and returns null", () => {
    const file = storePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not valid json", "utf8");

    const service = new CronService(file);

    expect(service.loadJobs()).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith("jobs.json.corrupt-"));
    expect(backups).toHaveLength(1);
  });

  it("refuses to start by overwriting a corrupt store", async () => {
    const file = storePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{still not json", "utf8");
    const service = new CronService(file);

    await expect(service.start()).rejects.toThrow(RuntimeError);
    expect(service.running).toBe(false);
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.startsWith("jobs.json.corrupt-"))).toBe(true);
  });

  it("falls back to in-memory state if a running store becomes corrupt", () => {
    const [service, file] = seededStore();
    service.loadStore();
    const snapshot = service.store;
    expect(snapshot?.jobs).toHaveLength(1);

    fs.writeFileSync(file, "\x00garbage\x00", "utf8");
    const result = service.loadStore();

    expect(result).toBe(snapshot);
    expect(result?.jobs[0].name).toBe("Daily Loving Message");
  });

  it("survives repeated save and load across service instances", () => {
    const file = storePath();
    const first = new CronService(file);
    first.addJob({
      name: "Daily Loving Message",
      schedule: new CronSchedule({ kind: "cron", expr: "0 10 * * *", tz: "Asia/Kuwait" }),
      message: "hello",
    });

    const second = new CronService(file);
    second.loadStore();

    expect(second.store?.jobs.map((job) => job.name)).toEqual(["Daily Loving Message"]);
  });
});
