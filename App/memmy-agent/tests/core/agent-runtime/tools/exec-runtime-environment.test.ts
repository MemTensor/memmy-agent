import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecSessionManager } from "../../../../src/core/agent-runtime/tools/exec-session.js";
import { ExecTool } from "../../../../src/core/agent-runtime/tools/shell.js";

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

describe.skipIf(process.platform === "win32")("exec selected Unix runtime", () => {
  let root: string;
  let selectedBin: string;
  let fallbackBin: string;
  let selectedPath: string;
  let manager: ExecSessionManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-exec-runtime-"));
    selectedBin = path.join(root, "selected bin");
    fallbackBin = path.join(root, "fallback bin");
    fs.mkdirSync(selectedBin);
    fs.mkdirSync(fallbackBin);
    manager = new ExecSessionManager();

    const probe = path.join(root, "probe.mjs");
    fs.writeFileSync(probe, `
      import { execFileSync } from "node:child_process";
      const child = process.argv.includes("--child");
      console.log(JSON.stringify({
        selected: process.argv[2],
        path: process.env.PATH,
        venv: process.env.VIRTUAL_ENV,
        condaPrefix: process.env.CONDA_PREFIX,
        condaName: process.env.CONDA_DEFAULT_ENV,
        condaLevel: process.env.CONDA_SHLVL,
        custom: process.env.MEMMY_EXEC_CUSTOM_TEST_VALUE,
        secretPresent: "MEMMY_EXEC_SECRET_TEST_VALUE" in process.env,
        nested: child ? null : JSON.parse(execFileSync("memmy-test-runtime", ["--child"], { encoding: "utf8" }))
      }));
    `);
    for (const [directory, identity] of [[selectedBin, "selected"], [fallbackBin, "fallback"]]) {
      fs.writeFileSync(path.join(directory, "memmy-test-runtime"),
        `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(probe)} ${shellQuote(identity)} "$@"\n`,
        { mode: 0o755 });
    }
    selectedPath = `${selectedBin}:/usr/bin:/bin`;
    vi.stubEnv("PATH", selectedPath);
    vi.stubEnv("VIRTUAL_ENV", path.join(root, "venv"));
    vi.stubEnv("CONDA_PREFIX", path.join(root, "conda"));
    vi.stubEnv("CONDA_DEFAULT_ENV", "selected");
    vi.stubEnv("CONDA_SHLVL", "1");
    vi.stubEnv("MEMMY_EXEC_CUSTOM_TEST_VALUE", "explicitly-allowed");
    vi.stubEnv("MEMMY_EXEC_SECRET_TEST_VALUE", "synthetic-secret");
  });

  afterEach(async () => {
    for (const id of [...manager.sessions.keys()]) await manager.stop(id);
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function executeProbe(session: boolean, shell: string | null, pathAppend = "") {
    const tool = new ExecTool({
      workspace: root,
      sessionManager: manager,
      pathAppend,
      allowedEnvKeys: ["MEMMY_EXEC_CUSTOM_TEST_VALUE"],
    });
    let output = await tool.execute({
      command: "memmy-test-runtime",
      shell,
      login: false,
      timeout: 5,
      ...(session ? { yield_time_ms: 0 } : {}),
    });
    const id = output.match(/session_id:\s*([0-9a-f]+)/)?.[1];
    if (id) {
      for (;;) {
        const poll = await manager.write({ sessionId: id, yieldTimeMs: 1000 });
        output += `\n${poll.output}`;
        if (poll.done) {
          expect(poll.exitCode, output).toBe(0);
          break;
        }
      }
    } else {
      expect(output).toContain("Exit code: 0");
    }
    const line = output.split(/\r?\n/).find((line) => line.startsWith("{"));
    expect(line, output).toBeDefined();
    return JSON.parse(line!);
  }

  function expectSelectedRuntime(result: Record<string, unknown>, expectedPath: string) {
    const expected = {
      selected: "selected",
      path: expectedPath,
      venv: path.join(root, "venv"),
      condaPrefix: path.join(root, "conda"),
      condaName: "selected",
      condaLevel: "1",
      custom: "explicitly-allowed",
      secretPresent: false,
    };
    expect(result).toMatchObject({ ...expected, nested: { ...expected, nested: null } });
  }

  it.each([
    { route: "one-shot", session: false, shell: "/bin/bash" },
    { route: "session", session: true, shell: "/bin/bash" },
    { route: "default-shell one-shot", session: false, shell: null },
    { route: "default-shell session", session: true, shell: null },
  ])("preserves the runtime for $route and nested child processes", async ({ session, shell }) => {
    expectSelectedRuntime(await executeProbe(session, shell), selectedPath);
  });

  it.each([false, true])("pathAppend keeps the selected runtime ahead of fallback tools (session=%s)", async (session) => {
    expectSelectedRuntime(await executeProbe(session, "/bin/bash", fallbackBin), `${selectedPath}:${fallbackBin}`);
  });
});
