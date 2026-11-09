import "../../fixtures/isolated-user-home.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAgentSkillInventory } from "@memmy/agent-source-core";
import { afterEach, describe, expect, it } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { agentSkillConnectionKey, importedSkillContentHash } from "../../../src/storage/imported-skill.js";
import { replayRound6ManualCollision, replayRound9UnverifiedArchive } from "../../fixtures/round6-manual-collision.js";
import { withLegacyImportedSkillWriter } from "../../fixtures/legacy-imported-skill-writer.js";
import { createCapturingEmbedder, createFailingLlm, createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const namespace = { source: "codex", profileId: "default", userId: "source-facts-user" };
const marker = "sourcefactsquartz42";
const content = `---\nname: deployment-helper\ndescription: Safe deployment procedure.\n---\nVerify ${marker} before deploying.`;

function setup(collision = false) {
  const embedded: string[] = [];
  const { db, service } = fixture.createTestService({ llm: createFailingLlm(), embedder: createCapturingEmbedder(embedded) });
  const repos = new Repositories(db.db);
  const root = fixture.createTestRoot("skill-source-facts-");
  const directory = join(root, "deployment-helper");
  const sourceSkillPath = join(directory, "SKILL.md");
  mkdirSync(directory, { recursive: true });
  writeFileSync(sourceSkillPath, content);
  const request = { namespace, source: "codex", layer: "Skill" as const, sourceAgentId: "codex",
    sourceSkillId: "deployment-helper", sourceSkillPath, title: "deployment-helper", content };
  const id = collision ? withLegacyImportedSkillWriter(service, () => {
    const id = service.addMemory(request).id;
    const manual = service.addMemory({ namespace, source: "codex", layer: "Skill", title: "ordinary-note",
      turnId: "deployment-helper", content: "An ordinary manually saved note." }).id;
    expect(repos.memories.getIncludingDeleted(id)!.properties.internal_info.superseded_by_skill_id).toBe(manual);
    return id;
  }) : undefined;
  const row = (memoryId: string) => repos.memories.getIncludingDeleted(memoryId)!;
  const observe = async (complete = true) => {
    const inventory = await readAgentSkillInventory(root);
    return service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete,
      skills: inventory.items.map(item => ({ ...item, title: item.name ?? item.sourceSkillId })) });
  };
  const sidecar = (text: string) => {
    mkdirSync(join(directory, "agents"), { recursive: true });
    writeFileSync(join(directory, "agents", "openai.yaml"), text);
  };
  return { db, service, repos, row, root, request, id: id!, embedded, observe, sidecar };
}

function ambiguousCollision() {
  const context = setup();
  const own = { ...namespace, source: "hermes" };
  const scan = (body = content) => context.service.reconcileAgentSkills({ namespace: own, sourceAgentId: "hermes", complete: false,
    skills: [{ sourceSkillId: context.request.sourceSkillId, sourceSkillPath: context.request.sourceSkillPath,
      title: context.request.title, content: body, contentHash: importedSkillContentHash(body), modifiedAt: "2026-11-01T00:00:00.000Z" }] });
  const file = scan().skills[0]!.memoryId!;
  const manual = replayRound6ManualCollision(context.service, context.repos,
    { namespace: own, source: "hermes", layer: "Skill", title: "ambiguous-note", turnId: context.request.sourceSkillId,
      content: "Ordinary ambiguous sourcefacts note." }, new Date().toISOString(), { inheritedPath: true });
  expect(context.row(manual).properties.internal_info).toMatchObject({ source_kind: "skill", source_skill_path: context.request.sourceSkillPath });
  return { ...context, own, scan, file, manual };
}

describe("source facts survive user archive and restore", () => {
  it.each(["manual-repair", "pointerless-history", "repeated-history"] as const)(
    "preserves a genuine historical edge through %s and content-only deletion", route => {
      const { service, repos, row, request } = setup();
      const own = { ...namespace, source: "hermes" };
      const scan = (body = content) => service.reconcileAgentSkills({ namespace: own, sourceAgentId: "hermes", complete: true,
        skills: [{ sourceSkillId: request.sourceSkillId, sourceSkillPath: request.sourceSkillPath,
          title: request.title, content: body, contentHash: importedSkillContentHash(body), modifiedAt: "2026-11-01T00:00:00.000Z" }] });
      const first = scan().skills[0]!.memoryId!;
      const next = scan(content + "\nSecond source version.").skills[0]!.memoryId!;
      expect(row(first).properties.internal_info.superseded_by_skill_id).toBe(next);
      service.reconcileAgentSkills({ namespace: own, sourceAgentId: "hermes", complete: true, skills: [] });
      const collide = (suffix: string) => replayRound6ManualCollision(service, repos,
        { namespace: own, source: "hermes", layer: "Skill", title: `collision-${suffix}`, turnId: request.sourceSkillId,
          content: `Ordinary collision note ${suffix}.` }, new Date().toISOString());
      const manual = collide("first");
      if (route !== "manual-repair") replayRound9UnverifiedArchive(repos, first, manual, new Date().toISOString());
      if (route === "repeated-history") collide("again");
      const reason = route === "manual-repair" ? "superseded" : "user";
      expect(repos.memories.resolveLegacyImportedSkillVersion(row(first)).properties.internal_info)
        .toMatchObject({ archive_reason: reason, superseded_by_skill_id: next });
      service.reconcileWorkerStartup(1);
      expect(row(first).properties.internal_info).toMatchObject({ archive_reason: reason, superseded_by_skill_id: next });
      expect(repos.isImportedSkillEligibleForEmbedding(row(first))).toBe(false);
      expect(row(next).properties.internal_info.archive_reason).toBe("source_missing");
      service.deleteMemory(next, { namespace: own });
      service.deleteMemory(first, { namespace: own });
      expect(row(first).properties.internal_info.deleted_current).toBe(false);
      expect(row(next).properties.internal_info.deleted_current).toBe(false);
      expect(scan(content + "\nThird source version.").skills[0]?.outcome).toBe("created");
    });

  it.each(["", "unknown-successor"])("retains the conservative historical marker %j recovered from a false collision", successor => {
    const { service, repos, row, request } = setup();
    const own = { ...namespace, source: "hermes" };
    const scan = (body = content) => service.reconcileAgentSkills({ namespace: own, sourceAgentId: "hermes", complete: true,
      skills: [{ sourceSkillId: request.sourceSkillId, sourceSkillPath: request.sourceSkillPath,
        title: request.title, content: body, contentHash: importedSkillContentHash(body), modifiedAt: "2026-11-01T00:00:00.000Z" }] });
    const first = scan().skills[0]!.memoryId!;
    const before = row(first);
    repos.memories.updateMaintenance({ ...before, status: "archived", properties: { ...before.properties, status: "archived",
      internal_info: { ...before.properties.internal_info, archive_reason: "superseded", superseded_by_skill_id: successor } } });
    replayRound6ManualCollision(service, repos,
      { namespace: own, source: "hermes", layer: "Skill", title: "collision", turnId: request.sourceSkillId,
        content: "An ordinary colliding note." }, new Date().toISOString());
    service.reconcileWorkerStartup(1);
    expect(row(first).properties.internal_info).toMatchObject({ archive_reason: "superseded", superseded_by_skill_id: successor });
    service.deleteMemory(first, { namespace: own });
    expect(row(first).properties.internal_info.deleted_current).toBe(false);
    expect(scan(content + "\nNew actual source bytes.").skills[0]?.outcome).toBe("created");
  });

  it("clears a recovered historical edge only when that source version is genuinely observed again", () => {
    const { service, repos, row, request } = setup();
    const own = { ...namespace, source: "hermes" };
    const scan = (body = content) => service.reconcileAgentSkills({ namespace: own, sourceAgentId: "hermes", complete: true,
      skills: [{ sourceSkillId: request.sourceSkillId, sourceSkillPath: request.sourceSkillPath,
        title: request.title, content: body, contentHash: importedSkillContentHash(body), modifiedAt: "2026-11-01T00:00:00.000Z" }] });
    const first = scan().skills[0]!.memoryId!;
    const next = scan(content + "\nSecond source version.").skills[0]!.memoryId!;
    const manual = replayRound6ManualCollision(service, repos,
      { namespace: own, source: "hermes", layer: "Skill", title: "collision", turnId: request.sourceSkillId,
        content: "Ordinary collision note." }, new Date().toISOString());
    replayRound9UnverifiedArchive(repos, first, manual, new Date().toISOString());
    service.reconcileWorkerStartup(1);
    expect(row(first).properties.internal_info.superseded_by_skill_id).toBe(next);
    expect(scan().skills[0]?.memoryId).toBe(first);
    expect(row(first).properties.internal_info.superseded_by_skill_id).toBeUndefined();
    expect(row(first).properties.internal_info.archive_reason).toBe("user");
    expect(service.reactivateSkill(first, { namespace: own }).status).toBe("activated");
    expect(row(next).properties.internal_info.superseded_by_skill_id).toBe(first);
    service.deleteMemory(first, { namespace: own });
    expect(row(first).properties.internal_info.deleted_current).toBe(true);
    expect(scan(content + "\nThird source version.").skills[0]?.outcome).toBe("deleted_by_user");
  });

  it("records only explicit connection decisions as authority events", () => {
    const { service, repos } = setup();
    const first = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false,
      skills: [], connectionState: "connected", connectionKind: "skill" }).connectionEvent;
    expect(first).toMatchObject({ id: expect.any(String), state: "connected", kind: "skill", revision: 1 });
    const scan = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false,
      skills: [], disconnected: true });
    expect(scan.connectionEvent).toBeUndefined();
    expect(repos.runtime.getKv(agentSkillConnectionKey("codex"))?.value).toBe("disconnected");
    expect(repos.runtime.getKv(`${agentSkillConnectionKey("codex")}:event`)?.value).toEqual(first);
    const second = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false,
      skills: [], connectionState: "connected", connectionKind: "plugin" }).connectionEvent;
    expect(second).toMatchObject({ id: expect.any(String), state: "connected", kind: "plugin", revision: 2 });
    expect(second?.id).not.toBe(first?.id);
    const third = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false,
      skills: [], connectionState: "disconnected" }).connectionEvent;
    expect(third).toEqual({ id: expect.any(String), state: "disconnected", revision: 3 });
    expect(third?.id).not.toBe(second?.id);
  });

  it("starts legacy connection events at revision one and rejects invalid stored revisions", () => {
    const { service, repos } = setup();
    const key = `${agentSkillConnectionKey("codex")}:event`;
    const legacy = { id: "legacy-event", state: "connected", kind: "skill" };
    repos.runtime.setKv(key, legacy);
    expect(service.agentSkillConnectionEvent("codex")).toEqual(legacy);
    const next = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false,
      skills: [], connectionState: "disconnected" }).connectionEvent;
    expect(next).toMatchObject({ state: "disconnected", revision: 1 });
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
      repos.runtime.setKv(key, { ...legacy, revision });
      expect(service.agentSkillConnectionEvent("codex")).toBeUndefined();
    }
    repos.runtime.setKv(key, { ...legacy, revision: 41 });
    expect(service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false,
      skills: [], connectionState: "connected" }).connectionEvent).toMatchObject({ revision: 42 });
  });

  it("rolls back connection state if its event revision cannot advance safely", () => {
    const { service, repos } = setup();
    const key = `${agentSkillConnectionKey("codex")}:event`;
    const previous = { id: "last-safe-event", state: "connected", kind: "skill", revision: Number.MAX_SAFE_INTEGER };
    repos.runtime.setKv(agentSkillConnectionKey("codex"), "connected");
    repos.runtime.setKv(key, previous);
    expect(() => service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false,
      skills: [], connectionState: "disconnected" })).toThrow("revision is exhausted");
    expect(repos.runtime.getKv(agentSkillConnectionKey("codex"))?.value).toBe("connected");
    expect(service.agentSkillConnectionEvent("codex")).toEqual(previous);
  });

  it.each(["cold", "warm"] as const)("keeps an old-writer collision pending through %s archive, startup and incomplete scans", async entry => {
    for (const scan of ["none", "empty", "sibling"] as const) {
      const { service, repos, id, row, embedded } = setup(true);
      if (entry === "warm") service.reconcileWorkerStartup(1);
      service.archiveMemory(id, { namespace });
      service.archiveMemory(id, { namespace });
      service.reconcileWorkerStartup(1);
      if (scan !== "none") service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: false,
        skills: scan === "empty" ? [] : [{ sourceSkillId: "sibling", sourceSkillPath: "/isolated/sibling/SKILL.md",
          title: "sibling", content: "Unrelated observed procedure.", contentHash: importedSkillContentHash("Unrelated observed procedure."),
          modifiedAt: "2026-11-01T00:00:00.000Z" }] });
      expect(row(id).properties.internal_info.source_state).not.toBe("present");
      expect(service.reactivateSkill(id, { namespace }).status).toBe("archived");
      expect(["source_review_pending", "scan_pending", "policy_unknown"]).toContain(row(id).properties.internal_info.archive_reason);
      await service.runWorkerOnce(50);
      expect(embedded.some(text => text.includes(marker))).toBe(false);
      expect(repos.memories.hasVector(id, "vec")).toBe(false);
      const cross = { ...namespace, source: "cursor" };
      expect((await service.search({ namespace: cross, query: marker, layers: ["Skill"], limit: 10 })).hits.some(hit => hit.id === id)).toBe(false);
    }
  });

  it("keeps a complete absence content-specific after an archived collision is restored and deleted", () => {
    const { service, id, row, request } = setup(true);
    service.archiveMemory(id, { namespace });
    service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true, skills: [] });
    expect(service.reactivateSkill(id, { namespace }).status).toBe("archived");
    expect(row(id).properties.internal_info.archive_reason).toBe("source_missing");
    service.deleteMemory(id, { namespace });
    expect(row(id).properties.internal_info.deleted_current).toBe(false);
    const nextContent = content + "\nA newly installed version.";
    const next = service.reconcileAgentSkills({ namespace, sourceAgentId: "codex", complete: true,
      skills: [{ sourceSkillId: request.sourceSkillId, sourceSkillPath: request.sourceSkillPath, title: request.title,
        content: nextContent, contentHash: importedSkillContentHash(nextContent), modifiedAt: "2026-11-02T00:00:00.000Z" }] });
    expect(next.skills[0]?.outcome).toBe("created");
  });

  it.each(["absent", "no policy", "allowed", "denied", "invalid"] as const)(
    "uses real %s sidecar evidence from an observed item even in an incomplete scan", async policy => {
      const { service, id, row, observe, sidecar, embedded, repos } = setup(true);
      if (policy === "no policy") sidecar("interface:\n  display_name: Deployment helper\n");
      if (policy === "allowed") sidecar("policy:\n  allow_implicit_invocation: true\n");
      if (policy === "denied") sidecar("policy:\n  allow_implicit_invocation: false\n");
      if (policy === "invalid") sidecar("policy: [unclosed\n");
      service.archiveMemory(id, { namespace });
      await observe(false);
      const allowed = policy === "absent" || policy === "no policy" || policy === "allowed";
      expect(service.reactivateSkill(id, { namespace }).status).toBe(allowed ? "activated" : "archived");
      expect(row(id).properties.internal_info.invocation).toMatchObject({ policy_observed: true });
      expect(row(id).memoryValue).toBe(allowed ? content : "");
      await service.runWorkerOnce(50);
      expect(embedded.some(text => text.includes(marker))).toBe(allowed);
      expect(repos.memories.hasVector(id, "vec")).toBe(allowed);
    });

  it("does not let a direct Codex body observation invent sidecar permission", async () => {
    const { service, request, row, observe, sidecar, embedded } = setup();
    sidecar("policy:\n  allow_implicit_invocation: false\n");
    const direct = service.addMemory(request);
    expect(direct.status).toBe("archived");
    expect(row(direct.id).properties.internal_info.archive_reason).toBe("policy_unknown");
    expect(row(direct.id).properties.internal_info.invocation).not.toMatchObject({ policy_observed: true });
    service.archiveMemory(direct.id, { namespace });
    expect(service.reactivateSkill(direct.id, { namespace }).status).toBe("archived");
    await service.runWorkerOnce(50);
    expect(embedded.some(text => text.includes(marker))).toBe(false);
    await observe();
    expect(row(direct.id).properties.internal_info.archive_reason).toBe("invocation_policy");
    expect(row(direct.id).memoryValue).toBe("");
    expect(service.addMemory({ ...request, content: content + "\nNew bytes." }).status).toBe("archived");
  });

  it("preserves verified default permission for direct observations of the same source path", async () => {
    const { service, request, observe, row } = setup();
    const id = (await observe()).skills[0]!.memoryId!;
    expect(row(id).properties.internal_info.invocation).toMatchObject({ policy_observed: true });
    const direct = service.addMemory({ ...request, content: content + "\nUpdated bytes." });
    expect(direct.status).toBe("activated");
    expect(row(direct.id).properties.internal_info.invocation).toMatchObject({ policy_observed: true });
    service.archiveMemory(direct.id, { namespace });
    expect(service.reactivateSkill(direct.id, { namespace }).status).toBe("activated");
  });

  it("does not transfer positive sidecar evidence to a changed direct source path", async () => {
    const { service, request, observe, row } = setup();
    await observe();
    const direct = service.addMemory({ ...request, sourceSkillPath: request.sourceSkillPath + ".moved", content: content + "\nMoved bytes." });
    expect(direct.status).toBe("archived");
    expect(row(direct.id).properties.internal_info.archive_reason).toBe("policy_unknown");
  });

  it("keeps an unrecognized stored source state pending instead of treating it as present", async () => {
    const { service, repos, observe, row } = setup();
    const id = (await observe()).skills[0]!.memoryId!;
    const before = row(id);
    repos.memories.updateMaintenance({ ...before, properties: { ...before.properties,
      internal_info: { ...before.properties.internal_info, source_state: "future_source_review" } } });
    service.archiveMemory(id, { namespace });
    expect(service.reactivateSkill(id, { namespace }).status).toBe("archived");
    expect(row(id).properties.internal_info.archive_reason).toBe("source_review_pending");
  });

  it("keeps an ambiguous inherited path pending across a direct source rewrite", () => {
    const { service, request, own, manual, row } = ambiguousCollision();
    const direct = service.addMemory({ ...request, namespace: own, source: "hermes", sourceAgentId: "hermes",
      content: "A new direct observation without a directory review." });
    expect(direct.status).toBe("archived");
    expect(row(direct.id).properties.internal_info).toMatchObject({ source_review_required: true, archive_reason: "source_review_pending" });
    service.archiveMemory(direct.id, { namespace: own });
    expect(service.reactivateSkill(direct.id, { namespace: own }).status).toBe("archived");
    expect(row(manual).properties.internal_info.read_only).toBe(true);
  });

  it("keeps ambiguous user archive local to its bytes and clears review after the actual source scan", () => {
    const { service, own, row, manual, file, scan } = ambiguousCollision();
    service.archiveMemory(manual, { namespace: own });
    expect(row(manual).properties.internal_info.archive_reason).toBe("user");
    expect(row(file).properties.internal_info.archive_reason).not.toBe("user");
    const observed = scan();
    expect(observed.skills[0]?.memoryId).toBe(file);
    expect(row(file).status).toBe("activated");
    expect(row(file).properties.internal_info.source_review_required).not.toBe(true);
    expect(row(manual).status).toBe("archived");
  });

  it("accepts later direct observations after a real scan superseded ambiguous bytes", () => {
    const { service, request, own, scan, manual, row } = ambiguousCollision();
    scan();
    service.archiveMemory(manual, { namespace: own });
    const direct = service.addMemory({ ...request, namespace: own, source: "hermes", sourceAgentId: "hermes",
      content: content + "\nObserved identity with new direct bytes." });
    expect(direct.status).toBe("activated");
    expect(row(direct.id).properties.internal_info.source_review_required).not.toBe(true);
  });

  it.each(["ambiguous", "observed"] as const)("scopes deletion of the %s collision row to its actual evidence", kind => {
    const { service, own, row, manual, file, scan } = ambiguousCollision();
    service.deleteMemory(kind === "ambiguous" ? manual : file, { namespace: own });
    expect(row(kind === "ambiguous" ? manual : file).properties.internal_info.deleted_current).toBe(kind === "observed");
    expect(scan(content + "\nA new real file version.").skills[0]?.outcome).toBe(kind === "observed" ? "deleted_by_user" : "created");
  });

  it("removes every old body copy when a cold restricted file is user-archived", () => {
    const { service, request, row } = setup();
    const restricted = content.replace("description:", "disable-model-invocation: true\ndescription:");
    const id = withLegacyImportedSkillWriter(service, () => service.addMemory({ ...request, content: restricted }).id);
    expect(JSON.stringify(row(id).properties)).toContain(marker);
    service.archiveMemory(id, { namespace });
    expect(row(id).memoryValue).toBe("");
    expect(JSON.stringify(row(id).properties)).not.toContain(marker);
  });

  it("keeps an orphaned historical version archived during migration", async () => {
    const { service, repos, row, observe } = setup();
    const id = (await observe()).skills[0]!.memoryId!;
    const before = row(id);
    // Preserve a genuine historical declaration whose successor has left this
    // local snapshot; missing successor evidence cannot prove a source rollback.
    repos.memories.updateMaintenance({ ...before, status: "archived", properties: { ...before.properties,
      status: "archived", internal_info: { ...before.properties.internal_info,
        import_state_version: 1, archive_reason: "superseded", superseded_by_skill_id: "unavailable-successor",
        skill: { ...(before.properties.internal_info.skill as Record<string, unknown>), status: "archived" } } } });
    service.reconcileWorkerStartup(1);
    expect(row(id).status).toBe("archived");
    expect(row(id).properties.internal_info.archive_reason).toBe("superseded");
  });

  it("leaves ordinary manually saved Skills independent of source policy", () => {
    const { service, row } = setup();
    const manual = service.addMemory({ namespace, source: "codex", layer: "Skill", turnId: "ordinary-turn", content: "Ordinary guide." });
    service.archiveMemory(manual.id, { namespace });
    expect(service.reactivateSkill(manual.id, { namespace }).status).toBe("activated");
    expect(row(manual.id).properties.internal_info.read_only).not.toBe(true);
    expect(row(manual.id).properties.internal_info.source_state).toBeUndefined();
  });
});
