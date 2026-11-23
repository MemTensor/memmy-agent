import "../fixtures/isolated-user-home.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSourceExecutor } from "../../src/agent-source/runtime.js";
import { createSourceRegistry } from "../../src/agent-source/adapters/source-registry.js";
import { createSkillTargetRegistry } from "../../src/agent-source/integration/target-registry.js";
import { LEGACY_TEST_CONFIG } from "../fixtures/memory-service-fixture.js";
import { readAgentSkillInventory } from "@memmy/agent-source-core";
import {
  createMemoryHttpServer,
  type Embedder,
  MemoryDb,
  MemoryService
} from "../../src/index.js";

const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

describe("skill archive over the service API", () => {
  it("archives and reactivates a skill for a token caller without the viewer header", async () => {
    const { baseUrl, service } = await startServer("skill-token");
    const skill = service.addMemory({ content: "skill", source: "contract", layer: "Skill" });

    const archived = await post(baseUrl, "/api/v1/skills/archive", { skillId: skill.id }, "skill-token");
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ ok: true, id: skill.id, status: "archived", serverTime: expect.any(String) });
    expect(service.getMemory(skill.id).status).toBe("archived");

    const reactivated = await post(baseUrl, "/api/v1/skills/reactivate", { skillId: skill.id }, "skill-token");
    expect(reactivated.status).toBe(200);
    expect(await reactivated.json()).toMatchObject({ ok: true, id: skill.id, status: "activated", serverTime: expect.any(String) });
    expect(service.getMemory(skill.id).status).toBe("activated");
  });

  it("rejects callers without the service token and requests without a skill id", async () => {
    const { baseUrl, service } = await startServer("skill-token");
    const skill = service.addMemory({ content: "skill", source: "contract", layer: "Skill" });

    const anonymous = await post(baseUrl, "/api/v1/skills/archive", { skillId: skill.id });
    expect(anonymous.status).toBe(401);
    expect(service.getMemory(skill.id).status).toBe("activated");

    const missingId = await post(baseUrl, "/api/v1/skills/archive", {}, "skill-token");
    expect(missingId.status).toBe(400);
  });

  it("passes unknown invocation metadata and explicit connection events to reconciliation", async () => {
    const { baseUrl, service } = await startServer("skill-token");
    const reconcile = vi.spyOn(service, "reconcileAgentSkills");
    const request = { sourceAgentId: "codex", complete: false, connectionState: "disconnected", disconnected: true,
      skills: [{ sourceSkillId: "private", sourceSkillPath: "/isolated/private/SKILL.md", title: "private",
        content: "Body", contentHash: "hash", modifiedAt: "2026-11-04T00:00:00.000Z",
        policyError: "permission denied", frontmatterError: "unclosed frontmatter" }] };
    const response = await post(baseUrl, "/api/v1/agent-skills/reconcile", request, "skill-token");
    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenLastCalledWith(expect.objectContaining(request));
  });

  it("allows only administrative connection events when memory capture is disabled", async () => {
    const { baseUrl, service, configPath } = await startServer("skill-token");
    const skill = { sourceSkillId: "private", sourceSkillPath: "/isolated/private/SKILL.md", title: "private",
      content: "Private procedure", contentHash: "hash", modifiedAt: "2026-11-04T00:00:00.000Z" };
    const created = service.reconcileAgentSkills({ sourceAgentId: "codex", complete: true, skills: [skill] });
    const memoryId = created.skills[0]!.memoryId!;
    writeFileSync(configPath, JSON.stringify({ memmyMemory: {
      ...LEGACY_TEST_CONFIG,
      algorithm: { ...LEGACY_TEST_CONFIG.algorithm, enableMemoryAdd: false }
    } }));
    service.reloadConfig({ restartFailedProcessing: false });

    const events = [
      { connectionState: "disconnected", disconnected: true },
      { connectionState: "connected" },
      { disconnected: true }
    ];
    for (const event of events) {
      const response = await post(baseUrl, "/api/v1/agent-skills/reconcile", {
        sourceAgentId: "codex", complete: false, skills: [], ...event
      }, "skill-token");
      expect(response.status).toBe(200);
      expect(service.agentSkillConnectionState("codex")).toBe(event.connectionState ?? "disconnected");
    }
    expect(service.getMemory(memoryId)).toMatchObject({ status: "archived", body: "" });

    const forbidden = [
      { complete: false, skills: [] },
      { complete: true, skills: [], connectionState: "connected" },
      { complete: false, skills: [skill], connectionState: "connected" },
      { complete: false, skills: [], connectionState: "connected", registrations: [
        { sourceSkillId: "plugin:private", sourceSkillPath: "/isolated/plugin/SKILL.md", name: "private" }
      ] },
      { complete: false, skills: [], connectionState: "connected", registrations: [], registrationsComplete: true }
    ];
    for (const request of forbidden) {
      const response = await post(baseUrl, "/api/v1/agent-skills/reconcile", { sourceAgentId: "codex", ...request }, "skill-token");
      expect(response.status).toBe(403);
    }
    expect(service.agentSkillConnectionState("codex")).toBe("disconnected");
    expect(() => service.addMemory({ content: "Capture remains disabled" })).toThrow("memory add is disabled");
  });

  it("reconciles empty and regular SKILL.md files in the same HTTP batch", async () => {
    const { baseUrl, service, configPath } = await startServer("skill-token");
    const skillsRoot = join(dirname(configPath), "skills");
    for (const [name, content] of [["empty", ""], ["whitespace", " \n "], ["regular", "A normal procedure.\n"]]) {
      const directory = join(skillsRoot, name!);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), content!);
    }
    const inventory = await readAgentSkillInventory(skillsRoot);
    expect(inventory.complete).toBe(true);
    const skills = inventory.items.map((item) => ({ sourceSkillId: item.sourceSkillId, sourceSkillPath: item.sourceSkillPath,
      title: item.name ?? basename(item.sourceSkillId), content: item.content, contentHash: item.contentHash, modifiedAt: item.modifiedAt }));
    const reconcile = vi.spyOn(service, "reconcileAgentSkills");
    const response = await post(baseUrl, "/api/v1/agent-skills/reconcile", { sourceAgentId: "hermes", complete: true, skills }, "skill-token");
    expect(response.status).toBe(200);
    const result = await response.json() as { skills: Array<{ sourceSkillId: string; outcome: string; memoryId: string }> };
    expect(result.skills).toHaveLength(3);
    for (const item of result.skills) {
      const scanned = skills.find((skill) => skill.sourceSkillId === item.sourceSkillId)!;
      expect(item.outcome).toBe("created");
      expect(service.getMemory(item.memoryId)).toMatchObject({ status: "activated", body: scanned.content });
    }
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ skills }));
    for (const content of [undefined, null, 42, {}, []]) {
      const invalid = await post(baseUrl, "/api/v1/agent-skills/reconcile", {
        sourceAgentId: "hermes", complete: true, skills: [skills[2], { ...skills[0], content }]
      }, "skill-token");
      expect(invalid.status).toBe(400);
    }
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("wakes the worker after reactivating through either route", async () => {
    const { baseUrl, service } = await startServer("skill-token");
    const skill = service.addMemory({ content: "skill", source: "contract", layer: "Skill" });
    const runWorkerOnce = vi.spyOn(service, "runWorkerOnce");

    const callers: Array<Record<string, string>> = [{ authorization: "Bearer skill-token" }, { "x-memmy-viewer": "1" }];
    for (const headers of callers) {
      expect((await post(baseUrl, "/api/v1/skills/archive", { skillId: skill.id }, undefined, headers)).status).toBe(200);
      runWorkerOnce.mockClear();
      expect((await post(baseUrl, "/api/v1/skills/reactivate", { skillId: skill.id }, undefined, headers)).status).toBe(200);
      await vi.waitFor(() => expect(runWorkerOnce).toHaveBeenCalled());
    }
  });
});

async function startServer(token: string): Promise<{ baseUrl: string; service: MemoryService; configPath: string }> {
  const root = mkdtempSync(join(tmpdir(), "memmy-skill-archive-http-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const llm = {
    config: { ...LEGACY_TEST_CONFIG.summary, provider: "local_only" as const },
    isConfigured: () => false,
    async complete(): Promise<never> { throw new Error("Unexpected test LLM call"); },
    async completeJson(): Promise<never> { throw new Error("Unexpected test LLM call"); },
    status: () => ({ provider: "local_only", configured: false, remote: false })
  };
  const service = new MemoryService({
    db,
    mode: "dev",
    llm,
    skillLlm: llm,
    config: LEGACY_TEST_CONFIG,
    configPath: join(root, "config.yaml"),
    l3FieldEnvironment: () => ({ machineId: "f".repeat(64), homeDir: root, tempRoots: [root] }),
    l3MachineProbe: () => new Promise(() => undefined),
    embedder: createTestEmbedder(),
    fetchAppMemoryBudget: async () => null
  });
  // The worker only runs when a request wakes it.
  const server = createMemoryHttpServer({
    service,
    auth: { localServiceToken: token },
    configPath: join(root, "config.yaml"),
    agentSourceExecutor: createAgentSourceExecutor({
      service, configPath: join(root, "config.yaml"), statePath: join(root, "agent-sources.json"),
      sourceRegistry: createSourceRegistry([]), integrationRegistry: createSkillTargetRegistry([])
    }),
    workerStartupFallbackMs: 60_000
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  cleanup.push(
    () => rmSync(root, { recursive: true, force: true }),
    () => db.close(),
    async () => service.stop(),
    () => new Promise<void>((resolve) => server.close(() => resolve()))
  );
  return { baseUrl: `http://127.0.0.1:${address.port}`, service, configPath: join(root, "config.yaml") };
}

function post(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function createTestEmbedder(): Embedder {
  return {
    config: {
      provider: "local",
      mode: "local",
      model: "skill-archive-test-embedding",
      batchSize: 32,
      timeoutMs: 60_000,
      maxRetries: 0,
      cache: false,
      normalize: false
    },
    isRemote() {
      return false;
    },
    async embed(texts: string[]) {
      return texts.map(() => [1, 0, 0]);
    },
    async embedOne() {
      return [1, 0, 0];
    },
    status() {
      return {
        provider: "local",
        model: "skill-archive-test-embedding",
        configured: true,
        remote: false
      };
    }
  };
}
