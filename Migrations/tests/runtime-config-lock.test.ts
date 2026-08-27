import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withRuntimeConfigWriteLock,
  withRuntimeConfigWriteLockForTest,
  withRuntimeConfigWriteLockSync,
} from "../src/runtime-config-lock.js";

const temporaryDirectories: string[] = [];

async function root(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-runtime-config-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("runtime config write lock", () => {
  it("serializes writes to the same normalized path", async () => {
    const directory = await root();
    const configPath = path.join(directory, "config.yaml");
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withRuntimeConfigWriteLock(configPath, async () => {
      events.push("first-start");
      await firstMayFinish;
      events.push("first-end");
    });
    await vi.waitFor(() => expect(events).toEqual(["first-start"]));

    const second = withRuntimeConfigWriteLock(
      path.join(directory, "nested", "..", "config.yaml"),
      async () => {
        events.push("second-start");
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("does not block a different config path", async () => {
    const directory = await root();
    let releaseFirst: () => void = () => undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withRuntimeConfigWriteLock(path.join(directory, "first.yaml"), async () => {
      await firstMayFinish;
    });

    await expect(
      withRuntimeConfigWriteLock(path.join(directory, "second.yaml"), async () => "second"),
    ).resolves.toBe("second");
    releaseFirst();
    await first;
  });

  it("returns a stable timeout and releases successfully held locks", async () => {
    const directory = await root();
    const configPath = path.join(directory, "config.yaml");
    const release = await lockfile.lock(configPath, {
      realpath: false,
      stale: 120_000,
      update: 10_000,
    });
    try {
      await expect(
        withRuntimeConfigWriteLockForTest(
          configPath,
          async () => undefined,
          { retries: 1, retryDelay: 5 },
        ),
      ).rejects.toMatchObject({
        code: "migration_lock_timeout",
        scope: "runtime-config",
      });
    } finally {
      await release();
    }

    await expect(
      withRuntimeConfigWriteLock(configPath, async () => "released"),
    ).resolves.toBe("released");
  });

  it("recovers a stale lock directory", async () => {
    const directory = await root();
    const configPath = path.join(directory, "config.yaml");
    const lockPath = `${configPath}.lock`;
    await fs.mkdir(lockPath);
    const staleTime = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, staleTime, staleTime);

    await expect(
      withRuntimeConfigWriteLockForTest(
        configPath,
        async () => "recovered",
        { stale: 2_000, update: 1_000, retries: 1, retryDelay: 5 },
      ),
    ).resolves.toBe("recovered");
  });

  it("always releases after the protected operation rejects", async () => {
    const directory = await root();
    const configPath = path.join(directory, "config.yaml");

    await expect(
      withRuntimeConfigWriteLock(configPath, async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");

    await expect(
      withRuntimeConfigWriteLock(configPath, async () => "next"),
    ).resolves.toBe("next");
  });

  it("supports synchronous callers and reports contention without sync retries", async () => {
    const directory = await root();
    const configPath = path.join(directory, "config.yaml");
    expect(withRuntimeConfigWriteLockSync(configPath, () => "sync")).toBe("sync");

    const release = await lockfile.lock(configPath, {
      realpath: false,
      stale: 120_000,
      update: 10_000,
    });
    try {
      expect(() => withRuntimeConfigWriteLockSync(configPath, () => undefined)).toThrowError(
        expect.objectContaining({ code: "migration_lock_timeout" }),
      );
    } finally {
      await release();
    }
  });
});
