import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBundledPluginCatalog } from "../bundled-plugin-registry.js";

let root: string | undefined;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("loadBundledPluginCatalog", () => {
  it("accepts an empty catalog for plugin-free development", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-empty-bundled-registry-"));
    const catalog = await loadBundledPluginCatalog(root);

    expect(catalog.releases).toEqual([]);
    expect(catalog.managedPluginIds).toEqual([]);
    await expect(catalog.registry.resolve("literature-review"))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("retains managed IDs when releases are intentionally omitted", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-omitted-bundled-registry-"));
    writeFileSync(join(root, "bundled-plugins-state.json"), JSON.stringify({
      schemaVersion: 1,
      managedPluginIds: ["literature-review"]
    }));

    const catalog = await loadBundledPluginCatalog(root);

    expect(catalog.releases).toEqual([]);
    expect(catalog.managedPluginIds).toEqual(["literature-review"]);
  });

  it("pins local artifacts to the descriptor SHA-256", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-bundled-registry-"));
    const bundleRoot = join(root, "bundled");
    mkdirSync(bundleRoot);
    const artifact = Buffer.from("immutable archive");
    const sha256 = createHash("sha256").update(artifact).digest("hex");
    writeFileSync(join(bundleRoot, "review.mpp.zip"), artifact);
    writeFileSync(join(bundleRoot, "review.release.json"), JSON.stringify({
      manifest: {
        apiVersion: "memmy/v1",
        id: "literature-review",
        name: "Literature Review",
        version: "0.5.17",
        runtime: { adapter: "command", config: { command: "dist/runtime.js" } },
        capabilities: [{
          id: "review_create_task",
          name: "Create task",
          description: "Create a literature-review task.",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          execution: "request"
        }],
        permissions: []
      },
      artifact: { file: "review.mpp.zip", sha256 }
    }));

    const catalog = await loadBundledPluginCatalog(bundleRoot);
    expect(catalog.managedPluginIds).toEqual(["literature-review"]);
    await expect(catalog.registry.resolve("literature-review", "0.5.17")).resolves.toMatchObject({
      manifest: { id: "literature-review", version: "0.5.17" },
      artifact: { localPath: join(catalog.trustedArtifactRoot, "review.mpp.zip"), sha256 }
    });

    writeFileSync(join(bundleRoot, "review.mpp.zip"), "tampered");
    await expect(loadBundledPluginCatalog(bundleRoot)).rejects.toThrow(/SHA-256 mismatch/);
  });
});
