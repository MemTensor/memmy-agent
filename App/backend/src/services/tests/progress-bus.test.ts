/** Progress bus tests. */
import { describe, expect, it } from "vitest";
import { createProgressBus } from "../progress-bus.js";

describe("progress bus", () => {
  it("emits typed scan progress and supports unsubscribe", () => {
    const bus = createProgressBus();
    const received: string[] = [];
    const unsubscribe = bus.on("agent_source.scan_progress", (event) => {
      received.push(event.phase);
    });

    bus.emit("agent_source.scan_progress", {
      jobId: "job-1",
      sourceId: "cursor",
      phase: "scan",
      current: 0,
      total: 1
    });
    unsubscribe();
    bus.emit("agent_source.scan_progress", {
      jobId: "job-1",
      sourceId: "cursor",
      phase: "done",
      current: 1,
      total: 1
    });

    expect(received).toEqual(["scan"]);
  });
});
