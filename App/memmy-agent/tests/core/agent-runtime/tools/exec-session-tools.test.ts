import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import iconv from "iconv-lite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecSession, ExecSessionManager, ListExecSessionsTool, WriteStdinTool } from "../../../../src/core/agent-runtime/tools/exec-session.js";
import { ExecTool, ExecToolConfig } from "../../../../src/core/agent-runtime/tools/shell.js";

const WINDOWS_COMMAND_NOT_FOUND = "'node' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。\r\n";

const roots: string[] = [];

function tmpDir(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function nodeCommand(code: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)}`;
}

function sessionId(output: string): string {
  const match = output.match(/session_id:\s*([0-9a-f]+)/);
  expect(match?.[1], output).toBeTruthy();
  return match![1];
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(predicate()).toBe(true);
}

function fakeSessionChild() {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => true);
  return child;
}

function closeFakeSessionChild(child: ReturnType<typeof fakeSessionChild>, exitCode = 0): void {
  child.exitCode = exitCode;
  child.stdout.end();
  child.stderr.end();
  child.emit("close", exitCode, null);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("exec session tools", () => {
  it("keeps one-shot behavior without yield_time_ms", async () => {
    const root = tmpDir("memmy-exec-one-shot-");
    const result = await new ExecTool({ workspace: root, config: new ExecToolConfig({ timeoutS: 5 }) }).execute({ command: "echo hello" });

    expect(result).toContain("hello");
    expect(result).toContain("Exit code: 0");
    expect(result).not.toContain("session_id:");
  });

  it("accepts command aliases and workdir aliases", async () => {
    const root = tmpDir("memmy-exec-alias-");
    const subdir = path.join(root, "subdir");
    fs.mkdirSync(subdir);

    const result = await new ExecTool({ workspace: root }).execute({
      cmd: nodeCommand("console.log(process.cwd())"),
      workdir: "subdir",
    });

    expect(result).toContain(subdir);
    expect(result).toContain("Exit code: 0");
  });

  it("falls back to non-empty aliases when preferred alias is empty", async () => {
    const root = tmpDir("memmy-exec-empty-alias-");
    const subdir = path.join(root, "subdir");
    fs.mkdirSync(subdir);

    const result = await new ExecTool({ workspace: root }).execute({
      command: "",
      cmd: nodeCommand("console.log(process.cwd())"),
      cwd: "",
      working_dir: "subdir",
      shell: "",
    });

    expect(result).toContain(subdir);
    expect(result).toContain("Exit code: 0");
  });

  it("returns completed output when yield_time_ms is used", async () => {
    const root = tmpDir("memmy-exec-yield-");
    const manager = new ExecSessionManager();
    const exec = new ExecTool({ workspace: root, sessionManager: manager, config: new ExecToolConfig({ timeoutS: 5 }) });
    const stdin = new WriteStdinTool({ manager });

    let result = await exec.execute({ command: "echo hello", yield_time_ms: 1000 });
    if (result.includes("session_id:")) {
      result += `\n${await stdin.execute({ session_id: sessionId(result), chars: "", yield_time_ms: 1000 })}`;
    }

    expect(result).toContain("hello");
    expect(result).toContain("Exit code: 0");
  });

  it("returns decoded CP936 output during the initial yield", async () => {
    const manager = new ExecSessionManager();
    const child = fakeSessionChild();
    setTimeout(() => child.stdout.write(iconv.encode(WINDOWS_COMMAND_NOT_FOUND, "cp936")), 5);

    const [id, initial] = await manager.start({
      command: "mock command",
      yieldTimeMs: 20,
      decoderOptions: { platform: "win32", oemCodePage: 936 },
      spawnProcess: (() => child) as any,
    });

    expect(initial.output).toBe(WINDOWS_COMMAND_NOT_FOUND);
    expect(initial.done).toBe(false);
    expect(initial.output).not.toContain("�");

    closeFakeSessionChild(child);
    const final = await manager.write({ sessionId: id, yieldTimeMs: 0 });
    expect(final.done).toBe(true);
    expect(final.output).toBe("");
  });

  it("preserves split OEM output across polls and write_stdin without duplication", async () => {
    const manager = new ExecSessionManager();
    const child = fakeSessionChild();
    const first = iconv.encode("准备", "cp936");
    const second = iconv.encode("完成", "cp936");
    child.stdin.once("data", () => child.stdout.write(second));
    const [id] = await manager.start({
      command: "mock command",
      yieldTimeMs: 0,
      decoderOptions: { platform: "win32", oemCodePage: 936 },
      spawnProcess: (() => child) as any,
    });

    child.stdout.write(first.subarray(0, 1));
    expect((await manager.write({ sessionId: id, yieldTimeMs: 0 })).output).toBe("");
    child.stdout.write(first.subarray(1));
    const beforeInput = await manager.write({ sessionId: id, yieldTimeMs: 0 });
    const afterInput = await manager.write({ sessionId: id, chars: "ping\n", yieldTimeMs: 0 });

    expect(beforeInput.output).toBe("准备");
    expect(afterInput.output).toBe("完成");
    expect(beforeInput.output + afterInput.output).toBe("准备完成");

    closeFakeSessionChild(child);
    await manager.write({ sessionId: id, yieldTimeMs: 0 });
  });

  it("keeps stdout and stderr event order and delays the stderr heading for a partial character", async () => {
    const child = fakeSessionChild();
    const session = new ExecSession({
      command: "mock command",
      decoderOptions: { platform: "win32", oemCodePage: 936 },
      spawnProcess: (() => child) as any,
    });
    const errorBytes = iconv.encode("错误继续", "cp936");

    child.stdout.write(Buffer.from("stdout-1|"));
    child.stderr.write(errorBytes.subarray(0, 1));
    expect((await session.poll(0, 10_000)).output).toBe("stdout-1|");

    child.stderr.write(errorBytes.subarray(1, 4));
    child.stdout.write(Buffer.from("stdout-2|"));
    child.stderr.write(errorBytes.subarray(4));
    const output = (await session.poll(0, 10_000)).output;

    expect(output).toBe("STDERR:\n错误stdout-2|继续");
    expect(output.match(/STDERR:/g)).toHaveLength(1);

    closeFakeSessionChild(child);
    await session.poll(0, 10_000);
  });

  it("does not report done until close flushes the final stream bytes", async () => {
    const child = fakeSessionChild();
    const session = new ExecSession({
      command: "mock command",
      decoderOptions: { platform: "win32", oemCodePage: 936 },
      spawnProcess: (() => child) as any,
    });
    const encoded = Buffer.from("最后输出", "utf8");
    child.stdout.write(encoded.subarray(0, encoded.length - 1));
    child.exitCode = 0;

    let settled = false;
    const pending = session.poll(0, 10_000).then((poll) => {
      settled = true;
      return poll;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    child.stdout.write(encoded.subarray(encoded.length - 1));
    closeFakeSessionChild(child);
    const final = await pending;

    expect(final.done).toBe(true);
    expect(final.exitCode).toBe(0);
    expect(final.output).toBe("最后输出");
  });

  it("accepts max_output_tokens for session output", async () => {
    const root = tmpDir("memmy-exec-tokens-");
    const manager = new ExecSessionManager();
    const exec = new ExecTool({ workspace: root, sessionManager: manager, config: new ExecToolConfig({ timeoutS: 5 }) });

    const result = await exec.execute({
      command: nodeCommand("console.log('A'.repeat(2000))"),
      yield_time_ms: 1000,
      max_output_tokens: 1000,
    });

    expect(result).toContain("chars truncated");
    expect(result).toContain("Exit code: 0");
  });

  it("accepts max_output_tokens for one-shot output", async () => {
    const root = tmpDir("memmy-exec-one-shot-tokens-");

    const result = await new ExecTool({ workspace: root, config: new ExecToolConfig({ timeoutS: 5 }) }).execute({
      command: nodeCommand("console.log('A'.repeat(2000))"),
      max_output_tokens: 1000,
    });

    expect(result).toContain("chars truncated");
    expect(result).toContain("Exit code: 0");
  });

  it("accepts a supported shell parameter", async () => {
    if (process.platform === "win32") return;
    const root = tmpDir("memmy-exec-shell-");

    const result = await new ExecTool({ workspace: root, config: new ExecToolConfig({ timeoutS: 5 }) }).execute({
      command: "echo shell-ok",
      shell: "sh",
      login: false,
    });

    expect(result).toContain("shell-ok");
    expect(result).toContain("Exit code: 0");
  });

  it("rejects an unsupported shell parameter", async () => {
    if (process.platform === "win32") return;
    const root = tmpDir("memmy-exec-shell-reject-");

    const result = await new ExecTool({ workspace: root, config: new ExecToolConfig({ timeoutS: 5 }) }).execute({
      command: "echo no",
      shell: "node",
    });

    expect(result).toContain("unsupported shell");
  });

  it("continues with stdin", async () => {
    const root = tmpDir("memmy-exec-stdin-");
    const manager = new ExecSessionManager();
    const exec = new ExecTool({ workspace: root, sessionManager: manager, config: new ExecToolConfig({ timeoutS: 5 }) });
    const stdin = new WriteStdinTool({ manager });
    const initial = await exec.execute({
      command: nodeCommand("process.stdout.write('ready\\n'); process.stdin.once('data', d => { console.log('got:' + d.toString().trim()); process.exit(0); })"),
      yield_time_ms: 500,
    });

    const result = await stdin.execute({ session_id: sessionId(initial), chars: "ping\n", yield_time_ms: 1000 });

    expect(initial).toContain("ready");
    expect(initial).toContain("Process running");
    expect(result).toContain("got:ping");
    expect(result).toContain("Exit code: 0");
  });

  it("closes stdin", async () => {
    const root = tmpDir("memmy-exec-close-");
    const manager = new ExecSessionManager();
    const exec = new ExecTool({ workspace: root, sessionManager: manager, config: new ExecToolConfig({ timeoutS: 5 }) });
    const stdin = new WriteStdinTool({ manager });
    const initial = await exec.execute({
      command: nodeCommand("let data=''; process.stdin.on('data', d => data += d); process.stdin.on('end', () => console.log('got:' + data)); console.log('ready')"),
      yield_time_ms: 500,
    });

    const result = await stdin.execute({
      session_id: sessionId(initial),
      chars: "payload",
      close_stdin: true,
      yield_time_ms: 1000,
    });

    expect(initial).toContain("ready");
    expect(result).toContain("got:payload");
    expect(result).toContain("Stdin closed.");
    expect(result).toContain("Exit code: 0");
  });

  it("terminates sessions", async () => {
    const root = tmpDir("memmy-exec-terminate-");
    const manager = new ExecSessionManager();
    const exec = new ExecTool({ workspace: root, sessionManager: manager, config: new ExecToolConfig({ timeoutS: 30 }) });
    const stdin = new WriteStdinTool({ manager });
    const initial = await exec.execute({
      command: nodeCommand("console.log('ready'); setTimeout(() => {}, 30000)"),
      yield_time_ms: 500,
    });

    const result = await stdin.execute({ session_id: sessionId(initial), terminate: true, yield_time_ms: 0 });

    expect(initial).toContain("ready");
    expect(result).toContain("Session terminated.");
    expect(result).toContain("Exit code:");
  });

  it("accepts max_output_tokens for write_stdin output", async () => {
    const root = tmpDir("memmy-exec-stdin-tokens-");
    const manager = new ExecSessionManager();
    const exec = new ExecTool({ workspace: root, sessionManager: manager, config: new ExecToolConfig({ timeoutS: 5 }) });
    const stdin = new WriteStdinTool({ manager });
    const initial = await exec.execute({
      command: nodeCommand("console.log('A'.repeat(2000)); setTimeout(() => {}, 5000)"),
      yield_time_ms: 0,
    });
    const sid = sessionId(initial);

    const poll = await stdin.execute({ session_id: sid, yield_time_ms: 500, max_output_tokens: 1000 });
    const cleanup = await stdin.execute({ session_id: sid, terminate: true, yield_time_ms: 0 });

    expect(initial).toContain("Process running");
    expect(poll).toContain("chars truncated");
    expect(cleanup).toContain("Session terminated.");
  });

  it("preserves completed session output until it is polled", async () => {
    const root = tmpDir("memmy-exec-completed-poll-");
    const manager = new ExecSessionManager();
    const exec = new ExecTool({ workspace: root, sessionManager: manager, config: new ExecToolConfig({ timeoutS: 5 }) });
    const stdin = new WriteStdinTool({ manager });
    const initial = await exec.execute({
      command: nodeCommand("console.log('ready'); setTimeout(() => { console.log('done'); }, 1000)"),
      yield_time_ms: 300,
    });
    const sid = sessionId(initial);

    await new Promise((resolve) => setTimeout(resolve, 1200));
    const final = await stdin.execute({ session_id: sid, chars: "", yield_time_ms: 0 });

    expect(initial).toContain("ready");
    expect(final).toContain("done");
    expect(final).toContain("Exit code: 0");
  });

  it("waits for expected output", async () => {
    const root = tmpDir("memmy-exec-wait-");
    const manager = new ExecSessionManager();
    const exec = new ExecTool({ workspace: root, sessionManager: manager, config: new ExecToolConfig({ timeoutS: 5 }) });
    const stdin = new WriteStdinTool({ manager });
    const initial = await exec.execute({
      command: nodeCommand("console.log('booting'); setTimeout(() => console.log('ready'), 400); setTimeout(() => {}, 5000)"),
      yield_time_ms: 100,
    });

    const waited = await stdin.execute({ session_id: sessionId(initial), wait_for: "ready", wait_timeout_ms: 3000 });
    const cleanup = await stdin.execute({ session_id: sessionId(initial), terminate: true, yield_time_ms: 0 });

    expect(initial).toContain("Process running");
    expect(initial + waited).toContain("booting");
    expect(waited).toContain("ready");
    expect(waited).not.toContain("Wait target not observed");
    expect(cleanup).toContain("Session terminated.");
  });

  it("reports wait_for timeout without killing the session", async () => {
    const root = tmpDir("memmy-exec-wait-timeout-");
    const manager = new ExecSessionManager();
    const exec = new ExecTool({ workspace: root, sessionManager: manager, config: new ExecToolConfig({ timeoutS: 5 }) });
    const stdin = new WriteStdinTool({ manager });
    const initial = await exec.execute({
      command: nodeCommand("console.log('booting'); setTimeout(() => {}, 5000)"),
      yield_time_ms: 100,
    });

    const waited = await stdin.execute({ session_id: sessionId(initial), wait_for: "never-ready", wait_timeout_ms: 1200 });
    const cleanup = await stdin.execute({ session_id: sessionId(initial), terminate: true, yield_time_ms: 0 });

    expect(initial).toContain("Process running");
    expect(initial + waited).toContain("booting");
    expect(waited).toContain("Process running");
    expect(waited).toContain("Wait target not observed: 'never-ready'");
    expect(cleanup).toContain("Session terminated.");
  });

  it("reuses the exec safety guard in session mode", async () => {
    const root = tmpDir("memmy-exec-guard-");
    const manager = new ExecSessionManager();
    const tool = new ExecTool({
      workspace: root,
      config: new ExecToolConfig({ denyPatterns: [String.raw`echo\s+blocked`], timeoutS: 5 }),
      sessionManager: manager,
    });

    const result = await tool.execute({ command: "echo blocked", yield_time_ms: 0 });

    expect(result.toLowerCase()).toContain("deny pattern filter");
  });

  it("reports missing sessions", async () => {
    const result = await new WriteStdinTool({ manager: new ExecSessionManager() }).execute({
      session_id: "missing",
      chars: "",
    });

    expect(result).toContain("exec session not found");
  });

  it("lists running sessions", async () => {
    const root = tmpDir("memmy-exec-list-");
    const manager = new ExecSessionManager();
    const exec = new ExecTool({ workspace: root, sessionManager: manager, config: new ExecToolConfig({ timeoutS: 5 }) });
    const list = new ListExecSessionsTool({ manager });
    const stdin = new WriteStdinTool({ manager });
    const initial = await exec.execute({
      command: nodeCommand("console.log('ready'); setTimeout(() => {}, 5000)"),
      yield_time_ms: 500,
    });
    const sid = sessionId(initial);

    const listing = await list.execute();
    const cleanup = await stdin.execute({ session_id: sid, terminate: true, yield_time_ms: 0 });

    expect(listing).toContain(sid);
    expect(listing).toContain("running");
    expect(listing).toContain("elapsed=");
    expect(listing).toContain("remaining=");
    expect(listing).toContain(root);
    expect(cleanup).toContain("Session terminated.");
  });

  it("reports an empty session list", async () => {
    await expect(new ListExecSessionsTool({ manager: new ExecSessionManager() }).execute()).resolves.toBe("No active exec sessions.");
  });

  it("kills a one-shot exec process when the tool call is aborted", async () => {
    const root = tmpDir("memmy-exec-abort-one-shot-");
    const marker = path.join(root, "still-alive.txt");
    const controller = new AbortController();
    const tool = new ExecTool({ workspace: root, config: new ExecToolConfig({ timeoutS: 30 }) });
    const running = tool.execute({
      command: nodeCommand(`const fs = require('fs'); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'alive'), 1000); setInterval(() => {}, 100);`),
    }, { abortSignal: controller.signal });

    setTimeout(() => controller.abort(), 100);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 1300));

    expect(fs.existsSync(marker)).toBe(false);
  });

  it("terminates an unreturned yielded session when the initial poll is aborted", async () => {
    const root = tmpDir("memmy-exec-abort-initial-");
    const marker = path.join(root, "initial-alive.txt");
    const manager = new ExecSessionManager();
    const controller = new AbortController();
    const tool = new ExecTool({ workspace: root, sessionManager: manager, config: new ExecToolConfig({ timeoutS: 30 }) });
    const running = tool.execute({
      command: nodeCommand(`const fs = require('fs'); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'alive'), 1000); setInterval(() => {}, 100);`),
      yield_time_ms: 5000,
    }, { abortSignal: controller.signal });

    setTimeout(() => controller.abort(), 100);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 1300));

    await expect(manager.list()).resolves.toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("does not kill a yielded session after its session_id has been returned", async () => {
    const root = tmpDir("memmy-exec-abort-after-session-id-");
    const manager = new ExecSessionManager();
    const controller = new AbortController();
    const exec = new ExecTool({ workspace: root, sessionManager: manager, config: new ExecToolConfig({ timeoutS: 5 }) });
    const stdin = new WriteStdinTool({ manager });

    const initial = await exec.execute({
      command: nodeCommand("console.log('ready'); setTimeout(() => console.log('still-running'), 300); setTimeout(() => {}, 5000)"),
      yield_time_ms: 50,
    }, { abortSignal: controller.signal });
    const sid = sessionId(initial);
    controller.abort();
    await waitFor(() => Boolean(manager.get(sid)));
    const poll = await stdin.execute({ session_id: sid, yield_time_ms: 500 });
    const cleanup = await stdin.execute({ session_id: sid, terminate: true, yield_time_ms: 0 });

    expect(initial).toContain("Process running");
    expect(poll).toContain("still-running");
    expect(cleanup).toContain("Session terminated.");
  });

  it("cancels a write_stdin wait without killing the session or losing already-written input", async () => {
    const root = tmpDir("memmy-exec-abort-stdin-wait-");
    const manager = new ExecSessionManager();
    const exec = new ExecTool({ workspace: root, sessionManager: manager, config: new ExecToolConfig({ timeoutS: 5 }) });
    const stdin = new WriteStdinTool({ manager });
    const initial = await exec.execute({
      command: nodeCommand("console.log('ready'); process.stdin.once('data', (chunk) => setTimeout(() => console.log('got:' + chunk.toString().trim()), 300)); setTimeout(() => {}, 5000);"),
      yield_time_ms: 100,
    });
    const sid = sessionId(initial);
    const controller = new AbortController();
    const waiting = stdin.execute({
      session_id: sid,
      chars: "ping\n",
      yield_time_ms: 1000,
    }, { abortSignal: controller.signal });

    setTimeout(() => controller.abort(), 50);
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    const poll = await stdin.execute({ session_id: sid, yield_time_ms: 500 });
    const cleanup = await stdin.execute({ session_id: sid, terminate: true, yield_time_ms: 0 });

    expect(poll).toContain("got:ping");
    expect(cleanup).toContain("Session terminated.");
  });

  it("still terminates a session when write_stdin terminate=true is called with an aborted signal", async () => {
    const root = tmpDir("memmy-exec-abort-terminate-");
    const manager = new ExecSessionManager();
    const exec = new ExecTool({ workspace: root, sessionManager: manager, config: new ExecToolConfig({ timeoutS: 5 }) });
    const stdin = new WriteStdinTool({ manager });
    const initial = await exec.execute({
      command: nodeCommand("console.log('ready'); setTimeout(() => {}, 5000)"),
      yield_time_ms: 100,
    });
    const sid = sessionId(initial);
    const controller = new AbortController();
    controller.abort();

    const result = await stdin.execute({ session_id: sid, terminate: true, yield_time_ms: 0 }, { abortSignal: controller.signal });

    expect(result).toContain("Session terminated.");
    await expect(manager.list()).resolves.toEqual([]);
  });
});
