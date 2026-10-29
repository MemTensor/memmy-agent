import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import JSZip from "jszip";
import { PluginManifestSchema, type PluginArtifactRef } from "@memmy/local-api-contracts";
import { createPluginArtifactManager } from "../adapters/outbound/plugin-artifact/index.js";
import { createHttpPluginRegistry } from "../adapters/outbound/plugin-registry/index.js";
import { createCommandPluginAdapter, createPluginRuntimeHost, PluginAdapterRegistry } from "../adapters/outbound/plugin-runtime/index.js";
import { createPluginSkillManager } from "../adapters/outbound/plugin-skill/index.js";
import { createPluginService, type PluginService } from "../services/plugin-service.js";
import { createPluginLocalArtifactService } from "../services/plugin-local-artifact-service.js";
import { createProgressBus } from "../services/progress-bus.js";
import { createAppStateStore, type AppStateStore } from "../infrastructure/app-state-store/index.js";
import { buildPluginMcpServer } from "../adapters/inbound/local-api/routes/plugin-mcp.js";
import { registerPluginRoutes } from "../adapters/inbound/local-api/routes/plugins.js";
import { AgentRunSpec, AgentRunner } from "../../../memmy-agent/src/core/agent-runtime/runner.js";
import { ContextBuilder } from "../../../memmy-agent/src/core/agent-runtime/context.js";
import { MCPToolWrapper } from "../../../memmy-agent/src/core/agent-runtime/tools/mcp.js";
import { ToolRegistry } from "../../../memmy-agent/src/core/agent-runtime/tools/registry.js";
import { LLMResponse, ToolCallRequest } from "../../../memmy-agent/src/providers/base.js";
import { resolveModelSelection } from "../../../memmy-agent/src/providers/model-catalog.js";
import YAML from "yaml";
import { createOfficeRuntimeInstaller } from "../adapters/outbound/plugin-runtime/office-installer.js";
import { serveRegistry } from "../../../../plugins/office/scripts/serve.mjs";

const repo = resolve(import.meta.dirname, "../../../..");
const pluginRoot = join(repo, "plugins/office");
const releaseRoot = join(pluginRoot, "release");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const cleanup: Array<() => unknown> = [];
// A verified renderer contains tens of thousands of files; Windows ACL cleanup
// and antivirus scanning take longer than Vitest's default ten-second hook.
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); }, 120000);

describe("Office MPP end to end", () => {
  it("publishes immutable registry releases and rejects tampered artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "office-publish-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const manifest = PluginManifestSchema.parse(JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf8")));
    const descriptor = join(releaseRoot, `office-${manifest.version}.release.json`);
    const archive = join(releaseRoot, `office-${manifest.version}.mpp.zip`);
    const publisher = join(pluginRoot, "scripts/publish.mjs");
    expect(existsSync(publisher), "The Office registry publisher must be available").toBe(true);
    const args = [publisher, "--help"];
    const help = execFileSync(process.execPath, args, { encoding: "utf8" });
    expect(help).toContain("--set-default");
    execFileSync(process.execPath, [publisher, "--root", root, "--descriptor", descriptor, "--artifact", archive, "--set-default"], { encoding: "utf8" });
    const registry = await serveRegistry({ root });
    cleanup.push(() => new Promise<void>(ok => registry.server.close(() => ok())));
    const remote = createHttpPluginRegistry({ baseUrl: registry.baseUrl });
    const listed = await remote.list!();
    expect(listed.map(item => item.id)).toEqual(["office"]);
    expect((await remote.resolve("office")).manifest.rules).toMatchObject({ installation: "manual", distribution: "public", requiresLogin: false });
    const bad = join(root, "bad.zip"); writeFileSync(bad, "tampered");
    expect(() => execFileSync(process.execPath, [publisher, "--root", root, "--descriptor", descriptor, "--artifact", bad], { stdio: "pipe" })).toThrow();
  });

  it("installs the real release, runs all formats through MCP/Agent, renders actual pages, delivers files and unregisters on disable/uninstall", async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "office-installed-e2e-")));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace"), uploads = join(root, "uploads"), dataRoot = join(root, "plugin-data");
    mkdirSync(workspace); mkdirSync(uploads);
    const registry = await serveRegistry({ root: releaseRoot });
    cleanup.push(() => new Promise<void>(ok => registry.server.close(() => ok())));
    const store: AppStateStore = createAppStateStore({ databasePath: join(root, "app.sqlite") });
    cleanup.push(() => store.close());
    const installationStages: string[] = [];
    const managed = process.env.OFFICE_E2E_MANAGED_RUNTIME === "1";
    if (managed) {
      const previous = process.env.MEMMY_OFFICE_RUNTIME_PREFER_MANAGED;
      process.env.MEMMY_OFFICE_RUNTIME_PREFER_MANAGED = "1";
      cleanup.push(() => { if (previous === undefined) delete process.env.MEMMY_OFFICE_RUNTIME_PREFER_MANAGED; else process.env.MEMMY_OFFICE_RUNTIME_PREFER_MANAGED = previous; });
    }
    const installer = managed ? createOfficeRuntimeInstaller({ cacheRoot: join(root, "managed-runtime"), catalogUrl: `${registry.baseUrl}/api/v1/plugins/office/runtimes/{target}`, onProgress: stage => { installationStages.push(stage); } }) : undefined;
    const runtime = createPluginRuntimeHost(new PluginAdapterRegistry([
      createCommandPluginAdapter({ fileInputRoots: [uploads], pluginDataRoot: dataRoot, officeRuntimeInstaller: installer })
    ]));
    const service: PluginService = createPluginService({ repository: store.repositories.plugins, secretStore: store.secretStore,
      registry: createHttpPluginRegistry({ baseUrl: registry.baseUrl }), runtimeHost: runtime,
      artifactManager: createPluginArtifactManager({ installRoot: join(root, "installed") }),
      skillManager: createPluginSkillManager({ skillsRoot: join(workspace, "skills") }),
      localArtifactService: createPluginLocalArtifactService({ pluginDataRoot: dataRoot, resolveWorkspace: async () => workspace }),
      isAuthenticated: () => false, isEntitlementGranted: () => false });
    cleanup.push(() => service.shutdown());
    const catalog = await service.catalog();
    expect(catalog[0]?.eligibility.canInstall).toBe(true);
    const installed = await service.install("office");
    expect(installed.state).toBe("pending_approval");
    await service.approvePermissions("office", installed.manifest.permissions);
    expect((await service.enable("office")).state).toBe("active");
    const progress = createProgressBus();
    const api = Fastify(); registerPluginRoutes(api, { plugins: service, progressBus: progress, authenticateRuntimeToken: async () => undefined });
    cleanup.push(() => api.close());
    const server = buildPluginMcpServer(service, progress);
    const client = new Client({ name: "office-e2e", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
    cleanup.push(async () => { await client.close(); await server.close(); });
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(installed.manifest.capabilities.length);
    const toolName = (id: string) => tools.find(t => t.name.includes(`${id}_`))!.name;
    const results: Array<Record<string, any>> = [];
    const call = async (id: string, args: Record<string, unknown>, expectedError?: string | readonly string[]) => {
      console.info(`Office E2E: ${id} started`);
      const result = await client.callTool({ name: toolName(id), arguments: args, _meta: { "memmy.dev/session-key": "office-e2e" } }, undefined, { timeout: 360000 });
      console.info(`Office E2E: ${id} completed`);
      const text = (result.content as Array<{ type: string; text?: string }>).find(c => c.type === "text")?.text ?? "";
      if (expectedError) {
        expect(result.isError).toBe(true);
        if (typeof expectedError === "string") expect(text).toContain(expectedError);
        else expect(expectedError.some(code => text.startsWith(`${code}:`)), text).toBe(true);
        return {};
      }
      expect(result.isError, `${id}: ${text}`).not.toBe(true);
      const output = JSON.parse(text); results.push(output);
      if (id === "office_review_page") expect((result.content as Array<{ type: string }>).some(c => c.type === "image")).toBe(true);
      return output;
    };
    if (managed) expect(installationStages).toContain("installed");
    const status = await call("office_status", {});
    expect(status.ready, JSON.stringify(status)).toBe(true);
    const advanced = await call("office_execute", { code: `
      const document = new docx.Document({sections:[{children:[new docx.Table({rows:[new docx.TableRow({children:[new docx.TableCell({children:[new docx.Paragraph("Advanced template table")]})]})]})]}]});
      await fs.writeFile(path.join(workspace, "table.docx"), await docx.Packer.toBuffer(document));
      return {files:["table.docx"]};
    ` });
    expect((await call("office_inspect", { taskId: advanced.taskId, file: "table.docx" })).text).toContain("Advanced template table");
    for (const format of ["docx", "pdf", "pptx", "xlsx"]) {
      const content = format === "pptx" ? { slides: [{ title: "Office integration", body: ["Independent plugin", "Actual page rendering"], notes: "Preserved speaker notes" }] }
        : format === "xlsx" ? { sheets: [{ name: "Budget", rows: [["Item", "Amount"], ["Research", 20], ["Writing", 30]] }] }
        : { title: "Office integration", paragraphs: ["This document verifies the standalone Office plugin.", "中文内容：文档生成、预览与交付。"] };
      let document = await call("office_create", { format, name: `sample.${format}`, ...content });
      const source = join(dataRoot, "office/tasks", document.taskId, document.file);
      const sourceHash = sha(readFileSync(source));
      const summary = await call("office_inspect", { taskId: document.taskId, file: document.file });
      expect(summary.format).toBe(format);
      if (format === "pdf") expect(summary.text).toContain("中文内容");
      if (format === "pptx") expect(summary.text).toContain("Preserved speaker notes");
      if (format === "docx" || format === "pptx") {
        const originalZip = await JSZip.loadAsync(readFileSync(source));
        document = await call("office_edit", { taskId: document.taskId, file: document.file, name: `edited.${format}`, replacements: [{ from: "Office integration", to: "Office delivery verified" }] });
        const edited = await JSZip.loadAsync(readFileSync(join(dataRoot, "office/tasks", document.taskId, document.file)));
        for (const name of Object.keys(originalZip.files).filter(n => !originalZip.files[n]!.dir && !/^(word\/document|ppt\/slides\/slide1)\.xml$/.test(n))) {
          expect(await edited.file(name)!.async("nodebuffer"), `Untouched part ${name}`).toEqual(await originalZip.file(name)!.async("nodebuffer"));
        }
        expect((await call("office_inspect", { taskId: document.taskId, file: document.file })).text).toContain("Office delivery verified");
      }
      if (format === "xlsx") {
        document = await call("office_edit", { taskId: document.taskId, file: document.file, name: "calculation.xlsx", cells: [{ sheet: "Budget", address: "B4", formula: "SUM(B2:B3)" }] });
        const stale = await call("office_execute", { sourceTaskId: document.taskId, inputFiles: [document.file], code: `
          const book = new ExcelJS.Workbook(); await book.xlsx.readFile(path.join(workspace, ${JSON.stringify(document.file)}));
          book.getWorksheet("Budget").getCell("B4").value = {formula:"SUM(B2:B3)",result:0};
          const checks = book.addWorksheet("Checks");
          checks.addRows([[{formula:"Budget!B4*2",result:999}], [{formula:'IF(A1=100,"OK","BAD")',result:"STALE"}], [{formula:"A1=100",result:false}], ["KEEP"]]);
          await fs.writeFile(path.join(workspace,"stale-cache.xlsx"),await book.xlsx.writeBuffer());
          return {files:["stale-cache.xlsx"]};
        ` });
        document = { taskId: stale.taskId, file: stale.files[0] };
        const stalePath = join(dataRoot, "office/tasks", document.taskId, document.file);
        const staleBytes = readFileSync(stalePath);
        expect((await call("office_inspect", document)).formulas.map((f: { cachedValue: string }) => f.cachedValue)).toEqual(["0", "999", "STALE", "0"]);
        await call("office_convert", { taskId: document.taskId, file: document.file, format: "xlsx" }, "preservation_consent_required");
        document = await call("office_convert", { taskId: document.taskId, file: document.file, format: "xlsx", allowLossy: true });
        expect(readFileSync(stalePath)).toEqual(staleBytes);
        const calculated = await call("office_inspect", { taskId: document.taskId, file: document.file });
        expect(calculated.formulas.map((f: { cachedValue: string }) => f.cachedValue)).toEqual(["50", "100", "OK", "1"]);
        expect(calculated.sheets.find((s: { name: string }) => s.name === "Checks").rows[3][0]).toBe("KEEP");
        const calculatedBytes = readFileSync(join(dataRoot, "office/tasks", document.taskId, document.file));
        const copied = await call("office_execute", { sourceTaskId: document.taskId, inputFiles: [document.file], code: `
          await fs.copyFile(path.join(workspace, ${JSON.stringify(document.file)}), path.join(workspace, "renamed-budget.xlsx"));
          return {files:["renamed-budget.xlsx"]};
        ` });
        document = { taskId: copied.taskId, file: copied.files[0] };
        expect(readFileSync(join(dataRoot, "office/tasks", document.taskId, document.file))).toEqual(calculatedBytes);
        await call("office_deliver", { taskId: document.taskId, file: document.file, revision: sha(calculatedBytes), reviewedPages: [1], reviewNotes: "not yet reviewed" }, "stale_review");
      }
      const rendered = await call("office_render", { taskId: document.taskId, file: document.file });
      expect(rendered.pages.length).toBeGreaterThan(0);
      const pageNumbers = rendered.pages.map((p: { page: number }) => p.page);
      await call("office_deliver", { taskId: document.taskId, file: document.file, revision: rendered.revision, reviewedPages: pageNumbers, reviewNotes: "premature" }, "pages_not_viewed");
      for (const page of pageNumbers) {
        const viewed = await call("office_review_page", { taskId: document.taskId, file: document.file, revision: rendered.revision, page });
        const preview = await api.inject({ method: "GET", url: viewed.artifacts[0].uri });
        expect(preview.statusCode).toBe(200);
        expect(preview.rawPayload.subarray(1, 4).toString()).toBe("PNG");
        // Retain real renderings for a human/model visual review after the run.
        const qaRoot = process.env.OFFICE_E2E_QA_DIR;
        if (qaRoot) { mkdirSync(qaRoot, { recursive: true }); writeFileSync(join(qaRoot, `${format}-page-${page}.png`), preview.rawPayload); }
      }
      const delivered = await call("office_deliver", { taskId: document.taskId, file: document.file, revision: rendered.revision, reviewedPages: pageNumbers,
        reviewNotes: "Automated transport check only; retained PNGs require separate visual review." });
      const artifact = delivered.artifacts[0] as PluginArtifactRef;
      expect(dirname(realpathSync.native(artifact.path!))).toBe(realpathSync.native(join(workspace, "outputs/office", document.taskId)));
      const preview = await api.inject({ method: "GET", url: artifact.uri });
      const download = await api.inject({ method: "GET", url: artifact.downloadUri! });
      expect(preview.statusCode).toBe(200); expect(download.statusCode).toBe(200);
      expect(preview.rawPayload).toEqual(download.rawPayload);
      expect(readFileSync(artifact.path!)).toEqual(download.rawPayload);
      expect(sha(readFileSync(source))).toBe(sourceHash);
      await call("office_review_page", { taskId: document.taskId, file: document.file, revision: "invalid", page: 1 }, "stale_review");
    }

    // Real AgentRunner + MCP wrapper, with a deterministic provider. This proves
    // tool routing and image transport, not live-model selection or visual judgment.
    const agentTools = new ToolRegistry();
    const session = { callTool: (name: string, args: Record<string, unknown>, timeout: number, meta?: Record<string, string>) =>
      client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) }, undefined, { timeout: timeout * 1000 }) };
    const wrappers = new Map<string, MCPToolWrapper>();
    for (const capability of installed.manifest.capabilities) {
      const wrapper = new MCPToolWrapper(session, "plugins", tools.find(t => t.name === toolName(capability.id))!, 180);
      agentTools.register(wrapper); wrappers.set(capability.id, wrapper);
    }
    let step = 0; let agentDocument: any; let agentRender: any;
    const provider = { generation: { maxTokens: 512 }, getDefaultModel: () => "gpt-4o",
      chatWithRetry: async ({ messages }: { messages: Array<Record<string, any>> }) => {
        const latest = messages.filter(m => m.role === "tool").at(-1)?.content;
        const text = Array.isArray(latest) ? latest.find(c => c.type === "text")?.text : latest;
        const last = text ? JSON.parse(text) : {};
        const tool = (id: string, args: Record<string, unknown>) => new LLMResponse({ content: null, finishReason: "tool_calls",
          toolCalls: [new ToolCallRequest({ id: `office-agent-${step}`, name: wrappers.get(id)!.name, arguments: args })] });
        switch (step++) {
          case 0: return tool("office_create", { format: "docx", name: "agent.docx", title: "Agent Office delivery", paragraphs: ["Generated through the actual Agent tool loop."] });
          case 1: agentDocument = last; return tool("office_render", { taskId: last.taskId, file: last.file });
          case 2: agentRender = last; expect(last.pages).toHaveLength(1); return tool("office_review_page", { taskId: last.taskId, file: last.file, revision: last.revision, page: 1 });
          case 3:
            expect(Array.isArray(latest) && latest.some(c => c.type === "image_url")).toBe(true);
            return tool("office_deliver", { taskId: agentDocument.taskId, file: agentDocument.file, revision: agentRender.revision,
              reviewedPages: [1], reviewNotes: "Scripted Agent image transport test; visual review is performed separately." });
          default: expect(last.artifacts[0].downloadUri).toContain("/download"); return new LLMResponse({ content: "Office file delivered.", finishReason: "stop" });
        }
      } };
    const context = new ContextBuilder({ workspace, fileMemoryEnabled: false });
    const system = context.buildSystemPrompt(["office-docx"]);
    expect(system).toContain("office_review_page");
    expect(context.skills.listSkills().filter(s => s.name.startsWith("office-")).map(s => s.name)).toEqual(["office-docx", "office-pdf", "office-pptx", "office-xlsx"]);
    const run = await new AgentRunner(provider as never).run(new AgentRunSpec({ provider: provider as never, tools: agentTools, model: "gpt-4o", maxIterations: 8,
      messages: [{ role: "system", content: system }, { role: "user", content: "$office-docx Create a short Word report and deliver the file." }] }));
    expect(run.finalContent).toBe("Office file delivered.");
    expect(run.toolsUsed).toContain(wrappers.get("office_deliver")!.name);

    let liveRun;
    if (process.env.OFFICE_LIVE_AGENT === "1") {
      const configPath = resolve(process.env.MEMMY_CONFIG ?? join(homedir(), ".memmy/config.yaml"));
      const config = YAML.parse(readFileSync(configPath, "utf8"));
      const mode = config.modelAssignments?.account?.agent?.default ? "account" : "byok";
      const selected = resolveModelSelection({ configPath, mode, activeAccountId: mode === "account" ? config.app?.userId ?? null : null, capability: "agent" });
      if (!selected) throw new Error("No configured Memmy model is available for Office live Agent validation");
      const liveArtifacts: PluginArtifactRef[] = [];
      const livePreviewArtifacts: PluginArtifactRef[] = [];
      const unsubscribe = progress.on("plugin.capability_event", event => {
        if (event.event.type === "artifact" && event.event.artifact.role === "deliverable") liveArtifacts.push(event.event.artifact);
        if (event.event.type === "artifact" && event.event.artifact.role === "setup" && event.event.artifact.mediaType === "image/png") livePreviewArtifacts.push(event.event.artifact);
      });
      try {
        liveRun = await new AgentRunner(selected.snapshot.provider).run(new AgentRunSpec({ provider: selected.snapshot.provider,
          model: selected.model, tools: agentTools, maxIterations: 20,
          messages: [{ role: "system", content: system }, { role: "user", content: "$office-docx 请使用 Office 插件制作一页中文 Word 报告，标题为“Office 插件验收”，用一个两列表格列出文档处理、图像检查、文件交付三项能力。请先检查依赖，通过 office_execute 使用 docx 库生成可编辑表格，再读取检查、实际渲染，调用 office_review_page 观察每页图像；修复发现的问题后调用 office_deliver 交付文件。无需再次确认，不要只汇报计划。最后返回工具实际给出的下载链接。" }] }));
        expect(liveRun.toolsUsed).toContain(wrappers.get("office_execute")!.name);
        expect(liveRun.toolsUsed).toContain(wrappers.get("office_review_page")!.name);
        expect(liveRun.toolsUsed).toContain(wrappers.get("office_deliver")!.name);
        expect(liveArtifacts.length).toBeGreaterThan(0);
        expect(existsSync(liveArtifacts.at(-1)!.path!)).toBe(true);
        if (process.env.OFFICE_E2E_QA_DIR) {
          const qaRoot = process.env.OFFICE_E2E_QA_DIR; mkdirSync(qaRoot, { recursive: true });
          writeFileSync(join(qaRoot, "live-agent-report.docx"), readFileSync(liveArtifacts.at(-1)!.path!));
          for (const [index, preview] of livePreviewArtifacts.entries()) {
            const token = preview.uri.split("/").at(-2)!;
            const opened = await service.openArtifact("office", token);
            writeFileSync(join(qaRoot, `live-agent-page-${index + 1}.png`), readFileSync(opened.path));
          }
        }
      } finally { unsubscribe(); }
    }

    // Imported files are copied and never altered; forbidden formats/paths fail.
    const uploaded = join(uploads, "uploaded.docx");
    writeFileSync(uploaded, readFileSync(join(dataRoot, "office/tasks", agentDocument.taskId, "agent.docx")));
    const uploadHash = sha(readFileSync(uploaded));
    const imported = await call("office_import", { path: uploaded });
    expect(imported.sourceUnchanged).toBe(true); expect(sha(readFileSync(uploaded))).toBe(uploadHash);
    await call("office_inspect", { taskId: imported.taskId, file: "../uploaded.docx" }, "invalid_path");
    // The Unix system path does not exist on Windows, where ENOENT proves
    // nothing about sandbox denial. The owned, existing fixture below covers
    // denied imports on every platform without relying on OS-specific paths.
    if (process.platform !== "win32") await call("office_import", { path: "/etc/passwd" }, "EPERM");
    const deniedPath = join(root, "outside.docx"); writeFileSync(deniedPath, readFileSync(uploaded));
    expect(existsSync(deniedPath)).toBe(true);
    const deniedHash = sha(readFileSync(deniedPath));
    // Both OS-level access denial and the plugin's approved-root guard reject
    // this file; missing-file and unrelated errors must not satisfy the test.
    await call("office_import", { path: deniedPath }, ["EPERM", "EACCES", "unsafe_file"]);
    expect(sha(readFileSync(deniedPath))).toBe(deniedHash);

    await service.disable("office");
    expect((await client.listTools()).tools).toEqual([]);
    expect(existsSync(join(workspace, "skills/office-docx"))).toBe(false);
    expect((await client.callTool({ name: toolName("office_status"), arguments: {} })).isError).toBe(true);
    await service.enable("office"); expect((await client.listTools()).tools).toHaveLength(tools.length);
    await service.uninstall("office"); expect((await client.listTools()).tools).toEqual([]);
    expect(existsSync(join(workspace, "skills/office-xlsx"))).toBe(false);
    const report = process.env.OFFICE_E2E_REPORT;
    if (report) writeFileSync(report, JSON.stringify({ result: "passed", pluginVersion: installed.version, platform: process.platform, realSandbox: true, realRenderer: true,
      managedRuntime: managed, runtimeInstallationStages: [...new Set(installationStages)],
      liveModel: Boolean(liveRun), visualReview: liveRun ? "Live Agent inspected rendered pages" : "PNG inspection required separately", formats: ["docx", "pdf", "pptx", "xlsx"], steps: results.length, agentTools: run.toolsUsed,
      ...(liveRun ? { liveAgentTools: liveRun.toolsUsed, liveAgentFinal: liveRun.finalContent } : {}) }, null, 2));
  }, process.env.OFFICE_LIVE_AGENT === "1" ? 900000 : process.platform === "win32" ? 1800000 : 600000);
});
