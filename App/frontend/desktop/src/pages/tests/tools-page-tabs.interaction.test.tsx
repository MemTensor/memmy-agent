// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { initialToolsState } from "../../state/tools-slice.js";
import { ToolsPageView, type ToolsSection } from "../tools-page.js";

vi.mock("../app-frame.js", () => ({ AppFrame: ({ children }: { children: ReactNode }) => <>{children}</> }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const loadMarketplace = vi.fn();
function MarketplaceFixture() {
  useEffect(() => { loadMarketplace(); }, []);
  return <input aria-label="Plugin filter fixture" defaultValue="" />;
}

beforeEach(() => {
  loadMarketplace.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
async function show(section: ToolsSection, pluginUpdatesAvailable = false) {
  await act(async () => root.render(
    <I18nProvider language="zh-CN">
      <ToolsPageView tools={{ ...initialToolsState, status: "ready" }} section={section}
        searchBySection={{ connections: "github", channels: "telegram" }}
        filterBySection={{ connections: "all", channels: "all" }}
        pluginUpdatesAvailable={pluginUpdatesAvailable} marketplace={<MarketplaceFixture />}
        onSearchChange={() => {}} onCategoryChange={() => {}} onOpenIntegration={() => {}}
        onModalClose={() => {}} onConnectionsChanged={() => {}} />
    </I18nProvider>
  ));
}

it("retains visited catalog nodes and keeps search criteria independent", async () => {
  await show("connections");
  const card = container.querySelector('[aria-label="GitHub · 应用工具"]');
  expect(card).not.toBeNull();
  expect(container.querySelector("#tools-panel-channels")).toBeNull();
  await show("channels");
  expect(container.querySelector<HTMLElement>("#tools-panel-connections")?.hidden).toBe(true);
  expect(container.querySelector('[aria-label="GitHub · 应用工具"]')).toBe(card);
  expect(container.querySelector<HTMLInputElement>('[aria-label="搜索聊天渠道"]')?.value).toBe("telegram");
  await show("connections");
  expect(container.querySelector('[aria-label="GitHub · 应用工具"]')).toBe(card);
  expect(container.querySelector<HTMLInputElement>('[aria-label="搜索应用工具"]')?.value).toBe("github");
  expect(container.querySelectorAll('[data-tour-anchor="product-tour-tools-content"]')).toHaveLength(1);
});

it("loads the marketplace only on its first visit and retains its filter on return", async () => {
  await show("connections");
  expect(loadMarketplace).not.toHaveBeenCalled();
  await show("plugins");
  const input = container.querySelector<HTMLInputElement>('[aria-label="Plugin filter fixture"]')!;
  input.value = "literature";
  await show("channels");
  expect(container.querySelector<HTMLElement>("#tools-panel-plugins")?.hidden).toBe(true);
  await show("plugins");
  expect(loadMarketplace).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[aria-label="Plugin filter fixture"]')).toBe(input);
  expect(input.value).toBe("literature");
});

it("keeps the update dot on the marketplace tab until the installed version catches up", async () => {
  await show("connections", true);
  expect(container.querySelector('#tools-tab-plugins [aria-label="插件有可用更新"]')).not.toBeNull();
  await show("plugins", true);
  expect(container.querySelector('#tools-tab-plugins [aria-label="插件有可用更新"]')).not.toBeNull();
  await show("plugins", false);
  expect(container.querySelector('[aria-label="插件有可用更新"]')).toBeNull();
});
