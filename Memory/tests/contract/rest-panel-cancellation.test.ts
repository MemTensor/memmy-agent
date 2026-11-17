import { afterEach, expect, it, vi } from "vitest";
import { createMemoryHttpServer } from "../../src/server/http.js";
import { closeMemoryHttpServer } from "../../src/server/http.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";
import { panelSafetyToken } from "../../src/storage/panel-security.js";
const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);

it("cancels an abandoned HTTP page through the service and shared reader, then retries normally", async () => {
  const { service, db, root } = fixture.createTestService();
  for (let i = 0; i < 25; i++) service.addMemory({ content: `HTTP cancel member ${i}`, source: "codex" });
  const original = service.readPanel.bind(service);
  let hold = false;
  let signal: AbortSignal | undefined;
  let finish = () => {};
  const spy = vi.spyOn(service, "readPanel").mockImplementation(async <T>(method: string, args: unknown[], inputSignal?: AbortSignal) => {
    if (hold && method === "page") {
      signal = inputSignal;
      return new Promise<{ safety: string; data: T }>(resolve => {
        finish = () => resolve({ safety: panelSafetyToken(db.db), data: { items: [] } as T });
      });
    }
    return original<T>(method, args, inputSignal);
  });
  const server = createMemoryHttpServer({ service, configPath: `${root}/synthetic-config.json`, auth: { localServiceToken: "synthetic-panel-token" } });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener");
    const url = `http://127.0.0.1:${address.port}/api/v1/panel/browse`;
    const post = (body: unknown, inputSignal?: AbortSignal) => fetch(url, { method: "POST", signal: inputSignal,
      headers: { authorization: "Bearer synthetic-panel-token", "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await (await post({ op: "create", filter: { layer: "L1" } })).json() as { viewId: string };
    hold = true;
    const controller = new AbortController();
    const pending = post({ op: "page", viewId: created.viewId, page: 2 }, controller.signal).catch(error => error);
    await vi.waitFor(() => expect(signal).toBeDefined());
    controller.abort();
    expect((await pending).name).toBe("AbortError");
    await vi.waitFor(() => expect(signal!.aborted).toBe(true));
    finish(); hold = false;
    const retried = await post({ op: "page", viewId: created.viewId, page: 2 });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ page: 2, items: expect.any(Array) });
    const response = await post({ op: "page", viewId: created.viewId, page: 2 });
    expect((await response.json() as { items: unknown[] }).items).toHaveLength(5);
  } finally {
    finish(); await closeMemoryHttpServer(server); spy.mockRestore(); await service.stop();
  }
});
