import { assignedEpisodeId } from "../../fixtures/memory-service-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import { Repositories } from "../../../src/storage/repositories.js";
import { selectionInput, type EpisodeSelectionInput } from "../../../src/service/session/episode-selection.js";
import { stableHash } from "../../../src/utils/id.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { createTurnJudgeLlm, openSession, turnJudgeConfig, l1For } from "./turn-judge-llm.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

function setup() {
  const calls: EpisodeSelectionInput[] = [];
  const { llm } = createTurnJudgeLlm({
    B: () => ({ relation: "new_task", feedback: "neutral", reason: "switch", l1: l1For("B task"), user: null }),
    C: () => ({ relation: "new_task", feedback: "neutral", reason: "switch", l1: l1For("C task"), user: null }),
    A2: () => ({ relation: "new_task", feedback: "neutral", reason: "return", l1: l1For("A2 resume"), user: null })
  });
  const original = llm.completeJson.bind(llm);
  llm.completeJson = async <T extends Record<string, unknown>>(messages: Parameters<typeof original>[0], options: Parameters<typeof original>[1]): Promise<T> => {
    if (options.operation !== "episode.select.v1") return original<T>(messages, options);
    expect(fixture.db.db.inTransaction).toBe(false);
    const input = JSON.parse(messages[1]!.content) as EpisodeSelectionInput;
    calls.push(input);
    const task = input.userText.startsWith("A2") ? "A task" : input.userText.startsWith("B2") ? "B task" : undefined;
    const match = task ? input.candidates.find(c => c.summary.includes(task) || c.users.some(u => u.text === task)) : undefined;
    return { episodeId: match?.episodeId ?? null, title: input.userText, summary: input.userText.startsWith("A") ? "A task" : "B task" } as unknown as T;
  };
  const fixture = createTestService({ llm, config: turnJudgeConfig() });
  const repos = new Repositories(fixture.db.db);
  return { ...fixture, repos, calls, llm };
}
async function settle(service: ReturnType<typeof setup>["service"]) {
  for (let i = 0; i < 4; i++) await service.runWorkerOnce(30);
}

describe("episode selection before creation", () => {
  it("ABA reuses A's ID with exactly two nonempty episodes, even without any summaries", async () => {
    const { service, repos, calls, db } = setup();
    const session = openSession(service, "aba");
    const a = await service.completeTurn("a1", { sessionId: session.sessionId, query: "A task", answer: "assistant-secret-A" });
    await settle(service);
    const b = await service.completeTurn("b1", { sessionId: session.sessionId, query: "B task", answer: "assistant-secret-B" });
    await settle(service);
    const bid = repos.runtime.getRawTurn(b.rawTurnId)!.episodeId;
    expect(bid).not.toBe(assignedEpisodeId(service, a));
    db.db.prepare("UPDATE episodes SET title = NULL, summary = NULL, meta_json = '{}' WHERE session_id = ?").run(session.sessionId);
    const a2 = await service.completeTurn("a2", { sessionId: session.sessionId, query: "A2 resume", answer: "assistant-secret-A2" });
    await settle(service);
    expect(repos.runtime.getRawTurn(a2.rawTurnId)?.episodeId).toBe(assignedEpisodeId(service, a));
    const episodes = repos.runtime.listEpisodesForSession(session.sessionId);
    expect(episodes).toHaveLength(2);
    expect(episodes.every(e => e.rawTurnIds.length > 0)).toBe(true);
    expect(repos.runtime.getEpisode(assignedEpisodeId(service, a))?.status).toBe("open");
    expect(repos.runtime.getEpisode(bid)?.status).toBe("closed");
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls.at(-1))).not.toContain("assistant-secret");
    expect(JSON.stringify(calls.at(-1)!.candidates)).not.toContain("A2 resume");
    expect(repos.memories.get(a2.l1MemoryId)?.info.episode_id).toBe(assignedEpisodeId(service, a));
  });

  it("resumes a closed task without creating a provisional empty episode", async () => {
    const { service, repos, calls } = setup();
    const session = openSession(service, "closed");
    const a = await service.completeTurn("a1", { sessionId: session.sessionId, query: "A task", answer: "done" });
    await settle(service);
    repos.runtime.closeEpisode(assignedEpisodeId(service, a), { closeReason: "end_topic" });
    const resumed = await service.completeTurn("a2", { sessionId: session.sessionId, query: "A2 resume", answer: "continued" });
    expect(repos.runtime.listEpisodesForSession(session.sessionId)).toHaveLength(1);
    await settle(service);
    expect(repos.runtime.listEpisodesForSession(session.sessionId)).toHaveLength(1);
    expect(repos.runtime.getRawTurn(resumed.rawTurnId)?.episodeId).toBe(assignedEpisodeId(service, a));
    expect(calls).toHaveLength(2);
    expect(repos.runtime.getEpisode(assignedEpisodeId(service, a))?.status).toBe("open");
  });

  it("does not offer episodes from another session", async () => {
    const { service, calls } = setup();
    const a = openSession(service, "session-one");
    await service.completeTurn("a1", { sessionId: a.sessionId, query: "A task", answer: "done" });
    const b = openSession(service, "session-two");
    await service.completeTurn("a2", { sessionId: b.sessionId, query: "A2 resume", answer: "done" });
    await settle(service);
    expect(calls.at(-1)?.candidates).toEqual([]);
  });

  it("adds only uncovered user messages and excludes the current and later turns", async () => {
    const { service, repos } = setup();
    const session = openSession(service, "coverage");
    const first = await service.completeTurn("t1", { sessionId: session.sessionId, query: "A task", answer: "secret one" });
    const second = await service.completeTurn("t2", { sessionId: session.sessionId, query: "add rollback", answer: "secret two" });
    const third = await service.completeTurn("t3", { sessionId: session.sessionId, query: "current", answer: "secret three" });
    await service.completeTurn("t4", { sessionId: session.sessionId, query: "future", answer: "secret four" });
    await settle(service);
    repos.runtime.updateEpisodeTitle(assignedEpisodeId(service, first), { title: "A", summary: "A task", meta: {
      episodeTitle: { coveredUserTurns: [{ id: first.rawTurnId, hash: stableHash("A task") }] }
    } });
    const input = selectionInput(repos, repos.runtime.getSession(session.sessionId)!, { userText: "current", rawTurnId: third.rawTurnId });
    expect(input.candidates[0]).toEqual({ episodeId: assignedEpisodeId(service, first), title: "A", summary: "A task", users: [{ rawTurnId: second.rawTurnId, text: "add rollback" }] });
    expect(JSON.stringify(input)).not.toMatch(/secret|future/);
  });

  it("ABAB repeatedly reopens the two original tasks without empty records", async () => {
    const { service, repos, db } = setup();
    const session = openSession(service, "abab");
    const ids: string[] = [];
    for (const [index, query] of ["A task", "B task", "A2 resume", "B2 resume"].entries()) {
      const turn = await service.completeTurn(`t${index}`, { sessionId: session.sessionId, query, answer: "done" });
      await settle(service);
      ids.push(assignedEpisodeId(service, turn));
      db.db.prepare("UPDATE episodes SET summary = NULL, title = NULL WHERE session_id = ?").run(session.sessionId);
    }
    expect(ids[0]).toBe(ids[2]);
    expect(ids[1]).toBe(ids[3]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(repos.runtime.listEpisodesForSession(session.sessionId)).toHaveLength(2);
    expect(repos.runtime.listEpisodesForSession(session.sessionId).every(e => e.rawTurnIds.length === 2)).toBe(true);
  });

  it("ABC keeps genuinely distinct tasks separate", async () => {
    const { service, repos } = setup();
    const session = openSession(service, "abc");
    for (const query of ["A task", "B task", "C task"]) {
      await service.completeTurn(query, { sessionId: session.sessionId, query, answer: "done" });
      await settle(service);
    }
    const episodes = repos.runtime.listEpisodesForSession(session.sessionId);
    expect(episodes).toHaveLength(3);
    expect(episodes.every(e => e.rawTurnIds.length === 1)).toBe(true);
  });

  it("rebuilds changed candidates after the model returns instead of committing a stale decision", async () => {
    const { service, repos, llm, calls } = setup();
    const session = openSession(service, "stale");
    const a = await service.completeTurn("a", { sessionId: session.sessionId, query: "A task", answer: "done" });
    await settle(service);
    const complete = llm.completeJson;
    let changed = false;
    llm.completeJson = async <T extends Record<string, unknown>>(messages: Parameters<typeof complete>[0], options: Parameters<typeof complete>[1]): Promise<T> => {
      const result = await complete<T>(messages, options);
      if (options.operation === "episode.select.v1" && !changed) {
        changed = true;
        repos.runtime.updateEpisodeTitle(assignedEpisodeId(service, a), { title: "updated A", summary: "A task changed while model waited" });
      }
      return result;
    };
    await service.completeTurn("b", { sessionId: session.sessionId, query: "B task", answer: "done" });
    await settle(service);
    expect(calls.filter(c => c.userText === "B task")).toHaveLength(2);
    expect(calls.at(-1)!.candidates.find(c => c.episodeId === assignedEpisodeId(service, a))?.summary).toContain("changed while model waited");
    expect(repos.runtime.listEpisodesForSession(session.sessionId)).toHaveLength(2);
  });

  it("rejects an invented episode ID before any episode is created", async () => {
    const { service, repos, llm } = setup();
    llm.completeJson = async <T extends Record<string, unknown>>() => ({ episodeId: "foreign", title: "bad", summary: "bad" } as unknown as T);
    const session = openSession(service, "invalid");
    const saved = await service.completeTurn("x", { sessionId: session.sessionId, query: "A task", answer: "done" });
    await settle(service);
    expect(repos.runtime.getRawTurn(saved.rawTurnId)?.userText).toBe("A task");
    expect(repos.runtime.listJobs().find(j => j.jobType === "episode_assignment")?.lastError).toContain("invalid episode selection");
    expect(repos.runtime.listEpisodesForSession(session.sessionId)).toEqual([]);
  });

  it("creates the episode offline when the summary model is unconfigured in turn-judge mode", async () => {
    const { service, repos, llm } = setup();
    llm.isConfigured = () => false;
    const session = openSession(service, "unconfigured");
    await service.completeTurn("x", { sessionId: session.sessionId, query: "A task", answer: "done" });
    expect(repos.runtime.listEpisodesForSession(session.sessionId)).toHaveLength(1);
  });

  it("model failure leaves no empty episode and a retry succeeds once", async () => {
    const { service, repos, llm, db } = setup();
    const complete = llm.completeJson;
    llm.completeJson = async () => { throw new Error("summary unavailable"); };
    const session = openSession(service, "retry");
    const request = { sessionId: session.sessionId, query: "A task", answer: "done" };
    const accepted = await service.completeTurn("x", request);
    await settle(service);
    expect(repos.runtime.getRawTurn(accepted.rawTurnId)?.userText).toBe(request.query);
    expect(repos.runtime.listEpisodesForSession(session.sessionId)).toEqual([]);
    llm.completeJson = complete;
    db.db.prepare("UPDATE evolution_jobs SET status='queued',attempts=0,failure_count=0,available_at=NULL,blocked_reason=NULL,leased_until=NULL,lease_owner=NULL,lease_token=NULL WHERE status IN ('failed','dead_letter')").run();
    await settle(service);
    const first = await service.completeTurn("x", request);
    const retry = await service.completeTurn("x", request);
    expect(retry.rawTurnId).toBe(first.rawTurnId);
    expect(repos.runtime.listEpisodesForSession(session.sessionId)).toHaveLength(1);
  });
});
