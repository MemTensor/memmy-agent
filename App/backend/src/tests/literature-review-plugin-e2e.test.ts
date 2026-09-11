import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type Server as HttpServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { buildPluginMcpServer } from "../adapters/inbound/local-api/routes/plugin-mcp.js";
import { registerPluginRoutes } from "../adapters/inbound/local-api/routes/plugins.js";
import { createPluginArtifactManager } from "../adapters/outbound/plugin-artifact/index.js";
import { createHttpPluginRegistry } from "../adapters/outbound/plugin-registry/index.js";
import {
  createCommandPluginAdapter,
  createPluginRuntimeHost,
  PluginAdapterRegistry
} from "../adapters/outbound/plugin-runtime/index.js";
import { createPluginSkillManager } from "../adapters/outbound/plugin-skill/index.js";
import { createAppStateStore, type AppStateStore } from "../infrastructure/app-state-store/index.js";
import { createPluginService } from "../services/plugin-service.js";
import { createPluginLocalArtifactService } from "../services/plugin-local-artifact-service.js";
import { createProgressBus } from "../services/progress-bus.js";
import { AgentRunSpec, AgentRunner } from "../../../memmy-agent/src/core/agent-runtime/runner.js";
import { ContextBuilder } from "../../../memmy-agent/src/core/agent-runtime/context.js";
import { MCPToolWrapper } from "../../../memmy-agent/src/core/agent-runtime/tools/mcp.js";
import { ToolRegistry } from "../../../memmy-agent/src/core/agent-runtime/tools/registry.js";
import { LLMResponse, ToolCallRequest } from "../../../memmy-agent/src/providers/base.js";
import { resolveModelSelection } from "../../../memmy-agent/src/providers/model-catalog.js";
import YAML from "yaml";

const pluginRoot = resolve(process.env.LITERATURE_REVIEW_PLUGIN_ROOT ?? join(process.cwd(), "..", "Literature-Review-Plugin"));
const manifestPath = join(pluginRoot, "plugin.json");
const integrationAvailable = existsSync(manifestPath);
const liveAgentEnabled = process.env.LITERATURE_REVIEW_LIVE_AGENT === "1";
let root: string | undefined;
let store: AppStateStore | undefined;
let client: Client | undefined;
let mcpServer: ReturnType<typeof buildPluginMcpServer> | undefined;
let registryServer: HttpServer | undefined;

afterEach(async () => {
  await client?.close();
  await mcpServer?.close();
  if (registryServer) await new Promise<void>((resolveClose) => registryServer!.close(() => resolveClose()));
  store?.close();
  client = undefined;
  mcpServer = undefined;
  registryServer = undefined;
  store = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe.skipIf(!integrationAvailable)("installed Literature Review Plugin", () => {
  it("installs the real MPP, runs the complete review tool chain, hosts outputs, and unregisters on disable", async () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const descriptor = JSON.parse(readFileSync(join(pluginRoot, "release", `${manifest.id}-${manifest.version}.release.json`), "utf8"));
    const archivePath = join(pluginRoot, "release", descriptor.artifact.file);
    const registry = await serveRelease(manifest, descriptor.artifact.sha256, archivePath);
    registryServer = registry.server;
    root = mkdtempSync(join(tmpdir(), "memmy-literature-review-package-e2e-"));
    const installRoot = join(root, "installed-plugins");
    const dataRoot = join(root, "plugin-data");
    const mediaRoot = join(root, "agent-data", "media");
    const skillsRoot = join(root, "workspace", "skills");
    const trace: Array<Record<string, unknown>> = [];
    mkdirSync(mediaRoot, { recursive: true });
    const sourcePath = join(mediaRoot, "host-service-evidence.txt");
    writeFileSync(sourcePath, Array.from({ length: 18 }, (_, index) =>
      `Study ${index + 1} reports that retrieval quality improves evidence grounding in persistent agent memory, while stale context increases conflicts and unsupported answers.`
    ).join("\n\n"), "utf8");
    const preloadPath = join(root, "academic-provider-fixture.mjs");
    writeFileSync(preloadPath, providerFetchPreload(), "utf8");

    store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
    const runtimeHost = createPluginRuntimeHost(new PluginAdapterRegistry([
      createCommandPluginAdapter({
        allowedNetworkHosts: manifest.permissions
          .filter((permission: { type: string }) => permission.type === "network")
          .flatMap((permission: { hosts: string[] }) => permission.hosts),
        fileInputRoots: [mediaRoot],
        pluginDataRoot: dataRoot,
        hostServices: {
          async invoke(call) {
            trace.push({ phase: "host-service", service: call.service, callId: call.callId });
            if (call.service === "model-inference") {
              const input = call.input as { messages?: Array<{ role?: string; content?: string }> };
              const system = input.messages?.find((message) => message.role === "system")?.content ?? "";
              const request = JSON.parse(input.messages?.at(-1)?.content ?? "{}") as Record<string, unknown>;
              return {
                content: JSON.stringify(modelFixtureResponse(system, request)),
                finishReason: "stop",
                usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
                model: { provider: "fixture", model: "fixture-model" }
              };
            }
            if (call.service === "embedding-inference") {
              const texts = (call.input as { texts?: string[] }).texts ?? [];
              return {
                embeddings: texts.map((text) => [
                  text.toLowerCase().includes("retriev") ? 1 : 0.2,
                  text.toLowerCase().includes("memory") ? 1 : 0.2,
                  text.toLowerCase().includes("evidence") ? 0.8 : 0.1,
                  0.4
                ]),
                model: { provider: "fixture", model: "fixture-embedding", mode: "local", dimension: 4 }
              };
            }
            throw Object.assign(new Error(`Unavailable fixture Host service: ${call.service}`), { code: "host_service_unavailable" });
          }
        },
        buildLaunch: async (context, config, networkEnabled) => {
          trace.push({ phase: "activate", rootPath: context.rootPath, networkEnabled });
          return {
            command: process.execPath,
            args: ["--import", pathToFileURL(preloadPath).href, join(context.rootPath!, config.command), ...config.args],
            cwd: join(context.rootPath!, config.cwd)
          };
        }
      })
    ]));
    const localArtifactService = createPluginLocalArtifactService({ pluginDataRoot: dataRoot });
    const progressBus = createProgressBus();
    const service = createPluginService({
      repository: store.repositories.plugins,
      secretStore: store.secretStore,
      registry: createHttpPluginRegistry({ baseUrl: registry.baseUrl }),
      runtimeHost,
      artifactManager: createPluginArtifactManager({ installRoot }),
      skillManager: createPluginSkillManager({ skillsRoot }),
      localArtifactService
    });

    const installed = await service.install(manifest.id, manifest.version);
    trace.push({ phase: "installed", version: installed.version, state: installed.state });
    expect(installed.state).toBe("pending_approval");
    service.configure(manifest.id, { config: {}, secrets: {} });
    await service.approvePermissions(manifest.id, manifest.permissions);
    const active = await service.enable(manifest.id);
    trace.push({ phase: "enabled", state: active.state });
    expect(active.state).toBe("active");
    expect(readFileSync(join(skillsRoot, "literature-review", "SKILL.md"), "utf8")).toContain("# Literature Review");
    await expect(service.readUi(manifest.id, "renderer")).resolves.toContain("memmy.plugin.render");

    mcpServer = buildPluginMcpServer(service, progressBus);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "literature-review-package-e2e", version: "1.0.0" });
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools;
    const createTool = tools.find((tool) => tool.name.includes("review_create_task"));
    const statusTool = tools.find((tool) => tool.name.includes("review_get_status"));
    expect(createTool).toBeDefined();
    expect(statusTool).toBeDefined();
    trace.push({ phase: "registered", toolCount: tools.length, createTool: createTool!.name });

    const created = await client.callTool({
      name: createTool!.name,
      arguments: { title: "Host package smoke", topic: "memory-augmented agents" },
      _meta: { "memmy.dev/session-key": "desktop:literature-review-e2e" }
    });
    if (created.isError) throw new Error(`Installed plugin create-task call failed: ${JSON.stringify(created.content)}`);
    expect(created.isError).not.toBe(true);
    const createOutput = created.structuredContent as { taskId?: string; suggestedNextTools?: unknown[] };
    expect(createOutput.taskId).toMatch(/^review-/);
    trace.push({ phase: "invoked", capabilityId: "review_create_task", taskId: createOutput.taskId });

    const status = await client.callTool({
      name: statusTool!.name,
      arguments: { taskId: createOutput.taskId },
      _meta: { "memmy.dev/session-key": "desktop:literature-review-e2e" }
    });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent).toMatchObject({ taskId: createOutput.taskId, ok: true });
    trace.push({ phase: "persisted", capabilityId: "review_get_status", taskId: createOutput.taskId });

    const cancellableRunId = "interaction-cancel-target";
    const cancellable = service.invoke({
      callId: cancellableRunId,
      pluginId: manifest.id,
      capabilityId: "review_request_interaction",
      conversationId: "desktop:literature-review-e2e",
      input: { taskId: createOutput.taskId, type: "review-spec" }
    })[Symbol.asyncIterator]();
    expect((await cancellable.next()).value).toMatchObject({ type: "interaction" });
    let cancelOutput: Record<string, unknown> | undefined;
    for await (const event of service.invoke({
      callId: "cancel-control-call",
      pluginId: manifest.id,
      capabilityId: "review_cancel",
      conversationId: "desktop:literature-review-e2e",
      input: { taskId: createOutput.taskId, scope: "run", runId: cancellableRunId, reason: "E2E cancellation check" }
    })) {
      if (event.type === "result") cancelOutput = event.output as Record<string, unknown>;
    }
    expect(cancelOutput).toMatchObject({ ok: true, data: { scope: "run", taskCancelled: false, cancelledRun: { runId: cancellableRunId, status: "cancelled" } } });
    expect((await cancellable.next()).value).toMatchObject({ type: "error", code: "plugin_cancelled", retryable: false });
    let cancellationStatus: Record<string, unknown> | undefined;
    for await (const event of service.invoke({
      callId: "status-after-cancel-result",
      pluginId: manifest.id,
      capabilityId: "review_get_status",
      conversationId: "desktop:literature-review-e2e",
      input: { taskId: createOutput.taskId }
    })) {
      if (event.type === "result") cancellationStatus = event.output as Record<string, unknown>;
    }
    expect(cancellationStatus).toMatchObject({ ok: true, data: { cancelled: false } });
    expect(((cancellationStatus?.data as { runs?: Array<{ runId: string; status: string }> } | undefined)?.runs ?? [])).toContainEqual(expect.objectContaining({ runId: cancellableRunId, status: "cancelled" }));
    trace.push({ phase: "run-cancellation-verified", runId: cancellableRunId, taskCancelled: false });

    const call = async (capabilityId: string, args: Record<string, unknown>) => {
      const tool = tools.find((candidate) => candidate.name.includes(capabilityId));
      if (!tool) throw new Error(`Agent tool was not registered: ${capabilityId}`);
      const result = await client!.callTool({
        name: tool.name,
        arguments: args,
        _meta: { "memmy.dev/session-key": "desktop:literature-review-e2e" }
      });
      if (result.isError) throw new Error(`${capabilityId} failed: ${JSON.stringify(result.content)}`);
      trace.push({ phase: "invoked", capabilityId });
      return result.structuredContent as Record<string, unknown>;
    };

    const interact = async (
      type: "review-spec" | "source-import" | "keywords" | "outline" | "paper-selection",
      responseFor: (request: Record<string, unknown>) => Record<string, unknown>
    ) => {
      const callId = `interaction-${type}`;
      let response: Record<string, unknown> | undefined;
      let output: Record<string, unknown> | undefined;
      for await (const event of service.invoke({
        callId,
        pluginId: manifest.id,
        capabilityId: "review_request_interaction",
        conversationId: "desktop:literature-review-e2e",
        input: { taskId: createOutput.taskId, type }
      })) {
        if (event.type === "interaction") {
          const request = event.request as unknown as Record<string, unknown>;
          response = responseFor(request);
          trace.push({
            phase: "interaction-requested",
            cardType: type,
            envelopeType: event.request.type,
            interactionId: event.request.interactionId
          });
          await service.respond(manifest.id, callId, event.request.interactionId, response);
          trace.push({ phase: "interaction-submitted", cardType: type, interactionId: event.request.interactionId });
        }
        if (event.type === "result") output = event.output as Record<string, unknown>;
      }
      if (!response || !output) throw new Error(`Interaction ${type} did not complete through the Host response channel.`);
      expect(output).toMatchObject({ ok: true, data: { response } });
      return { response, output };
    };

    const customResponse = (request: Record<string, unknown>, values: Record<string, unknown>) => {
      const payload = request.payload as Record<string, unknown>;
      const baseArtifact = payload.baseArtifact as Record<string, unknown> | undefined;
      return {
        action: "submit",
        ...(typeof baseArtifact?.contentHash === "string" ? { baseArtifactHash: baseArtifact.contentHash } : {}),
        values
      };
    };

    const confirmedSpec = {
        title: "Hosted literature review artifact",
        topic: "How retrieval quality affects grounded long-term agent memory",
        researchQuestions: ["How does retrieval quality affect grounded agent memory?"],
        onlineSearch: true,
        outputLanguage: "en",
        citationStyle: "apa",
        renderMode: "neurips-2024",
        outputFormats: ["pdf", "tex", "docx"]
    };
    const specInteraction = await interact("review-spec", (request) => customResponse(request, { spec: confirmedSpec }));
    await call("review_update_spec", {
      taskId: createOutput.taskId,
      spec: (specInteraction.response.values as { spec: unknown }).spec
    });
    const importInteraction = await interact("source-import", () => ({
      files: [{ path: sourcePath, name: "host-service-evidence.txt" }]
    }));
    const importSuggestion = (importInteraction.output.suggestedNextTools as Array<{ toolName: string; args: Record<string, unknown> }>)[0];
    expect(importSuggestion).toMatchObject({ toolName: "review_import_sources" });
    await call("review_import_sources", importSuggestion.args);
    await call("review_parse_sources", { taskId: createOutput.taskId });
    const interruptedRunId = "restart-interrupted-keywords";
    const interruptedAt = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(dataRoot, manifest.id, "tasks", createOutput.taskId!, "runs", `${interruptedRunId}.json`), `${JSON.stringify({
      runId: interruptedRunId,
      taskId: createOutput.taskId,
      toolName: "review_generate_keywords",
      status: "running",
      startedAt: interruptedAt,
      updatedAt: interruptedAt,
      heartbeatAt: interruptedAt,
      ownerPid: 987654321,
      input: { taskId: createOutput.taskId },
      inputHash: "sha256:e2e-fixture"
    }, null, 2)}\n`, "utf8");
    const restartStatus = await call("review_get_status", { taskId: createOutput.taskId });
    expect(restartStatus, JSON.stringify(restartStatus, null, 2)).toMatchObject({ ok: true });
    expect(((restartStatus.data as { recoverableRuns?: Array<{ runId: string; status: string }> } | undefined)?.recoverableRuns ?? []), JSON.stringify(restartStatus, null, 2)).toContainEqual(expect.objectContaining({ runId: interruptedRunId, status: "interrupted" }));
    const resumedKeywords = await call("review_resume", { taskId: createOutput.taskId, runId: interruptedRunId });
    expect(resumedKeywords).toMatchObject({ ok: true, data: { resumedFromRunId: interruptedRunId, resumedToolName: "review_generate_keywords" } });
    trace.push({ phase: "job-recovery-verified", interruptedRunId, resumed: true });
    const generatedKeywords = await call("review_generate_keywords", { taskId: createOutput.taskId });
    const keywordInteraction = await interact("keywords", (request) => customResponse(request, {
      keywords: (generatedKeywords.data as { keywords: unknown[] }).keywords
    }));
    await call("review_update_keywords", {
      taskId: createOutput.taskId,
      keywords: (keywordInteraction.response.values as { keywords: unknown[] }).keywords
    });
    const searched = await call("review_search_papers", { taskId: createOutput.taskId, providers: ["arxiv"], limit: 5 });
    const papers = (searched.data as { candidates: Array<{ id: string; authors: string[]; year?: number }> }).candidates;
    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({ authors: ["Ada Lovelace"], year: 2024 });
    const paperId = papers[0]!.id;
    const paperInteraction = await interact("paper-selection", (request) => customResponse(request, {
      includedPaperIds: [paperId], excludedPaperIds: []
    }));
    await call("review_update_paper_selection", {
      taskId: createOutput.taskId,
      ...(paperInteraction.response.values as { includedPaperIds: string[]; excludedPaperIds: string[] })
    });
    await call("review_resolve_metadata", { taskId: createOutput.taskId });
    const fetched = await call("review_fetch_fulltexts", { taskId: createOutput.taskId });
    expect(fetched.data).toMatchObject({ counts: { downloaded: 1 } });
    const readings = await call("review_build_readings", { taskId: createOutput.taskId });
    const readingData = readings.data as { evidenceUnits: unknown[]; readings?: unknown[]; chunks?: unknown[] };
    if (!readingData.evidenceUnits.length) {
      const debugStatus = await call("review_get_status", { taskId: createOutput.taskId });
      const values = (debugStatus.data as { values?: Record<string, unknown> }).values;
      throw new Error(`Downloaded PDF produced no evidence: ${JSON.stringify({ data: readingData, warnings: readings.warnings, diagnostics: values?.downloadParseDiagnostics, documents: values?.parsedDocuments })}`);
    }
    const outline = await call("review_generate_outline", { taskId: createOutput.taskId });
    expect(outline.data).toMatchObject({ generation: { mode: "host-model" } });
    const outlineInteraction = await interact("outline", (request) => customResponse(request, {
      outline: (outline.data as { outline: unknown[] }).outline
    }));
    await call("review_update_outline", {
      taskId: createOutput.taskId,
      outline: (outlineInteraction.response.values as { outline: unknown[] }).outline
    });
    expect(trace.filter((item) => item.phase === "interaction-submitted").map((item) => item.cardType)).toEqual([
      "review-spec", "source-import", "keywords", "paper-selection", "outline"
    ]);
    const mapped = await call("review_map_evidence", { taskId: createOutput.taskId });
    const packs = (mapped.data as { evidencePacks: Array<{ rankingMode: string }> }).evidencePacks;
    expect(packs.length).toBeGreaterThan(0);
    expect(packs.every((pack) => pack.rankingMode === "embedding+lexical")).toBe(true);
    expect(trace.some((item) => item.phase === "host-service" && item.service === "model-inference")).toBe(true);
    expect(trace.some((item) => item.phase === "host-service" && item.service === "embedding-inference")).toBe(true);
    expect(existsSync(join(dataRoot, manifest.id, "tasks", createOutput.taskId!, "task.json"))).toBe(true);
    trace.push({ phase: "host-boundaries-verified", modelInference: true, embeddingInference: true, taskData: true, networkPolicy: true });

    const generatedSections = await call("review_generate_sections", { taskId: createOutput.taskId, batchSize: 2 });
    expect(generatedSections.data).toMatchObject({ generation: { mode: "host-model" } });
    const refined = await call("review_refine", {
      taskId: createOutput.taskId,
      instruction: "Improve transitions without changing evidence or citations.",
      continuityScope: "adjacent",
      batchSize: 2
    });
    expect(refined.data).toMatchObject({ refinement: { validationPassed: true, citationsChanged: false } });
    await call("review_plan_figures", { taskId: createOutput.taskId });
    await call("review_build_tables", { taskId: createOutput.taskId });
    const bibliography = await call("review_build_bibliography", { taskId: createOutput.taskId });
    expect((bibliography.data as { records: unknown[] }).records).toHaveLength(1);
    const audit = await call("review_audit", { taskId: createOutput.taskId });
    expect(audit.data, JSON.stringify(audit.data, null, 2)).toMatchObject({ audit: { passed: true } });
    const abstractSuggestion = (audit.suggestedNextTools as Array<{ toolName: string; args?: Record<string, unknown> }>).find((item) => item.toolName === "review_generate_abstract");
    expect(abstractSuggestion?.args?.expectedArtifactHash).toMatch(/^sha256:/);
    const generatedAbstract = await call("review_generate_abstract", {
      taskId: createOutput.taskId,
      expectedArtifactHash: abstractSuggestion!.args!.expectedArtifactHash
    });
    expect(generatedAbstract.data).toMatchObject({ abstract: { language: "en" } });
    const renderPreflight = await call("review_check_render_environment", { taskId: createOutput.taskId });
    expect(renderPreflight.data).toMatchObject({
      environment: process.env.LITERATURE_REVIEW_REQUIRE_XELATEX === "1" ? { available: true, runtimeDependency: "texlive" } : { runtimeDependency: "texlive" }
    });

    const renderEvents = [];
    for await (const event of service.invoke({
      callId: "artifact-render-call",
      pluginId: manifest.id,
      capabilityId: "review_render",
      conversationId: "desktop:literature-review-e2e",
      input: { taskId: createOutput.taskId, formats: ["md", "bib", "pdf", "tex", "docx"] }
    })) renderEvents.push(event);
    trace.push({ phase: "invoked", capabilityId: "review_render" });
    const hostedArtifacts = renderEvents.flatMap((event) => event.type === "artifact" ? [event.artifact] : []);
    expect(hostedArtifacts.map((artifact) => artifact.name).sort()).toEqual(["neurips_2024.sty", "references.bib", "review.docx", "review.md", "review.pdf", "review.tex"]);
    expect(hostedArtifacts.every((artifact) => artifact.uri.startsWith(`/api/v1/plugins/${manifest.id}/artifacts/`) && artifact.downloadUri?.endsWith("/download"))).toBe(true);
    if (process.env.LITERATURE_REVIEW_REQUIRE_XELATEX === "1") {
      const renderedTask = JSON.parse(readFileSync(join(dataRoot, manifest.id, "tasks", createOutput.taskId!, "task.json"), "utf8"));
      const pdfOutput = renderedTask.values.outputs.find((output: { name: string }) => output.name === "review.pdf");
      expect(pdfOutput?.generation, JSON.stringify(pdfOutput?.generation, null, 2)).toMatchObject({ renderer: "xelatex", fallback: false, compile: { ok: true, passes: 2 } });
    }

    const api = Fastify();
    registerPluginRoutes(api, { plugins: service, progressBus, authenticateRuntimeToken: async () => undefined });
    await api.ready();
    try {
      for (const artifact of hostedArtifacts) {
        const preview = await api.inject({ method: "GET", url: artifact.uri });
        const download = await api.inject({ method: "GET", url: artifact.downloadUri! });
        expect(preview.statusCode).toBe(200);
        expect(preview.headers["content-disposition"]).toContain("inline");
        expect(preview.headers["content-security-policy"]).toContain("sandbox");
        expect(preview.headers["x-content-type-options"]).toBe("nosniff");
        expect(download.statusCode).toBe(200);
        expect(download.headers["content-disposition"]).toContain("attachment");
        expect(download.rawPayload.byteLength).toBeGreaterThan(0);
        if (artifact.name === "review.md") expect(preview.body).toContain("Hosted literature review artifact");
        if (artifact.name === "references.bib") {
          expect(preview.body).toContain("@article{lovelace2024grounded");
          expect(preview.body).toContain("eprint = {2401.01234}");
        }
        if (artifact.name === "review.pdf") expect(preview.rawPayload.subarray(0, 4).toString("ascii")).toBe("%PDF");
        if (artifact.name === "review.tex") {
          expect(preview.body).toContain("\\documentclass");
          expect(preview.body).toContain("\\usepackage[preprint]{neurips_2024}");
          expect(preview.body).toContain("\\cite{");
        }
        if (artifact.name === "neurips_2024.sty") expect(preview.body).toContain("\\ProvidesPackage{neurips_2024}");
        if (artifact.name === "review.docx") {
          expect(preview.headers["content-type"]).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
          expect(preview.rawPayload.subarray(0, 2).toString("ascii")).toBe("PK");
        }
      }
    } finally {
      await api.close();
    }
    trace.push({ phase: "artifact-api-verified", formats: hostedArtifacts.map((artifact) => artifact.name), preview: true, download: true });

    const originalToolsByCapability = new Map<string, (typeof tools)[number]>();
    for (const capability of manifest.capabilities.map((item: { id: string }) => item.id)) {
      const tool = tools.find((candidate) => candidate.name.includes(capability));
      if (!tool) throw new Error(`Agent integration capability was not registered: ${capability}`);
      originalToolsByCapability.set(capability, tool);
    }
    const agentTools = new ToolRegistry();
    const agentToolNames = new Map<string, string>();
    const agentToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const mcpSession = {
      callTool: async (name: string, args: Record<string, unknown>, timeout: number, meta?: Record<string, string>, signal?: AbortSignal | null) => {
        agentToolCalls.push({ name, args: structuredClone(args) });
        return client!.callTool(
          { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
          undefined,
          { timeout: timeout * 1_000, ...(signal ? { signal } : {}) }
        );
      }
    };
    for (const [capability, tool] of originalToolsByCapability) {
      const wrapper = new MCPToolWrapper(mcpSession, "plugins", tool, 60);
      agentTools.register(wrapper);
      agentToolNames.set(capability, wrapper.name);
    }

    const agentSpecBeforeChat = {
      ...confirmedSpec,
      title: "Agent-orchestrated review",
      outputLanguage: "en"
    };
    const pendingChat: Array<Record<string, unknown>> = [];
    const interactionResponses: Array<Promise<void>> = [];
    const agentCardTypes: string[] = [];
    const unsubscribe = progressBus.on("plugin.capability_event", (event) => {
      if (event.capabilityId === "review_create_task" && event.event.type === "result") {
        const output = event.event.output as { taskId?: unknown };
        if (typeof output.taskId === "string") agentTaskId = output.taskId;
      }
      if (event.capabilityId !== "review_request_interaction" || event.event.type !== "interaction") return;
      const request = event.event.request;
      const payload = request.payload as Record<string, unknown>;
      const cardType = String(payload.cardType ?? "");
      if (!cardType) return;
      agentCardTypes.push(cardType);
      if (cardType === "review-spec") pendingChat.push({
          role: "user",
          content: "把输出语言改为中文，并且只纳入2022年以来的论文。",
          client_request_id: "chat-during-review-spec-card",
          webui_queue_steer_origin: true
        });
      const baseArtifact = payload.baseArtifact as Record<string, unknown> | undefined;
      const data = payload.data as Record<string, unknown> | undefined;
      const paperCardIds = cardType === "paper-selection"
        ? [data?.includedPaperIds, data?.recommendedPaperIds]
            .find((value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string") && value.length > 0)
          ?? (Array.isArray(data?.papers) && typeof (data.papers[0] as { id?: unknown })?.id === "string"
            ? [(data.papers[0] as { id: string }).id]
            : [])
        : [];
      const response = cardType === "source-import"
        ? { files: [{ path: sourcePath, name: "host-service-evidence.txt" }] }
        : {
            action: "submit",
            ...(typeof baseArtifact?.contentHash === "string" ? { baseArtifactHash: baseArtifact.contentHash } : {}),
            values: cardType === "review-spec" ? { spec: agentSpecBeforeChat }
              : cardType === "keywords" ? { keywords: data?.keywords ?? [] }
                : cardType === "outline" ? { outline: data?.outline ?? [] }
                  : cardType === "paper-selection" ? {
                      includedPaperIds: paperCardIds,
                      excludedPaperIds: []
                    }
                    : {} 
          };
      interactionResponses.push(service.respond(manifest.id, event.callId, request.interactionId, response));
    });

    let agentModelStep = 0;
    let agentTaskId = "";
    const agentModelMessages: Array<Array<Record<string, unknown>>> = [];
    const scriptedAgentProvider = {
      generation: { maxTokens: 512 },
      getDefaultModel: () => "fixture-agent-model",
      chatWithRetry: async ({ messages }: { messages: Array<Record<string, unknown>> }) => {
        agentModelMessages.push(structuredClone(messages));
        const tool = (capability: string, args: Record<string, unknown>) => new LLMResponse({
          content: null,
          finishReason: "tool_calls",
          toolCalls: [new ToolCallRequest({
            id: `agent-call-${agentModelStep}`,
            name: agentToolNames.get(capability)!,
            arguments: args
          })]
        });
        const step = agentModelStep++;
        if (step === 0) return tool("review_create_task", {
          title: "Agent-orchestrated review",
          topic: "retrieval quality and grounded agent memory"
        });
        const latestToolOutput = [...messages].reverse().find((message) => message.role === "tool")?.content;
        const parsed = typeof latestToolOutput === "string" ? JSON.parse(latestToolOutput) as Record<string, unknown> : {};
        if (!agentTaskId && typeof parsed.taskId === "string") agentTaskId = parsed.taskId;
        const data = (parsed.data ?? {}) as Record<string, unknown>;
        const response = (data.response ?? {}) as Record<string, unknown>;
        const values = (response.values ?? {}) as Record<string, unknown>;
        if (step === 1) return tool("review_request_interaction", { taskId: agentTaskId, type: "review-spec" });
        if (step === 2) {
          const sawSteering = messages.some((message) => message.role === "user" && String(message.content).includes("2022"));
          if (!sawSteering) throw new Error("The Agent did not receive Chat steering submitted while the card was open.");
          return tool("review_update_spec", {
            taskId: agentTaskId,
            spec: {
              ...agentSpecBeforeChat,
              outputLanguage: "zh-CN",
              dateRange: { from: 2022 }
            }
          });
        }
        if (step === 3) return tool("review_request_interaction", { taskId: agentTaskId, type: "source-import" });
        if (step === 4) {
          const suggestion = (parsed.suggestedNextTools as Array<{ args: Record<string, unknown> }>)[0];
          return tool("review_import_sources", suggestion.args);
        }
        if (step === 5) return tool("review_parse_sources", { taskId: agentTaskId });
        if (step === 6) return tool("review_generate_keywords", { taskId: agentTaskId });
        if (step === 7) return tool("review_request_interaction", { taskId: agentTaskId, type: "keywords" });
        if (step === 8) return tool("review_update_keywords", { taskId: agentTaskId, keywords: values.keywords });
        if (step === 9) return tool("review_search_papers", { taskId: agentTaskId, providers: ["arxiv"], limit: 5 });
        if (step === 10) return tool("review_request_interaction", { taskId: agentTaskId, type: "paper-selection" });
        if (step === 11) return tool("review_update_paper_selection", {
          taskId: agentTaskId,
          includedPaperIds: values.includedPaperIds,
          excludedPaperIds: values.excludedPaperIds
        });
        if (step === 12) return tool("review_resolve_metadata", { taskId: agentTaskId });
        if (step === 13) return tool("review_fetch_fulltexts", { taskId: agentTaskId });
        if (step === 14) return tool("review_build_readings", { taskId: agentTaskId });
        if (step === 15) return tool("review_generate_outline", { taskId: agentTaskId });
        if (step === 16) return tool("review_request_interaction", { taskId: agentTaskId, type: "outline" });
        if (step === 17) return tool("review_update_outline", { taskId: agentTaskId, outline: values.outline });
        if (step === 18) return tool("review_map_evidence", { taskId: agentTaskId });
        if (step === 19) return tool("review_generate_sections", { taskId: agentTaskId, batchSize: 2 });
        if (step === 20) return tool("review_refine", {
          taskId: agentTaskId,
          instruction: "Improve transitions without changing evidence or citations.",
          continuityScope: "adjacent",
          batchSize: 2
        });
        if (step === 21) return tool("review_plan_figures", { taskId: agentTaskId });
        if (step === 22) return tool("review_build_tables", { taskId: agentTaskId });
        if (step === 23) return tool("review_build_bibliography", { taskId: agentTaskId });
        if (step === 24) return tool("review_audit", { taskId: agentTaskId });
        if (step === 25) {
          const suggestion = (parsed.suggestedNextTools as Array<{ toolName: string; args: Record<string, unknown> }>).find((item) => item.toolName === "review_generate_abstract");
          return tool("review_generate_abstract", { taskId: agentTaskId, expectedArtifactHash: suggestion?.args.expectedArtifactHash });
        }
        if (step === 26) return tool("review_render", { taskId: agentTaskId, formats: ["md", "bib", "pdf", "tex", "docx"] });
        if (step === 27) return tool("review_get_status", { taskId: agentTaskId });
        return new LLMResponse({ content: "已根据卡片和最新聊天指令完成综述并生成交付物。", finishReason: "stop" });
      }
    };
    const liveConfigPath = resolve(process.env.MEMMY_CONFIG ?? join(homedir(), ".memmy", "config.yaml"));
    const liveConfig = liveAgentEnabled && existsSync(liveConfigPath)
      ? YAML.parse(readFileSync(liveConfigPath, "utf8")) as { app?: { userId?: string }; modelAssignments?: { account?: { agent?: { default?: string } } } }
      : undefined;
    const liveMode = liveConfig?.modelAssignments?.account?.agent?.default ? "account" : "byok";
    const liveSelection = liveAgentEnabled ? resolveModelSelection({
      configPath: liveConfigPath,
      mode: liveMode,
      activeAccountId: liveMode === "account" ? liveConfig?.app?.userId ?? null : null,
      capability: "agent"
    }) : null;
    if (liveAgentEnabled && !liveSelection) throw new Error("The current Memmy user model is unavailable for the live Agent E2E.");
    const agentProvider = liveSelection?.snapshot.provider ?? scriptedAgentProvider;
    const agentContext = new ContextBuilder({ workspace: join(root, "workspace"), fileMemoryEnabled: false });
    const agentSystemPrompt = [
      agentContext.buildSystemPrompt(["literature-review"]),
      readFileSync(join(pluginRoot, "skills", "literature-review", "references", "tool-recipes.md"), "utf8")
    ].join("\n\n");
    expect(agentSystemPrompt).toContain("### Skill: literature-review");
    expect(agentSystemPrompt).toContain("five required structured interactions");
    expect(agentSystemPrompt).toContain("## New Full Review");
    let agentResult;
    try {
      agentResult = await new AgentRunner(agentProvider as never).run(new AgentRunSpec({
        messages: [
          { role: "system", content: agentSystemPrompt },
          { role: "user", content: "$literature-review 请创建一份关于检索质量与智能体长期记忆的综述。请使用 arXiv 检索，首次 review_search_papers 请明确使用 query=\"retrieval quality AND agent memory\"、providers=[\"arxiv\"]、limit=5。请立即通过插件依次发出所有必需卡片让我确认，无需在发卡片前再次用聊天征求许可；收到每张卡片结果后继续完成证据映射、正文、图表、参考文献、审计、摘要和全部交付物。上传的 host-service-evidence.txt 只用于验证文件导入和解析，不是具备书目信息的论文，不要把它加入写作语料、EvidenceUnit 或参考文献；论文选择必须采用卡片返回的 arXiv includedPaperIds。本评测允许保留 partial 或 gap 覆盖诊断，请不要为覆盖缺口重复检索、重复修改大纲、重复映射或重复生成正文，使用当前有全文 EvidenceUnit 的范围继续。正文生成后必须调用 review_refine 完成章节连贯性改写；随后必须分别调用 review_plan_figures 和 review_build_tables，即使没有合格图表也要让工具产出可审计的空结果；最后构建参考文献、审计、生成摘要并渲染。中途不要仅汇报下一步或询问是否继续。" }
        ],
        provider: agentProvider as never,
        tools: agentTools,
        model: liveSelection?.model ?? "fixture-agent-model",
        maxIterations: liveAgentEnabled ? 60 : 32,
        injectionCallback: ({ limit = 3 } = {}) => pendingChat.splice(0, limit)
      }));
      await Promise.all(interactionResponses);
    } finally {
      unsubscribe();
    }
    if (liveAgentEnabled) {
      const debugPath = resolve(process.env.LITERATURE_REVIEW_LIVE_AGENT_REPORT ?? join(process.cwd(), "artifacts", "literature-review-live-agent-report.json"));
      mkdirSync(dirname(debugPath), { recursive: true });
      writeFileSync(debugPath, `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        finalContent: agentResult.finalContent,
        toolsUsed: agentResult.toolsUsed,
        toolCalls: agentToolCalls,
        cards: agentCardTypes,
        taskId: agentTaskId,
        decisionModel: liveSelection ? { provider: liveSelection.provider, model: liveSelection.model } : null
      }, null, 2)}\n`, "utf8");
    }
    expect(agentResult.finalContent.length).toBeGreaterThan(0);
    expect(agentResult.hadInjections).toBe(true);
    const firstSeenCardTypes = agentCardTypes.filter((cardType, index) => agentCardTypes.indexOf(cardType) === index);
    expect(firstSeenCardTypes, JSON.stringify({
      finalContent: agentResult.finalContent,
      cards: agentCardTypes,
      toolsUsed: agentResult.toolsUsed
    }, null, 2)).toEqual(["review-spec", "source-import", "keywords", "paper-selection", "outline"]);
    for (const capability of [
      "review_create_task", "review_update_spec", "review_import_sources", "review_parse_sources", "review_generate_keywords",
      "review_update_keywords", "review_search_papers", "review_update_paper_selection", "review_resolve_metadata",
      "review_fetch_fulltexts", "review_build_readings", "review_generate_outline", "review_update_outline", "review_map_evidence",
      "review_generate_sections", "review_refine", "review_plan_figures", "review_build_tables", "review_build_bibliography",
      "review_audit", "review_generate_abstract", "review_render"
    ]) expect(agentResult.toolsUsed, JSON.stringify({ missing: capability, finalContent: agentResult.finalContent, toolsUsed: agentResult.toolsUsed }, null, 2)).toContain(agentToolNames.get(capability));
    expect(agentResult.toolsUsed.filter((name) => name === agentToolNames.get("review_request_interaction")).length).toBeGreaterThanOrEqual(5);
    const agentTask = JSON.parse(readFileSync(join(dataRoot, manifest.id, "tasks", agentTaskId, "task.json"), "utf8"));
    expect(agentTask.spec).toMatchObject({ outputLanguage: "zh-CN", dateRange: { from: 2022 } });
    expect(agentTask.values.outputs.map((output: { name: string }) => output.name).sort()).toEqual([
      "neurips_2024.sty", "references.bib", "review.docx", "review.md", "review.pdf", "review.tex"
    ]);
    const deliveryDir = process.env.LITERATURE_REVIEW_LIVE_DELIVERY_DIR;
    if (liveAgentEnabled && deliveryDir) {
      mkdirSync(deliveryDir, { recursive: true });
      for (const output of agentTask.values.outputs as Array<{ name: string; path: string }>) {
        copyFileSync(output.path, join(deliveryDir, output.name));
      }
      writeFileSync(join(deliveryDir, "delivery.json"), `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        taskId: agentTaskId,
        decisionModel: liveSelection ? { provider: liveSelection.provider, model: liveSelection.model } : null,
        files: agentTask.values.outputs.map((output: { name: string }) => output.name)
      }, null, 2)}\n`, "utf8");
    }
    if (!liveAgentEnabled) expect(agentModelMessages.at(-1)?.some((message) => message.role === "user" && String(message.content).includes("2022"))).toBe(true);
    trace.push({
      phase: "agent-orchestration-verified",
      skillLoaded: true,
      toolsUsed: agentResult.toolsUsed,
      cards: agentCardTypes,
      chatSteeringApplied: true,
      decisionModel: liveSelection ? { provider: liveSelection.provider, model: liveSelection.model } : { provider: "fixture", model: "fixture-agent-model" },
      taskId: agentTaskId
    });

    await service.disable(manifest.id);
    expect((await client.listTools()).tools).toHaveLength(0);
    expect(existsSync(join(skillsRoot, "literature-review"))).toBe(false);
    trace.push({ phase: "disabled", tools: 0, skillRegistered: false });
    await writeReport(trace, {
      plugin: {
        id: manifest.id,
        version: manifest.version,
        capabilityCount: manifest.capabilities.length,
        skillIds: manifest.skills.map((skill: { id: string }) => skill.id),
        uiSlots: Object.keys(manifest.ui ?? {})
      },
      artifact: {
        path: archivePath,
        sha256: descriptor.artifact.sha256,
        bytes: descriptor.artifact.bytes,
        files: descriptor.artifact.files
      },
      toolCount: tools.length,
      taskId: createOutput.taskId
    });
  }, liveAgentEnabled ? 900_000 : 120_000);
});

function modelFixtureResponse(system: string, request: Record<string, unknown>): Record<string, unknown> {
  if (system.includes("design evidence-oriented literature-review outlines")) {
    return { outline: [
      { title: "Scope and concepts", guidance: "Define the review scope and core concepts.", children: [] },
      { title: "Evidence synthesis", guidance: "Synthesize retrieval quality and grounding evidence.", children: [
        { title: "Retrieval quality", guidance: "Compare findings about retrieval quality, conflicts, and grounded answers." }
      ] }
    ] };
  }
  if (system.includes("write evidence-grounded literature-review sections") || system.includes("improve continuity in evidence-grounded literature-review sections")) {
    const sections = (request.sections ?? request.targetSections ?? []) as Array<{
      outlineNodeId: string;
      evidence?: Array<{ evidenceId: string; citeKey: string }>;
      evidenceIds?: string[];
      citeKeys?: string[];
    }>;
    return { sections: sections.map((section) => {
      const evidenceIds = section.evidence?.map((item) => item.evidenceId) ?? section.evidenceIds ?? [];
      const citeKeys = section.evidence?.map((item) => item.citeKey) ?? section.citeKeys ?? [];
      const focus = section.outlineNodeId.includes("2-1")
        ? "Across the reviewed evaluations, higher retrieval relevance is associated with fewer unsupported answers and clearer evidence provenance"
        : "The review scope connects retrieval quality, persistent memory, and grounded behavior under a shared evidence-tracing framework";
      return {
        outlineNodeId: section.outlineNodeId,
        markdown: `${focus} ${citeKeys.map((key) => `[${key}]`).join(" ")}.`,
        evidenceIds
      };
    }) };
  }
  if (system.includes("create compact evidence tables")) {
    const rows = (request.rows ?? []) as Array<{ paperId: string; evidence?: Array<{ evidenceId: string }> }>;
    return { rows: rows.map((row) => ({
      paperId: row.paperId,
      method: { text: "Controlled evaluation", evidenceIds: row.evidence?.slice(0, 1).map((item) => item.evidenceId) ?? [] },
      finding: { text: "Reliable retrieval improves grounding", evidenceIds: row.evidence?.slice(0, 1).map((item) => item.evidenceId) ?? [] },
      limitation: { text: "Limited benchmark scope", evidenceIds: row.evidence?.slice(0, 1).map((item) => item.evidenceId) ?? [] }
    })) };
  }
  if (system.includes("write a journal-style abstract")) {
    const sections = (request.sections ?? []) as Array<{ sectionId: string; evidenceIds?: string[] }>;
    return {
      text: request.language === "zh-CN"
        ? "本文综述检索质量如何影响具备长期记忆能力的智能体。研究基于已确认的全文证据，综合比较信息相关性、证据来源、记忆更新以及过期内容处理等主题。现有结果表明，更可靠的检索通常能够提高存储信息的复用质量，减少长任务中的无依据回答，并使生成结论与原始证据保持可追溯联系。同时，仅有表面相关性的记忆仍可能已经过时，或与较新的观察产生冲突，因此检索、来源记录和更新机制需要作为统一且可审计的过程进行设计。当前证据覆盖的任务类型和评测范围仍然有限，尚不足以证明单一检索策略能够稳定迁移到所有领域。未来研究应在更长交互周期、更广任务集合以及信息持续变化的环境中验证这些机制。"
        : "This review examines how retrieval quality affects grounded behavior in language agents with persistent memory. It synthesizes the supplied full-text evidence around retrieval relevance, evidence provenance, update behavior, and the handling of stale information. The reviewed findings consistently associate more reliable retrieval with better reuse of stored information and fewer unsupported responses during extended tasks. They also indicate that provenance must remain visible when evidence is selected for generation, because apparently relevant memories may be outdated or conflict with newer observations. The available corpus nevertheless reflects a limited range of evaluations and does not establish that one retrieval strategy transfers uniformly across domains. Overall, the evidence supports treating retrieval, provenance, and memory updating as one auditable process rather than independent components. Future work should evaluate these mechanisms over longer interactions, broader task families, and controlled changes in the underlying information environment.",
      sourceSectionIds: sections.map((section) => section.sectionId),
      sourceEvidenceIds: [...new Set(sections.flatMap((section) => section.evidenceIds ?? []))]
    };
  }
  throw new Error(`Unexpected model fixture operation: ${system.slice(0, 80)}`);
}

function providerFetchPreload(): string {
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>1</opensearch:totalResults>
  <entry>
    <id>https://arxiv.org/abs/2401.01234v1</id>
    <updated>2024-01-03T00:00:00Z</updated><published>2024-01-02T00:00:00Z</published>
    <title>Grounded Retrieval for Persistent Agent Memory</title>
    <summary>This study reports that retrieval quality improves evidence grounding in persistent agent memory while explicit provenance reduces unsupported answers and stale-memory conflicts.</summary>
    <author><name>Ada Lovelace</name></author>
    <link href="https://arxiv.org/pdf/2401.01234v1" type="application/pdf" title="pdf" />
  </entry>
</feed>`;
  const pdf = minimalTextPdf("The study reports that retrieval quality improves evidence grounding in persistent agent memory. Explicit provenance reduces unsupported answers and stale context conflicts. A controlled evaluation compares retrieval relevance across extended tasks. The results indicate more reliable reuse of stored evidence, while the limited benchmark domain constrains generalization. ".repeat(5));
  return `const originalFetch = globalThis.fetch;
const feed = ${JSON.stringify(feed)};
const pdf = Buffer.from(${JSON.stringify(pdf.toString("base64"))}, "base64");
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname === "export.arxiv.org") return new Response(feed, { status: 200, headers: { "content-type": "application/atom+xml" } });
  if (url.hostname === "arxiv.org" && url.pathname.startsWith("/pdf/")) return new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } });
  return originalFetch(input, init);
};\n`;
}

function minimalTextPdf(text: string): Buffer {
  const lines = text.match(/.{1,78}(?:\s|$)/gu) ?? [text];
  const content = `BT /F1 9 Tf 45 760 Td 11 TL ${lines.map((line, index) => {
    const escaped = line.trim().replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    return `${index ? "T* " : ""}(${escaped}) Tj`;
  }).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

async function serveRelease(manifest: Record<string, unknown>, sha256: string, archivePath: string) {
  const archive = await readFile(archivePath);
  const server = createServer((request, response) => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    if (request.url?.startsWith(`/api/v1/plugins/${encodeURIComponent(String(manifest.id))}`)) {
      const body = Buffer.from(JSON.stringify({ manifest, artifact: { url: `${baseUrl}/artifact.zip`, sha256 } }));
      response.writeHead(200, { "content-type": "application/json", "content-length": body.byteLength });
      response.end(body);
      return;
    }
    if (request.url === "/artifact.zip") {
      response.writeHead(200, { "content-type": "application/zip", "content-length": archive.byteLength });
      response.end(archive);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local plugin registry did not bind a TCP port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function writeReport(trace: Array<Record<string, unknown>>, details: Record<string, unknown>) {
  const reportPath = process.env.LITERATURE_REVIEW_E2E_REPORT;
  if (!reportPath) return;
  await mkdir(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    result: "passed",
    scenario: "real-mpp-install-full-review-render-disable",
    details,
    trace
  }, null, 2)}\n`);
}
