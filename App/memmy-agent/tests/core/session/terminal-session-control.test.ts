import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TerminalRunControl,
  TerminalSessionTurnLock,
} from "../../../src/core/session/terminal-session-control.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-terminal-control-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("terminal session control", () => {
  it("serializes cli turns across lock instances", async () => {
    const root = temporaryRoot();
    const first = new TerminalSessionTurnLock(root);
    const second = new TerminalSessionTurnLock(root);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const a = first.runExclusive("cli:shared", async () => {
      events.push("a:start");
      await firstGate;
      events.push("a:end");
    });
    while (!events.length) await new Promise((resolve) => setTimeout(resolve, 5));
    const b = second.runExclusive("cli:shared", async () => {
      events.push("b:start");
      events.push("b:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toEqual(["a:start"]);
    releaseFirst();
    await Promise.all([a, b]);
    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("cancels a waiter before it enters the protected turn", async () => {
    const root = temporaryRoot();
    const first = new TerminalSessionTurnLock(root);
    const second = new TerminalSessionTurnLock(root);
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const owner = first.runExclusive("cli:shared", () => gate);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const controller = new AbortController();
    let entered = false;
    const waiter = second.runExclusive(
      "cli:shared",
      async () => {
        entered = true;
      },
      controller.signal,
    );
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ name: "AbortError" });
    expect(entered).toBe(false);
    releaseFirst();
    await owner;
  });

  it("recovers a stale terminal turn lock", async () => {
    const root = temporaryRoot();
    const lock = new TerminalSessionTurnLock(root);
    const target = lock.targetPath("cli:stale");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.closeSync(fs.openSync(target, "a"));
    const lockDirectory = `${target}.lock`;
    fs.mkdirSync(lockDirectory);
    const staleAt = new Date(Date.now() - 180_000);
    fs.utimesSync(lockDirectory, staleAt, staleAt);

    let entered = false;
    await lock.runExclusive("cli:stale", async () => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(fs.existsSync(lockDirectory)).toBe(false);
  });

  it("keeps GUI cancellation monotonic across heartbeat updates", async () => {
    const root = temporaryRoot();
    const control = new TerminalRunControl(root);
    await control.create("cli:shared", "turn-1");
    await control.requestCancel("cli:shared");
    const heartbeat = await control.heartbeat("cli:shared", "turn-1");
    expect(heartbeat?.cancelRequested).toBe(true);
    expect(control.read("cli:shared")?.cancelRequested).toBe(true);
    await control.remove("cli:shared", "turn-1");
    expect(control.read("cli:shared")).toBeNull();
  });

  it("removes stale run state under the short run-control lock", async () => {
    const root = temporaryRoot();
    const control = new TerminalRunControl(root);
    await control.create("cli:stale", "turn-stale");
    const file = control.runPath("cli:stale");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.heartbeatAt = Date.now() - 180_000;
    fs.writeFileSync(file, `${JSON.stringify(state)}\n`, "utf8");

    expect(await control.requestCancel("cli:stale")).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("does not create terminal lock files for non-cli sessions", async () => {
    const root = temporaryRoot();
    const lock = new TerminalSessionTurnLock(root);
    await lock.runExclusive("telegram:123", async () => undefined);
    expect(fs.existsSync(path.join(root, ".terminal-control"))).toBe(false);
  });
});
