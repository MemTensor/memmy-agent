import { afterEach, expect, it, vi } from "vitest";
import { createMemoryHttpServer, closeMemoryHttpServer } from "../../src/server/http.js";
import { createBatchReflectionLlm, createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";
import { turnJudgeConfig } from "../service/session/turn-judge-llm.js";
import { panelSafetyToken } from "../../src/storage/panel-security.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);

it.each([true, false])("preserves fixed HTTP pages through a new turn's first background assignment (turn judge: %s)", async turnJudge => {
  const llm = createBatchReflectionLlm([]);
  const complete = llm.completeJson.bind(llm);
  let release!: () => void;
  const selection = new Promise<void>(resolve => { release = resolve; });
  llm.completeJson = async (messages, options) => {
    if (options.operation === "episode.select.v1") await selection;
    return complete(messages, options);
  };
  const { service, db, root } = fixture.createTestService({ llm, config: turnJudgeConfig(turnJudge) });
  for (let i = 0; i < 55; i++) service.addMemory({ content: `fixed HTTP member ${i}`, source: "codex" });
  const server = createMemoryHttpServer({ service, configPath: `${root}/synthetic-config.json`,
    auth: { localServiceToken: "synthetic-first-assignment" } });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener");
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/${path}`, { method: "POST",
        headers: { authorization: "Bearer synthetic-first-assignment", "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return response.json();
    };
    const filter = { section: "items", layer: "L1" };
    const view = await post("panel/browse", { op: "create", filter });
    const tasks = await post("panel/browse", { op: "create", filter: { section: "tasks" } });
    expect(view.total).toBe(55);
    expect(tasks.total).toBe(0);
    const second = await post("panel/browse", { op: "page", viewId: view.viewId, page: 2 });
    expect(second.items).toHaveLength(20);
    const safety = panelSafetyToken(db.db);
    const session = await post("sessions/open", {});
    const turn = await post("turns/new-during-browse/complete", { sessionId: session.sessionId,
      query: "A new task while the user browses page two", answer: "A complete answer" });
    expect(db.db.prepare("SELECT episode_id FROM raw_turns WHERE id=?").get(turn.rawTurnId)).toEqual({ episode_id: null });
    expect(await post("panel/browse", { op: "check", viewId: view.viewId })).toMatchObject({ updated: true });
    release();
    await vi.waitFor(() => {
      const raw = db.db.prepare("SELECT episode_id,message_payload_json FROM raw_turns WHERE id=?").get(turn.rawTurnId) as { episode_id: string | null; message_payload_json: string };
      expect(raw.episode_id).toBeTruthy();
      expect(JSON.parse(raw.message_payload_json).episode_assignment.status).toBe("assigned");
    }, { timeout: 5000 });
    expect(panelSafetyToken(db.db)).toBe(safety);
    expect(await post("panel/browse", { op: "check", viewId: view.viewId })).toMatchObject({ updated: true });
    const repeat = await post("panel/browse", { op: "page", viewId: view.viewId, page: 2 });
    const third = await post("panel/browse", { op: "page", viewId: view.viewId, page: 3 });
    expect(repeat).toMatchObject({ viewId: view.viewId, page: 2, total: 55, items: second.items });
    expect(third).toMatchObject({ viewId: view.viewId, page: 3, total: 55 });
    expect(third.items).toHaveLength(15);
    expect(new Set([...second.items, ...third.items].map((item: { id: string }) => item.id)).size).toBe(35);
    expect(await post("panel/browse", { op: "check", viewId: tasks.viewId })).toMatchObject({ updated: true });
    expect(await post("panel/browse", { op: "page", viewId: tasks.viewId, page: 1 })).toMatchObject({ total: 0 });
    const refreshed = await post("panel/browse", { op: "create", filter });
    expect(refreshed).toMatchObject({ page: 1, total: 56 });
    expect(refreshed.viewId).not.toBe(view.viewId);
    expect(await post("panel/browse", { op: "create", filter: { section: "tasks" } })).toMatchObject({ total: 1 });
    // The first-binding exception must not weaken subsequent destructive events.
    const beforeDelete = panelSafetyToken(db.db);
    service.redactRawTurn(turn.rawTurnId, { mode: "redact" });
    expect(panelSafetyToken(db.db)).not.toBe(beforeDelete);
    const denied = await fetch(`http://127.0.0.1:${address.port}/api/v1/panel/browse`, { method: "POST",
      headers: { authorization: "Bearer synthetic-first-assignment", "content-type": "application/json" },
      body: JSON.stringify({ op: "page", viewId: view.viewId, page: 2 }) });
    expect(denied.status).toBe(409);
  } finally {
    release();
    await closeMemoryHttpServer(server);
  }
});
