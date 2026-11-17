import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Execute the product callback with Electron's destroyed-window getter behavior,
// without starting a renderer, user services, or an installed application.
const source = ts.createSourceFile("main.ts",
  readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(statement => ts.isFunctionDeclaration(statement)
  && statement.name?.text === "waitForInitialRendererVerification");
if (!declaration) throw new Error("Missing initial renderer verification callback");
const code = ts.transpileModule(declaration.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText;

class FakeWindow extends EventEmitter {
  destroyed = false;
  webContentsReads = 0;
  readonly contents = Object.assign(new EventEmitter(), { id: 17 });

  get webContents() {
    this.webContentsReads += 1;
    if (this.destroyed) throw new TypeError("Object has been destroyed");
    return this.contents;
  }
  isDestroyed() { return this.destroyed; }
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
}

function setup() {
  const waiters = new Map<number, (verified: boolean) => void>();
  const readyIds = new Set<number>();
  const wait = runInNewContext(`${code}\nwaitForInitialRendererVerification`, {
    rendererReadyWaiters: waiters, rendererReadyWebContentsIds: readyIds,
    setTimeout, clearTimeout,
  }) as (window: FakeWindow | null) => Promise<boolean>;
  return { wait, waiters, readyIds, window: new FakeWindow() };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("initial renderer verification", () => {
  it("settles false and removes its waiter when Electron destroys the window before closed", async () => {
    const test = setup();
    const verified = test.wait(test.window);
    const reads = test.window.webContentsReads;

    expect(() => test.window.destroy()).not.toThrow();
    await expect(verified).resolves.toBe(false);
    expect(test.window.webContentsReads).toBe(reads);
    expect(test.waiters.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also settles a timeout if the native window was already destroyed", async () => {
    const test = setup();
    const verified = test.wait(test.window);
    const reads = test.window.webContentsReads;
    test.window.destroyed = true;

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(verified).resolves.toBe(false);
    expect(test.window.webContentsReads).toBe(reads);
    expect(test.waiters.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans both listeners and resolves once when a live renderer verifies", async () => {
    const test = setup();
    const verified = test.wait(test.window);
    const finish = test.waiters.get(test.window.contents.id)!;
    finish(true);
    finish(false);

    await expect(verified).resolves.toBe(true);
    expect(test.window.contents.listenerCount("did-fail-load")).toBe(0);
    expect(test.window.listenerCount("closed")).toBe(0);
    expect(test.waiters.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => test.window.destroy()).not.toThrow();
  });

  it("ignores subframe failures and settles false for a failed main-frame load", async () => {
    const test = setup();
    const verified = test.wait(test.window);
    test.window.contents.emit("did-fail-load", {}, -3, "cancelled", "https://test.invalid/", false);
    expect(test.waiters.size).toBe(1);
    test.window.contents.emit("did-fail-load", {}, -3, "cancelled", "https://test.invalid/", true);

    await expect(verified).resolves.toBe(false);
    expect(test.window.contents.listenerCount("did-fail-load")).toBe(0);
    expect(test.window.listenerCount("closed")).toBe(0);
    expect(test.waiters.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a live window and cleans its listeners", async () => {
    const test = setup();
    const verified = test.wait(test.window);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(verified).resolves.toBe(false);
    expect(test.window.contents.listenerCount("did-fail-load")).toBe(0);
    expect(test.window.listenerCount("closed")).toBe(0);
    expect(test.waiters.size).toBe(0);
  });

  it("does not remove a newer waiter for the same renderer", async () => {
    const test = setup();
    const verified = test.wait(test.window);
    const finish = test.waiters.get(test.window.contents.id)!;
    const replacement = vi.fn();
    test.waiters.set(test.window.contents.id, replacement);
    finish(false);

    await expect(verified).resolves.toBe(false);
    expect(test.waiters.get(test.window.contents.id)).toBe(replacement);
  });

  it("returns immediately for null, destroyed, and already verified windows", async () => {
    const test = setup();
    await expect(test.wait(null)).resolves.toBe(false);
    test.window.destroyed = true;
    await expect(test.wait(test.window)).resolves.toBe(false);
    expect(test.window.webContentsReads).toBe(0);
    test.window.destroyed = false;
    test.readyIds.add(test.window.contents.id);
    await expect(test.wait(test.window)).resolves.toBe(true);
    expect(test.waiters.size).toBe(0);
    expect(test.window.listenerCount("closed")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
