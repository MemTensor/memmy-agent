import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  parseWindowsStoreHelperMessage,
  runWindowsStoreUpdate,
  stageWindowsStoreUpdateFinalizer
} from "../src/main/windows-store-update.js";

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
    ["stage-store-update-finalizer", 30_000],
    ["download-user", 30 * 60_000]
  ] as const)("bounds %s even when the native helper never closes", async (command, timeout) => {
    const child = createChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const result = runWindowsStoreUpdate({
      resourcesPath: "C:\\Memmy\\resources",
      command,
      ...(command === "stage-store-update-finalizer" ? {
        packageFamilyName: "Memtensor.Memmy_test",
        attemptId: "12345678-1234-4234-8234-123456789abc"
      } : {})
    });
    const rejection = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(timeout);
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes only package identity and attempt nonce to native finalizer staging", async () => {
    const child = createChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const staged = {
      type: "finalizer-staged",
      attemptId: "12345678-1234-4234-8234-123456789abc",
      path: "C:\\Users\\lee\\AppData\\Local\\Memmy\\store-update\\Memtensor.Memmy_test\\12345678-1234-4234-8234-123456789abc\\MemmyStoreUpdate.exe",
      externalReadyPath: "C:\\Users\\lee\\AppData\\Local\\Memmy\\store-update\\Memtensor.Memmy_test\\12345678-1234-4234-8234-123456789abc\\external-ready-v1.json",
      installerReadyPath: "C:\\Users\\lee\\AppData\\Local\\Memmy\\store-update\\Memtensor.Memmy_test\\12345678-1234-4234-8234-123456789abc\\installer-ready-v1.json",
      resultPath: "C:\\Users\\lee\\AppData\\Local\\Memmy\\store-update\\Memtensor.Memmy_test\\12345678-1234-4234-8234-123456789abc\\store-update-result-v1.txt",
      logPath: "C:\\Users\\lee\\AppData\\Local\\Memmy\\store-update\\Memtensor.Memmy_test\\12345678-1234-4234-8234-123456789abc\\store-update-handoff.jsonl",
      size: 1_234_567,
      sha256: "a".repeat(64)
    } as const;

    const result = stageWindowsStoreUpdateFinalizer({
      resourcesPath: "C:\\Memmy\\resources",
      packageFamilyName: "Memtensor.Memmy_test",
      attemptId: "12345678-1234-4234-8234-123456789abc"
    });
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      "C:\\Memmy\\resources\\native\\MemmyStoreUpdate.exe",
      [
        "stage-store-update-finalizer",
        "--package-family-name", "Memtensor.Memmy_test",
        "--attempt-id", "12345678-1234-4234-8234-123456789abc"
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    child.stdout.write(`${JSON.stringify(staged)}\n`);
    child.emit("close", 0);
    await expect(result).resolves.toEqual(staged);
  });

  it("rejects malformed finalizer staging receipts", () => {
    expect(() => parseWindowsStoreHelperMessage(JSON.stringify({
      type: "finalizer-staged",
      attemptId: "12345678-1234-4234-8234-123456789abc",
      path: "C:\\MemmyStoreUpdate.exe",
      externalReadyPath: "C:\\external-ready-v1.json",
      installerReadyPath: "C:\\installer-ready-v1.json",
      resultPath: "C:\\store-update-result-v1.txt",
      logPath: "C:\\store-update-handoff.jsonl",
      size: 0,
      sha256: "not-a-sha256"
    }))).toThrow("invalid finalizer staging result");
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
