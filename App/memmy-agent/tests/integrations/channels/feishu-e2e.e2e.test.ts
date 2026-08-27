/**
 * Feishu real-connection E2E script, skipped by default.
 *
 * Purpose: run the full "send message / streaming card" path once against the
 * real Feishu API. Each step prints only Feishu business code/msg to precisely
 * locate missing permissions, such as 99991672, or invalid payloads, such as a
 * schema 2.0 wide_screen_mode misuse causing 400, instead of crashing the
 * process or flooding logs with socket internals.
 *
 * Run after enabling permissions such as im:message:send in the Feishu open
 * platform and publishing a version:
 *   FEISHU_APP_ID=cli_xxx \
 *   FEISHU_APP_SECRET=xxx \
 *   FEISHU_TEST_RECEIVE_ID=ou_xxx_or_oc_xxx \
 *   npx vitest run tests/integrations/channels/feishu-e2e.e2e.test.ts
 *
 * Optional: FEISHU_DOMAIN=feishu|lark, defaulting to feishu.
 *
 * The reproduced payloads stay aligned with sendMessageSync,
 * createStreamingCardSync, streamUpdateTextSync, and closeStreamingModeSync in
 * src/integrations/channels/feishu.ts. Any step failure fails the expectation
 * and prints the reason.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { describeFeishuError } from "../../../src/integrations/channels/feishu.js";

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const RECEIVE_ID = process.env.FEISHU_TEST_RECEIVE_ID;
const DOMAIN = process.env.FEISHU_DOMAIN === "lark" ? "lark" : "feishu";
const READY = Boolean(APP_ID && APP_SECRET && RECEIVE_ID);

/** Assert Feishu success (code === 0); otherwise print code/msg clearly before failing. */
function expectOk(step: string, res: any): any {
  const code = res?.code;
  if (code !== 0) {
    // eslint-disable-next-line no-console
    console.error(`[e2e] ${step} 失败：`, describeFeishuError(res));
  }
  expect(code, `${step} 应返回 code=0，实际：${describeFeishuError(res)}`).toBe(0);
  return res;
}

describe.skipIf(!READY)("Feishu E2E（真连飞书）", () => {
  let lark: any;
  let client: any;
  const receiveIdType = (RECEIVE_ID ?? "").startsWith("oc_") ? "chat_id" : "open_id";

  beforeAll(async () => {
    lark = await import("@larksuiteoapi/node-sdk");
    const domain = DOMAIN === "lark" ? lark.Domain?.Lark : lark.Domain?.Feishu;
    client = new lark.Client({
      appId: APP_ID,
      appSecret: APP_SECRET,
      appType: lark.AppType?.SelfBuild,
      domain,
    });
  });

  it("步骤1：换取 tenant_access_token（校验 App ID/Secret）", async () => {
    const res = await client.request({
      method: "POST",
      url: "/open-apis/auth/v3/tenant_access_token/internal",
      data: { app_id: APP_ID, app_secret: APP_SECRET },
    });
    expectOk("tenant_access_token", res?.data ?? res);
  });

  it("步骤2：发送纯文本消息（需要 im:message:send 权限）", async () => {
    const res = await client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: RECEIVE_ID,
        msg_type: "text",
        content: JSON.stringify({ text: "memmy E2E: hello ✅" }),
      },
    });
    const ok = expectOk("im.message.create(text)", res);
    // eslint-disable-next-line no-console
    console.log("[e2e] 文本消息已发送 message_id=", ok?.data?.message_id);
  });

  it("步骤3-5：创建流式卡片 → 流式更新 → 收尾（需要 cardkit 权限）", async () => {
    // Step 3: create a schema 2.0 streaming card entity, reproducing createStreamingCardSync's payload.
    const cardData = JSON.stringify({
      schema: "2.0",
      config: { width_mode: "fill", update_multi: true, streaming_mode: true },
      body: { elements: [{ tag: "markdown", content: "", element_id: "streaming_md" }] },
    });
    const created = await client.cardkit.v1.card.create({
      data: { type: "card_json", data: cardData },
    });
    const card = expectOk("cardkit.card.create", created);
    const cardId = card?.data?.card_id;
    expect(cardId, "创建卡片后应返回 card_id").toBeTruthy();

    // Deliver the card as an interactive message.
    const delivered = await client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: RECEIVE_ID,
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
      },
    });
    expectOk("im.message.create(interactive card)", delivered);

    // Step 4: update streaming card text, reproducing streamUpdateTextSync.
    const updated = await client.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: "streaming_md" },
      data: { content: "memmy E2E 流式更新中… ▍", sequence: 1 },
    });
    expectOk("cardkit.cardElement.content", updated);

    // Step 5: disable streaming mode for completion, reproducing closeStreamingModeSync.
    const closed = await client.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: { settings: JSON.stringify({ config: { streaming_mode: false } }), sequence: 2 },
    });
    expectOk("cardkit.card.settings", closed);
  });
});
