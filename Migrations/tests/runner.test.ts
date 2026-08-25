import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrations } from "../src/registry.js";
import { runMigrations, runMigrationsForTest } from "../src/runner.js";
import {
  getMigrationStatePaths,
  readMigrationState,
  runtimeConfigTargetKey,
} from "../src/state-store.js";
import type {
  AgentWorkspaceMigrationContext,
  MigrationDefinition,
  MigrationLogger,
  RunMigrationsOptions,
} from "../src/types.js";

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
  options: {
    scope?: MigrationDefinition["scope"];
    up?: MigrationDefinition["up"];
    requiredTargets?: MigrationDefinition["requiredTargets"];
  } = {},
): MigrationDefinition {
  return {
    id,
    introducedIn,
    scope: options.scope ?? "agent-workspace",
    description: `Test migration ${id}`,
    ...(options.requiredTargets ? { requiredTargets: options.requiredTargets } : {}),
    up: options.up ?? (async () => ({ scanned: 0, changed: 0, ignored: 0 })),
  };
}

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-migration-runner-"));
  temporaryDirectories.push(directory);
  return fs.realpath(directory);
}

function options(
  agentWorkspace: string,
  runtimeConfigFile = path.join(agentWorkspace, "config.yaml"),
): RunMigrationsOptions {
  return {
    targets: {
      agentWorkspace,
      runtimeConfigFile,
      sessionDagDir: path.join(agentWorkspace, "session-dag"),
    },
    logger: logger(),
  };
}

async function writeState(profileWorkspace: string, state: unknown): Promise<void> {
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
  it("applies the registry in order and skips both target types on the second run", async () => {
    const profileWorkspace = await workspace();
    const sessionsDir = path.join(profileWorkspace, "sessions");
    const configPath = path.join(profileWorkspace, "config.yaml");
    await fs.mkdir(sessionsDir);
    await fs.writeFile(
      path.join(sessionsDir, "legacy.jsonl"),
      `${JSON.stringify({
        recordType: "metadata",
        key: "websocket:legacy",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        metadata: { webui: true },
        lastConsolidated: 0,
      })}\n`,
    );
    await fs.writeFile(
      configPath,
      "memmyMemory:\n  activeProfile: byok\n  profiles:\n    byok:\n      embedding:\n        provider: local\n",
    );

    const first = await runMigrations(options(profileWorkspace, configPath));
    const second = await runMigrations(options(profileWorkspace, configPath));

    expect(first.applied.map((item) => item.id)).toEqual([
      "v1.0.4/0001-add-webui-session-binding",
      "v1.0.7/0001-normalize-runtime-model-catalog",
      "v1.0.7/0003-normalize-goal-state",
      "v1.0.7/0004-add-goal-dag-boundary",
      "v1.0.9/0001-repair-runtime-model-catalog",
    ]);
    expect(first.deferred).toEqual(["v1.0.7/0002-import-legacy-app-state-model-config"]);
    expect(first.results).toEqual({ scanned: 4, changed: 2, ignored: 2 });
    expect(second).toEqual({
      applied: [],
      skipped: [
        "v1.0.4/0001-add-webui-session-binding",
        "v1.0.7/0001-normalize-runtime-model-catalog",
        "v1.0.7/0003-normalize-goal-state",
        "v1.0.7/0004-add-goal-dag-boundary",
        "v1.0.9/0001-repair-runtime-model-catalog",
      ],
      deferred: ["v1.0.7/0002-import-legacy-app-state-model-config"],
      results: { scanned: 0, changed: 0, ignored: 0 },
    });

    const state = await readMigrationState(
      getMigrationStatePaths(profileWorkspace).file,
      migrations,
    );
    expect(state.formatVersion).toBe(2);
    expect(state.applied).toEqual([
      {
        id: "v1.0.4/0001-add-webui-session-binding",
        introducedIn: "1.0.4",
        appliedAt: expect.stringMatching(/Z$/),
        target: { type: "agent-workspace" },
      },
      {
        id: "v1.0.7/0001-normalize-runtime-model-catalog",
        introducedIn: "1.0.7",
        appliedAt: expect.stringMatching(/Z$/),
        target: {
          type: "runtime-config",
          key: runtimeConfigTargetKey(configPath),
        },
      },
      {
        id: "v1.0.7/0003-normalize-goal-state",
        introducedIn: "1.0.7",
        appliedAt: expect.stringMatching(/Z$/),
        target: { type: "agent-workspace" },
      },
      {
        id: "v1.0.7/0004-add-goal-dag-boundary",
        introducedIn: "1.0.7",
        appliedAt: expect.stringMatching(/Z$/),
        target: {
          type: "session-dag",
          key: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      {
        id: "v1.0.9/0001-repair-runtime-model-catalog",
        introducedIn: "1.0.9",
        appliedAt: expect.stringMatching(/Z$/),
        target: {
          type: "runtime-config",
          key: runtimeConfigTargetKey(configPath),
        },
      },
    ]);
  });

  it("runs pending definitions in registry order without filtering by app version", async () => {
    const profileWorkspace = await workspace();
    const calls: string[] = [];
    const definitions = [
      definition("v1.0.1/0001-first", "1.0.1", {
        up: async () => {
          calls.push("first");
          return { scanned: 1, changed: 1, ignored: 0 };
        },
      }),
      definition("v3.0.0/0001-future", "3.0.0", {
        up: async () => {
          calls.push("future");
          return { scanned: 2, changed: 0, ignored: 2 };
        },
      }),
    ];

    const result = await runMigrationsForTest(options(profileWorkspace), {
      definitions,
      now: () => new Date("2026-07-27T08:00:00.000Z"),
    });

    expect(calls).toEqual(["first", "future"]);
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
      definition("v1.0.1/0001-first", "1.0.1", { up: first }),
      definition("v1.0.1/0002-second", "1.0.1", { up: second }),
      definition("v1.0.1/0003-third", "1.0.1", { up: third }),
    ];

    await expect(
      runMigrationsForTest(options(profileWorkspace), { definitions }),
    ).rejects.toMatchObject({
      code: "migration_io_failed",
      migrationId: "v1.0.1/0002-second",
    });
    expect(third).not.toHaveBeenCalled();

    await runMigrationsForTest(options(profileWorkspace), { definitions });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(third).toHaveBeenCalledTimes(1);
  });

  it("runs a runtime-config migration once per normalized config path", async () => {
    const profileWorkspace = await workspace();
    const firstConfig = path.join(profileWorkspace, "first.yaml");
    const secondConfig = path.join(profileWorkspace, "nested", "..", "second.yaml");
    const workspaceUp = vi.fn(async () => ({ scanned: 0, changed: 1, ignored: 0 }));
    const configUp = vi.fn(async (_context: AgentWorkspaceMigrationContext) => ({
      scanned: 0,
      changed: 1,
      ignored: 0,
    }));
    const definitions = [
      definition("v1.0.1/0001-workspace", "1.0.1", { up: workspaceUp }),
      definition("v1.0.2/0001-config", "1.0.2", {
        scope: "runtime-config",
        up: configUp,
      }),
    ];

    await runMigrationsForTest(options(profileWorkspace, firstConfig), { definitions });
    await runMigrationsForTest(options(profileWorkspace, firstConfig), { definitions });
    await runMigrationsForTest(options(profileWorkspace, secondConfig), { definitions });

    expect(workspaceUp).toHaveBeenCalledTimes(1);
    expect(configUp).toHaveBeenCalledTimes(2);
    expect(configUp.mock.calls.map(([context]) => context.runtimeConfigFile)).toEqual([
      path.normalize(path.resolve(firstConfig)),
      path.normalize(path.resolve(secondConfig)),
    ]);
  });

  it("upgrades a valid v1 state without rerunning workspace migrations", async () => {
    const profileWorkspace = await workspace();
    await writeState(profileWorkspace, {
      formatVersion: 1,
      scope: "agent-workspace",
      applied: [
        {
          id: "v1.0.1/0001-workspace",
          introducedIn: "1.0.1",
          appliedAt: "2026-07-27T08:00:00.000Z",
        },
      ],
    });
    const workspaceUp = vi.fn(async () => ({ scanned: 0, changed: 1, ignored: 0 }));
    const configUp = vi.fn(async () => ({ scanned: 0, changed: 1, ignored: 0 }));
    const definitions = [
      definition("v1.0.1/0001-workspace", "1.0.1", { up: workspaceUp }),
      definition("v1.0.2/0001-config", "1.0.2", {
        scope: "runtime-config",
        up: configUp,
      }),
    ];

    await runMigrationsForTest(options(profileWorkspace), { definitions });

    expect(workspaceUp).not.toHaveBeenCalled();
    expect(configUp).toHaveBeenCalledOnce();
    const source = await fs.readFile(
      getMigrationStatePaths(profileWorkspace).file,
      "utf8",
    );
    expect(JSON.parse(source).formatVersion).toBe(2);
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["unsupported format", { formatVersion: 3, scope: "agent-workspace", applied: [] }],
    ["wrong scope", { formatVersion: 2, scope: "other", applied: [] }],
    [
      "unsupported fields",
      { formatVersion: 2, scope: "agent-workspace", applied: [], extra: true },
    ],
    [
      "duplicate targets",
      {
        formatVersion: 2,
        scope: "agent-workspace",
        applied: [
          {
            id: "unknown",
            introducedIn: "9.0.0",
            appliedAt: "2026-07-27T08:00:00.000Z",
            target: { type: "agent-workspace" },
          },
          {
            id: "unknown",
            introducedIn: "9.0.0",
            appliedAt: "2026-07-27T08:00:00.000Z",
            target: { type: "agent-workspace" },
          },
        ],
      },
    ],
    [
      "an exposed runtime config path",
      {
        formatVersion: 2,
        scope: "agent-workspace",
        applied: [
          {
            id: "unknown",
            introducedIn: "9.0.0",
            appliedAt: "2026-07-27T08:00:00.000Z",
            target: { type: "runtime-config", key: "/Users/example/config.yaml" },
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

    await expect(runMigrations(options(profileWorkspace))).rejects.toMatchObject({
      code: "migration_state_invalid",
    });
    await expect(fs.readFile(paths.file, "utf8")).resolves.toBe(source);
  });

  it("preserves records unknown to the current registry", async () => {
    const profileWorkspace = await workspace();
    await writeState(profileWorkspace, {
      formatVersion: 2,
      scope: "agent-workspace",
      applied: [
        {
          id: "v9.9.9/0001-from-newer-app",
          introducedIn: "9.9.9",
          appliedAt: "2026-07-27T08:00:00.000Z",
          target: { type: "agent-workspace" },
        },
      ],
    });
    const definitions = [definition("v1.0.1/0001-known", "1.0.1")];

    await runMigrationsForTest(options(profileWorkspace), { definitions });
    const state = await readMigrationState(
      getMigrationStatePaths(profileWorkspace).file,
      definitions,
    );
    expect(state.applied.map((item) => item.id)).toEqual([
      "v9.9.9/0001-from-newer-app",
      "v1.0.1/0001-known",
    ]);
  });

  it.each([
    [
      "duplicate IDs",
      [
        definition("v1.0.1/0001-duplicate", "1.0.1"),
        definition("v1.0.1/0001-duplicate", "1.0.1"),
      ],
    ],
    ["a leading-zero version", [definition("v01.0.1/0001-invalid", "01.0.1")]],
    ["a version mismatch", [definition("v1.0.1/0001-invalid", "1.0.2")]],
    ["sequence zero", [definition("v1.0.1/0000-invalid", "1.0.1")]],
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
  ])("rejects registry definitions with %s before touching state", async (_label, definitions) => {
    const profileWorkspace = await workspace();
    await expect(
      runMigrationsForTest(options(profileWorkspace), { definitions }),
    ).rejects.toMatchObject({ code: "migration_definition_invalid" });
    await expect(
      fs.access(getMigrationStatePaths(profileWorkspace).directory),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes concurrent runners so each target migration executes once", async () => {
    const profileWorkspace = await workspace();
    const up = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { scanned: 1, changed: 1, ignored: 0 };
    });
    const definitions = [
      definition("v1.0.1/0001-once", "1.0.1", { up }),
    ];
    const migrationOptions = options(profileWorkspace);

    const [left, right] = await Promise.all([
      runMigrationsForTest(migrationOptions, { definitions }),
      runMigrationsForTest(migrationOptions, { definitions }),
    ]);

    expect(up).toHaveBeenCalledTimes(1);
    expect([left.applied.length, right.applied.length].sort()).toEqual([0, 1]);
  });

  it("tracks a session-dag migration independently for each normalized directory", async () => {
    const profileWorkspace = await workspace();
    const seenTargets: string[] = [];
    const definitions = [definition("v1.0.1/0001-session-dag", "1.0.1", {
      scope: "session-dag",
      up: async (context) => {
        seenTargets.push(context.sessionDagDir);
        return { scanned: 1, changed: 1, ignored: 0 };
      },
    })];
    const firstOptions = options(profileWorkspace);
    firstOptions.targets.sessionDagDir = path.join(profileWorkspace, "nested", "..", "dag-a");
    const secondOptions = options(profileWorkspace);
    secondOptions.targets.sessionDagDir = path.join(profileWorkspace, "dag-b");

    const first = await runMigrationsForTest(firstOptions, { definitions });
    const second = await runMigrationsForTest(secondOptions, { definitions });
    const repeated = await runMigrationsForTest(firstOptions, { definitions });

    expect(first.applied).toHaveLength(1);
    expect(second.applied).toHaveLength(1);
    expect(repeated.applied).toHaveLength(0);
    expect(repeated.skipped).toEqual(["v1.0.1/0001-session-dag"]);
    expect(seenTargets).toEqual([
      path.join(profileWorkspace, "dag-a"),
      path.join(profileWorkspace, "dag-b"),
    ]);
  });

  it("returns a stable timeout when another process holds the workspace state lock", async () => {
    const profileWorkspace = await workspace();
    const paths = getMigrationStatePaths(profileWorkspace);
    await fs.mkdir(paths.directory, { recursive: true });
    const release = await lockfile.lock(paths.directory, { realpath: false });
    try {
      await expect(
        runMigrationsForTest(options(profileWorkspace), {
          definitions: [definition("v1.0.1/0001-lock", "1.0.1")],
          lock: { stale: 120_000, update: 10_000, retries: 1, retryDelay: 5 },
        }),
      ).rejects.toMatchObject({ code: "migration_lock_timeout" });
    } finally {
      await release();
    }
  });

  it("reports unavailable targets before creating state", async () => {
    const root = await workspace();
    const missingWorkspace = path.join(root, "missing");
    await expect(runMigrations(options(missingWorkspace))).rejects.toMatchObject({
      code: "migration_target_unavailable",
    });
  });

  it("rejects an empty runtime config target before creating state", async () => {
    const profileWorkspace = await workspace();
    await expect(
      runMigrations({
        targets: {
          agentWorkspace: profileWorkspace,
          runtimeConfigFile: " ",
          sessionDagDir: path.join(profileWorkspace, "session-dag"),
        },
        logger: logger(),
      }),
    ).rejects.toMatchObject({
      code: "migration_target_unavailable",
      scope: "runtime-config",
    });
    await expect(
      fs.access(getMigrationStatePaths(profileWorkspace).directory),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not expose a migration cause or config content in structured logs", async () => {
    const profileWorkspace = await workspace();
    const migrationLogger = logger();
    const definitions = [
      definition("v1.0.1/0001-secret", "1.0.1", {
        scope: "runtime-config",
        up: async () => {
          throw new Error("private API key");
        },
      }),
    ];

    await expect(
      runMigrationsForTest(
        { ...options(profileWorkspace), logger: migrationLogger },
        { definitions },
      ),
    ).rejects.toMatchObject({ code: "migration_io_failed" });

    const serializedCalls = JSON.stringify([
      ...vi.mocked(migrationLogger.info).mock.calls,
      ...vi.mocked(migrationLogger.warn).mock.calls,
      ...vi.mocked(migrationLogger.error).mock.calls,
    ]);
    expect(serializedCalls).not.toContain("private API key");
    expect(migrationLogger.error).toHaveBeenCalledWith("migration_failed", {
      migrationId: "v1.0.1/0001-secret",
      scope: "runtime-config",
      errorCode: "migration_io_failed",
    });
  });

  it("defers required app DB work without a marker and keys applied state by app DB target", async () => {
    const profileWorkspace = await workspace();
    const configPath = path.join(profileWorkspace, "config.yaml");
    const calls: string[] = [];
    const definitions = [definition("v1.0.7/0002-app-db", "1.0.7", {
      scope: "runtime-config",
      requiredTargets: ["appDatabaseFile"],
      up: async (context) => {
        calls.push(context.appDatabaseFile!);
        return { scanned: 1, changed: 1, ignored: 0 };
      },
    })];
    const base = options(profileWorkspace, configPath);

    const deferred = await runMigrationsForTest(base, { definitions });
    expect(deferred).toMatchObject({ applied: [], deferred: ["v1.0.7/0002-app-db"] });
    expect(calls).toEqual([]);
    expect((await readMigrationState(getMigrationStatePaths(profileWorkspace).file, definitions)).applied).toEqual([]);

    const databaseA = path.join(profileWorkspace, "a.sqlite");
    const databaseB = path.join(profileWorkspace, "b.sqlite");
    const first = await runMigrationsForTest({
      ...base,
      targets: { ...base.targets, appDatabaseFile: databaseA },
    }, { definitions });
    const repeated = await runMigrationsForTest({
      ...base,
      targets: { ...base.targets, appDatabaseFile: databaseA },
    }, { definitions });
    const secondTarget = await runMigrationsForTest({
      ...base,
      targets: { ...base.targets, appDatabaseFile: databaseB },
    }, { definitions });

    expect(first.applied).toHaveLength(1);
    expect(repeated.skipped).toEqual(["v1.0.7/0002-app-db"]);
    expect(secondTarget.applied).toHaveLength(1);
    expect(calls).toEqual([databaseA, databaseB]);
    const records = (await readMigrationState(getMigrationStatePaths(profileWorkspace).file, definitions)).applied;
    expect(records).toHaveLength(2);
    expect(records[0]?.target).not.toEqual(records[1]?.target);
  });
});
