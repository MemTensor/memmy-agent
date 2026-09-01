import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginLocalArtifactService } from "../plugin-local-artifact-service.js";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

describe("PluginLocalArtifactService", () => {
  it("turns an approved local file into opaque preview and download URIs", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-output-"));
    const output = join(root, "task", "review.pdf");
    mkdirSync(join(root, "task"));
    writeFileSync(output, "pdf");
    const service = createPluginLocalArtifactService();
    const hosted = await service.host({
      id: "literature-review",
      approvedPermissions: [
        { type: "filesystem", paths: [join(root, "task")], access: "read-write" },
        { type: "host-service", services: ["artifact-host"] }
      ],
      config: {}
    }, { id: "review", name: "review.pdf", mediaType: "application/pdf", uri: pathToFileURL(output).href });
    expect(hosted.uri).toMatch(/^\/api\/v1\/plugins\/literature-review\/artifacts\/[^/]+\/preview$/);
    expect(hosted.downloadUri).toMatch(/\/download$/);
    const token = hosted.uri.split("/").at(-2)!;
    await expect(service.open("literature-review", token)).resolves.toMatchObject({ path: realpathSync(output), name: "review.pdf" });
  });

  it("rejects local files outside approved filesystem roots", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-output-"));
    const output = join(root, "review.pdf");
    const allowed = join(root, "allowed");
    mkdirSync(allowed);
    writeFileSync(output, "pdf");
    await expect(createPluginLocalArtifactService().host({
      id: "literature-review",
      approvedPermissions: [
        { type: "filesystem", paths: [allowed], access: "read-write" },
        { type: "host-service", services: ["artifact-host"] }
      ],
      config: {}
    }, { id: "review", name: "review.pdf", mediaType: "application/pdf", uri: pathToFileURL(output).href })).rejects.toMatchObject({ code: "plugin_permission_denied" });
  });

  it("accepts artifacts under the Host-approved plugin-data task root", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-output-"));
    const pluginDataRoot = join(root, "plugin-data");
    const output = join(pluginDataRoot, "literature-review", "review.md");
    mkdirSync(join(pluginDataRoot, "literature-review"), { recursive: true });
    writeFileSync(output, "# Review");
    await expect(createPluginLocalArtifactService({ pluginDataRoot }).host({
      id: "literature-review",
      approvedPermissions: [{ type: "host-service", services: ["plugin-data", "artifact-host"] }],
      config: {}
    }, { id: "review", name: "review.md", mediaType: "text/markdown", uri: pathToFileURL(output).href })).resolves.toMatchObject({
      uri: expect.stringContaining("/preview"),
      downloadUri: expect.stringContaining("/download")
    });
  });

  it("does not treat a plugin-configured taskRoot as a Host-approved path", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-output-"));
    const output = join(root, "review.md");
    writeFileSync(output, "# Review");
    await expect(createPluginLocalArtifactService().host({
      id: "literature-review",
      approvedPermissions: [{ type: "host-service", services: ["plugin-data", "artifact-host"] }],
      config: { taskRoot: root }
    }, { id: "review", name: "review.md", mediaType: "text/markdown", uri: pathToFileURL(output).href })).rejects.toMatchObject({
      code: "plugin_permission_denied"
    });
  });
});
