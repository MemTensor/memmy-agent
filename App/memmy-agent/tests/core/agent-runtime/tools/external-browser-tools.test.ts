import { describe, expect, it, vi } from "vitest";
import { callExternalBrowserTool, emitExternalBrowserFrame } from "../../../../src/core/agent-runtime/tools/external-browser-tools.js";
import type { ExternalBrowserBridge, ExternalBrowserClaim } from "../../../../src/core/agent-runtime/tools/external-browser-bridge.js";
import * as surfaces from '../../../../src/tools/computer-use/surface-preview.js';

const claim: ExternalBrowserClaim = {
  connectionId: "test", tabId: 4, browser: "chrome",
  title: "Local page", url: "https://example.test/", claimedAt: 1,
};
const scope = { sessionKey: "s", channel: "projected-session", chatId: "s" };

describe("external browser tool adapter", () => {
  it('distinguishes an empty field, its label and its observed value after an action', async () => {
    const command = vi.fn(async () => ({ ok: true, observation: { nodes: [
      { ref: 'pw-1', role: 'textbox', name: 'Email', value: '' },
      { ref: 'pw-2', role: 'textbox', name: 'Font size', value: '11' },
      { ref: 'pw-3', role: 'textbox', name: 'Notes', value: 'Draft text' },
      { ref: 'pw-4', role: 'textbox', name: 'Password', value: 'must-not-appear', state: { valueRedacted: true } },
    ] } }));
    const result = await callExternalBrowserTool({ command } as unknown as ExternalBrowserBridge,
      { ...claim, browser: 'memmy' }, scope, 'browser_type', { target: 'pw-3', text: 'Draft text' }, async () => true);
    const text = result[0].text;
    expect(text).toContain('[pw-1] textbox "Email" value=""');
    expect(text).toContain('[pw-2] textbox "Font size" value="11"');
    expect(text).toContain('[pw-3] textbox "Notes" value="Draft text"');
    expect(text).not.toContain('must-not-appear');
  });

  it.each([{ boxes: true }, { target: 'pw-1' }, { ref: 'pw-1' }])('does not silently ignore unsupported connected snapshot options %j', async params => {
    const command = vi.fn();
    await expect(callExternalBrowserTool({ command } as unknown as ExternalBrowserBridge,
      { ...claim, browser: 'memmy' }, scope, 'browser_snapshot', params, async () => true))
      .rejects.toThrow(/not supported.*browser_find/);
    expect(command).not.toHaveBeenCalled();
  });

  it('returns the completed observation when its optional preview never responds', async () => {
    vi.useFakeTimers();
    try {
      let previewSignal: AbortSignal | undefined;
      const command = vi.fn(async (_claim, operation, _args, signal) => {
        if (operation === 'snapshot') return { nodes: [{ ref: 'pw-1', role: 'button', name: 'Continue' }] };
        previewSignal = signal;
        return await new Promise(() => undefined);
      });
      const pending = callExternalBrowserTool({ command } as unknown as ExternalBrowserBridge,
        claim, scope, 'browser_snapshot', {}, async () => true);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await pending).toEqual([{ type: 'text', text: '[pw-1] button "Continue"' }]);
      expect(previewSignal?.aborted).toBe(true);
      expect(command.mock.calls.map(call => call[1])).toEqual(['snapshot', 'screenshot']);
    } finally { vi.useRealTimers(); }
  });

  it('renders observed structure as indentation and found elements with their location', async () => {
    const command = vi.fn(async (_claim, operation) => operation === 'snapshot'
      ? { nodes: [{ ref: '', role: 'row', name: '044001 | 1000.00', value: '', depth: 0 },
        { ref: 'pw-1', role: 'button', name: 'Delete', value: '', depth: 1 }] }
      : { nodes: [{ ref: 'pw-2', role: 'button', name: 'Delete', value: '', context: 'table > row "044001 | 1000.00"' }] });
    const bridge = { command } as unknown as ExternalBrowserBridge;
    const embedded = { ...claim, browser: 'memmy' as const };
    expect(await callExternalBrowserTool(bridge, embedded, scope, 'browser_snapshot', {}, async () => true))
      .toEqual([{ type: 'text', text: 'row "044001 | 1000.00"\n  [pw-1] button "Delete"' }]);
    expect(await callExternalBrowserTool(bridge, embedded, scope, 'browser_find', { text: 'Delete' }, async () => true))
      .toEqual([{ type: 'text', text: '[pw-2] button "Delete" in "table > row \\"044001 | 1000.00\\""' }]);
  });

  it('cancels a pending preview with the turn and never publishes its late response', async () => {
    const controller = new AbortController();
    let resolve!: (value: unknown) => void;
    const command = vi.fn(() => new Promise<unknown>(done => { resolve = done; }));
    const publish = vi.spyOn(surfaces, 'emitComputerUseSurface');
    try {
      const pending = emitExternalBrowserFrame({ command } as unknown as ExternalBrowserBridge,
        claim, scope, undefined, controller.signal);
      controller.abort();
      await pending;
      resolve({ format: 'jpeg', data: 'AAA' });
      await Promise.resolve();
      expect(command).toHaveBeenCalledTimes(1);
      expect(publish).not.toHaveBeenCalled();
    } finally { publish.mockRestore(); }
  });

  it('keeps in-app text and DOM actions without requesting screenshots or publishing image previews', async () => {
    const embedded = { ...claim, browser: 'memmy' as const };
    const command = vi.fn(async (_claim, operation) => operation === 'snapshot'
      ? { nodes: [{ ref: 'ax-9', role: 'button', name: 'Continue' }] } : { clicked: true });
    const bridge = { command } as unknown as ExternalBrowserBridge;
    const publish = vi.spyOn(surfaces, 'emitComputerUseSurface');
    try {
      expect(await callExternalBrowserTool(bridge, embedded, scope, 'browser_snapshot', {}, async () => true))
        .toEqual([{ type: 'text', text: '[ax-9] button "Continue"' }]);
      expect(await callExternalBrowserTool(bridge, embedded, scope, 'browser_click', { target: 'ax-9' }, async () => true))
        .toEqual([{ type: 'text', text: '{"clicked":true}' }]);
      expect(command.mock.calls.map(call => call[1])).toEqual(['snapshot', 'click']);
      expect(publish).not.toHaveBeenCalled();
      command.mockClear();
      await expect(callExternalBrowserTool(bridge, embedded, scope, 'browser_take_screenshot', {}, async () => true))
        .rejects.toThrow(/not supported.*browser_snapshot/);
      expect(command).not.toHaveBeenCalled();
    } finally { publish.mockRestore(); }
  });

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
