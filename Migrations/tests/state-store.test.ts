import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_MIGRATION_STATE_FORMAT_VERSION,
  SUPPORTED_MIGRATION_STATE_FORMAT_VERSIONS,
} from "../src/index.js";
import {
  emptyMigrationState,
  getMigrationStatePaths,
  readMigrationState,
  runtimeConfigTargetKey,
  validateMigrationState,
  writeMigrationState,
  type MigrationState,
} from "../src/state-store.js";
import type { MigrationDefinition } from "../src/types.js";

const temporaryDirectories: string[] = [];
const definitions: MigrationDefinition[] = [
  {
    id: "v1.0.4/0001-workspace",
    introducedIn: "1.0.4",
    scope: "agent-workspace",
    description: "workspace",
    up: async () => ({ scanned: 0, changed: 0, ignored: 0 }),
  },
  {
    id: "v1.0.5/0001-config",
    introducedIn: "1.0.5",
    scope: "runtime-config",
    description: "config",
    up: async () => ({ scanned: 0, changed: 0, ignored: 0 }),
  },
];

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-migration-state-"));
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

describe("migration state store", () => {
  it("declares the v1 and v2 compatibility required by packaged runtimes", () => {
    expect(CURRENT_MIGRATION_STATE_FORMAT_VERSION).toBe(2);
    expect([...SUPPORTED_MIGRATION_STATE_FORMAT_VERSIONS]).toEqual([1, 2]);
    expect(
      validateMigrationState(
        {
          formatVersion: 2,
          scope: "agent-workspace",
          applied: [],
        },
        definitions,
      ),
    ).toEqual({
      formatVersion: 2,
      scope: "agent-workspace",
      applied: [],
    });
  });

  it("normalizes v1 records to v2 workspace targets", () => {
    expect(
      validateMigrationState(
        {
          formatVersion: 1,
          scope: "agent-workspace",
          applied: [
            {
              id: "v1.0.4/0001-workspace",
              introducedIn: "1.0.4",
              appliedAt: "2026-07-27T08:00:00.000Z",
            },
          ],
        },
        definitions,
      ),
    ).toEqual({
      formatVersion: 2,
      scope: "agent-workspace",
      applied: [
        {
          id: "v1.0.4/0001-workspace",
          introducedIn: "1.0.4",
          appliedAt: "2026-07-27T08:00:00.000Z",
          target: { type: "agent-workspace" },
        },
      ],
    });
  });

  it("uses a stable hash for normalized runtime config paths", async () => {
    const root = await workspace();
    const direct = path.join(root, "config.yaml");
    const equivalent = path.join(root, "nested", "..", "config.yaml");
    const other = path.join(root, "other.yaml");

    expect(runtimeConfigTargetKey(equivalent)).toBe(runtimeConfigTargetKey(direct));
    expect(runtimeConfigTargetKey(other)).not.toBe(runtimeConfigTargetKey(direct));
    expect(runtimeConfigTargetKey(direct)).toMatch(/^[a-f0-9]{64}$/);
    expect(runtimeConfigTargetKey(direct)).not.toContain(root);
  });

  it("rejects a target whose type conflicts with the known registry definition", () => {
    expect(() =>
      validateMigrationState(
        {
          formatVersion: 2,
          scope: "agent-workspace",
          applied: [
            {
              id: "v1.0.5/0001-config",
              introducedIn: "1.0.5",
              appliedAt: "2026-07-27T08:00:00.000Z",
              target: { type: "agent-workspace" },
            },
          ],
        },
        definitions,
      ),
    ).toThrow("target does not match");
  });

  it("leaves the previous state intact when atomic replacement fails", async () => {
    const root = await workspace();
    const paths = getMigrationStatePaths(root);
    await fs.mkdir(paths.directory, { recursive: true });
    const initial: MigrationState = {
      ...emptyMigrationState(),
      applied: [
        {
          id: "v1.0.4/0001-workspace",
          introducedIn: "1.0.4",
          appliedAt: "2026-07-27T08:00:00.000Z",
          target: { type: "agent-workspace" },
        },
      ],
    };
    await writeMigrationState(paths, initial, "v1.0.4/0001-workspace");
    const before = await fs.readFile(paths.file);
    const replacement: MigrationState = {
      ...initial,
      applied: [
        ...initial.applied,
        {
          id: "v1.0.5/0001-config",
          introducedIn: "1.0.5",
          appliedAt: "2026-07-27T08:01:00.000Z",
          target: {
            type: "runtime-config",
            key: runtimeConfigTargetKey(path.join(root, "config.yaml")),
          },
        },
      ],
    };

    await expect(
      writeMigrationState(paths, replacement, "v1.0.5/0001-config", {
        beforeRename: async () => {
          throw new Error("injected rename failure");
        },
      }),
    ).rejects.toMatchObject({ code: "migration_io_failed" });
    await expect(fs.readFile(paths.file)).resolves.toEqual(before);
    expect((await fs.readdir(paths.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    const reloaded = await readMigrationState(paths.file, definitions);
    expect(reloaded).toEqual(initial);
  });
});
