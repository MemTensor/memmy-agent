import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  it("publishes final artifacts into the bound conversation workspace", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-publish-"));
    const pluginDataRoot = join(root, "plugin-data");
    const workspace = join(root, "workspace");
    const output = join(pluginDataRoot, "literature-review", "tasks", "review-1", "outputs", "review.md");
    mkdirSync(join(pluginDataRoot, "literature-review", "tasks", "review-1", "outputs"), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(output, "# Published review");
    const service = createPluginLocalArtifactService({
      pluginDataRoot,
      resolveWorkspace: async (conversationId) => conversationId === "websocket:chat-1" ? workspace : null
    });

    const hosted = await service.host({
      id: "literature-review",
      approvedPermissions: [{ type: "host-service", services: ["plugin-data", "artifact-host"] }],
      config: {}
    }, {
      id: "review",
      name: "review.md",
      mediaType: "text/markdown",
      uri: pathToFileURL(output).href
    }, {
      conversationId: "websocket:chat-1",
      taskId: "review-1",
      callId: "call-1"
    });

    const published = join(workspace, "outputs", "literature-review", "review-1", "review.md");
    expect(hosted.path).toBe(realpathSync(published));
    expect(readFileSync(published, "utf8")).toBe("# Published review");
    expect(readFileSync(output, "utf8")).toBe("# Published review");
  });

  it("publishes another plugin's deliverables, keyed by conversation when it has no task", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-publish-any-"));
    const pluginDataRoot = join(root, "plugin-data");
    const workspace = join(root, "workspace");
    const output = join(pluginDataRoot, "legal-labor", "sessions", "s1", "artifacts", "报告.docx");
    mkdirSync(dirname(output), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(output, "report");
    const service = createPluginLocalArtifactService({
      pluginDataRoot,
      resolveWorkspace: async (conversationId) => conversationId === "websocket:chat-1" ? workspace : null
    });

    // No taskId: the legal plugin keys its work on sessionId, so the
    // conversation scopes the output directory instead.
    const hosted = await service.host({
      id: "legal-labor",
      approvedPermissions: [{ type: "host-service", services: ["plugin-data", "artifact-host"] }],
      config: {}
    }, {
      id: "report", name: "企业-用工风险与合规诊断报告.docx", mediaType: "application/vnd.ms-word", uri: pathToFileURL(output).href, role: "deliverable"
    }, { conversationId: "websocket:chat-1", callId: "call-1" });

    const published = join(workspace, "outputs", "legal-labor", "websocket-chat-1", "企业-用工风险与合规诊断报告.docx");
    expect(hosted.path).toBe(realpathSync(published));
    expect(readFileSync(published, "utf8")).toBe("report");
  });

  it("keeps setup templates out of the outputs directory", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-publish-setup-"));
    const pluginDataRoot = join(root, "plugin-data");
    const workspace = join(root, "workspace");
    const output = join(pluginDataRoot, "legal-labor", "sessions", "s1", "artifacts", "清单.xlsx");
    mkdirSync(dirname(output), { recursive: true });
    mkdirSync(workspace);
    writeFileSync(output, "template");
    const service = createPluginLocalArtifactService({
      pluginDataRoot,
      resolveWorkspace: async () => workspace
    });

    // A template is something the user fills in, not something the engagement
    // produced, so it is served but not written into outputs/.
    const hosted = await service.host({
      id: "legal-labor",
      approvedPermissions: [{ type: "host-service", services: ["plugin-data", "artifact-host"] }],
      config: {}
    }, {
      id: "checklist", name: "企业诊断前_资料准备清单.xlsx", mediaType: "application/vnd.ms-excel", uri: pathToFileURL(output).href, role: "setup"
    }, { conversationId: "websocket:chat-1", callId: "call-1" });

    expect(hosted.path).toBeUndefined();
    expect(existsSync(join(workspace, "outputs"))).toBe(false);
  });

  it("serves an artifact without publishing when the conversation has no workspace", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-publish-noworkspace-"));
    const pluginDataRoot = join(root, "plugin-data");
    const output = join(pluginDataRoot, "legal-labor", "sessions", "s1", "artifacts", "报告.docx");
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, "report");
    const service = createPluginLocalArtifactService({
      pluginDataRoot,
      // Non-WebUI invocations have no conversation workspace.
      resolveWorkspace: async () => null
    });

    const hosted = await service.host({
      id: "legal-labor",
      approvedPermissions: [{ type: "host-service", services: ["plugin-data", "artifact-host"] }],
      config: {}
    }, {
      id: "report", name: "报告.docx", mediaType: "application/vnd.ms-word", uri: pathToFileURL(output).href, role: "deliverable"
    }, { conversationId: "websocket:chat-1", callId: "call-1" });

    expect(hosted.path).toBeUndefined();
    expect(hosted.uri).toMatch(/\/preview$/);
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
