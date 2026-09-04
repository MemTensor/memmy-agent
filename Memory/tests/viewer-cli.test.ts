import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installViewerCli, viewerCliStatus } from "../src/server/viewer-cli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Viewer CLI installation", () => {
  it("installs an executable launcher and adds the user bin directory to shell profiles", async () => {
    const home = temporaryHome();
    const cliEntrypoint = join(home, "runtime", "dist", "src", "cli", "index.js");
    writeFileSync(cliEntrypoint, "// cli fixture\n", { flag: "w" });

    expect(await viewerCliStatus({ home, cliEntrypoint, platform: "darwin" })).toEqual({
      installed: false,
      path: "~/.local/bin/memmy-memory",
    });

    const installed = await installViewerCli({
      home,
      cliEntrypoint,
      executable: "/opt/memmy/node",
      platform: "darwin",
    });
    expect(installed).toMatchObject({
      installed: true,
      path: "~/.local/bin/memmy-memory",
      pathUpdated: true,
    });
    expect(readFileSync(join(home, ".local", "bin", "memmy-memory"), "utf8")).toContain(
      "'/opt/memmy/node'",
    );
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain(
      'export PATH="$HOME/.local/bin:$PATH"',
    );
    expect(await viewerCliStatus({ home, cliEntrypoint, platform: "darwin" })).toMatchObject({
      installed: true,
    });
  });

  it("is idempotent and does not duplicate PATH configuration", async () => {
    const home = temporaryHome();
    const cliEntrypoint = join(home, "runtime", "dist", "src", "cli", "index.js");
    writeFileSync(cliEntrypoint, "// cli fixture\n", { flag: "w" });
    const options = { home, cliEntrypoint, executable: "/opt/memmy/node", platform: "linux" as const };

    await installViewerCli(options);
    const second = await installViewerCli(options);

    expect(second.pathUpdated).toBe(false);
    expect(readFileSync(join(home, ".zshrc"), "utf8").match(/# Memmy CLI PATH/g)).toHaveLength(1);
  });
});

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), "memmy-viewer-cli-"));
  roots.push(home);
  const cliDirectory = join(home, "runtime", "dist", "src", "cli");
  mkdirSync(cliDirectory, { recursive: true });
  return home;
}
