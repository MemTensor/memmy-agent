import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecTool } from "../../../../src/core/agent-runtime/tools/shell.js";
import { ExecSessionManager, WriteStdinTool } from "../../../../src/core/agent-runtime/tools/exec-session.js";
import { ToolRegistry } from "../../../../src/core/agent-runtime/tools/registry.js";

const roots: string[] = [];
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-exec-aliases-"));
  roots.push(root);
  const manager = new ExecSessionManager();
  const exec = new ExecTool({ workspace: root, sessionManager: manager });
  const stdin = new WriteStdinTool({ manager });
  const registry = new ToolRegistry();
  registry.register(exec);
  registry.register(stdin);
  return { root, manager, exec, stdin, registry };
}

function nodeCommand(code: string) {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("exec canonical parameters and legacy compatibility", () => {
  it("publishes only canonical fields and describes the actual output unit in both tools", () => {
    const { registry } = setup();
    const definitions = registry.getDefinitions().map((definition) => definition.function);
    const schema = definitions.find((definition) => definition.name === "exec")!.parameters;
    expect(Object.keys(schema.properties).sort()).toEqual([
      "command", "cwd", "login", "max_output_chars", "shell", "timeout", "yield_time_ms",
    ]);
    expect(schema.required).toEqual(["command"]);
    for (const definition of definitions) {
      expect(definition.parameters.properties).not.toHaveProperty("max_output_tokens");
      expect(definition.parameters.properties.max_output_chars.description).toContain("UTF-16 code units");
      expect(definition.parameters.properties.max_output_chars.description).toContain("not tokens");
    }
    expect(registry.prepareCall("exec", {})[2]).toContain("missing required command");
  });

  it("normalizes all historical exec names after type conversion without mutating input", () => {
    const { registry, exec } = setup();
    const input = {
      cmd: "echo compatible", working_dir: "nested", workingDir: "nested", workdir: "nested",
      timeout_s: "5", timeoutS: 5, yieldTimeMs: "0", maxOutputChars: "1000",
      max_output_tokens: 1000, maxOutputTokens: "1000", login: "false",
    };
    const before = structuredClone(input);
    const [, normalized, error] = registry.prepareCall("exec", input);
    expect(error).toBeNull();
    expect(normalized).toEqual({
      command: "echo compatible", cwd: "nested", timeout: 5, yield_time_ms: 0, max_output_chars: 1000, login: false,
    });
    expect(input).toEqual(before);
    expect(exec.castParams(normalized)).toEqual(normalized);
  });

  it("merges equal duplicates and keeps nullish fallback and explicit zero", () => {
    const { registry } = setup();
    const [, normalized, error] = registry.prepareCall("exec", {
      command: "echo ok", cmd: "echo ok", cwd: null, workdir: "nested", timeout: undefined, timeoutS: "5",
      yield_time_ms: 0, yieldTimeMs: "0", max_output_chars: 1000, max_output_tokens: "1000", login: false,
    });
    expect(error).toBeNull();
    expect(normalized).toEqual({ command: "echo ok", cwd: "nested", timeout: 5, yield_time_ms: 0, max_output_chars: 1000, login: false });
    expect(registry.prepareCall("exec", { command: null, cmd: "echo ok", max_output_chars: null })[1]).toEqual({ command: "echo ok" });
  });

  const conflicts = [
    { command: "echo one", cmd: "echo two" },
    { command: "", cmd: "echo two" },
    { command: "echo one", cmd: "" },
    { cwd: "", working_dir: "nested" },
    { cwd: "one", workingDir: "two" },
    { working_dir: "one", workdir: "two" },
    { timeout: 1, timeout_s: 2 },
    { timeout_s: 1, timeoutS: 2 },
    { timeout: 9999, timeoutS: 9998 },
    { yield_time_ms: 0, yieldTimeMs: 1 },
    { max_output_chars: 1000, maxOutputChars: 2000 },
    { max_output_chars: 1000, max_output_tokens: 2000 },
    { max_output_tokens: 1000, maxOutputTokens: 2000 },
  ];
  it.each(conflicts)("rejects conflicts before command preparation/spawn/session creation: %j", async (conflict) => {
    const { root, registry, exec, manager } = setup();
    // If accidentally executed, the command would create an observable file in the fixture.
    const command = nodeCommand("require('fs').writeFileSync('unexpected.txt','changed')");
    const prepare = vi.spyOn(exec, "prepareCommand");
    const spawn = vi.spyOn(ExecTool, "spawnProcess");
    const start = vi.spyOn(manager, "start");
    for (const session of [false, true]) {
      const input = { command, ...(session ? { yield_time_ms: 0 } : {}), ...conflict };
      const [, cast, error] = registry.prepareCall("exec", input);
      expect(exec.castParams(cast)).toEqual(cast);
      for (const result of [error, await registry.execute("exec", input), await exec.execute(input)]) {
        expect(result).toContain("Conflicting parameters:");
        for (const field of Object.keys(conflict)) expect(result).toContain(field);
      }
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it.each([
    [{ cmd: "" }, "at least 1"],
    [{ cmd: "  \n " }, "must not be blank"],
    [{ timeoutS: "bad" }, "timeout should be integer"],
    [{ timeout_s: 0 }, "timeout must be >= 1"],
    [{ maxOutputTokens: "bad" }, "max_output_chars should be integer"],
    [{ max_output_tokens: 999 }, "max_output_chars must be >= 1000"],
    [{ maxOutputChars: 50001 }, "max_output_chars must be <= 50000"],
    [{ yieldTimeMs: -1 }, "yield_time_ms must be >= 0"],
  ])("validates legacy fields before execution: %j", async (options, message) => {
    const { registry, exec } = setup();
    const prepare = vi.spyOn(exec, "prepareCommand");
    const input = { cmd: "echo ok", ...options };
    expect(registry.prepareCall("exec", input)[2]).toContain(message);
    expect(await exec.execute(input as any)).toContain(message);
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([{ input: null }, { input: [] }, { input: "echo ok" }])("rejects non-object direct arguments: $input", async ({ input }) => {
    const { exec } = setup();
    const prepare = vi.spyOn(exec, "prepareCommand");
    expect(await exec.execute(input as any)).toContain("parameters must be an object");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("executes old command/cwd/timeout fields through the registry", async () => {
    const { root, registry } = setup();
    fs.mkdirSync(path.join(root, "nested"));
    const result = await registry.execute("exec", {
      cmd: nodeCommand("console.log(process.cwd())"), workdir: "nested", timeoutS: "5", login: false,
    });
    expect(result).toContain(path.join(root, "nested"));
    expect(result).toContain("Exit code: 0");
  });

  it("preserves the direct-call timeout cap for legacy fields", async () => {
    const { exec } = setup();
    const prepare = vi.spyOn(exec, "prepareCommand");
    const result = await exec.execute({ cmd: "echo capped", timeoutS: 9999 });
    expect(result).toContain("Exit code: 0");
    expect(prepare).toHaveBeenCalledWith("echo capped", undefined, ExecTool.MAX_TIMEOUT, undefined, undefined);
  });

  it.each([false, true])("preserves character budgets for all old output names with Unicode (session=%s)", async (session) => {
    const { registry, manager } = setup();
    const results: string[] = [];
    for (const field of ["max_output_chars", "maxOutputChars", "max_output_tokens", "maxOutputTokens"]) {
      const result = await registry.execute("exec", {
        command: nodeCommand("process.stdout.write('中😀'.repeat(800))"),
        login: false, timeout: 5, [field]: 1000, ...(session ? { yieldTimeMs: 1000 } : {}),
      });
      // Collect completion if a slow host returns a running session.
      let output = result;
      const id = result.match(/session_id:\s*([0-9a-f]+)/)?.[1];
      if (id) {
        try {
          output += await registry.execute("write_stdin", { sessionId: id, yieldTimeMs: 1000, [field]: 1000 });
        } finally {
          await manager.stop(id);
        }
      }
      expect(output).toContain("Exit code: 0");
      expect(output).toContain("chars truncated");
      results.push(output.replace(/Elapsed: [\d.]+s/g, ""));
    }
    expect(new Set(results).size).toBe(1);
    // 800 BMP characters + 800 surrogate pairs = 2400 UTF-16 units, not 1600 characters/tokens.
    if (session) expect(results[0]).toContain("1,400 chars truncated");
  });
});

describe("write_stdin output limit compatibility", () => {
  it("normalizes legacy fields and preserves empty stdin and false", async () => {
    const { registry, manager } = setup();
    const write = vi.spyOn(manager, "write").mockResolvedValue({ output: "done", done: true, exitCode: 0, elapsedS: 0 } as any);
    const input = { sessionId: "session", chars: "", closeStdin: false, yieldTimeMs: "0", maxOutputTokens: "1000" };
    expect(registry.prepareCall("write_stdin", input)[1]).toEqual({
      session_id: "session", chars: "", close_stdin: false, yield_time_ms: 0, max_output_chars: 1000,
    });
    expect(await registry.execute("write_stdin", input)).toContain("done");
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ chars: "", closeStdin: false, yieldTimeMs: 0, maxOutputChars: 1000 }));
  });

  it.each([
    { max_output_chars: 1000, max_output_tokens: 2000 },
    { maxOutputChars: 1000, maxOutputTokens: 2000 },
    { session_id: "one", sessionId: "two" },
    { close_stdin: false, closeStdin: true },
    { yield_time_ms: 0, yieldTimeMs: 1 },
    { wait_for: "", waitFor: "ready" },
    { wait_timeout_ms: 0, waitTimeoutMs: 1 },
  ])("rejects conflicting options before sending stdin or terminating: %j", async (options) => {
    const { registry, stdin, manager } = setup();
    const write = vi.spyOn(manager, "write");
    const stop = vi.spyOn(manager, "stop");
    const input = { session_id: "session", chars: "dangerous\n", terminate: true, ...options };
    expect(registry.prepareCall("write_stdin", input)[2]).toContain("Conflicting parameters:");
    expect(await registry.execute("write_stdin", input)).toContain("Conflicting parameters:");
    expect(await stdin.execute(input)).toContain("Conflicting parameters:");
    expect(write).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not bypass output limit validation through deprecated names", async () => {
    const { registry, stdin, manager } = setup();
    const write = vi.spyOn(manager, "write");
    const input = { sessionId: "session", maxOutputTokens: "bad" };
    expect(registry.prepareCall("write_stdin", input)[2]).toContain("max_output_chars should be integer");
    expect(await stdin.execute(input as any)).toContain("max_output_chars should be integer");
    expect(write).not.toHaveBeenCalled();
  });
});
