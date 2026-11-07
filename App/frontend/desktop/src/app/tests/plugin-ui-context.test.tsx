// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginUiProvider, usePluginUi, usePluginInteractionWaiting, reducePluginUiCalls, type PluginUiCall } from "../plugin-ui-context.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PluginUiProvider", () => {
  it("prunes completed history without losing an older pending confirmation", () => {
    const pending: PluginUiCall = { pluginId: "legal-labor", capabilityId: "session-start", callId: "waiting", conversationId: "chat-1", origin: "agent", events: [
      { type: "interaction", request: { interactionId: "upload", type: "file-input", payload: {} } }
    ] };
    let calls = [pending];
    for (let index = 0; index < 80; index++) {
      calls = reducePluginUiCalls(calls, { ...pending, callId: `done-${index}`, event: { type: "result", output: {} } });
    }
    expect(calls[0]?.callId).toBe(pending.callId);
    expect(calls.length).toBeLessThanOrEqual(51);
    expect(calls.at(-1)?.callId).toBe("done-79");
  });

  it("keeps same call ids isolated when two conversations invoke a plugin", () => {
    const base = {
      pluginId: "legal-labor",
      capabilityId: "session-start",
      callId: "reused-call-id",
      origin: "agent" as const
    };
    let calls: PluginUiCall[] = [];
    calls = reducePluginUiCalls(calls, {
      ...base,
      conversationId: "websocket:chat-1",
      event: { type: "interaction", request: { interactionId: "guide-1", type: "question", payload: {} } }
    });
    calls = reducePluginUiCalls(calls, {
      ...base,
      conversationId: "websocket:chat-2",
      event: { type: "interaction", request: { interactionId: "guide-2", type: "question", payload: {} } }
    });

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.conversationId)).toEqual(["websocket:chat-1", "websocket:chat-2"]);
    expect(calls[0]?.events[0]).toMatchObject({ type: "interaction", request: { interactionId: "guide-1" } });
    expect(calls[1]?.events[0]).toMatchObject({ type: "interaction", request: { interactionId: "guide-2" } });
  });
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

  it("keeps invocation context in memory and clears it explicitly", async () => {
    function Harness() {
      const ui = usePluginUi();
      return <>
        <span>{ui.activeSurface?.pluginId ?? "closed"}</span>
        <button onClick={() => ui.openSurface({ pluginId: "com.example.review", capabilityId: "run", conversationId: "chat-1", input: {} })}>open</button>
        <button onClick={ui.closeSurface}>close</button>
      </>;
    }
    await act(async () => root.render(<PluginUiProvider><Harness /></PluginUiProvider>));
    await act(async () => container.querySelectorAll("button")[0]?.click());
    expect(container.textContent).toContain("com.example.review");
    await act(async () => container.querySelectorAll("button")[1]?.click());
    expect(container.textContent).toContain("closed");
  });

  it("reports a pending card only for its owning chat and clears the indicator on answer", async () => {
    let ui!: ReturnType<typeof usePluginUi>;
    function Harness() {
      ui = usePluginUi();
      const waiting = usePluginInteractionWaiting("chat-1");
      const unrelated = usePluginInteractionWaiting("chat-2");
      return <span>{String(waiting)}:{String(unrelated)}</span>;
    }
    await act(async () => root.render(<PluginUiProvider><Harness /></PluginUiProvider>));
    await act(async () => ui.receive({ pluginId: "literature-review", capabilityId: "review_request_interaction", callId: "call", conversationId: "websocket:chat-1", origin: "agent",
      event: { type: "interaction", request: { interactionId: "card", type: "custom", payload: {} } } }));
    expect(container.textContent).toBe("true:false");
    await act(async () => ui.setAnsweredInteractions(new Set(["literature-review:call:card"])));
    expect(container.textContent).toBe("false:false");
  });

  it("removes a stale legal question after reconnect while keeping the live call in another chat", async () => {
    let ui!: ReturnType<typeof usePluginUi>;
    function Harness() {
      ui = usePluginUi();
      return <span>{String(usePluginInteractionWaiting("chat-1"))}:{String(usePluginInteractionWaiting("chat-2"))}</span>;
    }
    await act(async () => root.render(<PluginUiProvider><Harness /></PluginUiProvider>));
    const call = { pluginId: "legal-labor", capabilityId: "gap-resolve", callId: "reused-id", origin: "agent" as const,
      event: { type: "interaction" as const, request: { interactionId: "question", type: "question" as const,
        payload: { title: "补充企业情况", questions: [{ id: "location", label: "参保地" }] } } } };
    await act(async () => {
      ui.receive({ ...call, conversationId: "websocket:chat-1" });
      ui.receive({ ...call, conversationId: "websocket:chat-2" });
    });
    expect(container.textContent).toBe("true:true");
    await act(async () => ui.reconcilePendingCalls([{ pluginId: "legal-labor", capabilityId: "gap-resolve",
      callId: "reused-id", conversationId: "websocket:chat-2" }]));
    expect(container.textContent).toBe("false:true");
    expect(ui.calls.map((entry) => entry.conversationId)).toEqual(["websocket:chat-2"]);
    expect(ui.legalQuestionHistory.find((entry) => entry.conversationId === "websocket:chat-1")?.status).toBe("interrupted");
    expect(ui.legalQuestionHistory.find((entry) => entry.conversationId === "websocket:chat-2")?.status).toBe("pending");
  });

  it("closes a waiting legal card when a new message interrupts its interaction", async () => {
    let ui!: ReturnType<typeof usePluginUi>;
    function Harness() {
      ui = usePluginUi();
      return <span>{String(usePluginInteractionWaiting("chat-1"))}</span>;
    }
    await act(async () => root.render(<PluginUiProvider><Harness /></PluginUiProvider>));
    await act(async () => ui.receive({ pluginId: "legal-labor", capabilityId: "gap-resolve", callId: "old-call",
      conversationId: "websocket:chat-1", origin: "agent", event: { type: "interaction", request: {
        interactionId: "question", type: "question", payload: { title: "补充企业情况",
          questions: [{ id: "location", label: "实际参保地区" }] }
      } } }));
    expect(container.textContent).toBe("true");
    await act(async () => ui.interruptPendingInteractions(["legal-labor:old-call:question"]));
    expect(container.textContent).toBe("false");
    expect(ui.legalQuestionHistory.find((entry) => entry.callId === "old-call")?.status).toBe("interrupted");
    expect(ui.legalQuestionHistory.find((entry) => entry.callId === "old-call")?.answers).toBeNull();
  });
});
