/** Real OpenCode V2 lifecycle regression. The official host loads the installed
 * plugin and runs multiple turns against a local OpenAI-compatible fixture.
 * OPENCODE_V2_BINARY=/absolute/path/opencode node --import tsx scripts/test-opencode-lifecycle.mjs
 * Add --reproduce to record the pre-fix behavior without requiring captures.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { createOpencodeSkillTarget as backend } from "../App/backend/src/adapters/outbound/skill-writer/opencode/target.ts";
import { createOpencodeSkillTarget as memory } from "../Memory/src/agent-source/integration/opencode/target.ts";
import { readOpencodeDatabase } from "../Memory/src/agent-source/adapters/opencode/db-reader.ts";
import { selectSourceTurn } from "../Memory/AgentSourceCore/src/source-turn.ts";

assert(process.env.OPENCODE_V2_BINARY, "Set OPENCODE_V2_BINARY to the official 2.0.26 CLI");
const root = await mkdtemp(join(tmpdir(), "memmy-opencode-lifecycle-"));
console.log("Lifecycle evidence:", root);
for (const [name, factory] of [["Backend", backend], ["Memory", memory]]) {
  const dir = join(root, name), config = join(dir, "config/opencode"), project = join(dir, "project");
  await mkdir(project, { recursive: true });
  const calls = [], events = [], counts = [];
  let mode = "success", modelRequests = 0;
  const fixture = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === "/events") { events.push(body); res.end("{}"); return; }
    calls.push({ path: req.url, body });
    if (req.url?.endsWith("/chat/completions")) {
      modelRequests++;
      if (mode === "failure") { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "Intentional lifecycle fixture failure", type: "invalid_request_error" } })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk({ role: "assistant", content: `Local fixture answer ${modelRequests}` });
      if (mode === "interrupt") return; // client aborts this stream using the real host API
      chunk({}, "stop"); res.end("data: [DONE]\n\n"); return;
    }
    const data = req.url === "/api/v1/sessions/open" ? { sessionId: "fixture-session" }
      : req.url === "/api/v1/turns/start" ? { turnId: body.turnId, injectedContext: { markdown: "MEMMY_LIFECYCLE_RECALL" } }
      : { status: "stored" };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data));
  });
  await new Promise(r => fixture.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${fixture.address().port}`;
  const yaml = join(dir, "memmy.yaml");
  await writeFile(yaml, `memmyMemory:\n  storage:\n    endpoint: ${endpoint}\n`);
  await factory({ rootDirectory: config, memmyConfigPath: yaml }).installPlugin("opencode");
  await writeFile(join(config, "opencode.json"), JSON.stringify({
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: endpoint + "/v1", apiKey: "local-fixture" }, models: { fixture: { name: "fixture", limit: { context: 32768, output: 256 } } } } }
  }));
  // Observer only: never invokes Memmy hooks or fabricates completion events.
  await writeFile(join(config, "plugins/zz-lifecycle-observer.js"), `export default { id: "lifecycle-observer", async setup(ctx) {
    const controller = new AbortController();
    const title = await ctx.session.hook("title", async event => { event.result = "Lifecycle fixture"; });
    const job = (async () => { try { for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type.startsWith("session.execution.") || event.type === "session.message.created") await fetch(${JSON.stringify(endpoint + "/events")}, { method: "POST", body: JSON.stringify(event) });
    } } catch (error) { if (!controller.signal.aborted) throw error; } })();
    return async () => { controller.abort(); await job; await title.dispose(); };
  } };`);
  const probe = createServer(); await new Promise(r => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const env = { ...process.env, PWD: project, OPENCODE_CONFIG_DIR: config,
    XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"), XDG_CACHE_HOME: join(dir, "cache"), XDG_STATE_HOME: join(dir, "state") };
  const version = await promisify(execFile)(resolve(process.env.OPENCODE_V2_BINARY), ["--version"], { env, cwd: project });
  assert.equal(version.stdout.trim().replace(/^opencode v/, ""), "2.0.26");
  const child = spawn(resolve(process.env.OPENCODE_V2_BINARY), ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "debug"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", c => output += c); child.stderr.on("data", c => output += c);
  const closed = new Promise(r => child.on("close", r));
  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from("opencode:" + (output.match(/server password (\S+)/)?.[1] || "")).toString("base64") }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const text = await response.text(); assert(response.ok, `${path}: ${response.status} ${text}`); return text ? JSON.parse(text) : null;
  };
  const captures = () => calls.filter(c => c.path === "/api/v1/source-turns/complete");
  try {
    await waitFor(async () => { try { await api("/session"); return true; } catch { return false; } }, 30000);
    const created = await api("/session", { title: "Lifecycle fixture", model: { providerID: "fixture", id: "fixture" }, location: { directory: project } });
    const session = created.data || created; console.log(name, "session", session.id);
    for (let i = 1; i <= 2; i++) {
      const before = events.length;
      await api(`/session/${session.id}/prompt`, { text: `Lifecycle round ${i}: respond with a short answer.` });
      await waitFor(() => events.slice(before).some(e => e.type === "session.execution.succeeded" && e.data.sessionID === session.id), 20000);
      await delay(500);
      counts.push(captures().length);
    }
    console.log(name, "captures before exit:", counts);
    if (!process.argv.includes("--reproduce")) {
      assert.deepEqual(counts, [1, 2], "Each real completed turn must be captured before the next prompt or exit");
      // An actual model failure with no usable output must not store an empty memory.
      mode = "failure";
      let before = events.length;
      await api(`/session/${session.id}/prompt`, { text: "Lifecycle failure: model rejects this request." });
      await waitFor(() => events.slice(before).some(e => e.type === "session.execution.failed" && e.data.sessionID === session.id), 20000);
      await delay(500);
      assert.equal(captures().length, 2);
      // Interrupt a real streaming answer through the host, preserving useful partial text.
      mode = "interrupt";
      before = events.length;
      const previousRequests = modelRequests;
      await api(`/session/${session.id}/prompt`, { text: "Lifecycle interruption: wait for user cancel." });
      await waitFor(() => modelRequests > previousRequests, 10000);
      await delay(150);
      await api(`/session/${session.id}/interrupt`, {});
      await waitFor(() => events.slice(before).some(e => e.type === "session.execution.interrupted" && e.data.sessionID === session.id), 10000);
      await waitFor(() => captures().length === 3, 5000);
      assert.equal(captures().at(-1).body.status, "failed");
      for (const capture of captures()) {
        const { turn } = await selectSourceTurn(readOpencodeDatabase(join(dir, "data/opencode/opencode.db")), { conversationId: session.id, turnId: capture.body.sourceTurn.turnId });
        assert(turn, "Historical scan must resolve the same native user message");
        assert.equal(capture.body.answer, turn.answer);
        for (const field of ["source", "conversationId", "turnId", "profileId", "startedAt", "completedAt", "sequence", "completionEvidence"]) {
          assert.equal(capture.body.sourceTurn[field], turn[field], "Hook and scan identity differ: " + field);
        }
      }
    }
  } finally {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 10000);
    await closed; clearTimeout(killTimer);
    await writeFile(join(dir, "process.log"), output.replace(/server password \S+/g, "server password [local test credential]"));
    await writeFile(join(dir, "evidence.json"), JSON.stringify({ counts, capturesAfterExit: captures().length, events, calls }, null, 2));
    fixture.closeAllConnections(); await new Promise(r => fixture.close(r));
  }
  assert(output.includes("Memmy plugin disposed:"), "Official host must finish normal plugin cleanup");
  console.log(name, "captures after exit:", captures().length);
  if (!process.argv.includes("--reproduce")) assert.equal(captures().length, 3, "Exit must not repeat completed captures");
}
async function waitFor(predicate, timeout) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await delay(50); }
  throw new Error("Timed out waiting for real host lifecycle");
}
