import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class ConnectionChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  kill = vi.fn();
}
const state = vi.hoisted(() => ({ children: [] as ConnectionChild[], python: "/developer/python3" as string | null,
  privateStateReady: true,
  windowsPython: { executable: "C:\\Memmy\\python\\python.exe", args: ["-I", "-B", "-X", "utf8"] } as { executable: string; args: string[] } | null }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn(() => {
    const child = new ConnectionChild();
    state.children.push(child);
    return child;
  }),
}));
vi.mock("../../../../src/tools/computer-history/mac/wechat-python.js", () => ({ resolveMacWeChatPython: vi.fn(() => state.python) }));
vi.mock("../../../../src/tools/computer-history/win/python-runtime.js", () => ({ resolveWindowsWeChatPython: vi.fn(() => state.windowsPython) }));
vi.mock("../../../../src/tools/computer-history/win/private-files.js", () => ({
  prepareWindowsWeChatState: vi.fn(() => {
    if (!state.privateStateReady || !state.windowsPython) throw new Error("fixture private state is unavailable");
  }),
  validateWindowsWeChatConsent: vi.fn(() => state.privateStateReady),
}));
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";
import { mockMacConsentPermissions } from "../private-consent-fixture.js";

const windowsHost = process.platform === "win32";

let root: string;
let service: ComputerHistoryDemoService;
beforeEach(() => {
  state.children.length = 0;
  state.python = "/developer/python3";
  state.privateStateReady = true;
  state.windowsPython = { executable: "C:\\Memmy\\python\\python.exe", args: ["-I", "-B", "-X", "utf8"] };
  vi.mocked(spawn).mockClear();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-process-"));
  mockMacConsentPermissions(path.join(root, "wechat", "consent.json"));
  const library = path.join(root, "sqlcipher.dylib");
  fs.writeFileSync(library, "inert fixture: never loaded");
  vi.stubEnv("MEMMY_SQLCIPHER_LIBRARY", library);
  service = new ComputerHistoryDemoService({
    historyDirectory: path.join(root, "histories"),
    recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"),
    weChatConsentFile: path.join(root, "wechat", "consent.json"),
  });
});
afterEach(async () => {
  await service.shutdown();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function connect() {
  service.setWeChatChatAccess(true);
  expect(service.connectWeChat().wechat?.connection).toBe("connecting");
  return state.children.at(-1)!;
}

describe("WeChat connection process diagnostics", () => {
  it("persists only allowed source-change metadata and keeps the original failure phase", () => {
    const child = connect();
    child.stdout.write(JSON.stringify({ event: "preparing_wechat_data" }) + "\n");
    const detail = { kind: "directory", area: "cache", fields: "mtime_ns,ctime_ns",
      pathHash: "0123456789abcdef", attempts: 3, elapsedMs: 12000,
      path: "/private/account/chat-name", keys: "never save this" };
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "wechat_private_storage_source_changed", detail }) + "\n");
    child.stdout.write(JSON.stringify({ event: "original_reopened", success: true }) + "\n");
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "wechat_private_storage_source_changed", detail }) + "\n");
    child.emit("close", 2, null);
    const saved = JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8"));
    expect(saved).toMatchObject({ phase: "preparing_wechat_data", detail: {
      kind: "directory", area: "cache", fields: "mtime_ns,ctime_ns", pathHash: "0123456789abcdef", attempts: 3, elapsedMs: 12000,
    } });
    expect(saved.detail).not.toHaveProperty("path");
    expect(saved.detail).not.toHaveProperty("keys");
  });

  it("discards malformed source-change diagnostics", () => {
    const child = connect();
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "wechat_private_storage_source_changed",
      detail: { kind: "/private/path", area: "chat-name", fields: "arbitrary", pathHash: "secret", attempts: -1, elapsedMs: "secret" },
    }) + "\n");
    child.emit("close", 2, null);
    const saved = JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8"));
    expect(saved).not.toHaveProperty("detail");
  });

  it("shares a running connection instead of launching another helper for repeated requests", () => {
    const child = connect();
    expect(service.connectWeChat().wechat?.connection).toBe("connecting");
    expect(state.children).toEqual([child]);
  });

  it("keeps a private-storage failure distinct from logout and never retries it from a snapshot", () => {
    const child = connect();
    child.stdout.write(JSON.stringify({ event: "preparing_wechat_data" }) + "\n");
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "wechat_private_storage_unsafe_path" }) + "\n");
    child.emit("close", 2, null);
    for (let i = 0; i < 3; i++) {
      expect(service.snapshot().wechat).toMatchObject({
        connection: "error", error: "wechat_private_storage_unsafe_path", phase: null,
      });
    }
    expect(state.children).toEqual([child]);
    expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
      .toMatchObject({ category: "wechat_private_storage_unsafe_path", phase: "preparing_wechat_data" });
  });

  it.each([
    { category: "wechat_private_storage_clone_failed",
      detail: { path: "/Users/fixture/Library/Containers/com.tencent.xinWeChat/Data/a.db", operation: "open", errno: "EPERM" } },
    { category: "wechat_data_access_interrupted",
      detail: { path: "/Users/fixture/Library/Containers/com.tencent.xinWeChat/Data", operation: "listdir", errno: "EINTR" } },
    { category: "wechat_private_storage_unsafe_path",
      detail: { path: "/Users/fixture/Library/Containers/com.tencent.xinWeChat/Data/link", reason: "symlink" } },
  ])("records $category with where it happened", ({ category, detail }) => {
    const child = connect();
    child.stdout.write(JSON.stringify({ event: "preparing_wechat_data" }) + "\n");
    child.stdout.write(JSON.stringify({ event: "connection_error", category, detail }) + "\n");
    // A duplicate parent error must not overwrite the original detail or phase.
    child.stdout.write(JSON.stringify({ event: "connection_error", category }) + "\n");
    child.emit("close", 2, null);
    for (let i = 0; i < 3; i++) expect(service.snapshot().wechat?.error).toBe(category);
    expect(state.children).toEqual([child]);
    const file = path.join(root, "wechat", "last-connection-error.json");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved).toEqual({ category, phase: "preparing_wechat_data", detail, failedAt: expect.any(String) });
    if (!windowsHost) expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it.each([
    { label: "an array", detail: ["open", "EPERM"] },
    { label: "a raw string", detail: "/Users/fixture/a.db" },
    { label: "a numeric errno", detail: { path: "/Users/fixture/a.db", errno: 1 } },
    { label: "a nested value", detail: { path: { value: "/Users/fixture/a.db" } } },
    { label: "an unusual key", detail: { "Path Name": "/Users/fixture/a.db" } },
    { label: "too many fields", detail: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field_${"a".repeat(index + 1)}`, "x"])) },
    { label: "an oversized value", detail: { path: "x".repeat(4097) } },
    { label: "an empty map", detail: {} },
  ])("keeps the category but not a detail with $label", ({ detail }) => {
    const child = connect();
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "wechat_private_storage_clone_failed", detail }) + "\n");
    child.emit("close", 2, null);
    const saved = JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8"));
    expect(saved.category).toBe("wechat_private_storage_clone_failed");
    expect(saved).not.toHaveProperty("detail");
  });

  it("does not infer a data access category from a Python process interruption", () => {
    const child = connect();
    child.emit("close", null, "SIGINT");
    expect(service.snapshot().wechat?.error).toBe("connection_process_crashed");
    expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
      .toMatchObject({ category: "connection_process_crashed" });
  });

  it("rejects Windows consent with a friendly 503 before enabling an unavailable local reader", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    state.windowsPython = null;
    let thrown: unknown;
    try { service.setWeChatChatAccess(true); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ status: 503, message: "Windows WeChat local reader is unavailable" });
    expect(service.snapshot().wechat?.enabled).toBe(false);
    expect(fs.existsSync(path.join(root, "wechat", "consent.json"))).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports a missing bundled Windows interpreter before trying any system launcher", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    service.setWeChatChatAccess(true);
    state.windowsPython = null;
    expect(service.connectWeChat().wechat?.error).toBe("python_unavailable");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps an existing disabled Windows consent unchanged when its NTFS check fails", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    service.setWeChatChatAccess(false);
    const consentFile = path.join(root, "wechat", "consent.json");
    const previous = fs.readFileSync(consentFile, "utf8");
    state.privateStateReady = false;
    expect(() => service.setWeChatChatAccess(true)).toThrow("Windows WeChat local reader is unavailable");
    expect(fs.readFileSync(consentFile, "utf8")).toBe(previous);
    expect(service.snapshot().wechat?.enabled).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("keeps the Windows reason and its diagnostic when no key matches", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    // Windows has no POSIX owner, which used to drop every diagnostic.
    const getuid = process.getuid;
    Object.defineProperty(process, "getuid", { value: undefined, configurable: true });
    try {
      const child = connect();
      child.stdout.write(JSON.stringify({ event: "capture_finished", verified_databases: 0 }) + "\n");
      child.stdout.write(JSON.stringify({ event: "capture_error", category: "weixin_keys_not_found" }) + "\n");
      child.emit("close", 3, null);
      expect(service.snapshot().wechat).toMatchObject({ connection: "error", error: "weixin_keys_not_found" });
      expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
        .toMatchObject({ category: "weixin_keys_not_found", phase: "capture_finished" });
    } finally {
      Object.defineProperty(process, "getuid", { value: getuid, configurable: true });
    }
  });

  it("launches Windows WeChat with the private interpreter and isolated UTF-8 arguments", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    connect();
    expect(spawn).toHaveBeenCalledWith(state.windowsPython!.executable, [
      ...state.windowsPython!.args, expect.stringMatching(/weixin_keys[.]py$/u),
      "--output", path.join(root, "wechat", "keys.json"),
      "--consent-file", path.join(root, "wechat", "consent.json"),
    ], { stdio: ["pipe", "pipe", "pipe"] });
    state.children.at(-1)!.emit("close", 2, null);
  });

  it("reports a missing bundled Mac interpreter before launching Python or changing WeChat", async () => {
    state.python = null;
    await expect(service.prepareWeChatReader()).resolves.toMatchObject({ ready: false, error: "python_unavailable" });
    service.setWeChatChatAccess(true);
    expect(service.connectWeChat().wechat?.error).toBe("python_unavailable");
    expect(state.children).toHaveLength(0);
  });

  it("checks the managed reader independently of consent and coalesces concurrent preparation", async () => {
    const first = service.prepareWeChatReader();
    const second = service.prepareWeChatReader();
    expect(second).toBe(first);
    const child = state.children.at(-1)!;
    const appPath = path.join(root, "wechat", "connection-helper", "Memmy WeChat Reader.app");
    child.stdout.write(JSON.stringify({ event: "permission_prepared", ready: false, appPath,
      error: "wechat_data_access_required", probePid: 123 }) + "\n");
    child.emit("close", 0, null);
    await expect(first).resolves.toEqual({ ready: false, appPath, error: "wechat_data_access_required" });
    expect(service.snapshot().wechat?.enabled).toBe(false);
    expect(state.children).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
      .toMatchObject({ category: "wechat_data_access_required", phase: "reader_permission_check" });
  });

  it("does not trust a permission result for another application path", async () => {
    const pending = service.prepareWeChatReader();
    const child = state.children.at(-1)!;
    child.stdout.write(JSON.stringify({ ready: true, appPath: "/Applications/Other.app", error: null }));
    child.emit("close", 0, null);
    await expect(pending).resolves.toEqual({ ready: false, appPath: null, error: "wechat_permission_helper_unavailable" });
    expect(service.snapshot().wechat?.enabled).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
      .toMatchObject({ category: "wechat_permission_helper_unavailable", phase: "reader_permission_check" });
  });

  it("does not approve a reader whose preparation process failed after reporting success", async () => {
    const pending = service.prepareWeChatReader();
    const child = state.children.at(-1)!;
    child.stdout.write(JSON.stringify({ ready: true,
      appPath: path.join(root, "wechat", "connection-helper", "Memmy WeChat Reader.app"), error: null }));
    child.emit("close", 2, null);
    await expect(pending).resolves.toMatchObject({ ready: false, error: "wechat_permission_helper_unavailable" });
  });

  it("retains a safe failure category after the UI revokes incomplete chat access", () => {
    const child = connect();
    child.stdout.write(JSON.stringify({ event: "awaiting_wechat_login" }) + "\n");
    child.stdout.write(JSON.stringify({ event: "capture_error", category: "wechat_data_access_required" }) + "\n");
    child.stdout.write(JSON.stringify({ event: "original_reopened", success: true }) + "\n");
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "wechat_data_access_required" }) + "\n");
    child.emit("close", 2, null);
    service.setWeChatChatAccess(false);
    expect(service.snapshot().wechat?.error).toBeNull();
    const info = fs.statSync(path.join(root, "wechat", "last-connection-error.json"));
    if (!windowsHost) expect(info.mode & 0o077).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(root, "wechat", "last-connection-error.json"), "utf8")))
      .toMatchObject({ category: "wechat_data_access_required", phase: "awaiting_wechat_login" });
  });
  it("waits for terminal status after exit and parses a final line without a newline", () => {
    const child = connect();
    child.emit("exit", 2, null);
    expect(service.snapshot().wechat?.connection).toBe("connecting");
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "key_capture_crashed" }));
    child.emit("close", 2, null);
    expect(service.snapshot().wechat).toMatchObject({ connection: "error", error: "key_capture_crashed", phase: null });
  });

  it("keeps the capture cause when a legacy parent reports only key_capture_failed", () => {
    const child = connect();
    child.stdout.write(JSON.stringify({ event: "capture_error", category: "no_encrypted_databases" }) + "\n");
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "key_capture_failed" }) + "\n");
    child.emit("close", 2, null);
    expect(service.snapshot().wechat?.error).toBe("no_encrypted_databases");
  });

  it("distinguishes a Python process signal from an ordinary connection failure", () => {
    const child = connect();
    child.emit("close", null, "SIGBUS");
    expect(service.snapshot().wechat).toMatchObject({ connection: "error", error: "connection_process_crashed" });
  });

  it("reports an interpreter launch failure and permits an explicit retry", () => {
    connect().emit("error", new Error("ENOENT"));
    expect(service.snapshot().wechat).toMatchObject({ connection: "error", error: "connection_process_failed", phase: null });
    connect().emit("close", 2, null);
    expect(state.children).toHaveLength(2);
  });

  it("keeps chat access disabled if the user revokes it before the helper closes", () => {
    const child = connect();
    service.setWeChatChatAccess(false);
    child.stdout.write(JSON.stringify({ event: "connection_error", category: "key_capture_crashed" }) + "\n");
    child.emit("close", 2, null);
    expect(service.snapshot().wechat).toEqual({ enabled: false, connection: "disabled", phase: null, error: null });
  });
});
