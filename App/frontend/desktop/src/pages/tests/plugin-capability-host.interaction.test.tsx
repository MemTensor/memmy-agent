// @vitest-environment happy-dom

import { Window as TestWindow } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { InstalledPluginSchema, type PluginCapabilityEventPayload } from "@memmy/local-api-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadedAgentMedia } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginUiProvider, usePluginUi, reducePluginUiCalls, type PluginUiCall } from "../../app/plugin-ui-context.js";
import { buildRendererDocument, PluginCapabilityHost, resolveRendererInteractionStates, resolveSafeArtifactUri, selectVisiblePluginCalls } from "../plugin-capability-host.js";

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

  it("routes accepted chat feedback only to its live card and retires the old interaction", async () => {
    const customPlugin = InstalledPluginSchema.parse({ ...plugin, manifest: { ...plugin.manifest, ui: { renderer: { entry: "ui/index.html", height: 680 } } } });
    const respond = vi.fn(async () => undefined);
    const client = { getUi: vi.fn(async () => "<main>Outline</main>"), cancel: vi.fn(), respond };
    let ui: ReturnType<typeof usePluginUi>;
    function Sender() { ui = usePluginUi(); return null; }
    const call: PluginUiCall = { pluginId: plugin.id, capabilityId: "run", callId: "outline-feedback", conversationId: "websocket:chat-1", events: [
      { type: "interaction", request: { interactionId: "outline-1", type: "custom", payload: { chatFeedback: true } } }
    ] };
    await act(async () => root.render(<PluginUiProvider><Sender /><I18nProvider language="en-US"><PluginCapabilityHost calls={[call]} plugins={[customPlugin]} client={client} /></I18nProvider></PluginUiProvider>));
    const iframe = container.querySelector("iframe")!;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    await act(async () => ui!.notifyChatMessage("chat-2", { message: "Unrelated", clientRequestId: "other" }));
    expect(postMessage).not.toHaveBeenCalled();
    await act(async () => ui!.notifyChatMessage("chat-1", { message: "Revise outline", clientRequestId: "feedback" }));
    expect(postMessage).toHaveBeenCalledWith({ type: "memmy.plugin.chat-feedback", version: 1, interactionId: "outline-1", message: "Revise outline", clientRequestId: "feedback" }, "*");
    const response = { action: "chat-feedback", message: "Revise outline", values: { outline: [{ title: "User edit" }] } };
    await act(async () => window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, data: { type: "memmy.plugin.interaction-response", version: 1, interactionId: "outline-1", response } })));
    expect(respond).toHaveBeenCalledWith(plugin.id, call.callId, "outline-1", response);
    expect(container.querySelector("iframe")).toBeNull();
    await act(async () => ui!.notifyChatMessage("chat-1", { message: "Another change", clientRequestId: "next" }));
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("retains unuploaded file selections across chat feedback without importing them", async () => {
    let ui: ReturnType<typeof usePluginUi>;
    function Sender() { ui = usePluginUi(); return null; }
    const respond = vi.fn(async () => undefined);
    const uploadFiles = vi.fn();
    const client = { getUi: vi.fn(), cancel: vi.fn(), respond };
    const makeCall = (id: string): PluginUiCall => ({ pluginId: plugin.id, capabilityId: "run", callId: id, conversationId: "websocket:chat-1", events: [
      { type: "interaction", request: { interactionId: id, type: "file-input", payload: { chatFeedback: true, taskId: "task-1", cardType: "source-import", accept: [".pdf"] } } }
    ] });
    const mount = (id: string) => root.render(<PluginUiProvider><Sender /><I18nProvider language="en-US"><PluginCapabilityHost calls={[makeCall(id)]} plugins={[plugin]} client={client} uploadFiles={uploadFiles} /></I18nProvider></PluginUiProvider>);
    await act(async () => mount("files-1"));
    const picker = container.querySelector('input[type="file"]')!;
    Object.defineProperty(picker, "files", { value: [new File(["test"], "selected.pdf", { type: "application/pdf" })] });
    await act(async () => picker.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => ui!.notifyChatMessage("chat-1", { message: "Is this format supported?", clientRequestId: "feedback" }));
    expect(uploadFiles).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(plugin.id, "files-1", "files-1", expect.objectContaining({ action: "chat-feedback", files: [], values: { selectedFileNames: ["selected.pdf"] } }));
    await act(async () => mount("files-2"));
    expect(container.textContent).toContain("selected.pdf");
    let finishUpload!: (files: UploadedAgentMedia[]) => void;
    uploadFiles.mockImplementation(() => new Promise<UploadedAgentMedia[]>((resolve) => { finishUpload = resolve; }));
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Upload")?.click());
    await act(async () => ui!.notifyChatMessage("chat-1", { message: "Wait, check this file", clientRequestId: "during-file-upload" }));
    expect(respond).toHaveBeenCalledTimes(1);
    await act(async () => finishUpload([{ path: "/staged/selected.pdf", name: "selected.pdf", kind: "file", mime: "application/pdf", bytes: 4, url: "http://localhost/file" }]));
    expect(respond).toHaveBeenLastCalledWith(plugin.id, "files-2", "files-2", expect.objectContaining({ action: "chat-feedback", files: [], message: "Wait, check this file" }));
    await act(async () => mount("files-3"));
    expect(container.textContent).toContain("selected.pdf");
  });

  it.skipIf(!process.env.LITERATURE_REVIEW_PLUGIN_ROOT)("renders the exact 7/20 proposal and returns in-card edits with chat feedback", async () => {
    const window = new TestWindow({ settings: { enableJavaScriptEvaluation: true } });
    try {
      const outgoing: any[] = [];
      vi.spyOn(window, "postMessage").mockImplementation((message) => { outgoing.push(message); });
      const html = readFileSync(path.join(process.env.LITERATURE_REVIEW_PLUGIN_ROOT!, "ui/bundles/review-cards/index.html"), "utf8");
      window.document.write(html.replace(/<script>[\s\S]*?<\/script>/, ""));
      window.eval(html.match(/<script>([\s\S]*?)<\/script>/)![1]!);
      const send = (data: any) => window.eval(`window.dispatchEvent(new MessageEvent("message", { source: parent, data: ${JSON.stringify(data)} }))`);
      const original = Array.from({ length: 6 }, (_, i) => ({ id: `old-${i}`, title: `Old ${i}`, children: [] }));
      const proposal = Array.from({ length: 7 }, (_, i) => ({ id: `new-${i}`, title: `New ${i}`, children: Array.from({ length: i === 0 ? 2 : 3 }, (_, j) => ({ id: `new-${i}-${j}`, title: `Child ${i}-${j}` })) }));
      send({ type: "memmy.plugin.render", version: 1, events: [{ type: "interaction", request: { interactionId: "outline-1", type: "custom", payload: { cardType: "outline", chatFeedback: true, data: { outline: original }, draftValues: { outline: proposal } } } }] });
      const titles = Array.from(window.document.querySelectorAll('input')).map((input: any) => input.value);
      expect(titles.filter((value) => value.startsWith("New "))).toHaveLength(7);
      expect(titles.filter((value) => value.startsWith("Child "))).toHaveLength(20);
      expect(titles.some((value) => value.startsWith("Old "))).toBe(false);
      const first = window.document.querySelector("input")!;
      first.value = "Edited by the user";
      first.dispatchEvent(new window.Event("input"));
      send({ type: "memmy.plugin.chat-feedback", version: 1, interactionId: "wrong-card", message: "wrong" });
      expect(outgoing.filter((message) => message.type === "memmy.plugin.interaction-response")).toHaveLength(0);
      send({ type: "memmy.plugin.chat-feedback", version: 1, interactionId: "outline-1", message: "Please explain", clientRequestId: "message-1" });
      const response = outgoing.find((message) => message.type === "memmy.plugin.interaction-response").response;
      expect(response.action).toBe("chat-feedback");
      expect(response.values.outline[0].title).toBe("Edited by the user");
      expect(response.values.outline).toHaveLength(7);
    } finally { await window.happyDOM.close(); }
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
    expect(container.textContent).not.toContain("Scope");
    expect(container.textContent).toContain("report.md");
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

  it("uploads files inside a permitted custom card and keeps it mounted between row updates", async () => {
    const permission = { type: "host-service", services: ["file-input"] };
    const customPlugin = InstalledPluginSchema.parse({ ...plugin,
      approvedPermissions: [permission], manifest: { ...plugin.manifest, permissions: [permission], ui: { renderer: { entry: "ui/index.html", height: 680 } } }
    });
    const respond = vi.fn(async () => undefined);
    const uploadFiles = vi.fn(async () => [{ path: "/staged/paper.pdf", name: "paper.pdf", kind: "file", mime: "application/pdf" }] as UploadedAgentMedia[]);
    const client = { getUi: vi.fn(async () => "<main>Recovery</main>"), cancel: vi.fn(), respond };
    const call: PluginUiCall = { pluginId: plugin.id, capabilityId: "run", callId: "recovery", conversationId: "chat-1",
      events: [{ type: "interaction", request: { interactionId: "row-1", type: "custom", payload: {
        fileUpload: { accept: [".pdf"], maxFiles: 1, maxBytes: 1024 }
      } } }] };
    await act(async () => root.render(<I18nProvider language="en-US"><PluginCapabilityHost calls={[call]} plugins={[customPlugin]} client={client} uploadFiles={uploadFiles} /></I18nProvider>));
    const iframe = container.querySelector("iframe")!;
    const postMessage = vi.spyOn(iframe.contentWindow!, "postMessage");
    const file = new File(["synthetic pdf"], "paper.pdf", { type: "application/pdf" });
    const upload = { type: "memmy.plugin.upload-files", version: 1, interactionId: "row-1", requestId: "file-1", files: [file] };
    await act(async () => window.dispatchEvent(new MessageEvent("message", { source: window, data: upload })));
    expect(uploadFiles).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, data: upload })));
    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "memmy.plugin.upload-result", ok: true, requestId: "file-1" }), "*");
    await act(async () => window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, data: {
      ...upload, requestId: "bad-file", files: [new File(["x"], "bad.exe")]
    } })));
    expect(uploadFiles).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "memmy.plugin.upload-result", ok: false, requestId: "bad-file" }), "*");
    await act(async () => window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, data: {
      type: "memmy.plugin.interaction-response", version: 1, interactionId: "row-1",
      response: { action: "refresh", values: { intent: "import-fulltext", paperId: "p1", files: [{ path: "/staged/paper.pdf" }] } }
    } })));
    expect(respond).toHaveBeenCalledTimes(1);
    expect(container.querySelector("iframe")).toBe(iframe);
    await act(async () => window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, data: upload })));
    expect(uploadFiles).toHaveBeenCalledTimes(1); // Old interaction cannot upload again.
    const nextCall: PluginUiCall = { ...call, events: [...call.events, { type: "interaction", request: {
      interactionId: "row-2", type: "custom", payload: { fileUpload: { accept: [".pdf"], maxFiles: 1, maxBytes: 1024 } }
    } }] };
    await act(async () => root.render(<I18nProvider language="en-US"><PluginCapabilityHost calls={[nextCall]} plugins={[customPlugin]} client={client} uploadFiles={uploadFiles} /></I18nProvider>));
    expect(container.querySelector("iframe")).toBe(iframe);
    await act(async () => window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, data: { ...upload, interactionId: "row-2", requestId: "file-2" } })));
    expect(uploadFiles).toHaveBeenCalledTimes(2);
    const unpermitted = InstalledPluginSchema.parse({ ...customPlugin, approvedPermissions: [] });
    await act(async () => root.render(<I18nProvider language="en-US"><PluginCapabilityHost calls={[nextCall]} plugins={[unpermitted]} client={client} uploadFiles={uploadFiles} /></I18nProvider>));
    await act(async () => window.dispatchEvent(new MessageEvent("message", { source: iframe.contentWindow, data: { ...upload, interactionId: "row-2", requestId: "file-3" } })));
    expect(uploadFiles).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "memmy.plugin.upload-result", ok: false, requestId: "file-3" }), "*");
  });

  it("resizes a custom renderer to its content without exceeding the declared maximum", async () => {
    const customPlugin = InstalledPluginSchema.parse({
      ...plugin,
      manifest: { ...plugin.manifest, ui: { renderer: { entry: "ui/index.html", height: 680 } } }
    });
    const call: PluginUiCall = {
      pluginId: plugin.id,
      capabilityId: "run",
      callId: "call-resize",
      conversationId: "chat-1",
      events: [{ type: "interaction", request: { interactionId: "custom-resize", type: "custom", payload: {} } }]
    };

    await act(async () => root.render(
      <I18nProvider language="en-US">
        <PluginCapabilityHost
          calls={[call]}
          plugins={[customPlugin]}
          client={{ getUi: vi.fn(async () => "<main>Custom renderer</main>"), cancel: vi.fn(), respond: vi.fn() }}
        />
      </I18nProvider>
    ));
    await act(async () => Promise.resolve());

    const iframe = container.querySelector("iframe")!;
    expect(iframe.style.height).toBe("320px");
    await act(async () => window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { type: "memmy.plugin.resize", version: 1, height: 472.2 }
    })));
    expect(iframe.style.height).toBe("473px");

    await act(async () => window.dispatchEvent(new MessageEvent("message", {
      source: iframe.contentWindow,
      data: { type: "memmy.plugin.resize", version: 1, height: 900 }
    })));
    expect(iframe.style.height).toBe("680px");
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

  it.skipIf(!process.env.LITERATURE_REVIEW_PLUGIN_ROOT)("keeps the real recovery bundle open through selection, upload, retry and the next paper", async () => {
    const window = new TestWindow({ settings: { enableJavaScriptEvaluation: true } });
    try {
      const outgoing: any[] = [];
      vi.spyOn(window, "postMessage").mockImplementation((message) => { outgoing.push(message); });
      const html = readFileSync(path.join(process.env.LITERATURE_REVIEW_PLUGIN_ROOT!, "ui/bundles/review-cards/index.html"), "utf8");
      const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
      window.document.write(html.replace(/<script>[\s\S]*?<\/script>/, ""));
      window.eval(script);
      const items = Array.from({ length: 10 }, (_, index) => ({ paperId: `p${index}`, title: `Paper ${index}`, status: "failed", url: `https://example.test/${index}.pdf`, uploaded: false }));
      const send = (data: any) => window.eval(`window.dispatchEvent(new MessageEvent("message", { source: parent, data: ${JSON.stringify(data)} }))`);
      const render = (id: string, rows: any[]) => send({ type: "memmy.plugin.render", version: 1, events: [{ type: "interaction", request: { interactionId: id, type: "custom", payload: {
        cardType: "fulltext-recovery", chatFeedback: true, data: { items: rows }, fileUpload: { accept: [".pdf"], maxFiles: 1, maxBytes: 1024 }, baseArtifact: { contentHash: "sha256:test" }
      } } }] });
      render("r1", items);
      const doc = window.document;
      expect(doc.querySelectorAll(".recovery-row")).toHaveLength(10);
      const picker = doc.querySelector('input[type="file"]')! as any;
      const click = vi.spyOn(picker, "click");
      (Array.from(doc.querySelectorAll("button")).find((button) => button.textContent === "已下载：选择文件") as any).click();
      expect(click).toHaveBeenCalledTimes(1);
      expect(outgoing.filter((message) => message.type === "memmy.plugin.interaction-response")).toHaveLength(0);
      picker.dispatchEvent(new window.Event("change")); // Cancelled chooser: no file.
      expect(doc.querySelectorAll(".recovery-row")).toHaveLength(10);
      Object.defineProperty(picker, "files", { value: [new window.File(["test"], "paper.pdf", { type: "application/pdf" })], configurable: true });
      picker.dispatchEvent(new window.Event("change"));
      const upload = outgoing.find((message) => message.type === "memmy.plugin.upload-files");
      expect(upload.interactionId).toBe("r1");
      expect(doc.body.textContent).toContain("上传中");
      send({ type: "memmy.plugin.upload-result", version: 1, interactionId: "r1", requestId: upload.requestId, ok: false, error: { message: "Temporary upload failure" } });
      expect(doc.body.textContent).toContain("Temporary upload failure");
      expect(doc.querySelectorAll(".recovery-row")).toHaveLength(10);
      const retry = doc.querySelector('input[type="file"]')!;
      Object.defineProperty(retry, "files", { value: [new window.File(["test"], "paper.pdf", { type: "application/pdf" })] });
      retry.dispatchEvent(new window.Event("change"));
      const retried = outgoing.filter((message) => message.type === "memmy.plugin.upload-files").at(-1);
      send({ type: "memmy.plugin.upload-result", version: 1, interactionId: "r1", requestId: retried.requestId, ok: true, files: [{ name: "paper.pdf", path: "/staged/paper.pdf" }] });
      const response = outgoing.find((message) => message.type === "memmy.plugin.interaction-response");
      expect(response.response).toMatchObject({ action: "refresh", values: { intent: "import-fulltext", paperId: "p0" } });
      send({ type: "memmy.plugin.response-result", version: 1, interactionId: "r1", ok: true });
      expect(doc.querySelectorAll(".recovery-row")).toHaveLength(10);
      render("r2", items.map((item, i) => i === 0 ? { ...item, uploaded: true, fileName: "paper.pdf" } : item));
      expect(doc.querySelector("#app")!.classList.contains("busy")).toBe(false);
      expect(doc.body.textContent).toContain("已上传 1 / 10 篇");
      expect(doc.querySelectorAll('input[type="file"]')).toHaveLength(10);
      expect(doc.body.textContent).toContain("跳过剩余 9 篇并继续");
      const replacePicker = doc.querySelector('[data-paper-id="p0"] input')! as any;
      const replaceClick = vi.spyOn(replacePicker, "click");
      (Array.from(doc.querySelectorAll("button")).find((button) => button.textContent === "重新上传") as any).click();
      expect(replaceClick).toHaveBeenCalledTimes(1);
      replacePicker.dispatchEvent(new window.Event("change"));
      expect(doc.body.textContent).toContain("已上传：paper.pdf");
      Object.defineProperty(replacePicker, "files", { value: [new window.File(["replacement"], "corrected.pdf")] });
      replacePicker.dispatchEvent(new window.Event("change"));
      expect(doc.body.textContent).toContain("替换中…");
      expect(doc.body.textContent).toContain("已上传：paper.pdf");
      const replacing = outgoing.filter((message) => message.type === "memmy.plugin.upload-files").at(-1);
      send({ type: "memmy.plugin.upload-result", version: 1, interactionId: "r2", requestId: replacing.requestId, ok: false, error: { message: "Replacement failed" } });
      expect(doc.body.textContent).toContain("Replacement failed");
      expect(doc.body.textContent).toContain("已上传：paper.pdf");
      const replacementRetry = doc.querySelector('[data-paper-id="p0"] input')!;
      Object.defineProperty(replacementRetry, "files", { value: [new window.File(["replacement"], "corrected.pdf")] });
      replacementRetry.dispatchEvent(new window.Event("change"));
      const replacementUpload = outgoing.filter((message) => message.type === "memmy.plugin.upload-files").at(-1);
      send({ type: "memmy.plugin.upload-result", version: 1, interactionId: "r2", requestId: replacementUpload.requestId, ok: true, files: [{ name: "corrected.pdf", path: "/staged/corrected.pdf" }] });
      expect(outgoing.filter((message) => message.type === "memmy.plugin.interaction-response").at(-1).response.values).toMatchObject({ paperId: "p0", intent: "import-fulltext" });
      render("r3", items.map((item, i) => i === 0 ? { ...item, uploaded: true, fileName: "corrected.pdf" } : item));
      expect(doc.body.textContent).toContain("已上传：corrected.pdf");
      expect(doc.body.textContent).not.toContain("已上传：paper.pdf");
      const nextPicker = doc.querySelector('[data-paper-id="p1"] input')!;
      Object.defineProperty(nextPicker, "files", { value: [new window.File(["next paper"], "next.pdf")] });
      nextPicker.dispatchEvent(new window.Event("change"));
      const nextUpload = outgoing.filter((message) => message.type === "memmy.plugin.upload-files").at(-1);
      send({ type: "memmy.plugin.chat-feedback", version: 1, interactionId: "r3", message: "Please explain", clientRequestId: "during-upload" });
      expect(outgoing.filter((message) => message.response?.action === "chat-feedback")).toHaveLength(0);
      send({ type: "memmy.plugin.upload-result", version: 1, interactionId: "r3", requestId: nextUpload.requestId, ok: true, files: [{ name: "next.pdf", path: "/staged/next.pdf" }] });
      send({ type: "memmy.plugin.response-result", version: 1, interactionId: "r3", ok: true });
      render("r4", items.map((item, i) => i < 2 ? { ...item, uploaded: true, fileName: i ? "next.pdf" : "corrected.pdf" } : item));
      const chatResponse = outgoing.filter((message) => message.response?.action === "chat-feedback").at(-1);
      expect(chatResponse.interactionId).toBe("r4");
      expect(chatResponse.response.values.items.filter((item: any) => item.uploaded)).toHaveLength(2);
      expect(chatResponse.response.values.acknowledgedPaperIds).toBeUndefined();
      expect(doc.body.textContent).toContain("已上传 2 / 10 篇");
      expect(doc.querySelectorAll(".recovery-row")).toHaveLength(10);
    } finally { await window.happyDOM.close(); }
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

  it("does not treat a legacy missing-dependency sentinel as a stale artifact version", () => {
    const calls: PluginUiCall[] = [
      {
        pluginId: plugin.id,
        capabilityId: "review_generate_keywords",
        callId: "keywords-call",
        conversationId: "chat-1",
        events: [{
          type: "result",
          output: {
            taskId: "review-1",
            artifacts: [{ id: "keywords-old", kind: "keywords", contentHash: "sha256:keywords-old", stale: false }]
          }
        }]
      },
      {
        pluginId: plugin.id,
        capabilityId: "review_search_papers",
        callId: "search-call",
        conversationId: "chat-1",
        events: [{
          type: "result",
          output: {
            taskId: "review-1",
            artifacts: [{ id: "search-current", kind: "search-results", contentHash: "sha256:search-current", stale: false }]
          }
        }]
      },
      {
        pluginId: plugin.id,
        capabilityId: "review_request_interaction",
        callId: "selection-card",
        conversationId: "chat-1",
        events: [{
          type: "interaction",
          request: {
            interactionId: "selection-1",
            type: "custom",
            payload: {
              taskId: "review-1",
              baseArtifact: { id: "search-current", kind: "search-results", contentHash: "sha256:search-current" },
              artifactSnapshot: [
                { kind: "keywords", contentHash: "__missing__" },
                { kind: "search-results", contentHash: "sha256:search-current" }
              ]
            }
          }
        }]
      }
    ];

    expect(resolveRendererInteractionStates(calls).has(plugin.id + ":selection-card")).toBe(false);
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

  it("keeps actionable calls, unrecovered errors, and delivery artifacts while hiding recovered retry errors", () => {
    const base = { pluginId: plugin.id, capabilityId: "run", conversationId: "chat-1" };
    const calls: PluginUiCall[] = [
      { ...base, callId: "done", events: [{ type: "progress", current: 1, total: 1 }, { type: "result", output: {} }] },
      { ...base, capabilityId: "update-spec", callId: "recovered-error", events: [{ type: "error", code: "invalid_input", message: "invalid", retryable: false }] },
      { ...base, capabilityId: "update-spec", callId: "recovery", events: [{ type: "result", output: {} }] },
      { ...base, callId: "old-active", events: [{ type: "progress", current: 1, total: 2 }] },
      { ...base, callId: "artifact", events: [{ type: "artifact", artifact: { id: "pdf", name: "review.pdf", mediaType: "application/pdf", uri: "/api/v1/plugins/review/artifacts/token/preview" } }, { type: "result", output: {} }] },
      { ...base, callId: "latest-active", events: [{ type: "interaction", request: { interactionId: "outline", type: "custom", payload: {} } }] },
      { ...base, callId: "failed", events: [{ type: "error", code: "failed", message: "failed", retryable: true }] }
    ];

    expect(selectVisiblePluginCalls(calls).map((call) => call.callId)).toEqual(["artifact", "latest-active", "failed"]);
    expect(selectVisiblePluginCalls(calls.slice(0, -1)).map((call) => call.callId)).toEqual(["artifact", "latest-active"]);
    expect(selectVisiblePluginCalls(calls.slice(0, -1), new Set([`${plugin.id}:latest-active:outline`])).map((call) => call.callId)).toEqual(["artifact"]);
  });

  it("does not spin a progress indicator that has reached 100 percent", async () => {
    const progressContainer = document.createElement("div");
    document.body.append(progressContainer);
    const progressRoot = createRoot(progressContainer);
    const call: PluginUiCall = {
      pluginId: plugin.id,
      capabilityId: "run",
      callId: "progress-complete",
      conversationId: "chat-1",
      events: [{ type: "progress", current: 1, total: 1, message: "Complete" }]
    };
    await act(async () => progressRoot.render(
      <I18nProvider language="en-US">
        <PluginCapabilityHost calls={[call]} plugins={[plugin]} client={{ getUi: vi.fn(), cancel: vi.fn(), respond: vi.fn() }} />
      </I18nProvider>
    ));

    expect(progressContainer.textContent).toContain("100%");
    expect(progressContainer.querySelector(".animate-spin")).toBeNull();
    await act(async () => progressRoot.unmount());
    progressContainer.remove();
  });

  it("injects a restrictive CSP into renderer HTML", () => {
    const document = buildRendererDocument("<html><head><title>x</title></head><body>x</body></html>");
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("form-action 'none'");
  });
});
