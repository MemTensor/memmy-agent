// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { InstalledPluginSchema, type PluginCapabilityEventPayload } from "@memmy/local-api-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { reducePluginUiCalls, type PluginUiCall } from "../../app/plugin-ui-context.js";
import { buildRendererDocument, PluginCapabilityHost, resolveRendererInteractionStates, resolveSafeArtifactUri } from "../plugin-capability-host.js";

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

  it("blocks stale submissions and allows the renderer to request a refresh", async () => {
    const getUi = vi.fn(async () => "<main>Custom renderer</main>");
    const cancel = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const customPlugin = InstalledPluginSchema.parse({
      ...plugin,
      manifest: { ...plugin.manifest, ui: { renderer: { entry: "ui/index.html", height: 240 } } }
    });
    const calls: PluginUiCall[] = [
      {
        pluginId: plugin.id,
        capabilityId: "run",
        callId: "stale-call",
        conversationId: "chat-1",
        events: [{
          type: "interaction",
          request: {
            interactionId: "stale-1",
            type: "custom",
            payload: {
              taskId: "review-1",
              baseArtifact: { id: "outline-old", kind: "outline", contentHash: "sha256:outline" },
              artifactSnapshot: [{ kind: "review-spec", contentHash: "sha256:old" }]
            }
          }
        }]
      },
      {
        pluginId: plugin.id,
        capabilityId: "run",
        callId: "update-call",
        conversationId: "chat-1",
        events: [{
          type: "result",
          output: {
            taskId: "review-1",
            artifacts: [{ id: "spec-new", kind: "review-spec", contentHash: "sha256:new", stale: false }]
          }
        }]
      }
    ];

    await act(async () => root.render(
      <I18nProvider language="en-US">
        <PluginCapabilityHost calls={calls} plugins={[customPlugin]} client={{ getUi, cancel, respond }} />
      </I18nProvider>
    ));
    await act(async () => Promise.resolve());

    const iframe = container.querySelectorAll("iframe")[0]!;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    await act(async () => window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: {
        type: "memmy.plugin.interaction-response",
        version: 1,
        interactionId: "stale-1",
        response: { action: "submit", baseArtifactHash: "sha256:old", values: {} }
      }
    })));
    expect(respond).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "memmy.plugin.response-result",
      ok: false,
      error: expect.objectContaining({ code: "stale_card", latestContentHash: "sha256:new" })
    }), "*");

    await act(async () => window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: {
        type: "memmy.plugin.interaction-response",
        version: 1,
        interactionId: "stale-1",
        response: { action: "refresh", baseArtifactHash: "sha256:old", values: { outline: [] } }
      }
    })));
    expect(respond).toHaveBeenCalledWith(plugin.id, "stale-call", "stale-1", expect.objectContaining({ action: "refresh" }));
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
        {
          type: "interaction",
          request: {
            interactionId: "files-1",
            type: "file-input",
            payload: {
              title: "Sources",
              accept: [".pdf", ".doc"],
              maxFiles: 2,
              multiple: true,
              fileRules: [{
                extensions: [".doc"],
                disposition: "blocked",
                code: "legacy_doc_requires_conversion",
                message: "Save this legacy .doc file as .docx before importing."
              }]
            }
          }
        },
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
    Object.defineProperty(fileInput, "files", { value: [
      new File(["pdf"], "source.pdf", { type: "application/pdf" }),
      new File(["doc"], "legacy.doc", { type: "application/msword" })
    ] });
    await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    expect(container.textContent).toContain("source.pdf");
    expect(container.textContent).toContain("legacy.doc");
    expect(container.textContent).toContain("1 ready to import, 1 need attention");
    expect(container.textContent).toContain("Save this legacy .doc file as .docx before importing.");
    await act(async () => buttons().find((button) => button.textContent === "Upload")?.click());
    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(uploadFiles.mock.calls[0]?.[0]).toHaveLength(1);
    expect(uploadFiles.mock.calls[0]?.[0]?.[0]?.name).toBe("source.pdf");
    expect(respond).toHaveBeenCalledWith(plugin.id, "call-3", "files-1", { files: expect.any(Array) });

    await act(async () => buttons().find((button) => button.textContent === "Add to chat")?.click());
    expect(onAddArtifact).toHaveBeenCalledWith(call.events[3]!.type === "artifact" ? call.events[3]!.artifact : null);
  });

  it("allows an optional file-input interaction to be skipped without uploading", async () => {
    const respond = vi.fn(async () => undefined);
    const uploadFiles = vi.fn(async () => []);
    const call: PluginUiCall = {
      pluginId: plugin.id,
      capabilityId: "run",
      callId: "optional-files",
      conversationId: "chat-optional-files",
      events: [{
        type: "interaction",
        request: {
          interactionId: "optional-files-interaction",
          type: "file-input",
          payload: { title: "Optional sources", multiple: true }
        }
      }]
    };

    await act(async () => root.render(
      <I18nProvider language="en-US">
        <PluginCapabilityHost
          calls={[call]}
          plugins={[plugin]}
          client={{ getUi: vi.fn(), cancel: vi.fn(), respond }}
          uploadFiles={uploadFiles}
        />
      </I18nProvider>
    ));

    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Skip")?.click());
    expect(uploadFiles).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(plugin.id, "optional-files", "optional-files-interaction", { files: [] });
  });

  it.skipIf(!process.env.LITERATURE_REVIEW_PLUGIN_ROOT)("mounts every literature-review card through the real plugin UI bundle", async () => {
    const pluginRoot = process.env.LITERATURE_REVIEW_PLUGIN_ROOT!;
    const rendererHtml = readFileSync(path.join(pluginRoot, "ui/bundles/review-cards/index.html"), "utf8");
    const getUi = vi.fn(async () => rendererHtml);
    const cancel = vi.fn(async () => undefined);
    const respond = vi.fn(async () => undefined);
    const uploadFiles = vi.fn(async () => [{
      path: "/media/local-source.pdf",
      url: "http://agent.test/local-source.pdf",
      name: "local-source.pdf",
      kind: "file" as const,
      mime: "application/pdf" as const,
      bytes: 3
    }]);
    const literatureReviewPlugin = InstalledPluginSchema.parse({
      ...plugin,
      id: "literature-review",
      manifest: {
        ...plugin.manifest,
        id: "literature-review",
        ui: { renderer: { entry: "ui/bundles/review-cards/index.html", height: 680 } }
      }
    });
    const customCardTypes = ["review-spec", "keywords", "outline", "paper-selection", "fulltext-recovery"];
    const calls: PluginUiCall[] = customCardTypes.map((cardType, index) => ({
      pluginId: literatureReviewPlugin.id,
      capabilityId: "review_request_interaction",
      callId: `custom-${index}`,
      conversationId: "chat-card-flow",
      events: [{
        type: "interaction",
        request: {
          interactionId: `interaction-${index}`,
          type: "custom",
          payload: { cardType, taskId: "review-card-flow", title: cardType, data: {} }
        }
      }]
    }));
    calls.push({
      pluginId: literatureReviewPlugin.id,
      capabilityId: "review_request_interaction",
      callId: "source-import",
      conversationId: "chat-card-flow",
      events: [{
        type: "interaction",
        request: {
          interactionId: "source-import-interaction",
          type: "file-input",
          payload: {
            title: "添加本地参考文献",
            accept: [".pdf", ".docx", ".txt", ".md", ".doc"],
            multiple: true,
            fileRules: [{
              extensions: [".doc"],
              disposition: "blocked",
              code: "legacy_doc_requires_conversion",
              message: "暂不支持旧版 .doc，请另存为 .docx 后重新选择。"
            }]
          }
        }
      }]
    });

    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <PluginCapabilityHost
          calls={calls}
          plugins={[literatureReviewPlugin]}
          client={{ getUi, cancel, respond }}
          uploadFiles={uploadFiles}
        />
      </I18nProvider>
    ));
    await act(async () => Promise.resolve());

    const iframes = Array.from(container.querySelectorAll("iframe"));
    expect(iframes).toHaveLength(customCardTypes.length);
    expect(getUi).toHaveBeenCalledTimes(customCardTypes.length);
    for (const iframe of iframes) {
      expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
      expect(iframe.getAttribute("srcdoc")).toContain("CARD_NAMES");
      expect(iframe.getAttribute("srcdoc")).toContain("Content-Security-Policy");
    }

    for (const [index, iframe] of iframes.entries()) {
      await act(async () => window.dispatchEvent(new MessageEvent("message", {
        source: iframe.contentWindow,
        data: {
          type: "memmy.plugin.interaction-response",
          version: 1,
          interactionId: `interaction-${index}`,
          response: { action: "submit", values: { cardType: customCardTypes[index] } }
        }
      })));
    }
    expect(respond).toHaveBeenCalledTimes(customCardTypes.length);

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileInput, "files", { value: [new File(["pdf"], "local-source.pdf", { type: "application/pdf" })] });
    await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "上传")?.click());
    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      literatureReviewPlugin.id,
      "source-import",
      "source-import-interaction",
      { files: expect.any(Array) }
    );
  });
});

describe("plugin UI event reduction", () => {
  it("marks an interaction stale when a newer task artifact is observed", () => {
    const calls: PluginUiCall[] = [
      {
        pluginId: plugin.id,
        capabilityId: "review_request_interaction",
        callId: "card-call",
        conversationId: "chat-1",
        events: [{
          type: "interaction",
          request: {
            interactionId: "outline-card",
            type: "custom",
            payload: {
              taskId: "review-1",
              baseArtifact: { id: "outline-old", kind: "outline", contentHash: "sha256:old" }
            }
          }
        }]
      },
      {
        pluginId: plugin.id,
        capabilityId: "review_update_outline",
        callId: "update-call",
        conversationId: "chat-1",
        events: [{
          type: "result",
          output: {
            taskId: "review-1",
            artifacts: [{ id: "outline-new", kind: "outline", contentHash: "sha256:new", stale: false }]
          }
        }]
      }
    ];

    expect(resolveRendererInteractionStates(calls).get(plugin.id + ":card-call")).toEqual([{
      interactionId: "outline-card",
      status: "stale",
      error: {
        code: "stale_card",
        message: expect.any(String),
        latestContentHash: "sha256:new"
      }
    }]);
  });

  it("resolves Host-managed relative artifact URIs and rejects local file URIs", () => {
    expect(resolveSafeArtifactUri("/api/v1/plugins/review/artifacts/token/preview")).toBe(
      `${window.location.origin}/api/v1/plugins/review/artifacts/token/preview`
    );
    expect(resolveSafeArtifactUri("file:///tmp/review.pdf")).toBeNull();
  });

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
