// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentActions, appActions } from "../app-actions.js";
import { AppStateProvider, useAppState, type AppStateContextValue } from "../app-state.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AppStateProvider window visibility", () => {
  let root: Root;
  let host: HTMLDivElement;
  let context: AppStateContextValue;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  function Harness(props: { completeOnMount?: boolean }) {
    context = useAppState();
    useEffect(() => {
      context.dispatch(appActions.navigate("/main"));
      context.dispatch(agentActions.newChatCreated("chat-1"));
      if (props.completeOnMount) {
        context.dispatch(agentActions.wsEventReceived({ event: "run_status", chat_id: "chat-1", status: "running", started_at: 1781240000000 }));
        context.dispatch(agentActions.wsEventReceived({ event: "turn_end", chat_id: "chat-1" }));
      }
    }, [props.completeOnMount]);
    return null;
  }

  function render(completeOnMount = false) {
    act(() => root.render(<AppStateProvider><Harness completeOnMount={completeOnMount} /></AppStateProvider>));
  }

  function changeVisibility(next: DocumentVisibilityState) {
    visibility = next;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
  }

  it("reads an initially hidden document before descendant completion effects", () => {
    visibility = "hidden";
    render(true);

    expect(context.state.agent.chatViewVisible).toBe(false);
    expect(context.state.agent.completedUnseenByChatId["chat-1"]).toBeTypeOf("number");
  });

  it("keeps a hidden completion unread and acknowledges it when the main window becomes visible", () => {
    render();
    changeVisibility("hidden");
    act(() => {
      context.dispatch(agentActions.wsEventReceived({ event: "run_status", chat_id: "chat-1", status: "running", started_at: 1781240000000 }));
      context.dispatch(agentActions.wsEventReceived({ event: "turn_end", chat_id: "chat-1" }));
      context.dispatch(appActions.navigate("/tools"));
      context.dispatch(appActions.navigate("/main"));
    });

    expect(context.state.agent.chatViewVisible).toBe(false);
    expect(context.state.agent.completedUnseenByChatId["chat-1"]).toBeTypeOf("number");

    changeVisibility("visible");
    expect(context.state.agent.chatViewVisible).toBe(true);
    expect(context.state.agent.completedUnseenByChatId["chat-1"]).toBeUndefined();
  });

  it("treats a visible but unfocused window as readable", () => {
    render();
    act(() => window.dispatchEvent(new Event("blur")));
    act(() => {
      context.dispatch(agentActions.wsEventReceived({ event: "run_status", chat_id: "chat-1", status: "running", started_at: 1781240000000 }));
      context.dispatch(agentActions.wsEventReceived({ event: "turn_end", chat_id: "chat-1" }));
    });

    expect(context.state.agent.chatViewVisible).toBe(true);
    expect(context.state.agent.completedUnseenByChatId["chat-1"]).toBeUndefined();
  });
});
