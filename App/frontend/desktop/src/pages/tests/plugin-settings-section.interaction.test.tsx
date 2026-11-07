// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InstalledPluginSchema } from "@memmy/local-api-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginsClient } from "../../api/plugins-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginSettingsSection } from "../plugin-settings-section.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plugin = InstalledPluginSchema.parse({
  id: "literature-review",
  version: "0.2.0",
  manifest: {
    apiVersion: "memmy/v1",
    id: "literature-review",
    name: "Literature Review",
    version: "0.2.0",
    runtime: { adapter: "command", config: { command: "runtime/command.js" } },
    capabilities: [{ id: "run", name: "Run", description: "Run", inputSchema: { type: "object" }, outputSchema: { type: "object" }, execution: "job" }],
    permissions: [
      { type: "network", hosts: ["export.arxiv.org", "arxiv.org"] },
      { type: "host-service", services: ["file-input", "plugin-data", "artifact-host"] }
    ]
  },
  state: "pending_approval",
  approvedPermissions: [],
  config: {},
  lastError: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z"
});

describe("PluginSettingsSection", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("shows exact requested hosts and approves permissions before enabling", async () => {
    const approvePermissions = vi.fn(async () => ({ ...plugin, state: "disabled" as const, approvedPermissions: plugin.manifest.permissions }));
    const enable = vi.fn(async () => ({ ...plugin, state: "active" as const, approvedPermissions: plugin.manifest.permissions }));
    const client = {
      list: vi.fn(async () => [plugin]), approvePermissions, enable,
      install: vi.fn(), disable: vi.fn(), uninstall: vi.fn(), getUi: vi.fn(), invoke: vi.fn(), cancel: vi.fn(), respond: vi.fn()
    } as unknown as PluginsClient;

    await act(async () => root.render(<I18nProvider language="zh-CN"><PluginSettingsSection client={client} /></I18nProvider>));
    await act(async () => Promise.resolve());

    expect(container.textContent).toContain("export.arxiv.org, arxiv.org");
    expect(container.textContent).not.toContain("crossref");
    const approve = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "批准权限并启用");
    await act(async () => approve?.click());
    expect(approvePermissions).toHaveBeenCalledWith(plugin.id, plugin.manifest.permissions);
    expect(enable).toHaveBeenCalledWith(plugin.id);
  });
});
