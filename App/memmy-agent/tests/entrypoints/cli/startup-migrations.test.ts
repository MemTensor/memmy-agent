import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runMigrations } = vi.hoisted(() => ({
  runMigrations: vi.fn(async () => []),
}));

vi.mock("@memmy/migrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@memmy/migrations")>()),
  runMigrations,
}));

import {
  APP_DATABASE_ENV,
  MIGRATIONS_READY_CONFIG_ENV,
  MIGRATIONS_READY_APP_DATABASE_ENV,
  MIGRATIONS_READY_SESSION_DAG_ENV,
  MIGRATIONS_READY_WORKSPACE_ENV,
  prepareStartupMigrations,
  resolveStartupMigrationTarget,
} from "../../../src/entrypoints/cli/startup-migrations.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-startup-migrations-"));
  roots.push(root);
  return root;
}

function migrationEnv(root: string): NodeJS.ProcessEnv {
  return {
    HOME: root,
    MEMMY_AGENT_SESSION_DAG_DIR: path.join(root, "session-dag"),
  };
}

afterEach(() => {
  runMigrations.mockClear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("startup migrations", () => {
  it("resolves explicit targets to stable absolute and canonical paths", () => {
    const root = tempRoot();
    const configInput = path.join(root, "nested", "..", "config.yaml");
    const workspaceInput = path.join(root, "nested", "..", "workspace");
    const target = resolveStartupMigrationTarget(
      { config: configInput, workspace: workspaceInput },
      migrationEnv(root),
    );

    expect(target).toEqual({
      runtimeConfigFile: path.join(root, "config.yaml"),
      agentWorkspace: fs.realpathSync(path.join(root, "workspace")),
      sessionDagDir: path.join(root, "session-dag"),
    });
  });

  it("expands Windows home paths with USERPROFILE when HOME is unavailable", () => {
    const root = tempRoot();
    const target = resolveStartupMigrationTarget(
      {
        config: "~\\config.yaml",
        workspace: "~\\workspace",
        appDatabase: "~\\desktop\\app.sqlite",
      },
      {
        USERPROFILE: root,
        MEMMY_AGENT_SESSION_DAG_DIR: "~\\session-dag",
      },
    );

    expect(target).toEqual({
      runtimeConfigFile: path.join(root, "config.yaml"),
      agentWorkspace: fs.realpathSync(path.join(root, "workspace")),
      sessionDagDir: path.join(root, "session-dag"),
      appDatabaseFile: path.join(root, "desktop", "app.sqlite"),
    });
  });

  it("includes an optional Desktop app database without creating it", () => {
    const root = tempRoot();
    const appDatabase = path.join(root, "desktop", "app.sqlite");
    const target = resolveStartupMigrationTarget({
      config: path.join(root, "config.yaml"),
      appDatabase,
    }, migrationEnv(root));

    expect(target.appDatabaseFile).toBe(appDatabase);
    expect(fs.existsSync(appDatabase)).toBe(false);
  });

  it("uses the workspace configured in the target config", () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "configured-workspace");
    fs.writeFileSync(
      configPath,
      `agents:\n  defaults:\n    workspace: ${JSON.stringify(workspace)}\n`,
      "utf8",
    );

    expect(resolveStartupMigrationTarget({ config: configPath }, migrationEnv(root))).toEqual({
      runtimeConfigFile: configPath,
      agentWorkspace: fs.realpathSync(workspace),
      sessionDagDir: path.join(root, "session-dag"),
    });
  });

  it("lets the shared resolver derive workspace and session DAG from legacy config", () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "legacy", "workspace");
    fs.writeFileSync(
      configPath,
      `agent:\n  workspace: ${JSON.stringify(workspace)}\n`,
      "utf8",
    );

    expect(resolveStartupMigrationTarget({ config: configPath }, { HOME: root })).toEqual({
      runtimeConfigFile: configPath,
      agentWorkspace: fs.realpathSync(workspace),
      sessionDagDir: path.join(root, "legacy", "session-dag"),
    });
  });

  it("executes once when no matching parent marker exists", async () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "workspace");

    const result = await prepareStartupMigrations(
      { config: configPath, workspace },
      migrationEnv(root),
    );

    expect(result.source).toBe("executed");
    expect(result.target.appDatabaseFile).toBeUndefined();
    expect(runMigrations).toHaveBeenCalledOnce();
    expect(runMigrations).toHaveBeenCalledWith(expect.objectContaining({
      targets: result.target,
    }));
  });

  it("skips only when every prepared target marker matches", async () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    const env = {
      ...migrationEnv(root),
      [MIGRATIONS_READY_CONFIG_ENV]: configPath,
      [MIGRATIONS_READY_WORKSPACE_ENV]: workspace,
      [MIGRATIONS_READY_SESSION_DAG_ENV]: path.join(root, "session-dag"),
    };

    const result = await prepareStartupMigrations({ config: configPath, workspace }, env);

    expect(result.source).toBe("prepared-parent");
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it("does not treat a standalone target as the prepared Desktop database target", async () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "workspace");
    const env = {
      ...migrationEnv(root),
      [MIGRATIONS_READY_CONFIG_ENV]: configPath,
      [MIGRATIONS_READY_WORKSPACE_ENV]: workspace,
      [MIGRATIONS_READY_SESSION_DAG_ENV]: path.join(root, "session-dag"),
      [MIGRATIONS_READY_APP_DATABASE_ENV]: path.join(root, "app.sqlite"),
    };

    const result = await prepareStartupMigrations({ config: configPath, workspace }, env);

    expect(result.source).toBe("executed");
    expect(runMigrations).toHaveBeenCalledOnce();
  });

  it("reuses a matching prepared Desktop database target", async () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "workspace");
    const appDatabase = path.join(root, "app.sqlite");
    const env = {
      ...migrationEnv(root),
      [MIGRATIONS_READY_CONFIG_ENV]: configPath,
      [MIGRATIONS_READY_WORKSPACE_ENV]: workspace,
      [MIGRATIONS_READY_SESSION_DAG_ENV]: path.join(root, "session-dag"),
      [MIGRATIONS_READY_APP_DATABASE_ENV]: appDatabase,
    };

    const result = await prepareStartupMigrations({
      config: configPath,
      workspace,
      appDatabase,
    }, env);

    expect(result.source).toBe("prepared-parent");
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it("reuses an exact Desktop target inherited by a managed command", async () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "workspace");
    const appDatabase = path.join(root, "app.sqlite");
    const env = {
      ...migrationEnv(root),
      [APP_DATABASE_ENV]: appDatabase,
      [MIGRATIONS_READY_CONFIG_ENV]: configPath,
      [MIGRATIONS_READY_WORKSPACE_ENV]: workspace,
      [MIGRATIONS_READY_SESSION_DAG_ENV]: path.join(root, "session-dag"),
      [MIGRATIONS_READY_APP_DATABASE_ENV]: appDatabase,
    };

    const result = await prepareStartupMigrations({ config: configPath, workspace }, env);

    expect(result.source).toBe("prepared-parent");
    expect(result.target.appDatabaseFile).toBe(appDatabase);
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it("executes when only the Desktop app database target differs", async () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "workspace");
    const env = {
      ...migrationEnv(root),
      [APP_DATABASE_ENV]: path.join(root, "current.sqlite"),
      [MIGRATIONS_READY_CONFIG_ENV]: configPath,
      [MIGRATIONS_READY_WORKSPACE_ENV]: workspace,
      [MIGRATIONS_READY_SESSION_DAG_ENV]: path.join(root, "session-dag"),
      [MIGRATIONS_READY_APP_DATABASE_ENV]: path.join(root, "prepared.sqlite"),
    };

    const result = await prepareStartupMigrations({ config: configPath, workspace }, env);

    expect(result.source).toBe("executed");
    expect(runMigrations).toHaveBeenCalledOnce();
  });

  it.each(["config", "workspace", "session-dag"] as const)(
    "executes when the prepared %s target differs",
    async (differentTarget) => {
      const root = tempRoot();
      const configPath = path.join(root, "config.yaml");
      const workspace = path.join(root, "workspace");
      const env = {
        ...migrationEnv(root),
        [MIGRATIONS_READY_CONFIG_ENV]: differentTarget === "config"
          ? path.join(root, "other.yaml")
          : configPath,
        [MIGRATIONS_READY_WORKSPACE_ENV]: differentTarget === "workspace"
          ? path.join(root, "other-workspace")
          : workspace,
        [MIGRATIONS_READY_SESSION_DAG_ENV]: differentTarget === "session-dag"
          ? path.join(root, "other-session-dag")
          : path.join(root, "session-dag"),
      };

      const result = await prepareStartupMigrations({ config: configPath, workspace }, env);

      expect(result.source).toBe("executed");
      expect(runMigrations).toHaveBeenCalledOnce();
    },
  );

  it("force ignores matching parent markers", async () => {
    const root = tempRoot();
    const configPath = path.join(root, "config.yaml");
    const workspace = path.join(root, "workspace");
    const env = {
      ...migrationEnv(root),
      [MIGRATIONS_READY_CONFIG_ENV]: configPath,
      [MIGRATIONS_READY_WORKSPACE_ENV]: workspace,
      [MIGRATIONS_READY_SESSION_DAG_ENV]: path.join(root, "session-dag"),
    };

    await prepareStartupMigrations(
      { config: configPath, workspace },
      env,
      { force: true },
    );

    expect(runMigrations).toHaveBeenCalledOnce();
  });

  it("propagates migration failures", async () => {
    const failure = Object.assign(new Error("migration failed"), {
      code: "migration_failed",
    });
    runMigrations.mockRejectedValueOnce(failure);
    const root = tempRoot();

    await expect(prepareStartupMigrations({
      config: path.join(root, "config.yaml"),
      workspace: path.join(root, "workspace"),
    }, migrationEnv(root))).rejects.toBe(failure);
  });
});
