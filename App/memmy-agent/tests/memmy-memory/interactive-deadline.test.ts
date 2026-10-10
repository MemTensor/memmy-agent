import { describe, expect, it, vi } from "vitest";
import { INTERACTIVE_MEMORY_TIMEOUT_MS } from "../../src/memmy-memory/client.js";
import { waitForMemory } from "../../src/memmy-memory/lifecycle.js";

describe("interactive memory deadline", () => {
  it("stays well inside the window the desktop client allows a send", () => {
    // The client abandons a message after 30s. A best-effort enrichment that
    // could outlast that turns a slow memory service into a failed send.
    expect(INTERACTIVE_MEMORY_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it("gives up on a hanging memory service instead of holding the reply", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise(() => {});
      const raced = waitForMemory(() => never, INTERACTIVE_MEMORY_TIMEOUT_MS);
      const settled = raced.then(() => "resolved", (error: Error) => error.message);

      await vi.advanceTimersByTimeAsync(INTERACTIVE_MEMORY_TIMEOUT_MS + 1);

      expect(await settled).toContain("did not answer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the value untouched when memory answers in time", async () => {
    await expect(waitForMemory(async () => "session-1", INTERACTIVE_MEMORY_TIMEOUT_MS)).resolves.toBe("session-1");
  });

  it("propagates a real failure rather than masking it as a timeout", async () => {
    await expect(waitForMemory(async () => {
      throw new Error("memory refused the connection");
    }, INTERACTIVE_MEMORY_TIMEOUT_MS)).rejects.toThrow("memory refused the connection");
  });
});
