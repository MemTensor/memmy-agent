import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  clearTerminalScreen,
  tuiQueuePreview,
  tuiQueueSourceLabel,
} from "../../../src/entrypoints/cli/tui.js";

const source = readFileSync(
  new URL("../../../src/entrypoints/cli/tui.tsx", import.meta.url),
  "utf8",
);

describe("Ink TUI Turn admission", () => {
  it("maps Enter to queue and Tab to steer", () => {
    expect(source).toContain("dispatchTuiInput(inputRef.current);");
    expect(source).toContain('submit(value, "queue");');
    expect(source).toContain('submit(inputRef.current, "steer");');
    expect(source).toContain("gateway.submit(text, turnAdmission, request.clientRequestId)");
  });

  it("handles slash completion before Queue and never routes slash Tab to Steer", () => {
    const ctrlC = source.indexOf('if (key.ctrl && value === "c")');
    const slashEscape = source.indexOf("if (slashMenuOpen && key.escape)");
    const slashTab = source.indexOf("if (key.tab && slashInput)");
    const enter = source.indexOf("if (key.return)", slashTab);
    const steer = source.indexOf("if (key.tab && gatewayState.ownedByTui)", enter);
    expect(ctrlC).toBeGreaterThanOrEqual(0);
    expect(slashEscape).toBeGreaterThan(ctrlC);
    expect(slashTab).toBeGreaterThan(slashEscape);
    expect(enter).toBeGreaterThan(slashTab);
    expect(steer).toBeGreaterThan(enter);
    expect(source).toContain('const slashInput = inputRef.current.trimStart().startsWith("/");');
  });

  it("keeps only stop, last-compaction, and quit local", () => {
    expect(source).toContain('if (action === "local-stop")');
    expect(source).toContain("gateway.stopOwnedTurn()");
    expect(source).toContain('if (action === "local-last-compaction")');
    expect(source).toContain("gateway.readLastCompaction()");
    expect(source).toContain('if (action === "local-quit")');
    expect(source).toContain('submit(value, "queue");');
    expect(source).not.toContain('action === "local-new"');
    expect(source).not.toContain('action === "local-restart"');
    expect(source).not.toContain('action === "local-help"');
  });

  it("keeps the composer active while the Session is busy", () => {
    expect(source).not.toContain("if (busy) return;");
    expect(source).toContain("Enter: queue next turn · Tab: add to current turn");
    expect(source).toContain("Session is running from another channel · Enter: queue next turn");
    expect(source).toMatch(/<ComposerInput\s+active\s/);
  });

  it("uses Gateway state and never creates or stops a local AgentLoop", () => {
    expect(source).not.toContain("AgentLoop.fromConfig");
    expect(source).not.toContain("new MessageBus");
    expect(source).not.toContain("cancelActiveTasks");
    expect(source).toContain("gateway.subscribe(setGatewayState)");
    expect(source).toContain("gateway.close()");
    expect(source).toContain("gatewayState.modelSelection");
    expect(source).toContain("modelSelectionLabel(gatewayState.modelSelection)");
    expect(source).not.toContain("config.agents.defaults.modelPreset");
  });

  it("keeps the draft until the Gateway acknowledges Queue or Steer", () => {
    const sendIndex = source.indexOf("gateway.submit(text, turnAdmission, request.clientRequestId)");
    const clearIndex = source.indexOf('setDraft("", 0);', sendIndex);
    expect(sendIndex).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeGreaterThan(sendIndex);
  });

  it("clears local messages and terminal scrollback after the Session resets", () => {
    const write = vi.fn();
    clearTerminalScreen(write);

    expect(write).toHaveBeenCalledWith("\x1b[2J\x1b[H\x1b[3J");
    expect(source).toContain("handledSessionResetVersionRef.current === gatewayState.sessionResetVersion");
    expect(source).toContain("setLocalMessages([]);");
    expect(source).toContain("clearTerminalScreen(write);");
  });

  it("renders fixed queue sources and normalizes only the preview", () => {
    expect(tuiQueueSourceLabel({
      clientRequestId: "id",
      text: "x",
      queuedAt: "2026-08-09T12:00:00.000Z",
      source: { kind: "gui", channel: "websocket" },
    })).toBe("GUI");
    expect(tuiQueueSourceLabel({
      clientRequestId: "id",
      text: "x",
      queuedAt: "2026-08-09T12:00:00.000Z",
      source: { kind: "im", channel: "slack" },
    })).toBe("Slack");
    expect(tuiQueueSourceLabel({
      clientRequestId: "id",
      text: "x",
      queuedAt: "2026-08-09T12:00:00.000Z",
      source: { kind: "tui", channel: "websocket" },
    })).toBe("TUI");
    expect(tuiQueueSourceLabel({
      clientRequestId: "id",
      text: "x",
      queuedAt: "2026-08-09T12:00:00.000Z",
      source: { kind: "im", channel: "unknown" },
    })).toBe("IM");
    expect(tuiQueuePreview("line one\nline two", 80)).toBe("line one line two");
    expect(tuiQueuePreview("123456789", 7)).toBe("1234...");
    expect(source).toContain("const visible = items.slice(0, 3);");
    expect(source).toContain("items.length - visible.length");
  });
});
