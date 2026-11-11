import { describe, expect, it } from "vitest";
import { DEFAULT_LANE_WEIGHTS } from "../../../src/service/worker/lane-queue-selector.js";
import {
  resolveWorkerSchedulingOptions, type WorkerSchedulingOptions
} from "../../../src/service/worker/worker-scheduling-options.js";

describe("worker scheduling configuration", () => {
  it("defaults to real WRR and the confirmed 4/3/2/2/1 weights", () => {
    const actual = resolveWorkerSchedulingOptions(undefined, {});
    expect(actual).toEqual({ algorithm: "wrr", laneWeights: DEFAULT_LANE_WEIGHTS, aging: { enabled: true, thresholdMs: 300_000 } });
    expect(Object.isFrozen(actual)).toBe(true);
    expect(Object.isFrozen(actual.laneWeights)).toBe(true);
  });

  it("provides an explicit legacy rollback through the environment", () => {
    expect(resolveWorkerSchedulingOptions(undefined, { MEMMY_WORKER_SCHEDULER_ALGORITHM: " legacy " }).algorithm).toBe("legacy");
    expect(resolveWorkerSchedulingOptions(undefined, { MEMMY_WORKER_SCHEDULER_ALGORITHM: "WRR" }).algorithm).toBe("wrr");
    expect(resolveWorkerSchedulingOptions(undefined, { MEMMY_WORKER_SCHEDULER_ALGORITHM: "  " }).algorithm).toBe("wrr");
  });

  it("reads complete runtime weight objects and keeps override precedence field by field", () => {
    const custom = { ...DEFAULT_LANE_WEIGHTS, import: 5 };
    expect(resolveWorkerSchedulingOptions({ algorithm: "legacy" }, {
      MEMMY_WORKER_SCHEDULER_ALGORITHM: "wrr", MEMMY_WORKER_LANE_WEIGHTS: JSON.stringify(custom)
    })).toEqual({ algorithm: "legacy", laneWeights: custom, aging: { enabled: false, thresholdMs: 300_000 } });
    expect(resolveWorkerSchedulingOptions({ laneWeights: custom }, {
      MEMMY_WORKER_SCHEDULER_ALGORITHM: "legacy", MEMMY_WORKER_LANE_WEIGHTS: "invalid ignored override"
    })).toEqual({ algorithm: "legacy", laneWeights: custom, aging: { enabled: false, thresholdMs: 300_000 } });
    expect(resolveWorkerSchedulingOptions({ algorithm: "wrr", laneWeights: custom }, {
      MEMMY_WORKER_SCHEDULER_ALGORITHM: "invalid ignored override", MEMMY_WORKER_LANE_WEIGHTS: "{}"
    })).toEqual({ algorithm: "wrr", laneWeights: custom, aging: { enabled: true, thresholdMs: 300_000 } });
  });

  it("configures bounded aging explicitly while keeping the legacy rollback disabled", () => {
    expect(resolveWorkerSchedulingOptions(undefined, { MEMMY_WORKER_AGING_ENABLED: "false", MEMMY_WORKER_AGING_THRESHOLD_MS: "600000" }).aging)
      .toEqual({ enabled: false, thresholdMs: 600_000 });
    expect(resolveWorkerSchedulingOptions({ aging: { enabled: true, thresholdMs: 1000 } }, {
      MEMMY_WORKER_AGING_ENABLED: "invalid override", MEMMY_WORKER_AGING_THRESHOLD_MS: "invalid override"
    }).aging).toEqual({ enabled: true, thresholdMs: 1000 });
    expect(resolveWorkerSchedulingOptions({ algorithm: "legacy", aging: { enabled: true } }, {}).aging.enabled).toBe(false);
  });

  it.each(["", "maybe", "yes", "2"])("rejects malformed aging flags %j", flag => {
    expect(() => resolveWorkerSchedulingOptions(undefined, { MEMMY_WORKER_AGING_ENABLED: flag })).toThrow();
  });

  it.each(["", "0", "-1", "1.1", "NaN", "Infinity", "bad"])("rejects malformed aging thresholds %j", threshold => {
    expect(() => resolveWorkerSchedulingOptions(undefined, { MEMMY_WORKER_AGING_THRESHOLD_MS: threshold })).toThrow();
  });

  it.each([null, [], { enabled: "true" }, { enabled: null }, { thresholdMs: null }, { thresholdMs: -1 }])(
    "rejects invalid dependency aging values %j", aging => {
      expect(() => resolveWorkerSchedulingOptions({ aging } as unknown as WorkerSchedulingOptions, {})).toThrow();
    }
  );

  it.each(["fifo", "shadow", "wrrr", "false"])("rejects an unknown algorithm %s instead of silently selecting a policy", (algorithm) => {
    expect(() => resolveWorkerSchedulingOptions(undefined, { MEMMY_WORKER_SCHEDULER_ALGORITHM: algorithm })).toThrow("must be wrr or legacy");
  });

  it.each(["not-json", "null", "[]", "{}", '{"interactive":4}',
    JSON.stringify({ ...DEFAULT_LANE_WEIGHTS, maintenance: 0 }),
    JSON.stringify({ ...DEFAULT_LANE_WEIGHTS, future: 1 })
  ])("rejects incomplete or malformed environment weights %s", (encoded) => {
    expect(() => resolveWorkerSchedulingOptions(undefined, { MEMMY_WORKER_LANE_WEIGHTS: encoded })).toThrow();
  });

  it("validates dependency values at runtime instead of relying solely on TypeScript", () => {
    expect(() => resolveWorkerSchedulingOptions({ algorithm: "bad" } as unknown as WorkerSchedulingOptions, {})).toThrow();
    expect(() => resolveWorkerSchedulingOptions({ laneWeights: null } as unknown as WorkerSchedulingOptions, {})).toThrow();
  });
});
