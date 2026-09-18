import { describe, expect, it, vi } from "vitest";
import { INTERACTIVE_MEMORY_TIMEOUT_MS } from "../../src/memmy-memory/client.js";
import { MemmyMemoryHook } from "../../src/memmy-memory/hook.js";

describe("interactive memory deadline", () => {
  it("stays well inside the window the desktop client allows a send", () => {
    // The client abandons a message after 30s. A best-effort enrichment that
    // could outlast that turns a slow memory service into a failed send.
    expect(INTERACTIVE_MEMORY_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it("gives up on a hanging memory service instead of holding the reply", async () => {
    vi.useFakeTimers();
    try {
      const hook = Object.create(MemmyMemoryHook.prototype) as any;
      const never = new Promise(() => {});
      const raced = hook.withInteractiveDeadline(() => never);
      const settled = raced.then(() => "resolved", (error: Error) => error.message);

      await vi.advanceTimersByTimeAsync(INTERACTIVE_MEMORY_TIMEOUT_MS + 1);

      expect(await settled).toContain("did not answer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the value untouched when memory answers in time", async () => {
    const hook = Object.create(MemmyMemoryHook.prototype) as any;
    await expect(hook.withInteractiveDeadline(async () => "session-1")).resolves.toBe("session-1");
  });

  it("propagates a real failure rather than masking it as a timeout", async () => {
    const hook = Object.create(MemmyMemoryHook.prototype) as any;
    await expect(hook.withInteractiveDeadline(async () => {
      throw new Error("memory refused the connection");
    })).rejects.toThrow("memory refused the connection");
  });
});
