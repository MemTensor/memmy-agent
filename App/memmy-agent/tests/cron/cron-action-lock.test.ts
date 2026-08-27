import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type LockCall = {
  file: string;
  options: {
    realpath?: boolean;
    stale?: number;
  };
};

const lockMock = vi.hoisted((): { calls: LockCall[]; failures: number; releaseCount: number } => ({
  calls: [],
  failures: 0,
  releaseCount: 0,
}));

vi.mock("proper-lockfile", () => ({
  lockSync: vi.fn((file: string, options: LockCall["options"]) => {
    lockMock.calls.push({ file, options });
    if (lockMock.failures > 0) {
      lockMock.failures -= 1;
      const err = new Error("Lock file is already being held") as Error & { code: string };
      err.code = "ELOCKED";
      throw err;
    }
    return () => {
      lockMock.releaseCount += 1;
    };
  }),
}));

const { CronService } = await import("../../src/cron/service.js");
const { CronSchedule } = await import("../../src/cron/types.js");

const roots: string[] = [];
const services: InstanceType<typeof CronService>[] = [];

function storePath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-cron-lock-"));
  roots.push(root);
  return path.join(root, "cron", "jobs.json");
}

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  lockMock.calls.length = 0;
  lockMock.failures = 0;
  lockMock.releaseCount = 0;
  vi.clearAllMocks();
});

describe("CronService action log locking", () => {
  it("uses the same root lock for offline appends and running merges", async () => {
    const file = storePath();
    const root = path.dirname(file);

    new CronService(file).addJob({
      name: "offline",
      schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }),
      message: "hello",
    });
    const service = new CronService(file, { maxSleepMs: 60_000 });
    services.push(service);
    await service.start();

    expect(lockMock.calls.map((call) => call.file)).toEqual([root, root]);
    expect(lockMock.releaseCount).toBe(lockMock.calls.length);
    for (const call of lockMock.calls) {
      expect(call.options).toMatchObject({ realpath: false, stale: 10_000 });
    }

    const actionPath = path.join(root, "action.jsonl");
    expect(fs.readFileSync(actionPath, "utf8")).toBe("");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(raw.jobs.map((job: { name: string }) => job.name)).toEqual(["offline"]);
  });

  it("retries when the action lock is temporarily held", () => {
    const file = storePath();
    lockMock.failures = 1;

    new CronService(file).addJob({
      name: "offline",
      schedule: new CronSchedule({ kind: "every", everyMs: 60_000 }),
      message: "hello",
    });

    expect(lockMock.calls.map((call) => call.file)).toEqual([path.dirname(file), path.dirname(file)]);
    expect(lockMock.releaseCount).toBe(1);
    const actionPath = path.join(path.dirname(file), "action.jsonl");
    expect(fs.readFileSync(actionPath, "utf8")).toContain("\"action\":\"add\"");
  });
});
