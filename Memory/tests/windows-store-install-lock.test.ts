import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const memoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativePath = join(memoryRoot, "dist", "native", "memory-install-lock.node");
type NativeToken = object;
type NativeLock = { tryAcquire(path: string): NativeToken | null; release(token: NativeToken): void };
type Worker = {
  child: ChildProcess;
  messages: Array<{ event: string; [key: string]: unknown }>;
  errors: string;
  exited: boolean;
  done: Promise<number | null>;
};

// This exercises Win32 handles, not a mocked filesystem. Build the addon first:
// powershell.exe -NoProfile -ExecutionPolicy Bypass -File Memory/native/windows-install-lock/build.ps1
describe.skipIf(process.platform !== "win32")("Windows Store install lock across processes", () => {
  let native: NativeLock;
  let root: string;
  let lockPath: string;
  let workers: Worker[];
  let tokens: Set<NativeToken>;

  beforeAll(() => {
    if (!existsSync(nativePath)) {
      throw new Error("Build the Windows lock addon before these tests: powershell.exe -NoProfile -ExecutionPolicy Bypass -File Memory/native/windows-install-lock/build.ps1");
    }
    native = require(nativePath) as NativeLock;
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memmy-store-lock-process-"));
    lockPath = join(root, "install.lock");
    workers = [];
    tokens = new Set();
  });
  afterEach(async () => {
    await Promise.all(workers.map(stop));
    for (const token of tokens) native.release(token);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function acquire(path = lockPath) {
    const token = native.tryAcquire(path);
    if (token) tokens.add(token);
    return token;
  }
  function release(token: NativeToken) {
    native.release(token);
    tokens.delete(token);
  }
  function start(script: string, args: string[] = [], typescript = false): Worker {
    const file = join(root, `worker-${workers.length}.mjs`);
    writeFileSync(file, script);
    const child = spawn(process.execPath, [
      ...(typescript ? ["--import", require.resolve("tsx")] : []), file, ...args
    ], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    const worker: Worker = { child, messages: [], errors: "", exited: false, done: undefined! };
    child.on("message", (message) => worker.messages.push(message as Worker["messages"][number]));
    child.stderr!.on("data", (data) => { worker.errors += String(data); });
    worker.done = new Promise((done) => child.once("exit", (code) => { worker.exited = true; done(code); }));
    workers.push(worker);
    return worker;
  }
  async function stop(worker: Worker) {
    if (!worker.exited) worker.child.kill("SIGKILL");
    await worker.done;
  }
  async function until(predicate: () => boolean, worker?: Worker) {
    const deadline = Date.now() + 12_000;
    while (!predicate()) {
      if (worker?.exited || Date.now() > deadline) {
        throw new Error(`Timed out waiting for test process: ${worker?.errors ?? workers.map((item) => item.errors).join("\n")}`);
      }
      await new Promise((done) => setTimeout(done, 20));
    }
  }
  async function event(worker: Worker, name: string) {
    await until(() => worker.messages.some((message) => message.event === name), worker);
  }
  const nativeScript = `
    import { createRequire } from 'node:module';
    import { mkdirSync, rmSync } from 'node:fs';
    const native = createRequire(import.meta.url)(process.argv[2]);
    const lockPath = process.argv[3];
    const mode = process.argv[4];
    let token;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    process.on('message', async message => {
      if (message === 'release') { native.release(token); process.exit(0); }
      if (message !== 'begin') return;
      try {
        const deadline = Date.now() + 10000;
        while (!(token = native.tryAcquire(lockPath))) {
          if (Date.now() > deadline) throw new Error('native contender timed out');
          await delay(5);
        }
        process.send({ event: 'acquired', pid: process.pid });
        if (mode === 'hold') return;
        const guard = process.argv[5];
        // Independent atomic sentinel detects any overlapping critical sections.
        mkdirSync(guard);
        await delay(60);
        rmSync(guard, { recursive: true });
        native.release(token);
        process.send({ event: 'released' }, () => process.exit(0));
      } catch (error) { console.error(error); process.exit(1); }
    });
    process.send({ event: 'ready' });
  `;
  async function nativeWorker(mode: "hold" | "recover", index = 0) {
    const worker = start(nativeScript, [nativePath, lockPath, mode, join(root, `critical-section-${index}`)]);
    await event(worker, "ready");
    return worker;
  }

  it("keeps a live native owner exclusive and releases normally", async () => {
    const owner = await nativeWorker("hold");
    owner.child.send("begin");
    await event(owner, "acquired");
    expect(existsSync(lockPath)).toBe(true);
    expect(acquire()).toBeNull();
    expect(() => openSync(lockPath, "wx")).toThrow();
    owner.child.send("release");
    expect(await owner.done).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
    const successor = acquire();
    expect(successor).not.toBeNull();
    release(successor!);
  });

  it("recovers the exact PID marker left by a forcibly terminated owner", async () => {
    const owner = await nativeWorker("hold");
    owner.child.send("begin");
    await event(owner, "acquired");
    await stop(owner);
    expect(readFileSync(lockPath, "utf8")).toBe(`${owner.child.pid}\n`);
    const recovered = acquire();
    expect(recovered).not.toBeNull();
    expect(acquire()).toBeNull();
    release(recovered!);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("serializes six processes recovering one abandoned lock", async () => {
    const owner = await nativeWorker("hold");
    owner.child.send("begin");
    await event(owner, "acquired");
    await stop(owner);
    const contenders = await Promise.all(Array.from({ length: 6 }, (_, index) => nativeWorker("recover", index)));
    for (const contender of contenders) contender.child.send("begin");
    const exitCodes = await Promise.all(contenders.map((contender) => contender.done));
    expect(exitCodes, contenders.map((contender) => contender.errors).join("\n")).toEqual(Array(6).fill(0));
    expect(contenders.every((contender) => contender.messages.some((message) => message.event === "released"))).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(contenders.every((_contender, index) => !existsSync(join(root, `critical-section-${index}`)))).toBe(true);
  });

  it("preserves an old wx owner even before it writes a PID, then recovers its dead marker", () => {
    const handle = openSync(lockPath, "wx");
    try {
      expect(acquire()).toBeNull();
      writeFileSync(handle, `${deadPid()}\n`);
      expect(acquire()).toBeNull();
    } finally {
      closeSync(handle);
    }
    const recovered = acquire();
    expect(recovered).not.toBeNull();
    release(recovered!);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not overwrite a legacy live PID or delete a successor on repeated release", () => {
    writeFileSync(lockPath, `${process.pid}\n`);
    expect(acquire()).toBeNull();
    expect(readFileSync(lockPath, "utf8")).toBe(`${process.pid}\n`);
    rmSync(lockPath);
    for (let iteration = 0; iteration < 32; iteration++) {
      const previous = acquire();
      expect(previous).not.toBeNull();
      release(previous!);
      const successor = openSync(lockPath, "wx");
      try {
        writeFileSync(successor, `${process.pid}\n`);
        native.release(previous!);
        expect(readFileSync(lockPath, "utf8")).toBe(`${process.pid}\n`);
      } finally {
        closeSync(successor);
        rmSync(lockPath);
      }
    }
  });

});

function deadPid() {
  for (let pid = 999_999; pid > 100_000; pid -= 7) {
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("No unused PID found for the legacy marker fixture");
}
