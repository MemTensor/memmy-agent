import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrations } from "../src/registry.js";
import { runMigrations, runMigrationsForTest } from "../src/runner.js";
import {
  emptyMigrationState,
  getMigrationStatePaths,
  readMigrationState,
  writeMigrationState,
  type MigrationState,
} from "../src/state-store.js";
import type { MigrationDefinition, MigrationLogger } from "../src/types.js";

const temporaryDirectories: string[] = [];

function logger(): MigrationLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function definition(
  id: string,
  introducedIn: string,
  up: MigrationDefinition["up"] = async () => ({ scanned: 0, changed: 0, ignored: 0 }),
): MigrationDefinition {
  return {
    id,
    introducedIn,
    scope: "agent-workspace",
    description: `Test migration ${id}`,
    up,
  };
}

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-migration-runner-"));
  temporaryDirectories.push(directory);
  return fs.realpath(directory);
}

async function writeState(
  profileWorkspace: string,
  state: unknown,
): Promise<void> {
  const paths = getMigrationStatePaths(profileWorkspace);
  await fs.mkdir(paths.directory, { recursive: true });
  await fs.writeFile(paths.file, JSON.stringify(state));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("migration runner", () => {
  it("applies the default migration once and then skips it", async () => {
    const profileWorkspace = await workspace();
    const sessionsDir = path.join(profileWorkspace, "sessions");
    await fs.mkdir(sessionsDir);
    const sessionPath = path.join(sessionsDir, "legacy.jsonl");
    await fs.writeFile(
      sessionPath,
      `${JSON.stringify({
        recordType: "metadata",
        key: "websocket:legacy",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        metadata: { webui: true },
        lastConsolidated: 0,
      })}\n`,
    );

    const first = await runMigrations({
      targets: { agentWorkspace: profileWorkspace },
      logger: logger(),
    });
    const fileAfterFirstRun = await fs.readFile(sessionPath);
    const second = await runMigrations({
      targets: { agentWorkspace: profileWorkspace },
      logger: logger(),
    });

    expect(first.applied).toHaveLength(1);
    expect(first.results).toEqual({ scanned: 1, changed: 1, ignored: 0 });
    expect(second).toEqual({
      applied: [],
      skipped: ["v1.0.4/0001-add-webui-session-binding"],
      results: { scanned: 0, changed: 0, ignored: 0 },
    });
    expect(await fs.readFile(sessionPath)).toEqual(fileAfterFirstRun);
    const state = await readMigrationState(
      getMigrationStatePaths(profileWorkspace).file,
      migrations,
    );
    expect(state.applied).toEqual([
      {
        id: "v1.0.4/0001-add-webui-session-binding",
        introducedIn: "1.0.4",
        appliedAt: expect.stringMatching(/Z$/),
      },
    ]);
  });

  it("runs every pending migration in registry order without filtering by app version", async () => {
    const profileWorkspace = await workspace();
    const calls: string[] = [];
    const definitions = [
      definition("v1.0.1/0001-first", "1.0.1", async () => {
        calls.push("first");
        return { scanned: 1, changed: 1, ignored: 0 };
      }),
      definition("v3.0.0/0001-future", "3.0.0", async () => {
        calls.push("future");
        return { scanned: 2, changed: 0, ignored: 2 };
      }),
    ];

    const result = await runMigrationsForTest(
      { targets: { agentWorkspace: profileWorkspace }, logger: logger() },
      { definitions, now: () => new Date("2026-07-27T08:00:00.000Z") },
    );

    expect(calls).toEqual(["first", "future"]);
    expect(result.applied.map((item) => item.id)).toEqual([
      "v1.0.1/0001-first",
      "v3.0.0/0001-future",
    ]);
    expect(result.results).toEqual({ scanned: 3, changed: 1, ignored: 2 });
  });

  it("records each success, stops on failure, and resumes at the failed migration", async () => {
    const profileWorkspace = await workspace();
    const first = vi.fn(async () => ({ scanned: 0, changed: 0, ignored: 0 }));
    let secondAttempt = 0;
    const second = vi.fn(async () => {
      secondAttempt += 1;
      if (secondAttempt === 1) throw new Error("first attempt fails");
      return { scanned: 0, changed: 1, ignored: 0 };
    });
    const third = vi.fn(async () => ({ scanned: 0, changed: 0, ignored: 0 }));
    const definitions = [
      definition("v1.0.1/0001-first", "1.0.1", first),
      definition("v1.0.1/0002-second", "1.0.1", second),
      definition("v1.0.1/0003-third", "1.0.1", third),
    ];

    await expect(
      runMigrationsForTest(
        { targets: { agentWorkspace: profileWorkspace }, logger: logger() },
        { definitions },
      ),
    ).rejects.toMatchObject({
      code: "migration_io_failed",
      migrationId: "v1.0.1/0002-second",
    });
    expect(third).not.toHaveBeenCalled();

    const afterFailure = await readMigrationState(
      getMigrationStatePaths(profileWorkspace).file,
      definitions,
    );
    expect(afterFailure.applied.map((item) => item.id)).toEqual(["v1.0.1/0001-first"]);

    await runMigrationsForTest(
      { targets: { agentWorkspace: profileWorkspace }, logger: logger() },
      { definitions },
    );
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(third).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["invalid JSON", "not-json"],
    [
      "unsupported format",
      { formatVersion: 2, scope: "agent-workspace", applied: [] },
    ],
    [
      "wrong scope",
      { formatVersion: 1, scope: "other", applied: [] },
    ],
    [
      "unsupported fields",
      { formatVersion: 1, scope: "agent-workspace", applied: [], extra: true },
    ],
    [
      "duplicate IDs",
      {
        formatVersion: 1,
        scope: "agent-workspace",
        applied: [
          {
            id: "unknown",
            introducedIn: "9.0.0",
            appliedAt: "2026-07-27T08:00:00.000Z",
          },
          {
            id: "unknown",
            introducedIn: "9.0.0",
            appliedAt: "2026-07-27T08:00:00.000Z",
          },
        ],
      },
    ],
    [
      "invalid timestamp",
      {
        formatVersion: 1,
        scope: "agent-workspace",
        applied: [{ id: "unknown", introducedIn: "9.0.0", appliedAt: "yesterday" }],
      },
    ],
    [
      "known ID version mismatch",
      {
        formatVersion: 1,
        scope: "agent-workspace",
        applied: [
          {
            id: "v1.0.4/0001-add-webui-session-binding",
            introducedIn: "1.0.3",
            appliedAt: "2026-07-27T08:00:00.000Z",
          },
        ],
      },
    ],
  ])("rejects %s state without resetting it", async (_label, state) => {
    const profileWorkspace = await workspace();
    const paths = getMigrationStatePaths(profileWorkspace);
    await fs.mkdir(paths.directory, { recursive: true });
    const source = typeof state === "string" ? state : JSON.stringify(state);
    await fs.writeFile(paths.file, source);

    await expect(
      runMigrations({
        targets: { agentWorkspace: profileWorkspace },
        logger: logger(),
      }),
    ).rejects.toMatchObject({ code: "migration_state_invalid" });
    await expect(fs.readFile(paths.file, "utf8")).resolves.toBe(source);
  });

  it("preserves applied IDs unknown to the current registry", async () => {
    const profileWorkspace = await workspace();
    await writeState(profileWorkspace, {
      formatVersion: 1,
      scope: "agent-workspace",
      applied: [
        {
          id: "v9.9.9/0001-from-newer-app",
          introducedIn: "9.9.9",
          appliedAt: "2026-07-27T08:00:00.000Z",
        },
      ],
    });
    const definitions = [definition("v1.0.1/0001-known", "1.0.1")];

    await runMigrationsForTest(
      { targets: { agentWorkspace: profileWorkspace }, logger: logger() },
      { definitions },
    );

    const state = await readMigrationState(
      getMigrationStatePaths(profileWorkspace).file,
      definitions,
    );
    expect(state.applied.map((item) => item.id)).toEqual([
      "v9.9.9/0001-from-newer-app",
      "v1.0.1/0001-known",
    ]);
  });

  it("validates the complete registry before touching the target", async () => {
    const profileWorkspace = await workspace();
    const duplicate = definition("v1.0.1/0001-duplicate", "1.0.1");

    await expect(
      runMigrationsForTest(
        { targets: { agentWorkspace: profileWorkspace }, logger: logger() },
        { definitions: [duplicate, duplicate] },
      ),
    ).rejects.toMatchObject({
      code: "migration_definition_invalid",
    });
    await expect(
      fs.access(getMigrationStatePaths(profileWorkspace).directory),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    [
      "a leading-zero version",
      [definition("v01.0.1/0001-invalid", "01.0.1")],
    ],
    [
      "a version mismatch",
      [definition("v1.0.1/0001-invalid", "1.0.2")],
    ],
    [
      "sequence zero",
      [definition("v1.0.1/0000-invalid", "1.0.1")],
    ],
    [
      "out-of-order definitions",
      [
        definition("v1.0.2/0001-second", "1.0.2"),
        definition("v1.0.1/0001-first", "1.0.1"),
      ],
    ],
    [
      "an unsupported scope",
      [
        {
          ...definition("v1.0.1/0001-invalid", "1.0.1"),
          scope: "desktop",
        } as unknown as MigrationDefinition,
      ],
    ],
  ])("rejects registry definitions with %s", async (_label, definitions) => {
    const profileWorkspace = await workspace();
    await expect(
      runMigrationsForTest(
        { targets: { agentWorkspace: profileWorkspace }, logger: logger() },
        { definitions },
      ),
    ).rejects.toMatchObject({ code: "migration_definition_invalid" });
    await expect(
      fs.access(getMigrationStatePaths(profileWorkspace).directory),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent runners so a migration executes once", async () => {
    const profileWorkspace = await workspace();
    const up = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { scanned: 1, changed: 1, ignored: 0 };
    });
    const definitions = [definition("v1.0.1/0001-once", "1.0.1", up)];
    const options = {
      targets: { agentWorkspace: profileWorkspace },
      logger: logger(),
    };

    const [left, right] = await Promise.all([
      runMigrationsForTest(options, { definitions }),
      runMigrationsForTest(options, { definitions }),
    ]);

    expect(up).toHaveBeenCalledTimes(1);
    expect([left.applied.length, right.applied.length].sort()).toEqual([0, 1]);
    expect([left.skipped.length, right.skipped.length].sort()).toEqual([0, 1]);
  });

  it("returns a stable timeout when another process holds the scope lock", async () => {
    const profileWorkspace = await workspace();
    const paths = getMigrationStatePaths(profileWorkspace);
    await fs.mkdir(paths.directory, { recursive: true });
    const release = await lockfile.lock(paths.directory, { realpath: false });
    try {
      await expect(
        runMigrationsForTest(
          { targets: { agentWorkspace: profileWorkspace }, logger: logger() },
          {
            definitions: [definition("v1.0.1/0001-lock", "1.0.1")],
            lock: { stale: 120_000, update: 10_000, retries: 1, retryDelay: 5 },
          },
        ),
      ).rejects.toMatchObject({
        code: "migration_lock_timeout",
      });
    } finally {
      await release();
    }
  });

  it("keeps migration state independent for each profile workspace", async () => {
    const firstWorkspace = await workspace();
    const secondWorkspace = await workspace();
    const up = vi.fn(async () => ({ scanned: 0, changed: 1, ignored: 0 }));
    const definitions = [definition("v1.0.1/0001-per-workspace", "1.0.1", up)];

    for (const profileWorkspace of [firstWorkspace, secondWorkspace]) {
      await runMigrationsForTest(
        { targets: { agentWorkspace: profileWorkspace }, logger: logger() },
        { definitions },
      );
    }

    expect(up).toHaveBeenCalledTimes(2);
  });

  it("leaves the previous state intact when an atomic state replacement fails", async () => {
    const profileWorkspace = await workspace();
    const paths = getMigrationStatePaths(profileWorkspace);
    await fs.mkdir(paths.directory, { recursive: true });
    const initial: MigrationState = {
      ...emptyMigrationState(),
      applied: [
        {
          id: "v1.0.1/0001-old",
          introducedIn: "1.0.1",
          appliedAt: "2026-07-27T08:00:00.000Z",
        },
      ],
    };
    await writeMigrationState(paths, initial, "v1.0.1/0001-old");
    const before = await fs.readFile(paths.file);
    const replacement: MigrationState = {
      ...initial,
      applied: [
        ...initial.applied,
        {
          id: "v1.0.1/0002-new",
          introducedIn: "1.0.1",
          appliedAt: "2026-07-27T08:01:00.000Z",
        },
      ],
    };

    await expect(
      writeMigrationState(paths, replacement, "v1.0.1/0002-new", {
        beforeRename: async () => {
          throw new Error("injected rename failure");
        },
      }),
    ).rejects.toMatchObject({ code: "migration_io_failed" });
    await expect(fs.readFile(paths.file)).resolves.toEqual(before);
    expect((await fs.readdir(paths.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("reports unavailable targets before creating state", async () => {
    const missing = path.join(await workspace(), "missing");
    await expect(
      runMigrations({ targets: { agentWorkspace: missing }, logger: logger() }),
    ).rejects.toMatchObject({
      code: "migration_target_unavailable",
    });
  });

  it("does not expose a migration cause or Session content in structured logs", async () => {
    const profileWorkspace = await workspace();
    const migrationLogger = logger();
    const definitions = [
      definition("v1.0.1/0001-secret", "1.0.1", async () => {
        throw new Error("private chat content");
      }),
    ];

    await expect(
      runMigrationsForTest(
        { targets: { agentWorkspace: profileWorkspace }, logger: migrationLogger },
        { definitions },
      ),
    ).rejects.toMatchObject({ code: "migration_io_failed" });

    const serializedCalls = JSON.stringify([
      ...vi.mocked(migrationLogger.info).mock.calls,
      ...vi.mocked(migrationLogger.warn).mock.calls,
      ...vi.mocked(migrationLogger.error).mock.calls,
    ]);
    expect(serializedCalls).not.toContain("private chat content");
    expect(migrationLogger.error).toHaveBeenCalledWith("migration_failed", {
      migrationId: "v1.0.1/0001-secret",
      scope: "agent-workspace",
      errorCode: "migration_io_failed",
    });
  });
});
