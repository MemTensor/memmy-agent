import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ runtime: true, stdout: '{"private":true}' }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFileSync: vi.fn(() => state.stdout),
}));
vi.mock("../../../../src/tools/computer-history/win/python-runtime.js", () => ({
  resolveWindowsWeChatPython: vi.fn(() => state.runtime
    ? { executable: "D:\\应用\\python.exe", args: ["-I", "-B", "-X", "utf8"] } : null),
}));
import { execFileSync } from "node:child_process";
import { prepareWindowsWeChatState, validateWindowsWeChatConsent } from "../../../../src/tools/computer-history/win/private-files.js";

beforeEach(() => { state.runtime = true; state.stdout = '{"private":true}'; vi.clearAllMocks(); });

it("checks real Windows security with bounded isolated Python and Unicode arguments", () => {
  const directory = "D:\\普通用户 私密目录\\computer-history\\wechat";
  prepareWindowsWeChatState(directory);
  expect(execFileSync).toHaveBeenCalledWith("D:\\应用\\python.exe", [
    "-I", "-B", "-X", "utf8", expect.stringMatching(/private_files\.py$/u), "prepare-directory", directory,
  ], expect.objectContaining({ timeout: 5_000, maxBuffer: 1_024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }));
});

it("fails closed without a private runtime or a valid ACL result", () => {
  state.runtime = false;
  expect(validateWindowsWeChatConsent("D:\\state\\consent.json")).toBe(false);
  expect(() => prepareWindowsWeChatState("D:\\state")).toThrow("Windows WeChat local reader is unavailable");
  expect(execFileSync).not.toHaveBeenCalled();
  state.runtime = true;
  state.stdout = '{"private":false}';
  expect(validateWindowsWeChatConsent("D:\\state\\consent.json")).toBe(false);
  state.stdout = "invalid response";
  expect(validateWindowsWeChatConsent("D:\\state\\consent.json")).toBe(false);
});

describe("reusing a passed consent check", () => {
  let directory: string;
  let file: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-consent-acl-"));
    file = path.join(directory, "consent.json");
    fs.writeFileSync(file, "{}", { mode: 0o600 });
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("checks again after any metadata change, a replacement or a minute", () => {
    vi.useFakeTimers();
    expect(validateWindowsWeChatConsent(file)).toBe(true);
    expect(validateWindowsWeChatConsent(file)).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(1);

    fs.chmodSync(file, 0o644);
    expect(validateWindowsWeChatConsent(file)).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(2);

    fs.writeFileSync(path.join(directory, "replacement.json"), "{}");
    fs.renameSync(path.join(directory, "replacement.json"), file);
    expect(validateWindowsWeChatConsent(file)).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(60_000);
    expect(validateWindowsWeChatConsent(file)).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(4);
  });

  it("never reuses a failed check or one that changed the file while it ran", () => {
    state.stdout = '{"private":false}';
    expect(validateWindowsWeChatConsent(file)).toBe(false);
    state.stdout = '{"private":true}';
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      fs.chmodSync(file, 0o600);
      fs.chmodSync(file, 0o640);
      return state.stdout;
    });
    expect(validateWindowsWeChatConsent(file)).toBe(true);
    expect(validateWindowsWeChatConsent(file)).toBe(true);
    expect(execFileSync).toHaveBeenCalledTimes(3);
  });
});
