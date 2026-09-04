import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_MANAGED_MEMORY_ENV,
  MEMORY_RESTART_IPC_TYPE,
  requestMemoryServiceRestart,
} from "../src/server/service-restart.js";

describe("Memory service restart dispatch", () => {
  it("asks Memmy Desktop to restart a Desktop-managed service", async () => {
    const send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => {
      callback(null);
    });
    const restartInstalled = vi.fn();

    await requestMemoryServiceRestart({
      env: { [DESKTOP_MANAGED_MEMORY_ENV]: "1" },
      send,
      restartInstalled,
    });

    expect(send).toHaveBeenCalledWith(
      { type: MEMORY_RESTART_IPC_TYPE },
      expect.any(Function),
    );
    expect(restartInstalled).not.toHaveBeenCalled();
  });

  it("uses the user service manager for a standalone service", async () => {
    const restartInstalled = vi.fn();

    await requestMemoryServiceRestart({ env: {}, restartInstalled });

    expect(restartInstalled).toHaveBeenCalledOnce();
  });

  it("rejects a Desktop-managed restart without an IPC channel", async () => {
    expect(() => requestMemoryServiceRestart({
      env: { [DESKTOP_MANAGED_MEMORY_ENV]: "1" },
      send: null,
    })).toThrow("requires an IPC channel");
  });
});
