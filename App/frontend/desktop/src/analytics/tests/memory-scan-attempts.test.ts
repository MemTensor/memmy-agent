import { afterEach, expect, it, vi } from "vitest";
import { trackCloudAnalyticsEvent } from "../cloud-analytics.js";
import { recordScanStarted, resetMemoryUiScanAnalyticsForTests, trackAgentSourceScanOutcome } from "../memory-ui-analytics.js";
vi.mock("../cloud-analytics.js", () => ({ trackCloudAnalyticsEvent: vi.fn() }));
afterEach(() => { resetMemoryUiScanAnalyticsForTests(); vi.clearAllMocks(); });
it("tracks retries independently and deduplicates SSE plus polling for each attempt", () => {
  for (const attemptId of ["first", "second"]) {
    recordScanStarted("same-job", { attemptId, sourceId: "cursor", scanMode: "full", pagePath: "/memory/sources", subPage: "sources" });
    const outcome = { jobId: "same-job", attemptId, sourceId: "cursor", succeeded: attemptId === "second" };
    trackAgentSourceScanOutcome(outcome);
    trackAgentSourceScanOutcome(outcome);
  }
  expect(trackCloudAnalyticsEvent).toHaveBeenCalledTimes(2);
  expect(trackCloudAnalyticsEvent).toHaveBeenNthCalledWith(1, "memory_source_scan_failed", expect.objectContaining({ scan_mode: "full" }));
  expect(trackCloudAnalyticsEvent).toHaveBeenNthCalledWith(2, "memory_source_scan_completed", expect.objectContaining({ scan_mode: "full" }));
});
