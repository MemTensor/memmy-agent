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

  it("rebuilds a persistent service after its Desktop IPC channel closes", async () => {
    const restartLocal = vi.fn();
    const restartInstalled = vi.fn();
    await requestMemoryServiceRestart({
      env: { [DESKTOP_MANAGED_MEMORY_ENV]: "1" },
      send: null,
      restartLocal,
      restartInstalled,
    });
    expect(restartLocal).toHaveBeenCalledOnce();
    expect(restartInstalled).not.toHaveBeenCalled();
  });

  it("rebuilds locally if Desktop exits while a restart message is sent", async () => {
    const restartLocal = vi.fn();
    await requestMemoryServiceRestart({
      env: { [DESKTOP_MANAGED_MEMORY_ENV]: "1" },
      send: (_message, callback) => callback(Object.assign(new Error("closed"), { code: "ERR_IPC_CHANNEL_CLOSED" })),
      restartLocal,
    });
    expect(restartLocal).toHaveBeenCalledOnce();
  });

  it("preserves unexpected IPC errors", async () => {
    const restartLocal = vi.fn();
    await expect(requestMemoryServiceRestart({
      env: { [DESKTOP_MANAGED_MEMORY_ENV]: "1" },
      send: (_message, callback) => callback(new Error("invalid message")),
      restartLocal,
    })).rejects.toThrow("invalid message");
    expect(restartLocal).not.toHaveBeenCalled();
  });
});
