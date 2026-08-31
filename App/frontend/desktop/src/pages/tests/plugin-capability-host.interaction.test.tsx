// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InstalledPluginSchema, type PluginCapabilityEventPayload } from "@memmy/local-api-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { reducePluginUiCalls, type PluginUiCall } from "../../app/plugin-ui-context.js";
import { buildRendererDocument, PluginCapabilityHost } from "../plugin-capability-host.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plugin = InstalledPluginSchema.parse({
  id: "com.example.review",
  version: "1.0.0",
  manifest: {
    apiVersion: "memmy/v1",
    id: "com.example.review",
    name: "Review",
    version: "1.0.0",
    runtime: { adapter: "http" },
    capabilities: [{
      id: "run",
      name: "Run",
      description: "Run",
      inputSchema: {},
      outputSchema: {},
      execution: "job"
    }],
    permissions: []
  },
  state: "active",
  approvedPermissions: [],
  config: {},
  lastError: null,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z"
});

describe("PluginCapabilityHost", () => {
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
    vi.restoreAllMocks();
  });

  it("renders generic task, question, and artifact cards and submits a choice", async () => {
    const respond = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const call: PluginUiCall = {
      pluginId: plugin.id,
      capabilityId: "run",
      callId: "call-1",
      conversationId: "chat-1",
      events: [
        { type: "task-list", tasks: [{ id: "search", title: "Search papers", status: "running" }] },
        { type: "interaction", request: { interactionId: "q-1", type: "question", payload: { title: "Scope", options: ["Broad", "Focused"] } } },
        { type: "artifact", artifact: { id: "report", name: "report.md", mediaType: "text/markdown", uri: "https://example.test/report.md" } }
      ]
    };

    await act(async () => root.render(
      <I18nProvider language="en-US">
        <PluginCapabilityHost calls={[call]} plugins={[plugin]} client={{ getUi: vi.fn(), cancel, respond }} />
      </I18nProvider>
    ));

    expect(container.textContent).toContain("Search papers");
    expect(container.textContent).toContain("Scope");
    expect(container.textContent).toContain("report.md");
    await act(async () => container.querySelectorAll("button")[0]?.click());
    expect(respond).toHaveBeenCalledWith(plugin.id, "call-1", "q-1", "Broad");
    expect(container.textContent).toContain("Submitted");
  });

  it("loads a declared renderer into a script-only sandbox", async () => {
    const getUi = vi.fn(async () => "<main>Custom renderer</main>");
    const cancel = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const customPlugin = InstalledPluginSchema.parse({
      ...plugin,
      manifest: { ...plugin.manifest, ui: { renderer: { entry: "ui/index.html", height: 240 } } }
    });
    const call: PluginUiCall = {
      pluginId: plugin.id,
      capabilityId: "run",
      callId: "call-2",
      conversationId: "chat-1",
      events: [{ type: "interaction", request: { interactionId: "custom-1", type: "custom", payload: {} } }]
    };

    await act(async () => root.render(
      <I18nProvider language="en-US">
        <PluginCapabilityHost calls={[call]} plugins={[customPlugin]} client={{ getUi, cancel, respond }} />
      </I18nProvider>
    ));
    await act(async () => Promise.resolve());

    const iframe = container.querySelector("iframe")!;
    expect(getUi).toHaveBeenCalledWith(plugin.id, "renderer");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    expect(iframe.style.height).toBe("240px");
    await act(async () => window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { type: "memmy.plugin.interaction-response", version: 1, interactionId: "custom-1", response: { choice: "yes" } }
    })));
    expect(respond).toHaveBeenCalledWith(plugin.id, "call-2", "custom-1", { choice: "yes" });
  });

  it("supports cancellation, multiple choice, file upload, and artifact reuse", async () => {
    const cancel = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const uploadFiles = vi.fn(async () => [{
      path: "/media/source.pdf",
      url: "http://agent.test/source.pdf",
      name: "source.pdf",
      kind: "file" as const,
      mime: "application/pdf" as const,
      bytes: 3
    }]);
    const onAddArtifact = vi.fn();
    const call: PluginUiCall = {
      pluginId: plugin.id,
      capabilityId: "run",
      callId: "call-3",
      conversationId: "chat-1",
      events: [
        { type: "progress", current: 1, total: 2, cancellable: true },
        { type: "interaction", request: { interactionId: "q-2", type: "question", payload: { title: "Sources", multiple: true, options: ["PubMed", "Crossref"] } } },
        { type: "interaction", request: { interactionId: "files-1", type: "file-input", payload: { title: "Sources", accept: [".pdf"], maxFiles: 2 } } },
        { type: "artifact", artifact: { id: "report", name: "report.md", mediaType: "text/markdown", uri: "https://example.test/report.md" } }
      ]
    };

    await act(async () => root.render(
      <I18nProvider language="en-US">
        <PluginCapabilityHost
          calls={[call]}
          plugins={[plugin]}
          client={{ getUi: vi.fn(), cancel, respond }}
          uploadFiles={uploadFiles}
          onAddArtifact={onAddArtifact}
        />
      </I18nProvider>
    ));

    const buttons = () => Array.from(container.querySelectorAll("button"));
    await act(async () => buttons().find((button) => button.textContent === "Cancel")?.click());
    expect(cancel).toHaveBeenCalledWith(plugin.id, "call-3");

    const choices = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => choices[0]?.click());
    await act(async () => buttons().find((button) => button.textContent === "Submit")?.click());
    expect(respond).toHaveBeenCalledWith(plugin.id, "call-3", "q-2", ["PubMed"]);

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileInput, "files", { value: [new File(["pdf"], "source.pdf", { type: "application/pdf" })] });
    await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => buttons().find((button) => button.textContent === "Upload")?.click());
    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(plugin.id, "call-3", "files-1", { files: expect.any(Array) });

    await act(async () => buttons().find((button) => button.textContent === "Add to chat")?.click());
    expect(onAddArtifact).toHaveBeenCalledWith(call.events[3]!.type === "artifact" ? call.events[3]!.artifact : null);
  });
});

describe("plugin UI event reduction", () => {
  it("replaces transient events and keeps distinct cards", () => {
    const base = {
      pluginId: plugin.id,
      capabilityId: "run",
      callId: "call-1",
      conversationId: "chat-1"
    };
    const receive = (calls: PluginUiCall[], event: PluginCapabilityEventPayload["event"]) => (
      reducePluginUiCalls(calls, { ...base, event })
    );
    let calls = receive([], { type: "progress", current: 1, total: 2 });
    calls = receive(calls, { type: "progress", current: 2, total: 2 });
    calls = receive(calls, { type: "artifact", artifact: { id: "report", name: "report.md", mediaType: "text/markdown", uri: "file:///report.md" } });

    expect(calls[0]?.events).toEqual([
      { type: "progress", current: 2, total: 2 },
      { type: "artifact", artifact: { id: "report", name: "report.md", mediaType: "text/markdown", uri: "file:///report.md" } }
    ]);
  });

  it("injects a restrictive CSP into renderer HTML", () => {
    const document = buildRendererDocument("<html><head><title>x</title></head><body>x</body></html>");
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("form-action 'none'");
  });
});
