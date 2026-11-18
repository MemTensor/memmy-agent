import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerProjectMemoryRoutes } from "../../../adapters/inbound/local-api/routes/project-memory.js";
import { ProjectMemoryService } from "../service.js";

const migration = ["0031-project-memory.sql", "0032-project-memory-workspace-roots.sql"]
  .map(name => readFileSync(new URL("../../../infrastructure/app-state-store/migrations/" + name, import.meta.url), "utf8")).join("\n");
const origin = { source: "codex", conversation_id: "s", cwd: "/work/repo/src" };
const query = { ...origin, turn_id: "t", query: "409" };
const add = { ...origin, turn_id: "t", submission_id: "submission", messages: [{ role: "user", content: "Fix 409" },
  { role: "assistant", content: "<memmy_memory_context>other project's note</memmy_memory_context>Fixed" }] };
let account: string | null, db: DatabaseSync, app: ReturnType<typeof Fastify>, svc: ProjectMemoryService;
const gateway = vi.fn();
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE app_settings(active_uuid TEXT);" + migration);
  account = "alice";
  gateway.mockReset().mockImplementation(async (_auth, _method, path, body) => {
    if (path === "search") return { topics: [...body.project_ids, "foreign"].map(id => ({ project_id: id, id })) };
    if (path === "index") return { projects: body.project_ids.map(id => ({ project_id: id, topics: [] })) };
    if (path === "add") return { status: "running", task_id: "task-" + body.project_ids[0] };
    return {};
  });
  svc = new ProjectMemoryService(db, () => account ? { id: account, credential: "bearer-" + account } : null, { projectMemory: gateway });
  app = Fastify();
  registerProjectMemoryRoutes(app, { services: { projectMemory: svc } as never, authenticateRuntimeToken: async (req, res) => {
    if (req.headers["x-memmy-local-token"] !== "local") await res.code(401).send({});
  } });
});
afterEach(async () => { await app.close(); db.close(); });
const post = (path: string, body: object) => app.inject({ method: "POST", url: "/api/project-memory/" + path, headers: { "x-memmy-local-token": "local" }, payload: body });
const bind = (id: string, paths = ["/work/repo"], workspaces: string[] = []) => svc.scope.replace(account!, id, workspaces, paths);

it.each(["memmy-agent", "codex", "hermes", "claude-code"])("pins %s to its launch location and writes each still-bound project once", async source => {
  bind("A"); bind("B", ["/work/repo/src"]); bind("C", ["/work/repo-old"]);
  const response = await post("search", { ...query, source, include_index: true });
  expect(response.statusCode).toBe(200);
  expect(response.json().topics.map(t => t.id)).toEqual(["A", "B"]);
  expect(response.json().projects).toHaveLength(2);
  expect(gateway.mock.calls.every(call => !JSON.stringify(call[3]).includes("/work"))).toBe(true);
  bind("D"); bind("B", []);
  const body = { ...add, source, cwd: "/work/repo-old" };
  const replies = await Promise.all([post("add", body), post("add", body)]);
  for (const r of replies) expect(r.json().submissions).toEqual([expect.objectContaining({ project_id: "A", task_id: "task-A" })]);
  const writes = gateway.mock.calls.filter(c => c[2] === "add");
  expect(writes).toHaveLength(1);
  expect(writes[0]![3].messages[1]).toMatchObject({ content: "Fixed", message_id: expect.any(String), chat_time: expect.any(String) });
  expect((await post("add", { ...body, messages: [{ role: "user", content: "different" }] })).statusCode).toBe(409);
  expect((await post("search", { ...query, source, cwd: "/work/repo-old", turn_id: "next" })).json().topics.map(t => t.id)).toEqual(["A","D"]);
});

it("isolates accounts, unbound folders and workspaces, including a binding removed while reading", async () => {
  bind("A"); bind("B", [], ["ws"]);
  for (const cwd of ["/work/repo-old", undefined]) {
    const session = { ...query, conversation_id: String(cwd), cwd };
    expect((await post("search", session)).json().topics).toEqual([]);
    expect((await post("add", { ...add, ...session, query: undefined })).json().submissions).toEqual([]);
  }
  expect(gateway).not.toHaveBeenCalled();
  expect((await post("search", { ...query, workspace_id: "ws" })).json().topics).toHaveLength(2);
  gateway.mockImplementationOnce(async () => { bind("A", []); return { topics: [{ project_id: "A", id: "private" }] }; });
  expect((await post("search", query)).json().topics).toEqual([]);
  account = "bob";
  expect((await post("search", query)).json().topics).toEqual([]);
  account = null;
  expect((await post("search", query)).statusCode).toBe(401);
  expect((await app.inject({ url: "/api/project-memory/bindings?project_id=A" })).statusCode).toBe(401);
});

it("accepts a startup folder on the first prompt and keeps that scope on later prompts", async () => {
  bind("A");
  for (const [conversation, firstFolder, laterFolder, expected] of [
    ["bound", "/work/repo/src", "/elsewhere", ["A"]],
    ["unknown", undefined, "/work/repo/src", []],
  ] as const) {
    const s = { source: "openclaw", conversation_id: conversation };
    await post("sessions/open", s);
    await post("search", { ...query, ...s, cwd: firstFolder });
    const later = await post("search", { ...query, ...s, cwd: laterFolder, turn_id: "next" });
    expect(later.json().topics.map(t => t.id)).toEqual(expected);
  }
});

it("recovers unknown acceptance without sending a duplicate and persists only outstanding payloads", async () => {
  bind("A"); bind("B"); await post("search", query);
  gateway.mockImplementation(async (_a,_m,path,b) => {
    if (path === "add" && b.project_ids[0] === "A") throw new Error("lost response");
    if (path.startsWith("submissions/")) return { task_id: "task-A", status: "running" };
    return { task_id: "task-B", status: "completed" };
  });
  const submitted = await post("add", add);
  expect(submitted.statusCode).toBe(202);
  expect(submitted.json().submissions.map(x => x.status)).toEqual(["acceptance_unknown","completed"]);
  db.exec("UPDATE project_memory_submissions SET retry_at=0 WHERE request IS NOT NULL");
  await svc.retryPending();
  expect((await post("add", add)).json().submissions.map(x => x.task_id)).toEqual(["task-A","task-B"]);
  expect(gateway.mock.calls.filter(c => c[2] === "add")).toHaveLength(2);
  expect(db.prepare("SELECT count(*) AS n FROM project_memory_submissions WHERE request IS NOT NULL").get()?.n).toBe(0);
});

it("revalidates immutable unversioned content online and never serves a revoked item", async () => {
  let policy = "immutable";
  gateway.mockImplementation(async (_a,_m,path) => ({
    memory_id: "m", project_id: "A", kind: "trajectory_turn", cache_policy: policy,
    ...(path.endsWith("content") ? { content: "original" } : {})
  }));
  const read = () => svc.item(svc.account(),"A","m");
  expect((await read()).read_from).toBe("cloud");
  expect((await read()).read_from).toBe("local_cache");
  expect(gateway.mock.lastCall![2]).toMatch(/view=metadata$/);
  policy = "live";
  expect((await read()).read_from).toBe("cloud");
  expect(db.prepare("SELECT count(*) AS n FROM project_memory_cache").get()?.n).toBe(0);
  policy = "immutable"; await read();
  gateway.mockRejectedValue(Object.assign(new Error("revoked"), { code: "not_found" }));
  await expect(read()).rejects.toThrow("revoked");
  expect(db.prepare("SELECT count(*) AS n FROM project_memory_cache").get()?.n).toBe(0);
});

it("imports only explicitly selected bound projects in timestamp order, excluding injected text", async () => {
  bind("A"); bind("B");
  const payload = { ...origin, submission_id: "history", project_ids: ["B", "foreign"], confirmed: true,
    messages: [{ role: "assistant", chat_time: "2026-11-01T00:05:00Z", message_id: "2", content: "Fixed" },
      { role: "user", chat_time: "2026-11-01T00:00:00Z", message_id: "1", content: "Fix <memmy_project_quote>private</memmy_project_quote>409" }] };
  expect((await post("import", { ...payload, confirmed: false })).statusCode).toBe(400);
  const r = await post("import", payload);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().submissions).toEqual([expect.objectContaining({ project_id: "B" })]);
  expect(gateway.mock.lastCall![3].messages.map(x => x.content)).toEqual(["Fix 409", "Fixed"]);
});

it("retains readable projects when the gateway denies a multi-project batch", async () => {
  bind("A"); bind("B");
  gateway.mockImplementation(async (_a,_m,_p,b) => {
    if (b.project_ids.includes("B")) throw Object.assign(new Error("private"), { code: "forbidden" });
    return { topics: [{ id: "1", project_id: "A" }] };
  });
  const result = (await post("search", query)).json();
  expect(result.topics).toEqual([{ id: "1", project_id: "A" }]);
  expect(result.degraded).toEqual([{ project_id: "B", code: "forbidden" }]);
});
