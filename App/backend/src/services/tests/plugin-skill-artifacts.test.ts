import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { CapabilityEvent, PluginArtifactRef } from "@memmy/local-api-contracts";
import { createAppStateStore, type AppStateStore } from "../../infrastructure/app-state-store/index.js";
import { createPluginService } from "../plugin-service.js";
import { createPluginLocalArtifactService } from "../plugin-local-artifact-service.js";
import { createInMemoryPluginRegistry } from "../../adapters/outbound/plugin-registry/index.js";

const roots: string[] = [], stores: AppStateStore[] = [];
afterEach(() => { stores.splice(0).forEach(store => store.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const names = ["references/source.json", "references/teaching-gaps.json", "references/events.jsonl", "SKILL.md"];
function fixture(saved = true) {
  const root = mkdtempSync(join(tmpdir(), "skill-delivery-")); roots.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const pluginDataRoot = join(root, "plugin-data");
  const databasePath = join(root, "app.sqlite");
  const store = createAppStateStore({ databasePath }); stores.push(store);
  const manifest = { apiVersion: "memmy/v1" as const, id: "teach-mode", name: "Teach", version: "0.5.18-local.1",
    runtime: { adapter: "mcp" as const }, permissions: [{ type: "host-service" as const, services: ["plugin-data" as const, "artifact-host" as const] }],
    capabilities: [{ id: "create_skill", name: "Create", description: "Create", inputSchema: {}, outputSchema: {}, execution: "request" as const }] };
  store.repositories.plugins.save({ manifest, state: "active" });
  store.repositories.plugins.setApprovedPermissions(manifest.id, manifest.permissions);
  const localArtifacts = createPluginLocalArtifactService({ pluginDataRoot, resolveWorkspace: async () => workspace });
  let fail = "";
  const service = createPluginService({ repository: store.repositories.plugins, secretStore: store.secretStore,
    registry: createInMemoryPluginRegistry([]),
    artifactManager: { install: vi.fn(), remove: vi.fn(), readTextFile: vi.fn() },
    localArtifactService: { ...localArtifacts, host: async (plugin, artifact, context) => {
      if (fail && artifact.name.endsWith(fail)) throw new Error("disk unavailable");
      return localArtifacts.host(plugin, artifact, context);
    } },
    runtimeHost: { supports: () => true, activate: vi.fn(), deactivate: vi.fn(), cancel: vi.fn(), respond: vi.fn(),
      async *invoke(call) {
        const name = (call.input as { name: string }).name;
        const directory = join(pluginDataRoot, "teach-mode", "generated-skills", name);
        for (const file of names) {
          const source = join(directory, file); mkdirSync(dirname(source), { recursive: true });
          writeFileSync(source, file === "SKILL.md" ? names.slice(0, -1).map(ref => `[reference](${ref})`).join("\n") : `${name}:${file}`);
          yield { type: "artifact", artifact: { id: `${name}:${file}`, name: `${name}/${file}`, mediaType: "text/plain",
            uri: pathToFileURL(source).href, role: "deliverable" } };
        }
        yield { type: "result", output: { saved, execution: "not_run", directory, entry: "SKILL.md", skillFile: join(directory, "SKILL.md") } };
      }
    }
  });
  async function run(name = "skill-one", callId = crypto.randomUUID()) {
    const events: CapabilityEvent[] = [];
    for await (const event of service.invoke({ pluginId: "teach-mode", capabilityId: "create_skill", conversationId: "websocket:chat", callId, input: { name } })) {
      events.push(event);
    }
    return events;
  }
  return { service, store, root, databasePath, localArtifacts, run, setFailure: (name: string) => { fail = name; } };
}

it("publishes ordinary artifacts with a complete relative file tree and rewrites only reading paths", async () => {
  const f = fixture(); const events = await f.run();
  expect(events.map(event => event.type)).toEqual(["artifact", "artifact", "artifact", "artifact", "result"]);
  const artifacts = events.filter(event => event.type === "artifact").map(event => event.artifact);
  expect(artifacts.every(artifact => artifact.role === "deliverable" && !("delivery" in artifact))).toBe(true);
  const main = artifacts.find(artifact => artifact.name.endsWith("/SKILL.md"))!;
  const output = (events.at(-1) as { output: any }).output;
  expect(output).toMatchObject({ saved: true, execution: "not_run", skillFile: main.path });
  expect(output.directory).toContain("/plugin-data/teach-mode/generated-skills/skill-one");
  for (const [, reference] of readFileSync(main.path!, "utf8").matchAll(/\]\(([^)]+)\)/g)) {
    expect(readFileSync(join(dirname(main.path!), reference!), "utf8")).toBe(`skill-one:${reference}`);
  }
  const again = await f.run();
  expect(again.filter(event => event.type === "artifact").map(event => event.artifact.path)).toEqual(artifacts.map(artifact => artifact.path));
  const other = await f.run("skill-two");
  expect(other.filter(event => event.type === "artifact").every(event => !artifacts.some(a => a.path === event.artifact.path))).toBe(true);
});

it("keeps normal publication failures as errors when the operation did not save", async () => {
  const f = fixture(false); f.setFailure("SKILL.md");
  await expect(f.run()).rejects.toThrow("disk unavailable");
});

it.each(["references/events.jsonl", "SKILL.md"])("preserves saved fact if standard publication of %s fails", async file => {
  const f = fixture(); f.setFailure(file);
  const events = await f.run();
  expect(events.at(-1)).toMatchObject({ type: "result", output: { saved: true, artifactPublicationErrors: [
    { name: `skill-one/${file}`, message: "disk unavailable" }
  ] } });
  expect(events.filter(event => event.type === "artifact")).toHaveLength(3);
  f.setFailure(""); expect((await f.run()).filter(event => event.type === "artifact")).toHaveLength(4);
});
