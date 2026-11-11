import { describe, expect, it } from "vitest";
import { AccountInvitationViewSchema, DeletePanelTaskOutputSchema, InvitationResultSchema, PanelTasksOutputSchema,
  RecallEvidenceOutputSchema, TokenUsageDtoSchema } from "../../local-api-contracts/src/index.js";
import { createMockCloudClient } from "./support/mock-cloud-client.js";
import { createMockMemoryClient } from "./support/mock-memory-client.js";

const now = () => "2026-11-06T00:00:00.000Z";
describe("shared mock client contracts", () => {
  it("returns invitation results for new and returning accounts without inventing rewards", async () => {
    const client = createMockCloudClient({ now });
    const input = { channel: "email" as const, email: "fixture@example.test", verificationCode: "123456", loginSource: "Memmy" as const };
    expect(InvitationResultSchema.parse((await client.login(input)).invitationResult)).toEqual({ status: "not_provided" });
    expect(InvitationResultSchema.parse((await client.login({ ...input, invitationCode: "ABC123" })).invitationResult))
      .toEqual({ status: "not_new_user" });
    const invited = await client.login({ ...input, email: "new@example.test", invitationCode: "ABC123" });
    expect(InvitationResultSchema.parse(invited.invitationResult)).toEqual({ status: "pending" });
    expect(TokenUsageDtoSchema.parse(await client.getTokenUsage({})).sceneUsages).toEqual([]);
    expect(AccountInvitationViewSchema.parse(await client.ensureInvitationCode({ uuid: "fixture" })))
      .toMatchObject({ enabled: false, invitationCode: null, remainingInvitesToday: 0 });
  });

  it("provides contract-valid empty recall and task responses", async () => {
    const client = createMockMemoryClient({ now });
    expect(RecallEvidenceOutputSchema.parse(await client.recallEvidence("query-1")))
      .toMatchObject({ queryId: "query-1", hits: [], serverTime: now() });
    expect(PanelTasksOutputSchema.parse(await client.panelTasks({ page: 1 })))
      .toMatchObject({ tasks: [], total: 0, pageSize: 20, serverTime: now() });
    expect(DeletePanelTaskOutputSchema.parse(await client.deletePanelTask("task-1")))
      .toEqual({ ok: true, id: "task-1", deletedMemoryIds: [], serverTime: now() });
  });

  it("applies the existing failure simulation to the added memory methods", async () => {
    const client = createMockMemoryClient({ now, failureRate: 1 });
    await expect(client.recallEvidence("query-1")).rejects.toThrow("mock-induced failure");
    await expect(client.panelTasks({ page: 1 })).rejects.toThrow("mock-induced failure");
    await expect(client.deletePanelTask("task-1")).rejects.toThrow("mock-induced failure");
  });
});
