import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fileLintTesting,
  formatFileLintResults,
  lintFile,
  lintFiles,
  type FileLintRuntime,
} from "../../../../src/core/agent-runtime/tools/file-lint.js";

type FakeSpawnOptions = {
  delayMs?: number;
  onActiveChange?: (delta: number) => void;
  onKill?: (signal?: NodeJS.Signals | number) => void;
  onSpawn?: (command: string, args: string[], options: Record<string, unknown>) => void;
  stderrText?: string;
};

function createFakeSpawn(options: FakeSpawnOptions = {}): typeof nodeSpawn {
  return ((command: string, args: string[], spawnOptions: Record<string, unknown>) => {
    options.onActiveChange?.(1);
    options.onSpawn?.(command, args, spawnOptions);
    const child = new EventEmitter() as ChildProcess;
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const chunks: Buffer[] = [];
    let closed = false;
    const close = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (closed) return;
      closed = true;
      options.onActiveChange?.(-1);
      child.emit("close", code, signal);
    };
    stdin.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stdin.on("finish", () => {
      const content = Buffer.concat(chunks).toString("utf8");
      const isProbe = content === "fn main() {}\n";
      const invalid = !isProbe && content.includes("INVALID");
      if (options.stderrText != null) stderr.write(options.stderrText);
      else if (invalid) stderr.write("syntax error at line 1\n");
      stderr.end();
      setTimeout(() => close(invalid ? 1 : 0, null), options.delayMs ?? 0).unref();
    });
    Object.assign(child, {
      stdin,
      stderr,
      kill: vi.fn((signal?: NodeJS.Signals | number) => {
        options.onKill?.(signal);
        queueMicrotask(() => close(null, "SIGTERM"));
        return true;
      }),
    });
    return child;
  }) as typeof nodeSpawn;
}

function externalRuntime(spawn = createFakeSpawn()): FileLintRuntime {
  return {
    resolveCommand: (command) => `/tools/${command}`,
    spawn,
  };
}

afterEach(() => {
  fileLintTesting.clearRustEditionCache();
  vi.restoreAllMocks();
});

describe("file lint registry", () => {
  it.each([
    ["data.json", "{\"ok\":true}", "{\"ok\":"],
    ["data.yaml", "first: 1\n---\nsecond: 2\n", "items: [one, two\n"],
    ["data.toml", "name = \"memmy\"\n", "name = [\n"],
    ["data.xml", "<root><item /></root>", "<root>"],
    ["icon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", "<svg>"],
    ["style.css", "body { color: red; }", "body {\n"],
    ["code.js", "const value = 1;", "const = ;"],
    ["code.mjs", "export const value = 1;", "export const = ;"],
    ["code.cjs", "module.exports = 1;", "const = ;"],
    ["code.jsx", "const node = <div />;", "const node = <div>;"],
    ["code.ts", "const value: number = 1;", "const value: = 1;"],
    ["code.mts", "export const value: number = 1;", "export const value: = 1;"],
    ["code.cts", "export const value: number = 1;", "export const value: = 1;"],
    ["code.tsx", "const node = <div />;", "const node = <div>;"],
  ])("validates %s with passed and failed results", async (file, valid, invalid) => {
    const validResult = await lintFile({ path: file, content: valid });
    const invalidResult = await lintFile({ path: file, content: invalid });

    expect(validResult.status).toBe("passed");
    expect(invalidResult.status).toBe("failed");
    expect(invalidResult.output).not.toBe("");
  });

  it("accepts YAML streams and preserves warning-only output", async () => {
    const stream = await lintFile({ path: "stream.yaml", content: "first: 1\n---\nsecond: 2\n" });
    const warning = await lintFile({ path: "tag.yaml", content: "value: !custom content\n" });

    expect(stream).toMatchObject({ status: "passed", output: "" });
    expect(warning.status).toBe("passed");
    expect(warning.output).toContain("Unresolved tag");
  });

  it("validates complete HTML, fragments, embedded content, and truncation", async () => {
    const complete = await lintFile({
      path: "page.html",
      content: "<!doctype html><html><head><style>body { color: red; }</style></head><body><script>const value = 1;</script></body></html>",
    });
    const fragment = await lintFile({ path: "fragment.html", content: "<div>fragment</div>" });
    const truncated = await lintFile({
      path: "broken.html",
      content: "<!doctype html><html><head><style>body { color:",
    });
    const embeddedJs = await lintFile({
      path: "script.html",
      content: "<script>const value: = 1;</script>",
    });
    const excludedScript = await lintFile({
      path: "data.html",
      content: "<script type=\"application/json\">{not json}</script>",
    });

    expect(complete.status).toBe("passed");
    expect(fragment.status).toBe("passed");
    expect(truncated.status).toBe("failed");
    expect(truncated.output).toContain("Missing explicit </html>");
    expect(embeddedJs.status).toBe("failed");
    expect(excludedScript.status).toBe("passed");
  });

  it("does not let inline directives disable the fixed HTML rules", async () => {
    const plain = await lintFile({ path: "plain.html", content: "<!-- html-validate-disable close-order --><b><i>x</b></i>" });
    const bracketed = await lintFile({ path: "bracketed.html", content: "<!-- [html-validate-disable close-order] --><div>x</div>" });

    expect(plain.status).toBe("failed");
    expect(plain.output).toContain("Inline html-validate directives are not allowed");
    expect(bracketed.status).toBe("failed");
  });

  it("returns skipped for unsupported, binary-like, oversized, and unavailable validators", async () => {
    const unsupported = await lintFile({ path: "README.md", content: "text" });
    const binary = await lintFile({ path: "data.json", content: "{}\0" });
    const oversized = await lintFile({
      path: "data.json",
      content: "x".repeat(fileLintTesting.constants.MAX_LINT_BYTES + 1),
    });
    const missing = await lintFile(
      { path: "script.py", content: "print('ok')" },
      { runtime: { resolveCommand: () => null } },
    );

    expect(unsupported).toMatchObject({ status: "skipped" });
    expect(unsupported.output).toContain("No validator for .md");
    expect(binary).toMatchObject({ status: "skipped" });
    expect(oversized).toMatchObject({ status: "skipped" });
    expect(missing).toMatchObject({ status: "skipped" });
    expect(missing.output).toContain("not available");
  });

  it("limits in-process diagnostics to 64 KiB with an explicit omission marker", async () => {
    const result = await lintFile({
      path: "many-errors.ts",
      content: "const = ;\n".repeat(20_000),
    });

    expect(result.status).toBe("failed");
    expect(result.output.length).toBeLessThanOrEqual(fileLintTesting.constants.MAX_VALIDATOR_OUTPUT_CHARS);
    expect(result.output).toMatch(/omitted \d+ characters/);
  });

  it("keeps FileLintResult flat", async () => {
    const result = await lintFile({ path: "data.json", content: "{}" });

    expect(Object.keys(result).sort()).toEqual(["output", "path", "status"]);
  });
});

describe("external file validators", () => {
  it.each(["script.py", "main.go", "main.rs"])("maps valid and invalid %s input", async (file) => {
    const runtime = externalRuntime();
    const valid = await lintFile({ path: file, content: "valid input" }, { runtime });
    const invalid = await lintFile({ path: file, content: "INVALID input" }, { runtime });

    expect(valid.status).toBe("passed");
    expect(invalid.status).toBe("failed");
    expect(invalid.output).toContain("syntax error");
  });

  it("uses absolute commands, disables shell execution, and isolates rustfmt config", async () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const runtime = externalRuntime(createFakeSpawn({
      onSpawn: (command, args, options) => calls.push({ command, args, options }),
    }));

    await lintFile({ path: "main.rs", content: "fn main() {}" }, { runtime });

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => path.isAbsolute(call.command))).toBe(true);
    expect(calls.every((call) => call.options.shell === false)).toBe(true);
    const configPaths = calls.map((call) => call.args[call.args.indexOf("--config-path") + 1]);
    expect(configPaths.every((configPath) => fs.existsSync(path.dirname(configPath)))).toBe(false);
  });

  it("falls back from python3 to python and reports timeouts and oversized stderr as skipped", async () => {
    const resolved: string[] = [];
    const fallback = await lintFile(
      { path: "script.py", content: "valid input" },
      {
        runtime: {
          resolveCommand: (command) => {
            resolved.push(command);
            return command === "python" ? "/tools/python" : null;
          },
          spawn: createFakeSpawn(),
        },
      },
    );
    const timedOut = await lintFile(
      { path: "script.py", content: "valid input" },
      { runtime: { ...externalRuntime(createFakeSpawn({ delayMs: 10_000 })), timeoutMs: 1 } },
    );
    const oversized = await lintFile(
      { path: "script.py", content: "INVALID input" },
      {
        runtime: externalRuntime(createFakeSpawn({
          stderrText: "x".repeat(fileLintTesting.constants.MAX_VALIDATOR_OUTPUT_CHARS + 1),
        })),
      },
    );

    expect(fallback.status).toBe("passed");
    expect(resolved).toEqual(["python3", "python"]);
    expect(timedOut).toMatchObject({ status: "skipped" });
    expect(timedOut.output).toContain("timed out");
    expect(oversized).toMatchObject({ status: "skipped" });
    expect(oversized.output).toContain("stderr exceeded");
  });

  it("turns validator setup failures into skipped without exposing a stack", async () => {
    const result = await lintFile(
      { path: "script.py", content: "print('ok')" },
      { runtime: { resolveCommand: () => { throw new Error("resolver broke"); } } },
    );

    expect(result.status).toBe("skipped");
    expect(result.output).toContain("resolver broke");
    expect(result.output).not.toContain("at ");
  });

  it("terminates the child and rethrows AbortError", async () => {
    const controller = new AbortController();
    const killSignals: Array<NodeJS.Signals | number | undefined> = [];
    const spawn = createFakeSpawn({
      delayMs: 10_000,
      onKill: (signal) => killSignals.push(signal),
      onSpawn: () => queueMicrotask(() => controller.abort()),
    });

    await expect(lintFile(
      { path: "script.py", content: "valid input" },
      { abortSignal: controller.signal, runtime: externalRuntime(spawn) },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(killSignals).toContain("SIGTERM");
  });
});

describe("lint delta, batching, and formatting", () => {
  it("only excuses an identical pre-existing failure", async () => {
    const unchanged = await lintFile({
      path: "data.json",
      previousContent: "{",
      content: "{",
      useDelta: true,
    });
    const changed = await lintFile({
      path: "data.json",
      previousContent: "{",
      content: "[",
      useDelta: true,
    });
    const postSkipped = await lintFile({
      path: "README.md",
      previousContent: "old",
      content: "new",
      useDelta: true,
    });

    expect(unchanged.status).toBe("passed");
    expect(unchanged.output).toContain("pre-existing lint output unchanged");
    expect(changed.status).toBe("failed");
    expect(postSkipped.status).toBe("skipped");
  });

  it("runs no more than four validators and preserves request order", async () => {
    let active = 0;
    let maximum = 0;
    const spawn = createFakeSpawn({
      delayMs: 10,
      onActiveChange: (delta) => {
        active += delta;
        maximum = Math.max(maximum, active);
      },
    });
    const requests = Array.from({ length: 9 }, (_, index) => ({
      path: `file-${index}.py`,
      content: "valid input",
    }));

    const results = await lintFiles(requests, { runtime: externalRuntime(spawn) });

    expect(maximum).toBe(4);
    expect(results.map((result) => path.basename(result.path))).toEqual(requests.map((request) => request.path));
  });

  it("shares the 8000-character output budget across all files", () => {
    const results = Array.from({ length: 20 }, (_, index) => ({
      path: `/workspace/file-${index}.ts`,
      status: "failed" as const,
      output: `${index}:` + "x".repeat(1_000) + `:${index}`,
    }));

    const formatted = formatFileLintResults(results);

    let previous = -1;
    for (const result of results) {
      const current = formatted.indexOf(`- ${result.path}: failed`);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
    expect(formatted.match(/omitted \d+ characters/g)).toHaveLength(20);
  });

  it("keeps 3976 characters from each end for one oversized output", () => {
    const formatted = formatFileLintResults([{
      path: "/workspace/large.ts",
      status: "failed",
      output: "H".repeat(5_000) + "T".repeat(5_000),
    }]);

    expect(formatted.match(/H/g)).toHaveLength(3_976);
    expect(formatted.match(/T/g)).toHaveLength(3_976);
    expect(formatted).toContain("omitted 2048 characters");
  });
});
