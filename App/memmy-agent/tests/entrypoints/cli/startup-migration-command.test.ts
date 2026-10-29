import { afterEach, describe, expect, it, vi } from "vitest";

const { prepare, heavyMain, heavyImports } = vi.hoisted(() => ({ prepare: vi.fn(async () => undefined), heavyMain: vi.fn(), heavyImports: vi.fn() }));
vi.mock("../../../src/load-env.js", () => ({}));
vi.mock("../../../src/entrypoints/cli/startup-migrations.js", () => ({ prepareStartupMigrations: prepare }));
vi.mock("../../../src/entrypoints/cli/commands.js", () => { heavyImports(); return { main: heavyMain }; });
import { runStartupMigrationCommand } from "../../../src/entrypoints/cli/startup-migration-command.js";

const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("lightweight desktop migration entrypoint", () => {
  it("preserves all desktop migration targets and forces the existing migration runner", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runStartupMigrationCommand(["node", "main.js", "migrate", "--config", "config.yaml", "--workspace", "workspace", "--app-database", "app.sqlite"]);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ config: "config.yaml", workspace: "workspace", appDatabase: "app.sqlite" }),
      process.env, { force: true }
    );
  });

  it("production main bypasses the Agent/SDK CLI import graph for migrations", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.argv = ["node", "main.js", "migrate", "-c", "config.yaml", "-w", "workspace"];
    vi.resetModules();
    await import("../../../src/main.js");
    expect(prepare).toHaveBeenCalledOnce();
    expect(heavyMain).not.toHaveBeenCalled();
    expect(heavyImports).not.toHaveBeenCalled();
  });

  it("production main still dispatches other commands to the full CLI", async () => {
    process.argv = ["node", "main.js", "gateway"];
    vi.resetModules();
    await import("../../../src/main.js");
    expect(heavyMain).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not report success when a migration fails", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    prepare.mockRejectedValueOnce(new Error("migration failure"));
    await expect(runStartupMigrationCommand(["node", "main.js", "migrate"])).rejects.toThrow("migration failure");
    expect(output).not.toHaveBeenCalled();
  });
});
