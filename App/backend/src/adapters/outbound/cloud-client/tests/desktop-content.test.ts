import { describe, expect, it, vi } from "vitest";
import { createHttpCloudClient } from "../http-cloud-client.js";

const query = { locale: "en-US" as const, clientVersion: "1.2.7", region: "INTL" as const };
const agreement = { agreementCode: "CREDIT_RULES", title: "Credit rules", version: "credits-1",
  effectiveAt: "2026-11-01T00:00:00Z", url: "https://www.memmy.ai/legal/credits", required: true };
const campaign = { promotionId: "configured-checkin", title: "Daily reward", description: "Published description",
  startAt: "2026-11-01T00:00:00Z", endAt: "2026-12-01T00:00:00Z",
  rewardRule: { type: "CHECK_IN", amount: "100.00", validDays: 30 }, targetUrl: "memmy://credits/check-in" };

describe("published desktop content", () => {
  it("sends locale/version/region and preserves configured legal versions and credit amounts", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("locale")).toBe("en-US");
      expect(url.searchParams.get("clientVersion")).toBe("1.2.7");
      let data: unknown;
      if (url.pathname.endsWith("/agreements")) data = { items: [agreement] };
      else if (url.pathname.endsWith("/promotions")) {
        expect(url.searchParams.get("region")).toBe("INTL"); data = { items: [campaign] };
      } else data = { title: url.searchParams.get("pageCode"), version: "page-2",
        contentUrl: "https://www.memmy.ai/help/credits", updatedAt: "2026-11-01T00:00:00Z" };
      return Response.json({ code: 0, data });
    });
    const client = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl: fetchImpl as typeof fetch, deviceId: "fixture" });
    await expect(client.getDesktopContent!(query)).resolves.toMatchObject({ locale: "en-US", agreements: [agreement],
      promotions: [campaign], pages: [{ pageCode: "CREDIT_RULES", version: "page-2" }, { pageCode: "CREDIT_HELP", version: "page-2" }] });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("treats old shapes and missing published configuration as empty without inventing legal versions", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/page")) return Response.json({ code: "LEGAL_PAGE_NOT_FOUND", message: "not configured" }, { status: 404 });
      return Response.json({ code: 0, data: path.endsWith("/promotions") ? { loginBanner: true, agentChatTokenTotal: 500000 } :
        { terms: { "zh-CN": "https://www.memmy.ai/terms", "en-US": "https://www.memmy.ai/en/terms" } } });
    });
    const client = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl: fetchImpl as typeof fetch, deviceId: "fixture" });
    await expect(client.getDesktopContent!(query)).resolves.toEqual({ locale: "en-US", agreements: [], promotions: [], pages: [] });
  });

  it("does not expose executable or unrecognized application URLs from remote configuration", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return Response.json({ code: 0, data: path.endsWith("/promotions") ? { items: [{ ...campaign, targetUrl: "memmy://shell/execute" }] } :
        path.endsWith("/agreements") ? { items: [{ ...agreement, url: "javascript:alert(1)" }] } :
          { title: "unsafe", version: "1", updatedAt: "2026-11-01T00:00:00Z", contentUrl: "file:///private/fixture" } });
    });
    const client = createHttpCloudClient({ baseUrl: "https://cloud.test", fetchImpl: fetchImpl as typeof fetch, deviceId: "fixture" });
    await expect(client.getDesktopContent!(query)).resolves.toEqual({ locale: "en-US", agreements: [], promotions: [], pages: [] });
  });
});
