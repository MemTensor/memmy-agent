import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it, expect, vi } from "vitest";
import { createOpencodeSkillTarget as backend } from "../App/backend/src/adapters/outbound/skill-writer/opencode/target.ts";
import { createOpencodeSkillTarget as memory } from "../Memory/src/agent-source/integration/opencode/target.ts";
import { readOpencodeDatabase } from "../Memory/src/agent-source/adapters/opencode/db-reader.ts";
import { selectSourceTurn } from "../AgentSourceCore/src/source-turn.ts";

const roots = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(factory) {
  const root = mkdtempSync(join(tmpdir(), "memmy-opencode-upgrade-")); roots.push(root);
  return { root, target: factory({ rootDirectory: root, memmyConfigPath: join(root, "missing.yaml") }) };
}
async function load(root) {
  // Import the installed artifact unchanged: real bridge, real Zod, no SDK substitution.
  const source = readFileSync(join(root, "plugins/memmy-memory.js"), "utf8");
  const path = join(root, "plugins/test-runtime.mjs"); writeFileSync(path, source);
  return (await import(pathToFileURL(path).href)).default;
}

describe.each([["Backend", backend], ["Memory", memory]])("%s OpenCode upgrade", (_, factory) => {
  it("refreshes old files, preserves connection settings and other plugins, and detects partial updates", async () => {
    const { root, target } = fixture(factory);
    mkdirSync(join(root, "plugins"));
    const original = { endpoint: "http://127.0.0.1:19991", token: "fixture-token", memmy_config_path: join(root, "custom.yaml"), custom: { enabled: true } };
    const config = join(root, "plugins/memmy-memory-config.json");
    writeFileSync(config, JSON.stringify(original));
    writeFileSync(join(root, "plugins/memmy-memory.js"), "old plugin");
    writeFileSync(join(root, "plugins/other.js"), "other plugin");
    writeFileSync(join(root, "opencode.jsonc"), "// custom model settings\n{}");
    writeFileSync(join(root, "AGENTS.md"), "user instructions\n");
    expect(await target.isInstalledHookCurrent()).toBe(false);
    await target.installPlugin("opencode");
    expect(JSON.parse(readFileSync(config, "utf8"))).toMatchObject(original);
    expect(await target.isInstalledHookCurrent()).toBe(true);
    const otherPath = (factory === backend ? memory : backend)({ rootDirectory: root });
    expect(await otherPath.isInstalledHookCurrent()).toBe(true);
    const installed = readFileSync(config, "utf8");
    await target.installPlugin("opencode");
    expect(readFileSync(config, "utf8")).toBe(installed);
    expect(readFileSync(join(root, "plugins/other.js"), "utf8")).toBe("other plugin");
    expect(readFileSync(join(root, "opencode.jsonc"), "utf8")).toBe("// custom model settings\n{}");
    expect(readFileSync(join(root, "AGENTS.md"), "utf8").match(/memmy:start/g)).toHaveLength(1);
    writeFileSync(join(root, "plugins/memmy-workspace-bridge.mjs"), "partial write");
    expect(await target.isInstalledHookCurrent()).toBe(false);
    await target.installPlugin("opencode");
    expect(await target.isInstalledHookCurrent()).toBe(true);
    rmSync(join(root, "commands/memmy-resume.md"));
    expect(await target.isInstalledHookCurrent()).toBe(false);
  });

  it("does not overwrite a malformed user config or publish a new revision", async () => {
    const { root, target } = fixture(factory);
    mkdirSync(join(root, "plugins"));
    writeFileSync(join(root, "plugins/memmy-memory-config.json"), "{broken");
    writeFileSync(join(root, "plugins/memmy-memory.js"), "old");
    await expect(target.installPlugin("opencode")).rejects.toThrow();
    expect(readFileSync(join(root, "plugins/memmy-memory.js"), "utf8")).toBe("old");
  });

  it("registers V2 tools, recalls, captures the V2 database once, resumes, and cleans up", async () => {
    const { root, target } = fixture(factory);
    await target.installPlugin("opencode");
    const plugin = await load(root);
    const requests = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body) : {};
      requests.push({ path, body });
      const data = path === "/api/v1/sessions/open" ? { sessionId: "memmy-session" }
        : path === "/api/v1/turns/start" ? { turnId: body.turnId, injectedContext: { markdown: "Remembered preference" } }
        : path === "/api/v1/memory/search" ? { debug: { hits: [{ id: "trace-1", score: 1 }] } }
        : path === "/api/v1/memory/trace-1" ? { id: "trace-1", summary: "Remembered", refs: { episode: { id: "episode-1", title: "Task" } } }
        : path === "/api/v1/memory/episode-1" ? { id: "episode-1", title: "Task", body: "Episode detail" }
        : path === "/api/v1/memory/add" ? { id: "new-memory" }
        : { status: "stored" };
      return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
    }));
    const dataHome = join(root, "data"); vi.stubEnv("XDG_DATA_HOME", dataHome);
    const dbPath = writeV2Fixture(dataHome);
    const tools = new Map(); let promptHook; let command; let signal; let deliver;
    const disposals = [];
    const registration = () => { const dispose = vi.fn(); disposals.push(dispose); return { dispose }; };
    const ctx = {
      location: { directory: root },
      tool: { async transform(fn) { fn({ add(t) { tools.set(t.name, t); } }); return registration(); } },
      command: { async transform(fn) { fn({ add(c) { command = c; } }); return registration(); } },
      session: {
        async get() { return { agent: "build" }; },
        async hook(name, fn) { expect(["prompt", "context"]).toContain(name); if (name === "prompt") promptHook = fn; return registration(); },
        async prompt(input) { const event = { sessionID: input.sessionID, messageID: "resume", prompt: { text: input.text } }; await promptHook(event); return event; }
      },
      event: { async *subscribe(options) {
        signal = options.signal;
        while (!signal.aborted) {
          const event = await new Promise(resolve => {
            const abort = () => resolve(null);
            signal.addEventListener("abort", abort, { once: true });
            deliver = value => { signal.removeEventListener("abort", abort); resolve(value); };
          });
          if (event) yield event;
        }
      } }
    };
    const cleanup = await plugin.setup(ctx);
    try {
      expect([...tools.keys()]).toEqual(["memmy_memory_search", "memmy_memory_get", "memmy_memory_add"]);
      expect(tools.get("memmy_memory_search").input).toMatchObject({ type: "object", required: ["query"] });
      const context = { sessionID: "session-1", agent: "build" };
      for (const [name, args] of [["search", { query: "preference" }], ["get", { id: "trace-1" }], ["add", { content: "fixture fact" }]]) {
        expect(await tools.get("memmy_memory_" + name).execute(args, context)).toHaveProperty("content");
      }
      await expect(tools.get("memmy_memory_add").execute({ content: "" }, context)).rejects.toThrow("Missing required");
      const event = { sessionID: "session-1", messageID: "user-1", prompt: { text: "Inspect README", files: [{ uri: "file:///fixture" }] } };
      await promptHook(event);
      expect(event.prompt.text).toContain("Remembered preference");
      expect(event.prompt.files).toHaveLength(1);
      deliver({ type: "session.execution.succeeded", data: { sessionID: "session-1" } });
      await vi.waitFor(() => expect(requests.filter(r => r.path === "/api/v1/source-turns/complete")).toHaveLength(1));
      deliver({ type: "session.execution.succeeded", data: { sessionID: "session-1" } });
      const capture = requests.find(r => r.path === "/api/v1/source-turns/complete").body;
      expect(capture).toMatchObject({ query: "Inspect README", answer: "Verified", toolCalls: [expect.objectContaining({ name: "read", output: "README contents" })] });
      const scanned = await selectSourceTurn(readOpencodeDatabase(dbPath), { conversationId: "session-1", turnId: "user-1" });
      expect(capture.sourceTurn.turnId).toBe(scanned.turn.turnId);
      expect(capture.answer).toBe(scanned.turn.answer);
      await command.execute({ sessionID: "resume-session", prompt: { text: "prior task" }, delivery: "queue" });
      expect(requests.some(r => r.path === "/api/v1/memory/search" && r.body.query === "prior task")).toBe(true);
      const selection = { sessionID: "resume-session", messageID: "selection", prompt: { text: "1" } };
      await promptHook(selection);
      expect(selection.prompt.text).toContain("Episode detail");
      ctx.session.get = async () => { throw new Error("session temporarily unavailable"); };
      const unavailable = { sessionID: "unavailable", messageID: "retry", prompt: { text: "Keep my request" } };
      await expect(promptHook(unavailable)).resolves.toBeUndefined();
      expect(unavailable.prompt.text).toBe("Keep my request");
    } finally { await cleanup(); await cleanup(); }
    expect(signal.aborted).toBe(true);
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1);
    expect(requests.filter(r => r.path === "/api/v1/source-turns/complete")).toHaveLength(1);
  });
});

describe("V2 native completion boundaries", () => {
  it.each(["unfinished", "tool-only", "interrupted", "failed-after-tool", "subagent", "reverted"])("handles %s without capturing an invalid turn", async (kind) => {
    const { root } = fixture(memory);
    const dbPath = writeV2Fixture(root);
    const db = new DatabaseSync(dbPath);
    if (kind === "subagent") db.exec("UPDATE session_v2 SET parent_id = 'parent'");
    if (kind === "reverted") {
      db.exec("ALTER TABLE session_v2 ADD COLUMN revert TEXT");
      db.prepare("UPDATE session_v2 SET revert = ?").run(JSON.stringify({ messageID: "user-1" }));
    }
    if (["unfinished", "tool-only", "interrupted"].includes(kind)) db.exec("DELETE FROM session_message WHERE id IN ('assistant-2', 'idle')");
    if (["tool-only", "interrupted"].includes(kind)) db.prepare("INSERT INTO session_message VALUES ('idle', 'session-1', 'idle', ?, 4, ?)").run(
      JSON.stringify({ outcome: kind === "interrupted" ? "interrupted" : "succeeded", time: { created: 1792371600010 } }), 1792371600010);
    if (kind === "failed-after-tool") {
      db.prepare("UPDATE session_message SET data = ? WHERE id = 'assistant-2'").run(JSON.stringify({ type: "assistant", agent: "build", content: [] }));
      db.prepare("UPDATE session_message SET data = ? WHERE id = 'idle'").run(JSON.stringify({ outcome: "failed", time: { created: 1792371600010 } }));
    }
    db.close();
    const { turn } = await selectSourceTurn(readOpencodeDatabase(dbPath), { conversationId: "session-1", turnId: "user-1" });
    if (["tool-only", "interrupted", "failed-after-tool"].includes(kind)) {
      expect(turn.status).toBe(kind === "tool-only" ? "succeeded" : "failed");
      expect(turn.toolCalls).toHaveLength(1);
    } else expect(turn).toBeNull();
  });
});

function writeV2Fixture(dataHome) {
  mkdirSync(join(dataHome, "opencode"), { recursive: true });
  const path = join(dataHome, "opencode/opencode.db"); const db = new DatabaseSync(path);
  db.exec("CREATE TABLE session_v2 (id TEXT, parent_id TEXT, directory TEXT, agent TEXT, time_created INTEGER); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, data TEXT, seq INTEGER, time_created INTEGER)");
  db.prepare("INSERT INTO session_v2 VALUES (?, NULL, ?, 'build', 1)").run("session-1", dataHome);
  const insert = db.prepare("INSERT INTO session_message VALUES (?, 'session-1', ?, ?, ?, ?)");
  const start = Date.parse("2026-10-19T01:00:00Z");
  insert.run("user-1", "user", JSON.stringify({ type: "user", text: "Inspect README", time: { created: start } }), 1, start);
  insert.run("assistant-1", "assistant", JSON.stringify({ type: "assistant", agent: "build", finish: "tool-calls", time: { created: start + 1, completed: start + 2 }, content: [{ type: "tool", id: "call-1", name: "read", state: { status: "completed", input: { path: "README.md" }, content: [{ type: "text", text: "README contents" }] } }] }), 2, start + 1);
  insert.run("assistant-2", "assistant", JSON.stringify({ type: "assistant", agent: "build", finish: "stop", time: { created: start + 3, completed: start + 4 }, content: [{ type: "text", text: "Verified" }] }), 3, start + 3);
  insert.run("idle", "idle", JSON.stringify({ type: "idle", outcome: "succeeded", time: { created: start + 5 } }), 4, start + 5);
  db.close(); return path;
}

// This harness exercises installed artifacts with exact V2 event names. The
// separate real-host script guards the contract against changes in OpenCode.
async function lifecycleHarness(factory, options = {}) {
  const { root, target } = fixture(factory);
  await target.installPlugin("opencode");
  const plugin = await load(root);
  const dataHome = join(root, "data"); vi.stubEnv("XDG_DATA_HOME", dataHome);
  const dbPath = writeV2Fixture(dataHome);
  const requests = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const path = new URL(url).pathname, body = init?.body ? JSON.parse(init.body) : {};
    requests.push({ path, body });
    if (options.failL3 && path.endsWith("/context")) return Response.json({ error: "L3 temporarily unavailable" }, { status: 503 });
    return Response.json(options.l3 && path === "/api/v1/health" ? { features: { l3WorldModelProtocolVersions: [2] } }
      : path === "/api/v1/sessions/open" ? { sessionId: "memmy-session" }
      : path.endsWith("/context") ? { renderedContext: options.l3?.() || "" }
      : path.endsWith("/l3-world-model-trace-head") ? { throughL1MemoryId: "trace" }
      : path === "/api/v1/turns/start" ? { turnId: body.turnId } : { status: "stored" });
  }));
  const buffer = []; let wake; let prompt; let context; let aborted = false;
  const ctx = {
    location: { directory: root },
    tool: { async transform() { return { dispose() {} }; } },
    command: { async transform() { return { dispose() {} }; } },
    agent: { async list() { return [{ id: options.defaultAgent || "build", mode: "primary" }]; } },
    session: { async get() { return { agent: options.defaultAgent ? undefined : "build" }; }, async hook(name, fn) { if (name === "prompt") prompt = fn; else if (name === "context") context = fn; return { dispose() {} }; } },
    event: { async *subscribe({ signal }) {
      signal.addEventListener("abort", () => { aborted = true; wake?.(); }, { once: true });
      while (!aborted) { if (!buffer.length) await new Promise(r => wake = r); while (buffer.length) yield buffer.shift(); }
    } }
  };
  const cleanup = await plugin.setup(ctx);
  return {
    dbPath, cleanup, plugin, requests,
    context: async (system = []) => { const event = { sessionID: "session-1", agent: options.defaultAgent || "build", system }; await context(event); return event.system; },
    captures: () => requests.filter(r => r.path === "/api/v1/source-turns/complete").map(r => r.body),
    prompt: id => prompt({ sessionID: "session-1", messageID: id, prompt: { text: "Native request " + id } }),
    emit: (type, extra = {}) => { buffer.push({ type, data: { sessionID: "session-1", ...extra } }); wake?.(); }
  };
}
function appendTurn(dbPath, id, { outcome = "succeeded", terminal = true } = {}) {
  const db = new DatabaseSync(dbPath);
  const seq = db.prepare("SELECT MAX(seq) AS n FROM session_message").get().n + 1;
  const time = 1792371600000 + seq;
  const insert = db.prepare("INSERT INTO session_message VALUES (?, 'session-1', ?, ?, ?, ?)");
  insert.run(id, "user", JSON.stringify({ type: "user", text: "Native request " + id, time: { created: time } }), seq, time);
  insert.run(id + "-assistant", "assistant", JSON.stringify({ type: "assistant", agent: "build", finish: "stop", content: [{ type: "text", text: "Native answer " + id }], time: { created: time + 1, completed: time + 2 } }), seq + 1, time + 1);
  if (terminal) insert.run(id + "-idle", "idle", JSON.stringify({ type: "idle", outcome, time: { created: time + 3 } }), seq + 2, time + 3);
  db.close();
}

describe.each([["Backend", backend], ["Memory", memory]])("%s turn lifecycle", (_, factory) => {
  it("captures success, failure and user interruption once with the scan identity, never again on exit", async () => {
    const h = await lifecycleHarness(factory);
    try {
      for (const [index, outcome] of ["succeeded", "failed", "interrupted"].entries()) {
        const id = "native-" + index;
        appendTurn(h.dbPath, id, { outcome });
        await h.prompt(id);
        h.emit("session.execution." + outcome, outcome === "interrupted" ? { reason: "user" } : {});
        await vi.waitFor(() => expect(h.captures()).toHaveLength(index + 1));
        h.emit("session.execution." + outcome, { reason: "user" });
        const capture = h.captures().at(-1);
        const { turn } = await selectSourceTurn(readOpencodeDatabase(h.dbPath), { conversationId: "session-1", turnId: id });
        expect(capture.sourceTurn.turnId).toBe(turn.turnId);
        expect(capture.answer).toBe(turn.answer);
        expect(turn.status).toBe(outcome === "succeeded" ? "succeeded" : "failed");
      }
    } finally { await h.cleanup(); }
    expect(h.captures()).toHaveLength(3);
  });

  it("waits for the durable terminal boundary and retains overlapping native messages", async () => {
    const h = await lifecycleHarness(factory);
    const db = new DatabaseSync(h.dbPath);
    // Even a final-looking assistant is not complete until V2 persists its idle row.
    db.exec("DELETE FROM session_message WHERE id = 'idle'"); db.close();
    try {
      await h.prompt("user-1");
      h.emit("session.execution.succeeded");
      await new Promise(r => setTimeout(r, 80));
      expect(h.captures()).toHaveLength(0);
      await h.prompt("user-2"); // must not replace user-1 while capture retries
      h.emit("session.execution.succeeded"); // duplicate must not capture user-2 early
      const writer = new DatabaseSync(h.dbPath);
      writer.prepare("INSERT INTO session_message VALUES ('idle', 'session-1', 'idle', ?, 4, ?)").run(JSON.stringify({ outcome: "succeeded", time: { created: 1792371600010 } }), 1792371600010);
      writer.close();
      await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
      expect(h.captures()[0].sourceTurn.turnId).toBe("user-1");
      appendTurn(h.dbPath, "user-2");
      h.emit("session.execution.succeeded");
      await vi.waitFor(() => expect(h.captures()).toHaveLength(2));
    } finally { await h.cleanup(); }
    expect(h.captures().map(c => c.sourceTurn.turnId).sort()).toEqual(["user-1", "user-2"]);
  });

  it("does not capture unfinished shutdown or empty failed turns", async () => {
    const h = await lifecycleHarness(factory);
    try {
      appendTurn(h.dbPath, "shutdown", { terminal: false });
      await h.prompt("shutdown");
      h.emit("session.execution.interrupted", { reason: "shutdown" });
      await new Promise(r => setTimeout(r, 80));
      expect(h.captures()).toHaveLength(0);
      // Failure with no assistant output remains ineligible for memory storage.
      const db = new DatabaseSync(h.dbPath);
      db.exec("DELETE FROM session_message WHERE id = 'shutdown-assistant'"); db.close();
      h.emit("session.execution.failed", { error: { message: "No model output" } });
      await new Promise(r => setTimeout(r, 80));
      const started = performance.now();
      await h.cleanup();
      expect(performance.now() - started).toBeLessThan(1000);
    } finally { await h.cleanup(); }
    expect(h.captures()).toHaveLength(0);
  });

  it("keeps V1 idle/status lifecycle working and duplicate terminal events idempotent", async () => {
    const h = await lifecycleHarness(factory);
    const hooks = await h.plugin.server({ directory: "fixture" });
    try {
      await hooks["chat.message"]({ sessionID: "session-1", messageID: "user-1", agent: "build" }, { message: { id: "user-1" }, parts: [{ type: "text", text: "Inspect README" }] });
      await hooks.event({ event: { type: "session.status", properties: { sessionID: "session-1", status: { type: "idle" } } } });
      await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
    } finally { await hooks.dispose(); await h.cleanup(); }
    expect(h.captures()).toHaveLength(1);
  });
});

describe.each([["Backend", backend], ["Memory", memory]])("%s L3 and effective Agent", (_, factory) => {
  it("initializes on actual use, coalesces concurrent reads and refreshes only a durable successful compaction", async () => {
    let l3 = "INITIAL_L3";
    const h = await lifecycleHarness(factory, { l3: () => l3, defaultAgent: "plan" });
    const reads = () => h.requests.filter(r => r.path.endsWith("/context"));
    const boundaries = () => h.requests.filter(r => r.path.endsWith("/l3-world-model-boundary"));
    try {
      // No session.created: same path for cold start and restored existing sessions.
      await h.prompt("user-1");
      const contexts = await Promise.all([h.context(), h.context()]);
      expect(contexts.every(parts => JSON.stringify(parts).includes("INITIAL_L3"))).toBe(true);
      expect(reads()).toHaveLength(1);
      expect(h.requests.find(r => r.path === "/api/v1/sessions/open").body.namespace.profileId).toBe("plan");
      expect(h.requests.find(r => r.path === "/api/v1/turns/start").body.namespace.profileId).toBe("plan");
      expect(await h.context(contexts[0])).toHaveLength(1); // duplicate hook does not append twice
      l3 = "UPDATED_L3";
      const db = new DatabaseSync(h.dbPath);
      db.prepare("INSERT INTO session_message VALUES ('compact', 'session-1', 'compaction', ?, 20, 20)").run(JSON.stringify({ status: "failed" }));
      h.emit("session.compaction.failed");
      expect(JSON.stringify(await h.context())).toContain("INITIAL_L3");
      expect(reads()).toHaveLength(1); expect(boundaries()).toHaveLength(0);
      db.prepare("UPDATE session_message SET data = ? WHERE id = 'compact'").run(JSON.stringify({ status: "completed" })); db.close();
      h.emit("session.compaction.ended");
      h.emit("session.compaction.ended");
      const refreshed = await h.context();
      expect(JSON.stringify(refreshed)).toContain("UPDATED_L3");
      expect(JSON.stringify(refreshed)).not.toContain("INITIAL_L3");
      expect(reads()).toHaveLength(2); expect(boundaries()).toHaveLength(1);
    } finally { await h.cleanup(); }
  });
});


describe.each([["Backend", backend], ["Memory", memory]])("%s V1 L3 degradation", (_, factory) => {
  it("keeps recall and capture active when L3 initialization fails", async () => {
    const h = await lifecycleHarness(factory, { l3: () => "unused", failL3: true });
    const hooks = await h.plugin.server({ directory: "fixture" });
    try {
      await hooks["chat.message"]({ sessionID: "session-1", messageID: "user-1" }, { message: { id: "user-1", agent: "build" }, parts: [{ type: "text", text: "Inspect README" }] });
      expect(h.requests.filter(r => r.path === "/api/v1/turns/start")).toHaveLength(1);
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
      await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    } finally { await hooks.dispose(); await h.cleanup(); }
  });
});
