/** Sidebar resize tests. */
import { describe, expect, it } from "vitest";
import {
  SHARED_ROW_MIN_CHAT_WIDTH,
  SHARED_ROW_MIN_PANE_WIDTH,
  SHARED_ROW_PRIMARY_RESERVE,
  clampSidebarWidth,
  fitSidebarMaxWidth
} from "../sidebar-resize.js";

describe("clampSidebarWidth", () => {
  it("keeps a width inside the pane's own bounds", () => {
    expect(clampSidebarWidth(520, 360, 760)).toBe(520);
    expect(clampSidebarWidth(200, 360, 760)).toBe(360);
    expect(clampSidebarWidth(900, 360, 760)).toBe(760);
  });
});

describe("fitSidebarMaxWidth", () => {
  it("leaves the pane alone until the shared row has been measured", () => {
    expect(fitSidebarMaxWidth(null, SHARED_ROW_PRIMARY_RESERVE, 760)).toBe(760);
    expect(fitSidebarMaxWidth(Number.NaN, SHARED_ROW_PRIMARY_RESERVE, 760)).toBe(760);
    expect(fitSidebarMaxWidth(1200, undefined, 760)).toBe(760);
  });

  it("caps the pane so the chat keeps its share of the row", () => {
    // A roomy window: the pane's own ceiling still wins.
    expect(fitSidebarMaxWidth(1400, SHARED_ROW_PRIMARY_RESERVE, 760)).toBe(760);

    // A narrowed window: the cap is what is left after reserving the chat.
    expect(fitSidebarMaxWidth(1000, SHARED_ROW_PRIMARY_RESERVE, 760)).toBe(580);
    expect(fitSidebarMaxWidth(900, SHARED_ROW_PRIMARY_RESERVE, 760)).toBe(480);
  });

  it("keeps both columns on screen at the desktop window's minimum width", () => {
    // main/window-mode.ts floors the window at 1024px, and the app sidebar can
    // be dragged out to 520px. That narrowing is the worst the row can get, and
    // it must still fit the chat and the pane side by side.
    const workspaceRow = 1024 - 520;
    const paneMax = fitSidebarMaxWidth(workspaceRow, SHARED_ROW_PRIMARY_RESERVE, 760);

    expect(paneMax).toBeGreaterThanOrEqual(SHARED_ROW_MIN_PANE_WIDTH);
    expect(workspaceRow - paneMax).toBeGreaterThan(SHARED_ROW_MIN_CHAT_WIDTH);
  });

  it("never returns less than the pane's own floor", () => {
    // A row too narrow for even the reserve must not produce a pane of zero.
    expect(fitSidebarMaxWidth(300, SHARED_ROW_PRIMARY_RESERVE, 760)).toBe(SHARED_ROW_MIN_PANE_WIDTH);
    expect(fitSidebarMaxWidth(0, SHARED_ROW_PRIMARY_RESERVE, 760)).toBe(SHARED_ROW_MIN_PANE_WIDTH);
  });
});
