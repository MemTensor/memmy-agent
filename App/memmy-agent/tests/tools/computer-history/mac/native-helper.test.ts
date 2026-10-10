import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const compiler = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: compiler.run });
  return { execFile };
});
import { ensureNativeHistoryHelper } from "../../../../src/tools/computer-history/mac/native-helper.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "history-helper-"));
  vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "home"));
  compiler.run.mockReset();
  compiler.run.mockImplementation(async (_command: string, args: string[]) => {
    fs.writeFileSync(args[2], "compiled fixture", { mode: 0o755 });
    return { stdout: "", stderr: "" };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

test.each(["human-recorder", "app-icon"])("%s resolves the unpacked binary without reading source or invoking Swift", async (name) => {
  const source = path.join(root, "Memmy.app", "Contents", "Resources", "app.asar", "dist", `${name}.swift`);
  const binary = path.join(path.dirname(source).replace("app.asar", "app.asar.unpacked"), "native", process.arch, name);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "native fixture", { mode: 0o755 });
  expect(await ensureNativeHistoryHelper(source, name)).toBe(binary);
  expect(compiler.run).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(root, "home"))).toBe(false);
});

test.each(["app.asar", "app.asar.unpacked"])("a missing %s helper is an installation error and never falls back to Swift", async (archive) => {
  const source = path.join(root, archive, "human-recorder.swift");
  await expect(ensureNativeHistoryHelper(source, "recorder")).rejects.toThrow(/packaged helper.*Reinstall Memmy/);
  expect(compiler.run).not.toHaveBeenCalled();
});

test.runIf(process.platform !== "win32")("a non-executable packaged helper is reported without a compiler fallback", async () => {
  const source = path.join(root, "app.asar", "app-icon.swift");
  const binary = path.join(root, "app.asar.unpacked", "native", process.arch, "app-icon");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, "fixture", { mode: 0o644 });
  await expect(ensureNativeHistoryHelper(source, "app-icon")).rejects.toThrow("not executable");
  expect(compiler.run).not.toHaveBeenCalled();
});

test("development builds are cached and invalidated when Swift source changes", async () => {
  const source = path.join(root, "human-recorder.swift");
  fs.writeFileSync(source, "source v1");
  const first = await ensureNativeHistoryHelper(source, "recorder");
  expect(fs.readFileSync(first, "utf8")).toBe("compiled fixture");
  expect(await ensureNativeHistoryHelper(source, "recorder")).toBe(first);
  expect(compiler.run).toHaveBeenCalledTimes(1);
  fs.writeFileSync(source, "source v2");
  expect(await ensureNativeHistoryHelper(source, "recorder")).not.toBe(first);
  expect(compiler.run).toHaveBeenCalledTimes(2);
  expect(fs.readdirSync(path.dirname(first)).filter((file) => file.startsWith(".build-"))).toEqual([]);
});

test("a failed development compile leaves no cached binary and can be retried", async () => {
  const source = path.join(root, "app-icon.swift");
  fs.writeFileSync(source, "source");
  compiler.run.mockRejectedValueOnce(new Error("syntax error"));
  await expect(ensureNativeHistoryHelper(source, "app-icon")).rejects.toThrow("syntax error");
  expect(fs.readdirSync(path.join(root, "home", ".memmy", "tools", "app-icon"))).toEqual([]);
  expect(fs.existsSync(await ensureNativeHistoryHelper(source, "app-icon"))).toBe(true);
});
