// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopContent } from "@memmy/local-api-contracts";
import { AppProviders } from "../../app/providers.js";
import { useAppState } from "../../state/app-state.js";
import { appActions } from "../../state/app-actions.js";
import { CreditsPublishedContent } from "../credits-published-content.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const current = new Date("2026-11-09T00:00:00Z");
const content: DesktopContent = { locale: "zh-CN", agreements: [{ agreementCode: "CREDIT_RULES", title: "正式积分规则",
  version: "rules-2026", effectiveAt: "2026-11-01T00:00:00Z", url: "https://www.memmy.ai/credits/rules", required: true }],
  pages: [{ pageCode: "CREDIT_RULES", title: "重复规则", version: "rules-2026", contentUrl: "https://www.memmy.ai/credits/rules", updatedAt: "2026-11-01T00:00:00Z" },
    { pageCode: "CREDIT_HELP", title: "积分帮助", version: "help-1", contentUrl: "https://www.memmy.ai/credits/help", updatedAt: "2026-11-01T00:00:00Z" }],
  promotions: [{ promotionId: "checkin", title: "服务器活动", description: "服务端说明", startAt: "2026-11-01T00:00:00Z", endAt: "2026-11-09T00:00:20Z",
    rewardRule: { type: "CHECK_IN", amount: "123.45", validDays: 30 }, targetUrl: "memmy://credits/check-in" }] };
function Harness({ data }: { data?: DesktopContent }) {
  const { state, dispatch } = useAppState();
  useEffect(() => { dispatch(appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, language: "zh-CN" }, desktopContent: data }, "/settings")); }, [data, dispatch]);
  return <><CreditsPublishedContent /><output data-route>{state.navigation.currentPath}</output></>;
}
async function render(data?: DesktopContent) { await act(async () => root.render(<AppProviders><Harness data={data} /></AppProviders>)); }
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(current);
  window.localStorage.clear(); window.sessionStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("hides missing configuration instead of inventing campaigns or legal versions", async () => {
  await render(); expect(host.querySelector('section')).toBeNull();
  await render({ locale: "zh-CN", agreements: [], pages: [], promotions: [] });
  expect(host.querySelector('section')).toBeNull();
});
it("opens configured credit rules and routes native campaigns while displaying server reward terms", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await render(content);
  expect(host.textContent).toContain("奖励 123.45 积分");
  expect(host.textContent).toContain("到账后 30 天有效");
  expect(host.textContent).not.toContain("重复规则");
  const rules = [...host.querySelectorAll('button')].find(button => button.textContent === "正式积分规则")!;
  expect(rules.title).toContain("rules-2026");
  await act(async () => rules.click());
  expect(open).toHaveBeenCalledWith("https://www.memmy.ai/credits/rules", "_blank", "noopener,noreferrer");
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === "服务器活动")!.click());
  expect(host.querySelector('[data-route]')?.textContent).toBe("/checkin");
});
it("removes expired campaigns and does not mix another locale's legal publication", async () => {
  await render(content);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(host.textContent).not.toContain("服务器活动");
  expect(host.textContent).toContain("正式积分规则");
  await render({ ...content, locale: "en-US" });
  expect(host.querySelector('section')).toBeNull();
});
