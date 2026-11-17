import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelStats, type PanelStatsData } from "../../../src/service/panel/stats.js";
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());
describe("background panel stats", () => {
  it("keeps explicit user scopes separate even when the namespace is the same", async () => {
    const read = vi.fn(async (input: { userId?: string }) => ({
      safety: "a",
      data: { overview: { user: input.userId }, analysis: {} } as never
    }));
    const stats = new PanelStats<PanelStatsData>(read, () => "a");
    try {
      stats.get({ userId: "first", timeZone: "UTC" });
      stats.get({ userId: "second", timeZone: "UTC" });
      await tick();
      expect(read).toHaveBeenCalledTimes(2);
      expect(stats.get({ userId: "second", timeZone: "UTC" }).data?.overview).toEqual({ user: "second" });
      expect(stats.get({ userId: "first", timeZone: "UTC" }).data?.overview).toEqual({ user: "first" });
    } finally {
      stats.stop();
    }
  });
  it("publishes atomically and retains safe data on failure, but never after reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T01:00:00Z"));
    let safety = "a";
    let fail = false;
    const read = vi.fn(async () => {
      if (fail) throw new Error("busy");
      return { safety, data: { overview: {}, analysis: {} } as never };
    });
    const stats = new PanelStats<PanelStatsData>(read, () => safety);
    expect(stats.get({ timeZone: "UTC" }).status).toBe("preparing");
    await tick();
    expect(stats.get({ timeZone: "UTC" }).status).toBe("ready");
    fail = true;
    await vi.advanceTimersByTimeAsync(300000);
    expect(stats.get({ timeZone: "UTC" })).toMatchObject({ status: "error", data: { overview: {}, analysis: {} } });
    safety = "b";
    expect(stats.get({ timeZone: "UTC" })).toMatchObject({ status: "preparing", data: undefined });
    stats.stop();
  });
  it("does not publish a computation spanning midnight and recalculates for the new day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T23:59:59Z"));
    let finish!: (value: { safety: string; data: never }) => void;
    const read = vi.fn(
      () =>
        new Promise<{ safety: string; data: never }>((resolve) => {
          finish = resolve;
        })
    );
    const stats = new PanelStats<PanelStatsData>(read, () => "a");
    stats.get({ timeZone: "UTC" });
    vi.setSystemTime(new Date("2026-10-28T00:00:01Z"));
    finish({ safety: "a", data: {} as never });
    await tick();
    expect(stats.get({ timeZone: "UTC" }).data).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    stats.stop();
  });
  it("does not revive evicted or stopped entries when in-flight work finishes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T01:00:00Z"));
    const finishes: Array<() => void> = [];
    const read = vi.fn(
      () =>
        new Promise<{ safety: string; data: never }>((resolve) =>
          finishes.push(() => resolve({ safety: "a", data: {} as never }))
        )
    );
    const stats = new PanelStats<PanelStatsData>(read, () => "a");
    for (let i = 0; i < 17; i++) stats.get({ namespace: { userId: String(i), source: "codex", profileId: "default" } });
    finishes[0]!();
    await tick();
    await vi.advanceTimersByTimeAsync(300000);
    expect(read).toHaveBeenCalledTimes(17);
    stats.stop();
    for (const finish of finishes) finish();
    await tick();
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("coalesces ordinary write revisions without blanking a safe snapshot",async()=>{
  vi.useFakeTimers();
  let revision="2:1",count=1;
  const read=vi.fn(async()=>({safety:"safe",data:{overview:{count},analysis:{}} as never}));
  const stats=new PanelStats<PanelStatsData>(read,()=>"safe",()=>revision);
  try{
    stats.get({});await tick();expect(stats.get({}).data?.overview).toEqual({count:1});
    revision="2:2";count=2;
    expect(stats.get({})).toMatchObject({status:"ready",data:{overview:{count:1}}});
    await vi.advanceTimersByTimeAsync(1000);await tick();expect(stats.get({}).data?.overview).toEqual({count:2});
    expect(read).toHaveBeenCalledTimes(2);
  }finally{stats.stop();vi.useRealTimers();}
});
