import { describe, expect, it } from "vitest";
import { PanelLogsOutputSchema, PanelStatsOutputSchema, PanelOverviewStatsOutputSchema,
  PanelBrowseOutputSchema, PanelTaskSummariesOutputSchema, PanelTaskCheckOutputSchema } from "../../local-api-contracts/src/index.js";
import { createMockMemoryClient } from "./support/mock-memory-client.js";

const now = () => "2026-11-06T00:00:00.000Z";
describe("shared mock client contracts", () => {
  it("implements the synchronized panel read contracts without inventing missing detail records", async () => {
    const client = createMockMemoryClient({ now });
    expect(PanelLogsOutputSchema.parse(await client.panelLogs({ limit: 7, offset: 2 })))
      .toMatchObject({ logs: [], total: 0, limit: 7, offset: 2, serverTime: now() });
    expect(PanelStatsOutputSchema.parse(await client.panelStats()))
      .toMatchObject({ status: "ready", data: { overview: { counts: { memories: 0 } } }, serverTime: now() });
    expect(PanelOverviewStatsOutputSchema.parse(await client.panelOverviewStats()))
      .toMatchObject({ status: "ready", data: { counts: { memories: 0 } }, serverTime: now() });
    expect(PanelBrowseOutputSchema.parse(await client.panelBrowse({ op: "create" })))
      .toMatchObject({ items: [], total: 0, serverTime: now() });
    expect(PanelBrowseOutputSchema.parse(await client.panelBrowse({ op: "page", viewId: "mock-view", filter: { section: "tasks" } })))
      .toMatchObject({ tasks: [], total: 0, serverTime: now() });
    expect(PanelBrowseOutputSchema.parse(await client.panelBrowse({ op: "check", viewId: "mock-view" })))
      .toMatchObject({ viewId: "mock-view", updated: false, serverTime: now() });
    expect(PanelBrowseOutputSchema.parse(await client.panelBrowse({ op: "release", viewId: "mock-view" })))
      .toEqual({ ok: true });
    expect(PanelTaskSummariesOutputSchema.parse(await client.panelTaskSummaries({ page: 1 })))
      .toMatchObject({ tasks: [], total: 0, serverTime: now() });
    expect(PanelTaskCheckOutputSchema.parse(await client.panelTaskCheck("task-1")))
      .toEqual({ serverTime: now() });
    await expect(client.panelLogDetail(1)).rejects.toMatchObject({ status: 404 });
    await expect(client.panelTaskDetail("task-1")).rejects.toMatchObject({ status: 404 });
    await expect(client.panelTaskField("task-1", "turn-1", { field: "userText" })).rejects.toMatchObject({ status: 404 });
  });

  it("keeps failure simulation on every synchronized panel method", async () => {
    const client = createMockMemoryClient({ now, failureRate: 1 });
    const reads = [
      () => client.panelLogs({}), () => client.panelLogDetail(1), () => client.panelStats(),
      () => client.panelOverviewStats(), () => client.panelBrowse({ op: "create" }),
      () => client.panelTaskSummaries({ page: 1 }), () => client.panelTaskCheck("task-1"),
      () => client.panelTaskDetail("task-1"), () => client.panelTaskField("task-1", "turn-1", { field: "userText" })
    ];
    for (const read of reads) await expect(read()).rejects.toThrow("mock-induced failure");
  });
});
