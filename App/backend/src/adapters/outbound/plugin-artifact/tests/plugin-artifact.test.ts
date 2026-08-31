import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginArtifactManager } from "../index.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

async function release(fileName = "runtime/plugin.sh") {
  const zip = new JSZip();
  zip.file(fileName, "#!/bin/sh\nprintf '{\"ok\":true}'\n", { unixPermissions: 0o100755 });
  const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
  return {
    bytes,
    release: {
      manifest: {
        apiVersion: "memmy/v1" as const,
        id: "com.example.command",
        name: "Command plugin",
        version: "1.0.0",
        runtime: { adapter: "command" as const, config: { command: "runtime/plugin.sh" } },
        capabilities: [{
          id: "run",
          name: "Run",
          description: "Run command",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          execution: "request" as const
        }],
        permissions: []
      },
      artifact: {
        url: "https://registry.example/plugin.zip",
        sha256: createHash("sha256").update(bytes).digest("hex")
      }
    }
  };
}

describe("PluginArtifactManager", () => {
  it("verifies and atomically installs a ZIP artifact", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-artifact-"));
    const input = await release();
    const manager = createPluginArtifactManager({
      installRoot: root,
      fetchFn: vi.fn(async () => new Response(input.bytes)) as typeof fetch
    });
    const installed = await manager.install(input.release);
    expect(installed.artifactHash).toBe(input.release.artifact.sha256);
    expect(readFileSync(join(installed.rootPath!, "runtime/plugin.sh"), "utf8")).toContain("#!/bin/sh");
    await expect(manager.readTextFile(installed, "runtime/plugin.sh", 1_024)).resolves.toContain("#!/bin/sh");
    await expect(manager.readTextFile(installed, "../outside.html", 1_024)).rejects.toThrow(/escapes/);
    await manager.remove(installed);
    expect(() => readFileSync(join(installed.rootPath!, "runtime/plugin.sh"))).toThrow();
  });

  it("rejects a digest mismatch", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-artifact-"));
    const input = await release();
    input.release.artifact.sha256 = "0".repeat(64);
    const manager = createPluginArtifactManager({
      installRoot: root,
      fetchFn: vi.fn(async () => new Response(input.bytes)) as typeof fetch
    });
    await expect(manager.install(input.release)).rejects.toThrow(/SHA-256 mismatch/);
  });

  it("rejects path traversal entries", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-artifact-"));
    const input = await release("../outside.txt");
    const manager = createPluginArtifactManager({
      installRoot: root,
      fetchFn: vi.fn(async () => new Response(input.bytes)) as typeof fetch
    });
    await expect(manager.install(input.release)).rejects.toThrow(/unsafe path/);
  });
});
