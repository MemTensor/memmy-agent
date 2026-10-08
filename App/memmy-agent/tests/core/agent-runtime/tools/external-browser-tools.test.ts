import { describe, expect, it, vi } from "vitest";
import { callExternalBrowserTool } from "../../../../src/core/agent-runtime/tools/external-browser-tools.js";
import type { ExternalBrowserBridge, ExternalBrowserClaim } from "../../../../src/core/agent-runtime/tools/external-browser-bridge.js";

const claim: ExternalBrowserClaim = {
  connectionId: "test", tabId: 4, browser: "chrome",
  title: "Local page", url: "https://example.test/", claimedAt: 1,
};
const scope = { sessionKey: "s", channel: "projected-session", chatId: "s" };

describe("external browser tool adapter", () => {
  it("formats AX references as model targets without exposing other tab metadata", async () => {
    const command = vi.fn(async () => ({ nodes: [
      { ref: "ax-9", role: "button", name: "Continue", value: "" },
    ], tab: { id: 99, url: "https://other.test/" } }));
    const result = await callExternalBrowserTool({ command } as unknown as ExternalBrowserBridge,
      claim, scope, "browser_snapshot", {}, async () => false);
    expect(result).toEqual([{ type: "text", text: '[ax-9] button "Continue"' }]);
    expect(command).toHaveBeenNthCalledWith(1, claim, "snapshot", {});
  });

  it("requires site approval before granting cross-origin navigation", async () => {
    const command = vi.fn(async (_claim, operation) => operation === "screenshot"
      ? { format: "jpeg", data: "AAA" } : {});
    const bridge = { command } as unknown as ExternalBrowserBridge;
    await expect(callExternalBrowserTool(bridge, claim, scope,
      "browser_navigate", { url: "https://other.test/" }, async () => false))
      .rejects.toThrow(/not approved/);
    expect(command).not.toHaveBeenCalled();
    const approve = vi.fn(async () => true);
    await callExternalBrowserTool(bridge, claim, scope,
      "browser_navigate", { url: "https://other.test/" }, approve);
    expect(approve).toHaveBeenCalledWith("https://other.test/");
    expect(command.mock.calls.slice(0, 2).map(call => call[1])).toEqual(["allowOrigin", "navigate"]);
  });

  it("returns a real image item for screenshot tool calls", async () => {
    const command = vi.fn(async () => ({ format: "png", data: "AAAA" }));
    const result = await callExternalBrowserTool({ command } as unknown as ExternalBrowserBridge,
      claim, scope, "browser_take_screenshot", { type: "png" }, async () => false);
    expect(result).toContainEqual({ type: "image", mimeType: "image/png", data: "AAAA" });
  });
});
