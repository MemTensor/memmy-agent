// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginUiProvider, usePluginUi } from "../plugin-ui-context.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PluginUiProvider", () => {
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
});
