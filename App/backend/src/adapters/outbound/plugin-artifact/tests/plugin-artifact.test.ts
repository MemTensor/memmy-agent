import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const manifest = {
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
  };
  const zip = new JSZip();
  zip.file(fileName, "#!/bin/sh\nprintf '{\"ok\":true}'\n", { unixPermissions: 0o100755 });
  zip.file("plugin.json", JSON.stringify(manifest));
  const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
  return {
    bytes,
    release: {
      manifest,
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

  it("installs only regular local archives inside a trusted bundled root", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-artifact-"));
    const bundleRoot = join(root, "bundled");
    const installRoot = join(root, "installed");
    mkdirSync(bundleRoot);
    const input = await release();
    const archivePath = join(bundleRoot, "plugin.mpp.zip");
    writeFileSync(archivePath, input.bytes);
    const manager = createPluginArtifactManager({
      installRoot,
      trustedLocalRoots: [bundleRoot]
    });

    const installed = await manager.install({
      ...input.release,
      artifact: { localPath: archivePath, sha256: input.release.artifact.sha256 }
    });
    expect(readFileSync(join(installed.rootPath!, "plugin.json"), "utf8")).toContain("com.example.command");

    const outsidePath = join(root, "outside.mpp.zip");
    writeFileSync(outsidePath, input.bytes);
    await expect(manager.install({
      ...input.release,
      artifact: { localPath: outsidePath, sha256: input.release.artifact.sha256 }
    })).rejects.toThrow(/outside the trusted/);

    const symlinkPath = join(bundleRoot, "linked.mpp.zip");
    symlinkSync(outsidePath, symlinkPath);
    await expect(manager.install({
      ...input.release,
      artifact: { localPath: symlinkPath, sha256: input.release.artifact.sha256 }
    })).rejects.toThrow(/regular file/);
  });
});
