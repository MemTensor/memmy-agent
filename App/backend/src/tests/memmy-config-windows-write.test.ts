import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const { renameMock } = vi.hoisted(() => ({
  renameMock: vi.fn()
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: renameMock
  };
});

import { patchMcpServerConfigInMemmyConfig } from "../infrastructure/memmy-config/index.js";

const temporaryDirectories: string[] = [];
let actualRename: typeof import("node:fs/promises").rename;

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  actualRename = actual.rename;
  renameMock.mockImplementation(actualRename);
});

afterEach(async () => {
  renameMock.mockReset();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Memmy config Windows replacement", () => {
  it("falls back without losing the config when replacing an existing file returns EPERM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "memmy-config-windows-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.yaml");
    await writeFile(configPath, "memmyMemory:\n  storage:\n    runtime: remote\n", "utf8");

    const permissionError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    renameMock.mockRejectedValueOnce(permissionError);

    await patchMcpServerConfigInMemmyConfig(
      "composio",
      { type: "streamableHttp", url: "http://127.0.0.1:12345/mcp/composio" },
      configPath
    );

    const config = YAML.parse(await readFile(configPath, "utf8")) as {
      memmyMemory: { storage: { runtime: string } };
      tools: { mcpServers: { composio: { url: string } } };
    };
    expect(config.memmyMemory.storage.runtime).toBe("remote");
    expect(config.tools.mcpServers.composio.url).toBe("http://127.0.0.1:12345/mcp/composio");
    expect(renameMock).toHaveBeenCalledTimes(1);
  });
});
