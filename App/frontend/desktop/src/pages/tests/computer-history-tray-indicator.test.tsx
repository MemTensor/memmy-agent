// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { useComputerHistoryTrayIndicator, writeComputerHistoryTrayIndicator } from "../../app/computer-history-tray-indicator.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Indicator({ client }: { client: MemmyAgentClient }) {
  useComputerHistoryTrayIndicator(client);
  return null;
}

describe("Computer History menu bar indicator", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "memmy");
  });

  it("shows a running recording and immediately hides it when opted out", async () => {
    const publish = vi.fn();
    Object.defineProperty(window, "memmy", { configurable: true, value: {
      platform: "darwin", setComputerHistoryTrayIndicator: publish,
    } });
    const client = { getComputerHistoryObservationStatus: vi.fn().mockResolvedValue({ state: "running" }) } as unknown as MemmyAgentClient;
    await act(async () => root.render(<Indicator client={client} />));
    expect(publish).toHaveBeenCalledWith({ enabled: true, recording: true });

    act(() => writeComputerHistoryTrayIndicator(false));
    expect(publish).toHaveBeenLastCalledWith({ enabled: false, recording: false });
    expect(client.getComputerHistoryObservationStatus).toHaveBeenCalledOnce();
  });
});
