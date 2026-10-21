// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { WindowsHistorySettings } from "../memory/windows-history-settings.js";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { WindowsHistoryConfigurationSchema, type WindowsHistoryConfiguration } from "../../api/computer-history-contract.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
function configuration(): WindowsHistoryConfiguration {
  return WindowsHistoryConfigurationSchema.parse({
    settings: { version: 1, applications: [] },
    permissions: { supported: true, platform: "windows", ready: false, accessibility: false, inputMonitoring: false, reason: "authorization_required" },
    applications: [
      { id: "windows:fixture", name: "Fixture.exe", executable: "C:\\Apps\\Fixture.exe", allowed: false, supported: true, running: true },
      { id: "windows:browser", name: "chrome.exe", executable: "C:\\Apps\\chrome.exe", allowed: false, supported: false, running: true },
    ],
  });
}
async function render(config = configuration(), start?: () => Promise<void>) {
  const onClose = vi.fn(); const onSaved = vi.fn();
  const ready = { ...config, permissions: { ...config.permissions, ready: true, reason: "ready" as const } };
  const client = { getWindowsHistoryConfiguration: vi.fn().mockResolvedValue(config), updateWindowsHistorySettings: vi.fn().mockResolvedValue(ready) };
  await act(async () => { root.render(<I18nProvider language="en-US"><WindowsHistorySettings client={client as unknown as MemmyAgentClient} onClose={onClose} onSaved={onSaved} onStart={start} /></I18nProvider>); });
  return { client, onClose, onSaved };
}
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label)!;

describe("Windows application scope", () => {
  it("searches friendly names and paths while preserving hidden selections and selectors on save", async () => {
    const config = configuration();
    const rule = { executable: "C:\\Apps\\Fixture.exe", searchFields: [{ controlType: "Edit" as const, automationId: "search" }] };
    config.settings.applications = [rule];
    Object.assign(config.applications[0]!, { name: "中文编辑器", allowed: true, rule });
    const { client } = await render(config);
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    const searchFor = async (text: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, text);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await searchFor("中文");
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(document.body.textContent).toContain("中文编辑器");
    await searchFor("APPS\\chrome");
    expect(document.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(document.body.textContent).not.toContain("中文编辑器");
    await searchFor("no matches");
    expect(document.body.textContent).toContain("No matching applications.");
    await act(async () => { button("Save selection").click(); });
    expect(client.updateWindowsHistorySettings).toHaveBeenCalledExactlyOnceWith({ version: 1, applications: [rule] });
  });
  it("does not select discovered applications and prevents selecting unsupported browsers", async () => {
    const { client, onClose } = await render();
    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(inputs[0]!.checked).toBe(false); expect(inputs[1]!.checked).toBe(false); expect(inputs[1]!.disabled).toBe(true);
    expect(document.body.textContent).toContain("C:\\Apps\\Fixture.exe");
    expect(document.body.textContent).not.toContain("Accessibility");
    await act(async () => { inputs[0]!.click(); });
    await act(async () => { button("Save selection").click(); });
    expect(client.updateWindowsHistorySettings).toHaveBeenCalledExactlyOnceWith({ version: 1, applications: [{ executable: "C:\\Apps\\Fixture.exe" }] });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("preserves advanced selectors and invokes start only after saving explicit consent", async () => {
    const config = configuration();
    const rule = { executable: "C:\\Apps\\Fixture.exe", searchFields: [{ controlType: "Edit" as const, automationId: "search" }], sensitiveAutomationIds: ["private"] };
    config.settings.applications = [rule]; config.applications[0]!.allowed = true; config.applications[0]!.rule = rule;
    config.applications[0]!.executable = "C:\\APPS\\FIXTURE.EXE";
    const start = vi.fn().mockResolvedValue(undefined);
    const { client, onSaved, onClose } = await render(config, start);
    await act(async () => { button("Save and start recording").click(); });
    expect(client.updateWindowsHistorySettings).toHaveBeenCalledExactlyOnceWith({ ...config.settings, applications: [rule] });
    expect(onSaved.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]!);
    expect(start.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]!);
  });
  it("keeps the picker open and reports unavailable applications instead of claiming recording started", async () => {
    const config = configuration(); config.applications[0]!.allowed = true;
    const start = vi.fn().mockResolvedValue(undefined);
    const { client, onClose } = await render(config, start);
    client.updateWindowsHistorySettings.mockResolvedValue({ ...config, permissions: { ...config.permissions, reason: "no_running_authorized_application" } });
    await act(async () => { button("Save and start recording").click(); });
    expect(start).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Open");
  });
  it("uses broad mode as exclusions and saves an excluded app without requiring an allowlist", async () => {
    const config = configuration();
    config.settings.defaultApplicationBehavior = "observe";
    config.permissions.ready = true;
    config.permissions.reason = "ready";
    config.applications[0]!.allowed = true;
    const { client } = await render(config);
    expect(document.querySelector<HTMLSelectElement>("select")?.value).toBe("observe");
    await act(async () => { document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    await act(async () => { button("Save selection").click(); });
    expect(client.updateWindowsHistorySettings).toHaveBeenCalledExactlyOnceWith({ version: 1, defaultApplicationBehavior: "observe",
      applications: [], deny: { executables: ["C:\\Apps\\Fixture.exe"] } });
  });
  it("does not re-enable an excluded custom rule when switching to selected-only mode", async () => {
    const config = configuration();
    const rule = { executable: "C:\\Apps\\Fixture.exe", searchFields: [{ controlType: "Edit" as const, automationId: "search" }] };
    config.settings = { version: 1, defaultApplicationBehavior: "observe", applications: [rule], deny: { executables: [rule.executable] } };
    config.applications[0]!.rule = rule;
    const { client } = await render(config);
    await act(async () => {
      const select = document.querySelector<HTMLSelectElement>("select")!;
      select.value = "do_not_observe";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
    await act(async () => { button("Save selection").click(); });
    expect(client.updateWindowsHistorySettings).toHaveBeenCalledExactlyOnceWith({ ...config.settings,
      defaultApplicationBehavior: "do_not_observe", applications: [] });
  });
});
