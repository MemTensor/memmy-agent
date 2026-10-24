/** Opt-in integration check against official, pinned CLI binaries. No SDK or
 * loader mocks. Run with `node --import tsx scripts/test-opencode-loader.mjs`.
 * OPENCODE_TEST_BINARIES is a JSON map of exact version to absolute binary path.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { createOpencodeSkillTarget as backend } from "../App/backend/src/adapters/outbound/skill-writer/opencode/target.ts";
import { createOpencodeSkillTarget as memory } from "../Memory/src/agent-source/integration/opencode/target.ts";

const binaries = JSON.parse(process.env.OPENCODE_TEST_BINARIES || "{}");
assert(Object.keys(binaries).length, "Set OPENCODE_TEST_BINARIES to pinned official V1/V2 binaries");
const root = await mkdtemp(join(tmpdir(), "memmy-opencode-loader-"));
console.log("Isolated loader evidence:", root);
for (const [version, binary] of Object.entries(binaries)) {
  for (const [name, factory] of [["Backend", backend], ["Memory", memory]]) {
    const dir = join(root, version, name);
    const config = join(dir, "config/opencode");
    const project = join(dir, "project"); await mkdir(project, { recursive: true });
    // A local fixture service records real host callbacks; no user Memory service.
    const calls = [];
    const server = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      calls.push({ path: request.url, body: raw ? JSON.parse(raw) : {} });
      let result;
      if (request.url === "/api/v1/sessions/open") result = { sessionId: "fixture-session" };
      if (request.url === "/api/v1/turns/start") result = { turnId: "fixture-turn", injectedContext: { markdown: "MEMMY_TEST_RECALL" } };
      response.writeHead(result ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(result || {}));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const yaml = join(dir, "memmy.yaml");
      await writeFile(yaml, `memmyMemory:\n  storage:\n    endpoint: http://127.0.0.1:${server.address().port}\n`);
      await factory({ rootDirectory: config, memmyConfigPath: yaml }).installPlugin("opencode");
      const v2 = version.startsWith("2.");
      if (v2) await writeFile(join(config, "plugins/zz-loader-check.js"), `export default {
        id: "memmy-loader-check", async setup(ctx) {
          const tools = await ctx.tool.list();
          for (const name of ["memmy_memory_search", "memmy_memory_get", "memmy_memory_add"]) {
            if (!tools.some(tool => tool.name === name || tool.id === name)) throw new Error("Missing tool " + name);
          }
          console.error("MEMMY_REAL_V2_TOOLS_OK");
        }
      };`);
      const env = { ...process.env, PWD: project, OPENCODE_CONFIG_DIR: config,
        XDG_CONFIG_HOME: join(dir, "config"), XDG_DATA_HOME: join(dir, "data"),
        XDG_CACHE_HOME: join(dir, "cache"), XDG_STATE_HOME: join(dir, "state") };
      const reported = await run(resolve(binary), ["--version"], env, project);
      assert.equal(reported.output.trim().replace(/^opencode v/, ""), version);
      // The nonexistent model deliberately stops after initialization, with no LLM request.
      const result = await run(resolve(binary), ["run", ...(v2 ? ["--standalone"] : []),
        "--model", "memmy-loader-check/no-model", "--print-logs", "--log-level", v2 ? "debug" : "DEBUG", "loader check"], env, project);
      await writeFile(join(dir, "process.log"), result.output);
      assert(!result.timeout, `${version}/${name}: timed out`);
      assert(result.output.includes(`entry=${v2 ? "v2" : "v1"}`), `${version}/${name}: missing actual plugin initialization`);
      assert(!/failed to load plugin|Cannot find package/.test(result.output), `${version}/${name}: plugin loading error`);
      if (v2) {
        assert(result.output.includes("MEMMY_REAL_V2_TOOLS_OK"), `${version}/${name}: tools absent from real registry`);
        assert(result.output.includes("Memmy plugin disposed:"), `${version}/${name}: cleanup did not finish`);
      }
      await writeFile(join(dir, "fixture-requests.json"), JSON.stringify(calls, null, 2));
      if (v2) assert(calls.some(call => call.path === "/api/v1/turns/start"), `${version}/${name}: actual prompt hook did not recall memory`);
      assert(/Model.*not found|ModelUnavailable|ProviderModelNotFound|Unknown model/i.test(result.output), "Expected intentional unavailable model termination");
      console.log(`${version}/${name}: real loader passed (model intentionally unavailable)`);
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
}

function run(binary, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", timeout = false;
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", chunk => output += chunk);
    const timer = setTimeout(() => { timeout = true; child.kill("SIGTERM"); }, 45000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolve({ output, timeout, code }); });
  });
}
