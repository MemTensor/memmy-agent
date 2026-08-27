import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMigrationTargets } from "../src/target-resolver.js";

const roots: string[] = [];

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-target-resolver-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("migration target resolver", () => {
  it("prefers explicit workspace over current and legacy config", () => {
    const base = root();
    const configPath = path.join(base, "config.yaml");
    fs.writeFileSync(configPath, [
      "agents:",
      "  defaults:",
      `    workspace: ${JSON.stringify(path.join(base, "current"))}`,
      "agent:",
      `  workspace: ${JSON.stringify(path.join(base, "legacy"))}`,
      "",
    ].join("\n"));
    const explicit = path.join(base, "explicit");
    const targets = resolveMigrationTargets({
      runtimeConfigFile: configPath,
      agentWorkspaceOverride: explicit,
      appDatabaseFile: path.join(base, "app.sqlite"),
      env: { HOME: base },
    });
    expect(targets).toEqual({
      runtimeConfigFile: configPath,
      agentWorkspace: fs.realpathSync(explicit),
      sessionDagDir: path.join(base, "session-dag"),
      appDatabaseFile: path.join(base, "app.sqlite"),
    });
  });

  it("does not parse malformed runtime config when workspace is explicit", () => {
    const base = root();
    const configPath = path.join(base, "config.yaml");
    const explicit = path.join(base, "explicit");
    fs.writeFileSync(configPath, "providers: [unterminated");

    const targets = resolveMigrationTargets({
      runtimeConfigFile: configPath,
      agentWorkspaceOverride: explicit,
      env: { HOME: base },
    });
    expect(targets.agentWorkspace).toBe(fs.realpathSync(explicit));
    expect(targets.sessionDagDir).toBe(path.join(base, "session-dag"));
  });

  it("uses current workspace before legacy and derives the first-run session DAG", () => {
    const base = root();
    const configPath = path.join(base, "config.yaml");
    const current = path.join(base, "profiles", "current-workspace");
    fs.writeFileSync(configPath, `agents:\n  defaults:\n    workspace: ${JSON.stringify(current)}\nagent:\n  workspace: ignored\n`);
    const targets = resolveMigrationTargets({ runtimeConfigFile: configPath, env: { HOME: base } });
    expect(targets.agentWorkspace).toBe(fs.realpathSync(current));
    expect(targets.sessionDagDir).toBe(path.join(base, "profiles", "session-dag"));
  });

  it("falls back to legacy agent.workspace and honors an explicit session DAG override", () => {
    const base = root();
    const configPath = path.join(base, "config.yaml");
    const legacy = path.join(base, "legacy", "workspace");
    const dag = path.join(base, "custom-dag");
    fs.writeFileSync(configPath, `agent:\n  workspace: ${JSON.stringify(legacy)}\n`);
    const targets = resolveMigrationTargets({
      runtimeConfigFile: configPath,
      sessionDagDirOverride: dag,
      env: { HOME: base },
    });
    expect(targets.agentWorkspace).toBe(fs.realpathSync(legacy));
    expect(targets.sessionDagDir).toBe(dag);
  });
});
