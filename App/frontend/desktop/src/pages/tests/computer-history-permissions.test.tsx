// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ComputerHistoryPermissionsDialog } from "../memory/computer-history-permissions.js";
import { normalizeWebsite } from "../memory/computer-history-permissions-utils.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let client: MemmyAgentClient;
let closed: ReturnType<typeof vi.fn>;
const initial = { revision: "revision-1", settings: { observation: {
  defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [],
} } };
beforeEach(() => {
  const node = document.createElement("div"); document.body.append(node); root = createRoot(node);
  client = { getComputerHistoryObservationPermissions: vi.fn().mockResolvedValue(structuredClone(initial)),
    saveComputerHistoryObservationPermissions: vi.fn().mockResolvedValue(initial),
    listComputerHistoryApplications: vi.fn().mockResolvedValue([{ bundleId: "com.apple.Notes", name: "Notes" }]),
    getApplicationIcon: vi.fn().mockResolvedValue(null),
  } as unknown as MemmyAgentClient;
  closed = vi.fn();
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); });
async function render() { await act(async () => { root.render(<I18nProvider language="zh-CN"><ComputerHistoryPermissionsDialog client={client} onClose={closed} /></I18nProvider>); }); }
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text)!; }
async function click(element: HTMLElement) { await act(async () => { element.click(); }); }
async function input(element: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
}
it("saves both axes together with domain normalization and the original revision", async () => {
  await render();
  await click(button("只排除这些软件"));
  await click(button("只包含这些软件"));
  expect(document.body.textContent).toContain("不会记录任何软件");
  await click(button("添加软件")); await click(document.querySelector(".ch-permissions__results button")!);
  await click(button("添加网站"));
  await input(document.querySelector('input[aria-label="添加网站"]')!, "https://BANK.com/account?secret=1");
  await click(document.querySelector('button[aria-label="保存网站"]')!);
  expect(document.body.textContent).toContain("bank.com");
  expect(document.body.textContent).not.toContain("secret=1");
  await click(button("完成"));
  expect(client.saveComputerHistoryObservationPermissions).toHaveBeenCalledWith({ revision: "revision-1", settings: { observation: {
    defaultApplicationBehavior: "do_not_observe", defaultURLBehavior: "observe",
    rules: [{ scope: "app", bundleID: "com.apple.Notes", behavior: "observe" }, { scope: "url", urlDomain: "bank.com", behavior: "do_not_observe" }],
  } } });
  expect(closed).toHaveBeenCalledOnce();
});
it("Cancel makes no policy writes; failed saves keep the draft open", async () => {
  await render();
  await click(button("取消"));
  expect(client.saveComputerHistoryObservationPermissions).not.toHaveBeenCalled();
  vi.mocked(client.saveComputerHistoryObservationPermissions).mockRejectedValue(new Error("409 Settings changed"));
  await click(button("完成"));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("409");
  expect(closed).toHaveBeenCalledOnce();
});
it("does not turn a failed settings load into an empty policy", async () => {
  vi.mocked(client.getComputerHistoryObservationPermissions).mockRejectedValue(new Error("invalid settings"));
  await render();
  expect(button("完成").disabled).toBe(true);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("invalid settings");
});
it("normalizes hosts and rejects ambiguous or invalid website inputs", () => {
  expect(normalizeWebsite("https://Sub.Example.com:443/path?q=1")).toBe("sub.example.com");
  expect(normalizeWebsite("example.com.")).toBe("example.com");
  expect(normalizeWebsite("https://例子.测试/")).toBe("xn--fsqu00a.xn--0zwm56d");
  for (const value of ["", "*.example.com", "http://user:pass@bank.com", "foo bar", "ftp://example.com", "example..com", "-example.com"]) expect(normalizeWebsite(value)).toBeNull();
});

it("Save includes an unfinished website entry and blocks invalid input", async () => {
  await render();
  await click(button("添加网站"));
  const field = document.querySelector<HTMLInputElement>('input[aria-label="添加网站"]')!;
  await input(field, "*.bank.com"); await click(button("完成"));
  expect(client.saveComputerHistoryObservationPermissions).not.toHaveBeenCalled();
  await input(field, "https://bank.com/private"); await click(button("完成"));
  expect(vi.mocked(client.saveComputerHistoryObservationPermissions).mock.calls[0][0].settings.observation.rules).toEqual([
    { scope: "url", urlDomain: "bank.com", behavior: "do_not_observe" },
  ]);
});
it("switching mode keeps selected identities and reverses their rules; remove deletes only that row", async () => {
  vi.mocked(client.getComputerHistoryObservationPermissions).mockResolvedValue({ revision: "old", settings: { observation: {
    defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [
      { scope: "url", urlDomain: "bank.com", behavior: "do_not_observe" },
      { scope: "url", urlDomain: "example.com", behavior: "do_not_observe" },
    ],
  } } });
  await render();
  await click(button("只排除这些网站"));
  await click(button("只包含这些网站"));
  await click(document.querySelector('button[aria-label="移除 example.com"]')!);
  await click(button("完成"));
  expect(vi.mocked(client.saveComputerHistoryObservationPermissions).mock.calls[0][0].settings.observation).toEqual({
    defaultApplicationBehavior: "observe", defaultURLBehavior: "do_not_observe", rules: [{ scope: "url", urlDomain: "bank.com", behavior: "observe" }],
  });
});

it("opens a checked mode menu, moves with arrows, and Escape dismisses only the menu", async () => {
  await render();
  const trigger = button("只排除这些软件");
  await click(trigger);
  expect(document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toBe("只排除这些软件");
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  expect(document.activeElement?.textContent).toBe("只包含这些软件");
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(closed).not.toHaveBeenCalled();
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(closed).toHaveBeenCalledOnce();
});
it("keeps app search in a dismissible popover and expands website editing only on request", async () => {
  await render();
  expect(document.querySelector('input[aria-label="添加网站"]')).toBeNull();
  await click(button("添加软件"));
  expect(document.activeElement?.getAttribute("aria-label")).toBe("搜索软件");
  await input(document.querySelector('input[aria-label="搜索软件"]')!, "no match");
  expect(document.body.textContent).toContain("没有匹配的软件");
  await act(async () => { document.querySelector('.ch-permissions__privacy')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
  expect(document.querySelector('.ch-permissions__picker')).toBeNull();
  await click(button("添加网站"));
  const field = document.querySelector<HTMLInputElement>('input[aria-label="添加网站"]')!;
  await input(field, "unfinished.com");
  await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(document.querySelector('input[aria-label="添加网站"]')).toBeNull();
  expect(document.activeElement).toBe(button("添加网站"));
  expect(closed).not.toHaveBeenCalled();
});

it("reselecting the checked mode preserves preexisting mixed rules", async () => {
  const mixed = { revision: "custom", settings: { observation: {
    defaultApplicationBehavior: "observe" as const, defaultURLBehavior: "observe" as const,
    rules: [{ scope: "url" as const, urlDomain: "example.com", behavior: "observe" as const }],
  } } };
  vi.mocked(client.getComputerHistoryObservationPermissions).mockResolvedValue(mixed);
  await render();
  await click(button("只排除这些网站"));
  await click(document.querySelector('[role="menuitemradio"][aria-checked="true"]')!);
  await click(button("完成"));
  expect(client.saveComputerHistoryObservationPermissions).toHaveBeenCalledWith(mixed);
});
