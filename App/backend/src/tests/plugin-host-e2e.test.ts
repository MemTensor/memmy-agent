import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPluginMcpServer } from "../adapters/inbound/local-api/routes/plugin-mcp.js";
import { createInMemoryPluginRegistry } from "../adapters/outbound/plugin-registry/index.js";
import {
  createCommandPluginAdapter,
  createHttpPluginAdapter,
  createPluginRuntimeHost,
  PluginAdapterRegistry
} from "../adapters/outbound/plugin-runtime/index.js";
import { createPluginSkillManager } from "../adapters/outbound/plugin-skill/index.js";
import { createAppStateStore, type AppStateStore } from "../infrastructure/app-state-store/index.js";
import { createPluginService } from "../services/plugin-service.js";
import { createPluginLocalArtifactService } from "../services/plugin-local-artifact-service.js";
import { createProgressBus } from "../services/progress-bus.js";

let root: string | undefined;
let store: AppStateStore | undefined;
let client: Client | undefined;
let mcpServer: ReturnType<typeof buildPluginMcpServer> | undefined;

afterEach(async () => {
  await client?.close();
  await mcpServer?.close();
  client = undefined;
  mcpServer = undefined;
  store?.close();
  store = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("plugin host end to end", () => {
  it("installs a generic review plugin and invokes it from Agent", async () => {
    const fetchFn = vi.fn(async () => new Response([
      JSON.stringify({ type: "progress", current: 1, total: 1, message: "searching" }),
      JSON.stringify({ type: "result", output: { review: "Agent Memory review" } })
    ].join("\n"), { headers: { "content-type": "application/x-ndjson" } }));
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-e2e-"));
    store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
    const runtimeHost = createPluginRuntimeHost(new PluginAdapterRegistry([
      createHttpPluginAdapter({ fetchFn: fetchFn as typeof fetch })
    ]));
    const service = createPluginService({
      repository: store.repositories.plugins,
      secretStore: store.secretStore,
      registry: createInMemoryPluginRegistry([{
        manifest: {
          apiVersion: "memmy/v1",
          id: "com.example.review",
          name: "Literature Review",
          version: "1.0.0",
          runtime: {
            adapter: "http",
            config: {
              baseUrl: "https://review.example",
              secretHeaders: { authorization: "api-key" }
            }
          },
          capabilities: [{
            id: "write-review",
            name: "Write review",
            description: "Search papers and write a literature review",
            inputSchema: {
              type: "object",
              properties: { topic: { type: "string" } },
              required: ["topic"]
            },
            outputSchema: {
              type: "object",
              properties: { review: { type: "string" } },
              required: ["review"]
            },
            execution: "job"
          }],
          permissions: [
            { type: "network", hosts: ["review.example"] },
            { type: "secret", keys: ["api-key"] }
          ],
          configSchema: {
            type: "object",
            properties: { database: { type: "string" } },
            required: ["database"]
          }
        }
      }]),
      runtimeHost,
      artifactManager: {
        install: async () => ({ artifactHash: null, rootPath: null }),
        readTextFile: async () => "",
        remove: async () => undefined
      }
    });

    await service.install("com.example.review");
    service.configure("com.example.review", {
      config: { database: "crossref" },
      secrets: { "api-key": "Bearer secret" }
    });
    await service.approvePermissions("com.example.review", service.get("com.example.review").manifest.permissions);
    await service.enable("com.example.review");

    mcpServer = buildPluginMcpServer(service, createProgressBus());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "agent-test", version: "1.0.0" });
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const result = await client.callTool({
      name: tools.tools[0]!.name,
      arguments: { topic: "Agent Memory" },
      _meta: { "memmy.dev/session-key": "desktop:review-session" }
    });

    expect(result).toMatchObject({ structuredContent: { review: "Agent Memory review" } });
    const [, request] = fetchFn.mock.calls[0]!;
    expect((request?.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      conversationId: "desktop:review-session",
      input: { topic: "Agent Memory" },
      config: { database: "crossref" }
    });
    expect(store.db.prepare("SELECT outcome FROM plugin_call_logs").get()).toEqual({ outcome: "success" });
  });

  it("runs the command-plugin vertical slice through file input, Skill, UI, artifact hosting, and disable", async () => {
    root = mkdtempSync(join(tmpdir(), "memmy-review-plugin-e2e-"));
    const artifactRoot = join(root, "plugin");
    const mediaRoot = join(root, "agent-data", "media");
    const pluginDataRoot = join(root, "plugin-data");
    const skillsRoot = join(root, "workspace", "skills");
    mkdirSync(join(artifactRoot, "runtime"), { recursive: true });
    mkdirSync(join(artifactRoot, "skills", "literature-review"), { recursive: true });
    mkdirSync(join(artifactRoot, "ui"), { recursive: true });
    mkdirSync(mediaRoot, { recursive: true });
    writeFileSync(join(artifactRoot, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(join(artifactRoot, "skills", "literature-review", "SKILL.md"), "---\nname: literature-review\ndescription: Test review\n---\nUse the review tools.\n");
    writeFileSync(join(artifactRoot, "ui", "review.html"), "<main>Review card</main>");
    writeFileSync(join(artifactRoot, "runtime", "command.js"), commandPluginFixture());
    const sourcePath = join(mediaRoot, "paper.pdf");
    writeFileSync(sourcePath, "paper bytes");

    store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
    const runtimeHost = createPluginRuntimeHost(new PluginAdapterRegistry([
      createCommandPluginAdapter({
        allowedNetworkHosts: ["export.arxiv.org", "arxiv.org"],
        fileInputRoots: [mediaRoot],
        pluginDataRoot,
        buildLaunch: async (context, config, networkEnabled) => {
          expect(networkEnabled).toBe(true);
          return {
            command: process.execPath,
            args: [join(context.rootPath!, config.command)],
            cwd: context.rootPath!
          };
        }
      })
    ]));
    const manifest = commandReviewManifest();
    const service = createPluginService({
      repository: store.repositories.plugins,
      secretStore: store.secretStore,
      registry: createInMemoryPluginRegistry([{ manifest }]),
      runtimeHost,
      artifactManager: {
        install: async () => ({ artifactHash: "fixture", rootPath: artifactRoot }),
        readTextFile: async (_plugin, relativePath) => readFileSync(join(artifactRoot, relativePath), "utf8"),
        remove: async () => undefined
      },
      skillManager: createPluginSkillManager({ skillsRoot }),
      localArtifactService: createPluginLocalArtifactService({ pluginDataRoot })
    });

    await service.install(manifest.id);
    service.configure(manifest.id, { config: {}, secrets: {} });
    await service.approvePermissions(manifest.id, manifest.permissions);
    await service.enable(manifest.id);
    expect(readFileSync(join(skillsRoot, "literature-review", "SKILL.md"), "utf8")).toContain("Use the review tools");
    await expect(service.readUi(manifest.id, "renderer")).resolves.toContain("Review card");

    mcpServer = buildPluginMcpServer(service, createProgressBus());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "agent-test", version: "1.0.0" });
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools).toHaveLength(1);

    const iterator = service.invoke({
      callId: "call-import",
      pluginId: manifest.id,
      capabilityId: "review_import_sources",
      conversationId: "chat-1",
      input: {}
    })[Symbol.asyncIterator]();
    const interaction = await iterator.next();
    expect(interaction.value).toMatchObject({
      type: "interaction",
      request: { type: "file-input" }
    });
    const interactionId = interaction.value?.type === "interaction" ? interaction.value.request.interactionId : "";
    await service.respond(manifest.id, "call-import", interactionId, {
      files: [{ path: sourcePath, name: "paper.pdf" }]
    });
    const artifact = await iterator.next();
    expect(artifact.value).toMatchObject({
      type: "artifact",
      artifact: {
        name: "review.md",
        uri: expect.stringMatching(/^\/api\/v1\/plugins\/literature-review\/artifacts\/[^/]+\/preview$/),
        downloadUri: expect.stringMatching(/\/download$/)
      }
    });
    const hostedUri = artifact.value?.type === "artifact" ? artifact.value.artifact.uri : "";
    const token = hostedUri.split("/").at(-2)!;
    const hosted = await service.openArtifact(manifest.id, token);
    expect(readFileSync(hosted.path, "utf8")).toContain("Imported paper.pdf");
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "result", output: { ok: true } } });

    await service.disable(manifest.id);
    expect(existsSync(join(skillsRoot, "literature-review"))).toBe(false);
    expect((await client.listTools()).tools).toHaveLength(0);
  });
});

function commandReviewManifest() {
  return {
    apiVersion: "memmy/v1" as const,
    id: "literature-review",
    name: "Literature Review",
    version: "0.2.0",
    runtime: {
      adapter: "command" as const,
      config: {
        command: "runtime/command.js",
        interpreter: "node",
        inputMode: "stdin-json",
        outputMode: "ndjson",
        interactive: true
      }
    },
    capabilities: [{
      id: "review_import_sources",
      name: "Import sources",
      description: "Import selected literature and produce a task artifact.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      execution: "job" as const
    }],
    permissions: [
      { type: "network" as const, hosts: ["export.arxiv.org", "arxiv.org"] },
      { type: "host-service" as const, services: ["file-input", "plugin-data", "artifact-host"] }
    ],
    configSchema: { type: "object", additionalProperties: false },
    skills: [{
      id: "literature-review",
      name: "Literature Review",
      description: "Coordinate review tools.",
      entry: "skills/literature-review/SKILL.md"
    }],
    ui: { renderer: { entry: "ui/review.html", capabilities: ["review_import_sources"] } }
  };
}

function commandPluginFixture(): string {
  return `
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const iterator = lines[Symbol.asyncIterator]();
const call = JSON.parse((await iterator.next()).value);
const interactionId = "source-files";
process.stdout.write(JSON.stringify({
  type: "interaction",
  request: {
    interactionId,
    type: "file-input",
    payload: { title: "Select papers", accept: [".pdf"], multiple: true },
    responseSchema: {
      type: "object",
      required: ["files"],
      properties: { files: { type: "array", minItems: 1, items: { type: "object", required: ["path", "name"] } } }
    }
  }
}) + "\\n");
const response = JSON.parse((await iterator.next()).value).response;
const source = response.files[0];
readFileSync(source.path);
const outputPath = join(process.env.MEMMY_PLUGIN_DATA_DIR, "review.md");
writeFileSync(outputPath, "# Review\\n\\nImported " + source.name + "\\n");
process.stdout.write(JSON.stringify({
  type: "artifact",
  artifact: { id: "review", name: "review.md", mediaType: "text/markdown", uri: pathToFileURL(outputPath).href }
}) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", output: { ok: true } }) + "\\n");
lines.close();
`;
}
