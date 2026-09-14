import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { runWindowsStoreUpdate } from "../src/main/windows-store-update.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function createChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    // Deliberately never emit close: the timeout must reject independently.
    kill: vi.fn(() => false)
  });
}

describe("Windows Store helper timeouts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

  it.each([
    ["identity", 15_000],
    ["check", 30_000],
    ["download-user", 30 * 60_000]
  ] as const)("bounds %s even when the native helper never closes", async (command, timeout) => {
    const child = createChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const result = runWindowsStoreUpdate({ resourcesPath: "C:\\Memmy\\resources", command });
    const rejection = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(timeout);
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline when the helper returns a valid identity", async () => {
    const child = createChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const identity = {
      type: "identity",
      aumid: "Memtensor.Memmy_test!Memmy",
      packageFamilyName: "Memtensor.Memmy_test",
      currentPackageVersion: "1.1.400.0",
      currentPackageFullName: "Memtensor.Memmy_1.1.400.0_x64__test"
    };
    const result = runWindowsStoreUpdate({ resourcesPath: "C:\\Memmy\\resources", command: "identity" });
    child.stdout.write(JSON.stringify(identity) + "\n");
    child.emit("close", 0);
    await expect(result).resolves.toEqual(identity);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("clears the deadline when the helper cannot start", async () => {
    const child = createChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const result = runWindowsStoreUpdate({ resourcesPath: "C:\\Memmy\\resources", command: "identity" });
    const rejection = expect(result).rejects.toThrow("spawn failed");
    child.emit("error", new Error("spawn failed"));
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});
