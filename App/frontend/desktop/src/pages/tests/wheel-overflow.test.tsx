// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { InstalledPluginSchema } from "@memmy/local-api-contracts";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginUiProvider } from "../../app/plugin-ui-context.js";
import { PluginCapabilityHost } from "../plugin-capability-host.js";

/**
 * happy-dom does not load styles.css, so the scroll container's own rule is
 * applied inline here to stand in for it.
 */
function makeScrollable(list: HTMLElement, { scrollTop, scrollHeight, clientHeight }: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  list.style.overflowY = "auto";
  Object.defineProperty(list, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(list, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(list, "scrollTop", { configurable: true, value: scrollTop, writable: true });
}

const plugin = InstalledPluginSchema.parse({
  id: "legal-labor", version: "1.0.0", manifest: { apiVersion: "memmy/v1", id: "legal-labor", name: "Legal", version: "1.0.0",
    runtime: { adapter: "http" }, capabilities: [{ id: "session-start", name: "S", description: "S", inputSchema: {}, outputSchema: {}, execution: "job" }],
    commands: [{ command: "/legal-guide", name: "Guide", description: "G", capabilityId: "session-start", pinned: true }], permissions: [] },
  state: "active", approvedPermissions: [], config: {}, lastError: null,
  createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z"
});

const questionCall = { pluginId: "legal-labor", capabilityId: "session-start", callId: "q", conversationId: "chat", origin: "agent" as const,
  events: [{ type: "interaction" as const, request: { interactionId: "questions", type: "question" as const,
    payload: { title: "补充企业情况", questions: [
      { id: "a", label: "A?", required: false, options: [] },
      { id: "b", label: "B?", required: false, options: [] }
    ] } } }] };

it("keeps the wheel on the question card while the pointer is over it, even at the list's end", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const onRegionWheelOverflow = vi.fn();
  try {
    await act(async () => root.render(<PluginUiProvider><I18nProvider language="zh-CN">
      <PluginCapabilityHost region="pinned" calls={[questionCall]} plugins={[plugin]}
        client={{ respond: vi.fn(async () => undefined), cancel: vi.fn(), getUi: vi.fn() }}
        onRegionWheelOverflow={onRegionWheelOverflow} />
    </I18nProvider></PluginUiProvider>));

    const list = container.querySelector<HTMLElement>(".legal-question-card__list")!;
    const field = container.querySelector("input")!;

    // Mid-list, at the bottom, at the top: the chat never moves.
    for (const scrollTop of [200, 600, 0]) {
      makeScrollable(list, { scrollTop, scrollHeight: 900, clientHeight: 300 });
      await act(async () => field.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true })));
      await act(async () => field.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true })));
    }
    expect(onRegionWheelOverflow).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); container.remove(); }
});

it("scrolls the question list when the wheel is over the card's header", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const onRegionWheelOverflow = vi.fn();
  try {
    await act(async () => root.render(<PluginUiProvider><I18nProvider language="zh-CN">
      <PluginCapabilityHost region="pinned" calls={[questionCall]} plugins={[plugin]}
        client={{ respond: vi.fn(async () => undefined), cancel: vi.fn(), getUi: vi.fn() }}
        onRegionWheelOverflow={onRegionWheelOverflow} />
    </I18nProvider></PluginUiProvider>));
    const list = container.querySelector<HTMLElement>(".legal-question-card__list")!;
    makeScrollable(list, { scrollTop: 100, scrollHeight: 900, clientHeight: 300 });
    const header = container.querySelector<HTMLElement>(".legal-question-card__header h3")!;
    await act(async () => header.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true })));
    expect(list.scrollTop).toBe(220);
    expect(onRegionWheelOverflow).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); container.remove(); }
});

it("still forwards the wheel when the card holds nothing scrollable", async () => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const onRegionWheelOverflow = vi.fn();
  // The region itself is the scroller here: no card has its own list.
  try {
    await act(async () => root.render(<PluginUiProvider><I18nProvider language="zh-CN">
      <PluginCapabilityHost region="pinned" calls={[questionCall]} plugins={[plugin]}
        client={{ respond: vi.fn(async () => undefined), cancel: vi.fn(), getUi: vi.fn() }}
        onRegionWheelOverflow={onRegionWheelOverflow} />
    </I18nProvider></PluginUiProvider>));
    // A card with no scroll container of its own.
    const list = container.querySelector<HTMLElement>(".legal-question-card__list")!;
    list.style.overflowY = "visible";
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 300 });
    const header = container.querySelector<HTMLElement>(".legal-question-card__header h3")!;
    await act(async () => header.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true })));
    expect(onRegionWheelOverflow).toHaveBeenCalledWith(120);
  } finally { act(() => root.unmount()); container.remove(); }
});
