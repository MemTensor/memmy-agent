import { describe, expect, it } from "vitest";
import { AccountInvitationViewSchema, AsrModelIdSchema, AsrProviderSchema, InvitationResultSchema, TokenUsageDtoSchema } from "@memmy/local-api-contracts";
import { createMockCloudClient } from "./mock-cloud-client.js";

describe("shared mock cloud contracts", () => {
  it("reports invitations and token usage without inventing rewards", async () => {
    const client = createMockCloudClient({ now: () => "2026-11-12T00:00:00.000Z" });
    const input = { channel: "email" as const, email: "fixture@example.test", verificationCode: "123456", loginSource: "Memmy" as const };
    expect(InvitationResultSchema.parse((await client.login(input)).invitationResult)).toEqual({ status: "not_provided" });
    expect(InvitationResultSchema.parse((await client.login({ ...input, invitationCode: "ABC123" })).invitationResult))
      .toEqual({ status: "not_new_user" });
    expect(InvitationResultSchema.parse((await client.login({ ...input, email: "new@example.test", invitationCode: "ABC123" })).invitationResult))
      .toEqual({ status: "pending" });
    expect(TokenUsageDtoSchema.parse(await client.getTokenUsage({})).sceneUsages).toEqual([]);
    expect(AccountInvitationViewSchema.parse(await client.ensureInvitationCode({ uuid: "fixture" })))
      .toMatchObject({ enabled: false, invitationCode: null, remainingInvitesToday: 0 });
  });

  it("returns the declared empty transcription contract without performing external work", async () => {
    const client = createMockCloudClient();
    const result = await client.transcribeAudio({ uuid: "fixture", audioBase64: "AA==", mimeType: "audio/wav" });
    // The Cloud adapter reply precedes the service's UI routing/timestamp envelope.
    expect(result.text).toBe("");
    expect(AsrModelIdSchema.parse(result.modelId)).toBe("qwen3-asr-flash");
    expect(AsrProviderSchema.parse(result.provider)).toBe("aliyun");
  });
});
