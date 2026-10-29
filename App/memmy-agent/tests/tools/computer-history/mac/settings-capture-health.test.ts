import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { ComputerHistoryStatusTool } from "../../../../src/tools/computer-history/mac/computer-history-settings.js";
import { ObservationSettingsStore } from "../../../../src/tools/computer-history/mac/settings-store.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function status(captureHealth?: unknown, wechat?: unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "history-status-health-")); directories.push(directory);
  return new ComputerHistoryStatusTool({ snapshot: () => ({
    observation: { state: "running", startedAt: null, segmentId: "synthetic-segment", error: null, captureHealth },
    wechat,
    privacy: { screenshots: false, audio: false, rawRetentionHours: 48, markdownDirectory: "/synthetic/history", eventStreamDirectory: "/synthetic/events" },
  }) } as any, new ObservationSettingsStore(path.join(directory, "settings.json")));
}
test("status distinguishes recorder lifecycle from partial capture and preserves recent write evidence", async () => {
  const health = { status: "degraded", lastEventAt: "2026-10-09T10:49:55Z", lastHeartbeatAt: "2026-10-09T10:50:00Z",
    issues: [{ code: "privacy_unknown", count: 2 }], limitations: ["foreground_accessibility_only"] };
  const tool = status(health);
  const response = JSON.parse(await tool.execute());
  expect(response.state).toBe("running");
  expect(response.capture_health).toEqual(health);
  expect(response.privacy.capture_scope).toContain("Foreground applications");
  expect(tool.description).toContain("No recent event alone does not establish failure");
  expect(tool.description).toContain("never infer that the user did not act");
});
test("status marks coverage as unknown when an older snapshot omits health", async () => {
  expect(JSON.parse(await status().execute()).capture_health).toBeNull();
});

test("status exposes the independent WeChat reader state instead of inferring it from screen recording", async () => {
  const connected = { enabled: true, connection: "connected", phase: null, error: null };
  const failed = { enabled: true, connection: "error", phase: null, error: "wechat_reader_unavailable" };
  expect(JSON.parse(await status(undefined, connected).execute()).wechat).toEqual(connected);
  expect(JSON.parse(await status(undefined, failed).execute()).wechat).toEqual(failed);
  expect(JSON.parse(await status().execute()).wechat).toBeNull();
});
