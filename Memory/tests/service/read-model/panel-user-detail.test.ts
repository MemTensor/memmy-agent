import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { GetMemoryOutputSchema } from "../../../src/contracts/memory-runtime.js";
const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
describe("user memory summary and authenticated detail", () => {
  it("preserves full content, references and archive reason without embedding; old lists stay complete", () => {
    const { service, db } = createTestService();
    const repos = new Repositories(db.db);
    const at = "2026-10-27T00:00:00.000Z";
    const content = "长期偏好😀".repeat(2000);
    repos.userMemories.insert({
      id: "user_detail",
      sourceTurnId: "first",
      userId: "owner",
      content,
      normalizedUserTextHash: "hash",
      sourceTurnRefs: ["first", "second"],
      memoryTypes: ["User Preference"],
      status: "archived",
      replacesMemoryId: "old",
      replacedByMemoryId: "new",
      archivedAt: at,
      archiveReason: "user_correction",
      embedding: [1, 2, 3],
      createdAt: at,
      updatedAt: at
    });
    const namespace = { userId: "owner", source: "codex", profileId: "default" };
    expect(service.panelItems({ layer: "UserMemory", namespace }).items[0]?.summary).toBe(content);
    const light = service.panelItems({ layer: "UserMemory", namespace, userSummary: true }).items[0]!;
    expect(light.summary.length).toBeLessThan(400);
    expect(light.metadata?.fullContentAvailable).toBe(true);
    const result = GetMemoryOutputSchema.parse(service.getMemory("user_detail", { namespace }));
    expect(result.item.body).toBe(content);
    expect(result.item.metadata).toMatchObject({
      sourceTurnRefs: ["first", "second"],
      replacesMemoryId: "old",
      replacedByMemoryId: "new",
      archiveReason: "user_correction"
    });
    expect(JSON.stringify(result)).not.toContain("embedding");
    expect(service.getMemory("user_detail").item.body).toBe(content);
    expect(service.getMemory("user_detail", { namespace: { ...namespace, userId: "other" } }).item.body).toBe(content);
    repos.userMemories.softDelete("user_detail");
    expect(() => service.getMemory("user_detail", { namespace })).toThrow();
  });

  it("retains the owner check for cloud User Memory detail", () => {
    const {service,db}=createTestService({mode:"cloud"});
    const repos=new Repositories(db.db),at="2026-10-27T00:00:00.000Z";
    repos.userMemories.insert({id:"cloud-detail",sourceTurnId:"first",userId:"owner",content:"cloud preference",
      normalizedUserTextHash:"hash",sourceTurnRefs:["first"],memoryTypes:["User Preference"],status:"active",createdAt:at,updatedAt:at});
    db.db.prepare("UPDATE user_memories SET user_id='owner' WHERE id='cloud-detail'").run();
    expect(service.getMemory("cloud-detail",{namespace:{userId:"owner",source:"codex",profileId:"default"}}).item.body).toBe("cloud preference");
    expect(()=>service.getMemory("cloud-detail",{namespace:{userId:"other",source:"codex",profileId:"default"}})).toThrow("unavailable");
    expect(()=>service.getMemory("cloud-detail")).toThrow("unavailable");
  });
});
