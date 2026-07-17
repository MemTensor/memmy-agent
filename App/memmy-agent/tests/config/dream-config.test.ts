import { describe, expect, it } from "vitest";
import { DreamConfig } from "../../src/config/schema.js";

describe("DreamConfig", () => {
  it("defaults to interval hours", () => {
    const cfg = new DreamConfig();

    expect(cfg.intervalH).toBe(2);
    expect(cfg.cron).toBeNull();
  });

  it("builds every schedules from intervalH", () => {
    const cfg = new DreamConfig({ intervalH: 3 });
    const schedule = cfg.buildSchedule("UTC");

    expect(schedule.kind).toBe("every");
    expect(schedule.everyMs).toBe(3 * 3_600_000);
    expect(schedule.expr).toBeNull();
  });

  it("honors legacy cron overrides", () => {
    const cfg = DreamConfig.fromObject({ cron: "0 */4 * * *" });
    const schedule = cfg.buildSchedule("UTC");

    expect(schedule.kind).toBe("cron");
    expect(schedule.expr).toBe("0 */4 * * *");
    expect(schedule.tz).toBe("UTC");
    expect(cfg.describeSchedule()).toBe("cron 0 */4 * * * (legacy)");
  });

  it("dumps intervalH and hides legacy cron", () => {
    const cfg = DreamConfig.fromObject({ intervalH: 5, cron: "0 */4 * * *" });
    const dumped = cfg.toObject();

    expect(dumped.intervalH).toBe(5);
    expect(dumped).not.toHaveProperty("cron");
  });

  it("uses modelOverride", () => {
    const cfg = DreamConfig.fromObject({ modelOverride: "openrouter/sonnet" });
    const dumped = cfg.toObject();

    expect(cfg.modelOverride).toBe("openrouter/sonnet");
    expect(dumped.modelOverride).toBe("openrouter/sonnet");
    expect(dumped).not.toHaveProperty("model");
  });

  it("validates bounded schedule and batch fields", () => {
    expect(() => new DreamConfig({ intervalH: 0 })).toThrow(/intervalH/);
    expect(() => new DreamConfig({ maxBatchSize: 0 })).toThrow(/maxBatchSize/);
    expect(() => new DreamConfig({ maxIterations: 0 })).toThrow(/maxIterations/);

    const cfg = new DreamConfig({ intervalH: 1, maxBatchSize: 1, maxIterations: 1 });

    expect(cfg.intervalH).toBe(1);
    expect(cfg.maxBatchSize).toBe(1);
    expect(cfg.maxIterations).toBe(1);
  });
});
