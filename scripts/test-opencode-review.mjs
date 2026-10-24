/** Official-host review regressions, with real Memory HTTP/storage and a local
 * model fixture. No user data or external model service is used.
 * OPENCODE_V2_BINARY=... [OPENCODE_V1_BINARY=...] node --import tsx scripts/test-opencode-review.mjs
 * --reproduce records failing baseline observations without asserting acceptance.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createOpencodeSkillTarget as backend } from "../App/backend/src/adapters/outbound/skill-writer/opencode/target.ts";
import { createOpencodeSkillTarget as memory } from "../Memory/src/agent-source/integration/opencode/target.ts";
import { readOpencodeDatabase } from "../Memory/src/agent-source/adapters/opencode/db-reader.ts";
import { selectSourceTurn, buildSourceTurnRequest } from "../AgentSourceCore/src/source-turn.ts";
import { createMemoryServiceFixture } from "../Memory/tests/fixtures/memory-service-fixture.ts";
import { createMemoryHttpServer } from "../Memory/src/index.ts";
import { Repositories } from "../Memory/src/storage/repositories.ts";

assert(process.env.OPENCODE_V2_BINARY, "Set OPENCODE_V2_BINARY to official 2.0.26");
const reproduce = process.argv.includes("--reproduce");
const root = await mkdtemp(join(tmpdir(), "memmy-opencode-review-"));
console.log("Review evidence:", root);
const check = (condition, message) => { if (reproduce) console.log(condition ? "PASS" : "REPRODUCED", message); else assert(condition, message); };
for (const [name, factory] of [["Backend", backend], ["Memory", memory]]) {
  const h = await harness(name, factory);
  try {
    await h.start(process.env.OPENCODE_V2_BINARY, 2);
    const first = await h.session();
    for (let i = 0; i < 2; i++) {
      const turn = await h.prompt(first, "Review normal round " + i, undefined, true);
      check(h.stored() === i + 1, name + " default Agent: each turn stored before exit");
      check(h.lastRequest().includes("MEMMY_L3_INITIAL"), name + " first/next real request includes L3");
      await h.scan(first, turn);
    }
    const original = await h.scanned(first, h.turns[0].turnId);
    await h.api(`/session/${first}/synthetic`, { text: "System follow-up: acknowledge this maintenance message.", resume: true });
    await h.waitTerminal(first);
    const after = await h.scanned(first, h.turns[0].turnId);
    check(JSON.stringify(original) === JSON.stringify(after), name + " synthetic continuation cannot rewrite the completed turn");
    await h.scan(first, h.turns[0].turnId);
    await h.api(`/session/${first}/agent`, { agent: "plan" });
    const switched = await h.prompt(first, "Review switched agent: answer without tools.");
    check(h.latestCapture()?.namespace?.profileId === "plan", name + " switched Agent uses plan");
    await h.scan(first, switched);

    h.seed("MEMMY_L3_COMPACTED");
    const reads = h.l3Reads(), boundaries = h.boundaries();
    await h.compact(first, true);
    const compacted = await h.prompt(first, "Review after successful compaction.");
    check(h.lastRequest().includes("MEMMY_L3_COMPACTED") && !h.lastRequest().includes("MEMMY_L3_INITIAL"), name + " next model request contains refreshed L3");
    check(h.l3Reads() === reads + 1, name + " compaction refresh reads L3 exactly once");
    check(h.boundaries() === boundaries + 1, name + " successful compaction notifies Memory once");
    await h.scan(first, compacted);
    const failedReads = h.l3Reads(), failedBoundaries = h.boundaries();
    h.seed("MEMMY_L3_MUST_NOT_REFRESH_ON_FAILURE");
    await h.compact(first, false);
    await h.prompt(first, "Review after failed compaction.");
    check(h.l3Reads() === failedReads && h.boundaries() === failedBoundaries, name + " failed compaction neither refreshes nor reports success");
    check(!h.lastRequest().includes("MEMMY_L3_MUST_NOT_REFRESH_ON_FAILURE"), name + " failed compaction keeps prior L3");

    const count = h.stored();
    await h.stop();
    check(h.stored() === count, name + " cleanup does not duplicate captures");
    h.seed("MEMMY_L3_RESTARTED");
    await h.configure("plan");
    await h.start(process.env.OPENCODE_V2_BINARY, 2);
    await h.prompt(first, "Review resume existing session after restart.");
    check(h.lastRequest().includes("MEMMY_L3_RESTARTED"), name + " resumed existing session initializes current L3");
    const second = await h.session();
    await h.prompt(second, "Review custom default agent without an explicit selection.", undefined, true);
    check(h.latestCapture()?.namespace?.profileId === "plan", name + " configured default plan is respected");
    check(h.lastRequest().includes("MEMMY_L3_RESTARTED"), name + " new session initializes current L3");
    h.scanFirstNext();
    const third = await h.session("build");
    await h.prompt(third, "Review explicit build overrides default plan.");
    check(h.latestCapture()?.namespace?.profileId === "build", name + " explicit build overrides configured default");
    check(h.scanFirstResults()[0]?.status === "stored" && h.captureResponses().at(-1)?.status === "existing", name + " actual scan-first stores once and live plugin capture deduplicates");
    check(h.captureResponses().every(r => ["stored", "existing"].includes(r.status)), name + " all live captures accepted by real Memory");
    console.log(name, "V2 real stored turns", h.stored());
  } finally { await h.close(); }

  if (process.env.OPENCODE_V1_BINARY) {
    const old = await harness(name + "-migration", factory);
    try {
      await old.configure("plan");
      await old.start(process.env.OPENCODE_V1_BINARY, 1);
      const session = await old.session();
      const before = [];
      for (let i = 0; i < 6; i++) {
        const id = await old.prompt(session, "Migration completed round " + i, i < 3 ? undefined : "build");
        before.push(await old.scanned(session, id));
        check(old.stored() === i + 1, name + " V1 turn " + i + " stored via host SQLite driver");
        await old.scan(session, id);
      }
      await old.stop();
      await old.start(process.env.OPENCODE_V2_BINARY, 2);
      await waitFor(() => {
        const native = new DatabaseSync(old.nativePath, { readOnly: true });
        try { return native.prepare("SELECT COUNT(*) AS n FROM session_v2 WHERE id = ?").get(session)?.n === 1; }
        catch { return false; } finally { native.close(); }
      }, 30000);
      for (const turn of before) {
        const migrated = await old.scanned(session, turn?.turnId);
        check(Boolean(migrated), name + " migrated completed turn is eligible");
        check(JSON.stringify(turn) === JSON.stringify(migrated), name + " migration preserves original source-turn identity/content/time");
        if (migrated) await old.scan(session, migrated.turnId);
      }
      console.log(name, "V1 -> V2 migrated turns", before.length);
    } finally { await old.close(); }
  }
}

async function harness(name, factory) {
  const dir = join(root, name), config = join(dir, "config/opencode"), project = join(dir, "project");
  await mkdir(project, { recursive: true });
  const mf = createMemoryServiceFixture(), { service, db } = mf.createTestService();
  const repos = new Repositories(db.db);
  const memoryServer = createMemoryHttpServer({ service, startAgentSourceAutomation: false, auth: { mode: "dev", allowAnonymous: true } });
  await listen(memoryServer);
  const memoryEndpoint = `http://127.0.0.1:${memoryServer.address().port}`;
  const calls = [], events = [], turns = [], scanFirstResults = [];
  let scanFirstPending = false;
  const seededProjects = new Set(); let seedValue = "MEMMY_L3_INITIAL";
  let mode = "success", serial = 0, generation = 2, child, closed, output = "", port, cursor = 0, hostBinary;
  const fixture = createServer(async (req, res) => {
    try {
      let raw = ""; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/events") { events.push(body); res.end("{}"); return; }
      const call = { path: req.url, body }; calls.push(call);
      if (req.url?.endsWith("/chat/completions")) {
        serial++;
        if (mode === "failure") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "Intentional review model failure", type: "invalid_request_error" } })); return; }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        const answer = mode === "compaction"
          ? ["## Objective", "## Requirements", "## Decisions", "## Work State", "### Completed", "### Active", "### Blocked", "## Next Move", "## Relevant Files", "## Important Context"].map(heading => heading + "\n- Preserve user data and finish the review fixture.").join("\n\n")
          : `Verified local fixture answer ${serial}. Continue the requested task safely.`;
        chunk({ role: "assistant", content: answer });
        chunk({}, "stop"); res.end("data: [DONE]\n\n"); return;
      }
      if (req.url === "/api/v1/source-turns/complete" && scanFirstPending) {
        scanFirstPending = false;
        const scanned = await scanTurn(nativePath, body.sourceTurn.conversationId, body.sourceTurn.turnId);
        const turn = scanned.turn;
        assert(turn, "Scan-first must read the actual persisted native turn: " + scanned.reason);
        scanFirstResults.push(service.completeSourceTurn({ ...buildSourceTurnRequest(turn, "agent_source_scan"), namespace: body.namespace }));
      }
      const response = await fetch(memoryEndpoint + req.url, { method: req.method, headers: { ...req.headers, host: new URL(memoryEndpoint).host }, body: raw || undefined });
      const text = await response.text(); call.response = { code: response.status, body: JSON.parse(text) };
      const projectId = call.response.body.projectId;
      if (req.url === "/api/v1/sessions/open" && projectId && !seededProjects.has(projectId)) {
        seededProjects.add(projectId);
        repos.l3WorldModels.upsertField({ userId: "local-user", projectId, targetField: "project_contract", value: seedValue });
      }
      res.writeHead(response.status, { "content-type": "application/json" }); res.end(text);
    } catch (error) { console.error("Review fixture request failed:", String(error)); res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
  });
  await listen(fixture);
  const endpoint = `http://127.0.0.1:${fixture.address().port}`;
  const yaml = join(dir, "memmy.yaml"); await writeFile(yaml, `memmyMemory:\n  storage:\n    endpoint: ${endpoint}\n`);
  await factory({ rootDirectory: config, memmyConfigPath: yaml }).installPlugin("opencode");
  const nativePath = join(dir, "data/opencode/opencode.db");
  const env = { ...process.env, PWD: project, OPENCODE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), XDG_STATE_HOME: join(dir, "state") };
  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${generation === 2 ? "/api" : ""}${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(generation === 2 ? { authorization: "Basic " + Buffer.from("opencode:" + (output.match(/server password (\S+)/)?.[1] || "")).toString("base64") } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const text = await response.text(); assert(response.ok, `${path}: ${response.status} ${text}`); return text ? JSON.parse(text) : null;
  };
  const h = {
    nativePath, turns, api,
    scanFirstNext: () => { scanFirstPending = true; },
    scanFirstResults: () => scanFirstResults,
    async configure(defaultAgent) { await writeFile(join(config, "opencode.json"), JSON.stringify({ ...(defaultAgent ? { default_agent: defaultAgent } : {}), provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: endpoint + "/v1", apiKey: "local-fixture" }, models: { fixture: { name: "fixture", limit: { context: 32768, output: 256 } } } } } })); },
    seed(value) {
      seedValue = value;
      repos.l3WorldModels.upsertField({ userId: "local-user", targetField: "general_rules_and_safety_constraints", value, eligibleL1MemoryIds: [] });
      for (const row of db.db.prepare("SELECT DISTINCT project_id FROM sessions WHERE project_id IS NOT NULL").all()) {
        repos.l3WorldModels.upsertField({ userId: "local-user", projectId: row.project_id, targetField: "project_contract", value });
      }
    },
    stored: () => db.db.prepare("SELECT COUNT(*) AS n FROM source_turn_captures").get().n,
    latestCapture: () => calls.filter(c => c.path === "/api/v1/source-turns/complete").at(-1)?.body,
    captureResponses: () => calls.filter(c => c.path === "/api/v1/source-turns/complete").map(c => c.response?.body || {}),
    lastRequest: () => JSON.stringify(calls.filter(c => c.path?.endsWith("/chat/completions")).at(-1)?.body),
    l3Reads: () => calls.filter(c => c.path.includes("/context?")).length,
    boundaries: () => calls.filter(c => c.path.endsWith("/l3-world-model-boundary")).length,
    async start(binary, gen) {
      generation = gen; output = ""; hostBinary = resolve(binary);
      const observer = `export default { id: "review-observer", async server() { return { event: async ({event}) => fetch(${JSON.stringify(endpoint + "/events")}, {method:"POST",body:JSON.stringify(event)}) }; }, async setup(ctx) {
        const stop = new AbortController();
        const title = await ctx.session.hook("title", async event => { event.result = "Review fixture"; });
        const job = (async()=> {try {for await(const event of ctx.event.subscribe({signal:stop.signal})) if(event.type.startsWith("session.")) await fetch(${JSON.stringify(endpoint + "/events")},{method:"POST",body:JSON.stringify(event)});}catch(e){if(!stop.signal.aborted)throw e;}})();
        return async()=>{stop.abort();await job;await title.dispose();};
      }};`;
      await writeFile(join(config, "plugins/zz-review-observer.js"), observer);
      const probe = createServer(); await listen(probe); port = probe.address().port; await shutdown(probe);
      child = spawn(resolve(binary), ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", gen === 2 ? "debug" : "DEBUG"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", c => output += c); child.stderr.on("data", c => output += c);
      closed = new Promise(r => child.on("close", r));
      await waitFor(async () => { try { await api("/session"); return true; } catch { return false; } }, 30000);
    },
    async stop() {
      if (!child) return;
      child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      await closed; clearTimeout(timer); child = undefined;
      await writeFile(join(dir, `process-${generation}-${Date.now()}.log`), output.replace(/server password \S+/g, "server password [local test credential]"));
    },
    async session(agent) {
      const response = await api("/session", generation === 2 ? { title: "Review fixture", ...(agent ? { agent } : {}), model: { providerID: "fixture", id: "fixture" }, location: { directory: project } } : { title: "Review fixture" });
      return (response.data || response).id;
    },
    async waitTerminal(sessionID) {
      await waitFor(() => events.slice(cursor).some(e => generation === 2 ? ["session.execution.succeeded", "session.execution.failed"].includes(e.type) && e.data.sessionID === sessionID : e.type === "session.idle" && e.properties.sessionID === sessionID), 25000);
      cursor = events.length; await delay(500);
    },
    async prompt(session, text, agent, cli = false) {
      // Concrete coding feedback remains capture-eligible even if prior fixture
      // turns are recalled. Keep the real Memory content policy enabled.
      text = "This implementation should preserve user data and verify the requested change. " + text;
      cursor = events.length;
      let cliTurn;
      if (cli) {
        const credential = output.match(/server password (\S+)/)?.[1];
        const running = promisify(execFile)(hostBinary, ["run", "--server", `http://127.0.0.1:${port}`, "--session", session, "--model", "fixture/fixture", text], { cwd: project, env: { ...env, OPENCODE_PASSWORD: credential }, timeout: 30000 });
        running.child.stdin.end();
        await running;
        const native = new DatabaseSync(nativePath, { readOnly: true });
        try { cliTurn = native.prepare("SELECT id FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq DESC LIMIT 1").get(session)?.id; } finally { native.close(); }
      }
      const answer = cli ? { id: cliTurn } : await api(`/session/${session}/${generation === 2 ? "prompt" : "message"}`, generation === 2 ? { text } : { parts: [{ type: "text", text }], model: { providerID: "fixture", modelID: "fixture" }, ...(agent ? { agent } : {}) });
      await h.waitTerminal(session);
      let turnId;
      if (generation === 2) turnId = (answer.data || answer).id;
      else {
        const native = new DatabaseSync(nativePath, { readOnly: true });
        try { turnId = native.prepare("SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY time_created DESC, id DESC LIMIT 1").get(session)?.id; } finally { native.close(); }
      }
      turns.push({ session, turnId });
      return turnId;
    },
    async compact(session, success) {
      cursor = events.length; mode = success ? "compaction" : "failure";
      await api(`/session/${session}/compact`, {});
      await waitFor(() => events.slice(cursor).some(e => e.type === (success ? "session.compaction.ended" : "session.compaction.failed") && e.data.sessionID === session), 25000);
      await delay(500); mode = "success";
    },
    async scanned(session, turnId) { return (await scanTurn(nativePath, session, turnId)).turn; },
    async scan(session, turnId) {
      const turn = await h.scanned(session, turnId); check(Boolean(turn), name + " scanner finds completed turn");
      if (!turn) return;
      const result = service.completeSourceTurn({ ...buildSourceTurnRequest(turn, "agent_source_scan"), namespace: { source: "opencode", profileId: turn.profileId, userId: "local-user" } });
      check(result.status === "existing", name + " history scan deduplicates actual live storage: " + result.status + "/" + (result.reason || ""));
    },
    async close() {
      await h.stop();
      await writeFile(join(dir, "evidence.json"), JSON.stringify({ stored: h.stored(), turns, calls, events, scanFirstResults }, null, 2));
      await shutdown(fixture); await shutdown(memoryServer); mf.cleanup();
    }
  };
  await h.configure(); h.seed("MEMMY_L3_INITIAL");
  return h;
}
async function listen(server) { await new Promise(r => server.listen(0, "127.0.0.1", r)); }
async function shutdown(server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
async function waitFor(predicate, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(50); }
  throw new Error("Timed out waiting for official host lifecycle");
}

async function scanTurn(path, conversationId, turnId) {
  // selectSourceTurn deliberately rejects mixed conversations. The production
  // scanner partitions by conversation before passing messages to this parser.
  async function* conversation() {
    for await (const message of readOpencodeDatabase(path)) {
      if (message.conversationId === conversationId) yield message;
    }
  }
  return selectSourceTurn(conversation(), { conversationId, turnId });
}
