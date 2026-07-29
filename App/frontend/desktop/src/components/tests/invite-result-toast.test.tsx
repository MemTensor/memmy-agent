// @vitest-environment happy-dom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InviteResultToast } from "../invite-result-toast.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("InviteResultToast", () => {
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
    vi.useRealTimers();
  });

  it("reports the toast once after it is mounted", () => {
    vi.useFakeTimers();
    const onShown = vi.fn();

    act(() => {
      root.render(
        <StrictMode>
          <InviteResultToast
            text="邀请奖励已到账"
            tone="success"
            onDismiss={vi.fn()}
            onShown={onShown}
          />
        </StrictMode>
      );
    });

    expect(document.body.querySelector('[role="status"]')).not.toBeNull();
    expect(onShown).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <StrictMode>
          <InviteResultToast
            text="Invitation applied"
            tone="success"
            onDismiss={vi.fn()}
            onShown={onShown}
          />
        </StrictMode>
      );
    });
    expect(onShown).toHaveBeenCalledTimes(1);
  });
});
