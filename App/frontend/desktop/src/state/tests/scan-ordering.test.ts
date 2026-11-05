import { describe, expect, it } from "vitest";
import { appActions as a } from "../app-actions.js";
import { appReducer as reduce, createInitialAppState } from "../app-reducer.js";
const version = (sequence: number, generation = 1) => ({ generation, sequence });
const progress = (sequence: number, phase: "scan" | "stopped" = "scan", attemptId = "a") => ({ version: version(sequence), jobId: "job", attemptId, sourceId: "all", phase, current: 1, total: 10 });
const completion = (sequence: number, attemptId = "a") => ({ version: version(sequence), jobId: "job", attemptId, sourceId: "all", succeeded: true, completedAt: "2026-10-21T00:00:00Z" });
const running = () => reduce(createInitialAppState(), a.agentSourceScanProgressReceived(progress(1)));
describe("authoritative scan order", () => {
  it("1/4: pause rejects old running; resume rejects old pause", () => {
    let state = running();
    state = reduce(state, a.agentSourceScanControl("pause", "p"));
    expect(state.agentSources.scanProgress?.phase).toBe("scan");
    state = reduce(state, a.agentSourceScanProgressReceived(progress(3, "stopped")));
    expect(reduce(state, a.agentSourceScanProgressReceived(progress(2)))).toBe(state);
    state = reduce(state, a.agentSourceScanProgressReceived(progress(4)));
    expect(reduce(state, a.agentSourceScanProgressReceived(progress(3, "stopped")))).toBe(state);
  });
  it("2: cancel retains execution and rejects delayed progress/completion", () => {
    let state = reduce(running(), a.agentSourceScanProgressReceived(progress(2, "stopped")));
    state = reduce(state, a.agentSourceScanStatusReceived({ version: version(3), status: "cancelled", execution: { jobId: "job", attemptId: "a" }, active: false, progress: null }));
    expect(state.agentSources.scanProgress).toBeNull();
    expect(state.agentSources.scanStamp?.attemptId).toBe("a");
    expect(reduce(state, a.agentSourceScanProgressReceived(progress(1)))).toBe(state);
    expect(reduce(state, a.agentSourceScanCompleted(completion(2)))).toBe(state);
    expect(state.agentSources.recentScanCompletions).toEqual([]);
  });
  it("3: completion wins over pending pause, is accepted once, and releases controls", () => {
    let state = reduce(running(), a.agentSourceScanControl("pause", "p"));
    state = reduce(state, a.agentSourceScanCompleted(completion(2)));
    expect(state.agentSources.scanControl).toBeNull();
    expect(state.agentSources.scanProgress).toBeNull();
    expect(state.agentSources.recentScanCompletions).toHaveLength(1);
    expect(reduce(state, a.agentSourceScanCompleted(completion(2)))).toBe(state);
    const duplicate = reduce(state, a.agentSourceScanCompleted(completion(3)));
    expect(duplicate.agentSources.scanStamp?.version).toEqual(version(3));
    expect(duplicate.agentSources.recentScanCompletions).toBe(state.agentSources.recentScanCompletions);
  });
  it("advances restored completion versions after restart without replaying feedback", () => {
    let state = reduce(running(), a.agentSourceScanCompleted(completion(2)));
    state = reduce(state, a.agentSourceScanCompletionExpired("job", "a"));
    state = reduce(state, a.agentSourceScanCompleted({ ...completion(0), version: version(0, 2) }));
    expect(state.agentSources.scanStamp?.version).toEqual(version(0, 2));
    expect(state.agentSources.recentScanCompletions).toEqual([]);
    state = reduce(state, a.agentSourceScanProgressReceived({ ...progress(1, "scan", "b"), version: version(1, 2) }));
    expect(state.agentSources.isScanning).toBe(true);
  });
  it("5/6: old idle and source-list results cannot clear a new scan", () => {
    let state = reduce(createInitialAppState(), a.agentSourceScanStarted());
    state = reduce(state, a.agentSourceScanProgressReceived(progress(2)));
    expect(reduce(state, a.agentSourceScanStatusReceived({ active: false, progress: null, version: version(1), status: "idle" }, 0))).toBe(state);
    expect(reduce(state, a.agentSourceScanStatusReceived({ active: false, progress: null }, 0))).toBe(state);
    state = reduce(state, a.agentSourcesLoaded([]));
    state = reduce(state, a.agentSourcesFailed("list failed"));
    expect(state.agentSources.scanProgress).toEqual(progress(2));
    expect(state.agentSources.isScanning).toBe(true);
  });
  it("accepts legacy cancellation only for the pending control and its execution", () => {
    const legacy = { ...progress(1), version: undefined };
    let state = reduce(createInitialAppState(), a.agentSourceScanProgressReceived(legacy));
    state = reduce(state, a.agentSourceScanControl("cancel", "cancel-a"));
    const idle = { active: false, progress: null };
    expect(reduce(state, a.agentSourceScanStatusReceived(idle))).toBe(state);
    expect(reduce(state, a.agentSourceScanStatusReceived(idle, undefined, { ...legacy, token: "old" }))).toBe(state);
    const confirmed = a.agentSourceScanStatusReceived(idle, undefined, { ...legacy, token: "cancel-a" });
    const newer = reduce(state, a.agentSourceScanProgressReceived({ ...legacy, jobId: "new-job", attemptId: "b" }));
    expect(reduce(newer, confirmed)).toBe(newer);
    state = reduce(state, confirmed);
    expect(state.agentSources.isScanning).toBe(false);
    expect(state.agentSources.scanProgress).toBeNull();
    expect(state.agentSources.scanControl).toBeNull();
    expect(reduce(state, a.agentSourceScanProgressReceived(legacy))).toBe(state);
    expect(reduce(state, a.agentSourceScanCompleted({ ...completion(2), version: undefined }))).toBe(state);
  });
  it("accepts newer terminal results from a query issued before control", () => {
    let state = reduce(running(), a.agentSourceScanControl("pause", "p"));
    state = reduce(state, a.agentSourceScanStatusReceived({ active: false, progress: null, version: version(4), status: "cancelled", execution: { jobId: "job", attemptId: "a" } }, 0));
    expect(state.agentSources.scanProgress).toBeNull();
  });
  it("recovery uses generation even if the wall clock moved backwards", () => {
    let state = reduce(createInitialAppState(), a.agentSourceScanProgressReceived({ ...progress(9), attemptStartedAt: "2026-10-21" }));
    state = reduce(state, a.agentSourceScanProgressReceived({ ...progress(0), version: version(0, 2), attemptId: "b", attemptStartedAt: "2026-10-20" }));
    expect(state.agentSources.scanProgress?.attemptId).toBe("b");
    expect(reduce(state, a.agentSourceScanProgressReceived(progress(100)))).toBe(state);
  });
  it("old attempt expiry/finally cannot clear new feedback/control", () => {
    let state = reduce(running(), a.agentSourceScanCompleted(completion(2)));
    state = reduce(state, a.agentSourceScanProgressReceived(progress(3, "scan", "b")));
    state = reduce(state, a.agentSourceScanCompleted(completion(4, "b")));
    state = reduce(state, a.agentSourceScanCompletionExpired("job", "a"));
    expect(state.agentSources.recentScanCompletions[0]?.attemptId).toBe("b");
    state = reduce(state, a.agentSourceScanControl("start", "new"));
    expect(reduce(state, a.agentSourceScanControl(null, "old"))).toBe(state);
    state = reduce(state, a.agentSourceScanCompletionExpired("job", "b"));
    expect(state.agentSources.recentScanCompletions).toEqual([]);
  });
});

it("reconciles a current legacy idle query after external cancellation and rejects late queries/events", () => {
  const legacy = { ...progress(1), version: undefined, attemptId: undefined };
  let state = reduce(createInitialAppState(), a.agentSourceScanProgressReceived(legacy));
  const generation = state.agentSources.scanRequestGeneration ?? 0;
  state = reduce(state, a.agentSourceScanStatusReceived({ active: false, progress: null }, generation));
  expect(state.agentSources.isScanning).toBe(false);
  expect(state.agentSources.scanProgress).toBeNull();
  expect(reduce(state, a.agentSourceScanStatusReceived({ active: true, progress: legacy }, generation))).toBe(state);
  expect(reduce(state, a.agentSourceScanProgressReceived(legacy))).toBe(state);
  const next = reduce(state, a.agentSourceScanProgressReceived({ ...legacy, jobId: "new" }));
  expect(next.agentSources.isScanning).toBe(true);
});

it("does not let a current legacy idle poll acknowledge a pending resume", () => {
  let state = reduce(createInitialAppState(), a.agentSourceScanProgressReceived({ ...progress(1, "stopped"), version: undefined, attemptId: undefined }));
  state = reduce(state, a.agentSourceScanControl("resume", "pending"));
  expect(reduce(state, a.agentSourceScanStatusReceived({ active: false, progress: null }, state.agentSources.scanRequestGeneration))).toBe(state);
});

it("rejects legacy idle queries issued before another page's new execution was observed", () => {
  let state = createInitialAppState();
  const generation = state.agentSources.scanRequestGeneration ?? 0;
  state = reduce(state, a.agentSourceScanProgressReceived({ ...progress(1), version: undefined, attemptId: undefined }));
  expect(reduce(state, a.agentSourceScanStatusReceived({ active: false, progress: null }, generation))).toBe(state);
});

it("preserves failure feedback when a restored failed attempt advances generation", () => {
  let state = reduce(running(), a.agentSourceScanCompleted({ ...completion(2), succeeded: false }));
  state = reduce(state, a.agentSourcesFailed("Import failed: unreadable history"));
  const recent = state.agentSources.recentScanCompletions;
  state = reduce(state, a.agentSourceScanCompleted({ ...completion(0), succeeded: false, version: version(0, 2) }));
  expect(state.agentSources.error).toBe("Import failed: unreadable history");
  expect(state.agentSources.scanStamp?.version).toEqual(version(0, 2));
  expect(state.agentSources.recentScanCompletions).toBe(recent);
});

for (const refresh of [a.agentSourcesLoading(), a.agentSourcesLoaded([]), a.agentSourcesRefreshed([])]) {
  it(`retains failed scan feedback across ${refresh.type} and restart, until retry`, () => {
    let state = reduce(running(), a.agentSourceScanCompleted({ ...completion(2), succeeded: false }));
    state = reduce(state, a.agentSourcesFailed("Import failed: unreadable history"));
    state = reduce(state, a.agentSourceScanCompletionExpired("job", "a"));
    state = reduce(state, refresh);
    expect(state.agentSources.error).toBe("Import failed: unreadable history");
    state = reduce(state, a.agentSourceScanCompleted({ ...completion(0), succeeded: false, version: version(0, 2) }));
    expect(state.agentSources.error).toBe("Import failed: unreadable history");
    state = reduce(state, a.agentSourceScanStarted());
    expect(state.agentSources.error).toBeNull();
  });
}


describe("completion feedback after memory clear", () => {
  const completed = () => reduce(createInitialAppState(), a.agentSourceScanCompleted(completion(2)));
  const synchronize = (state: ReturnType<typeof createInitialAppState>, sequence = 3) => reduce(state,
    a.agentSourceScanStateSynchronized(state.agentSources.scanStateSyncGeneration,
      { active: false, progress: null, status: "idle", version: version(sequence) }, []));

  it.each(["all", "codex"])("expires old %s feedback only after successful clear synchronization", (sourceId) => {
    const oldCompletion = { ...completion(2), sourceId };
    let state = reduce(createInitialAppState(), a.agentSourceScanCompleted(oldCompletion));
    state = reduce(state, a.agentSourceClearStarted(version(2)));
    expect(state.agentSources.recentScanCompletions).toEqual([oldCompletion]);
    state = reduce(state, a.agentSourceClearFinished(true));
    expect(synchronize(state, 2)).toBe(state); // A pre-clear snapshot must not unlock or expire feedback.
    expect(state.agentSources.recentScanCompletions).toEqual([oldCompletion]);
    state = synchronize(state);
    expect(state.agentSources.scanStateSyncRequired).toBe(false);
    expect(state.agentSources.recentScanCompletions).toEqual([]);
    expect(reduce(state, a.agentSourceScanCompleted(oldCompletion))).toBe(state);
  });

  it("preserves feedback after a failed clear", () => {
    let state = reduce(completed(), a.agentSourceClearStarted(version(2)));
    state = reduce(state, a.agentSourceClearFinished(false));
    state = synchronize(state, 2);
    expect(state.agentSources.scanStateSyncRequired).toBe(false);
    expect(state.agentSources.recentScanCompletions).toEqual([completion(2)]);
  });

  it("keeps a newer completion that arrives before the clear snapshot is applied", () => {
    let state = reduce(completed(), a.agentSourceClearStarted(version(2)));
    state = reduce(state, a.agentSourceClearFinished(true));
    const newer = { ...completion(4, "new"), jobId: "new-job", sourceId: "codex" };
    state = reduce(state, a.agentSourceScanCompleted(newer));
    state = synchronize(state);
    expect(state.agentSources.recentScanCompletions).toEqual([newer]);
    expect(state.agentSources.scanStamp?.version).toEqual(version(4));
  });
});
