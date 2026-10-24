import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeExcelControl, type NativeExcelAdapter } from "../../../src/tools/computer-use/excel-native-control.js";
import { nativeExcelRunner, type NativeExcelStatus } from "../../../src/tools/computer-use/excel-native-runtime.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture(native: Partial<NativeExcelStatus> = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-native-excel-"));
  directories.push(dataDir);
  const state = { available: true, connected: true, workbooks: [{ id: "/tmp/one.xlsx", name: "one.xlsx" },
    { id: "/tmp/two.xlsx", name: "two.xlsx" }], activeWorkbookId: "/tmp/one.xlsx", ...native };
  const adapter = { status: vi.fn().mockResolvedValue(state), authorize: vi.fn().mockResolvedValue(state),
    invoke: vi.fn().mockResolvedValue({ workbookId: "/tmp/two.xlsx", values: [["ok"]] }) } satisfies NativeExcelAdapter;
  const control = new NativeExcelControl({ dataDir, platform: "darwin", adapter });
  return { control, adapter, dataDir, state };
}

describe("application-level Excel control", () => {
  it("does not launch Excel or widen legacy document consent while reading settings", async () => {
    const { control, adapter, dataDir } = await fixture();
    const old = path.join(dataDir, "computer-use/excel-addin");
    await fs.mkdir(old, { recursive: true });
    await fs.writeFile(path.join(old, "setup.json"), JSON.stringify({ consented: true, enabled: true, containerSideload: true }));
    await control.start();
    expect(await control.status()).toMatchObject({ scope: "application", enabled: false, configured: false, workbooks: [] });
    expect(adapter.status).not.toHaveBeenCalled();
    expect(adapter.authorize).not.toHaveBeenCalled();
    await expect(control.invoke({ kind: "read_range", address: "A1" })).rejects.toThrow("Enable Microsoft Excel");
    expect(adapter.invoke).not.toHaveBeenCalled();
  });

  it("authorizes once and addresses either workbook without per-document setup", async () => {
    const { control, adapter, dataDir } = await fixture();
    const enabled = await control.setEnabled(true);
    expect(enabled).toMatchObject({ enabled: true, connectionCount: 2, connected: true, manifestUrl: null, manualInstallPath: null });
    expect(adapter.authorize).toHaveBeenCalledTimes(1);
    await control.invoke({ kind: "write_range", workbook: "/tmp/two.xlsx", address: "A1", values: [["ok"]] });
    expect(adapter.invoke).toHaveBeenCalledWith(expect.objectContaining({ workbook: "/tmp/two.xlsx" }), expect.any(Function));
    const reopened = new NativeExcelControl({ dataDir, platform: "darwin", adapter });
    await reopened.start();
    expect((await reopened.status()).enabled).toBe(true);
    expect(adapter.authorize).toHaveBeenCalledTimes(1);
    const file = path.join(dataDir, "computer-use/excel-native/setup.json");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("allows one request without turning the setting on", async () => {
    const { control, adapter, dataDir } = await fixture();
    expect(await control.authorizeOnce()).toMatchObject({ enabled: true, connected: true, setupCompleted: false });
    expect(adapter.authorize).toHaveBeenCalledTimes(1);
    expect(await control.isEnabled()).toBe(false);
    expect(await control.status()).toMatchObject({ enabled: false, workbooks: [] });
    expect(adapter.status).not.toHaveBeenCalled();
    expect(await control.status({ granted: true })).toMatchObject({ enabled: true, connectionCount: 2 });
    await control.invoke({ kind: "read_range", address: "A1" }, null, { granted: true });
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
    await expect(control.invoke({ kind: "read_range", address: "A1" })).rejects.toThrow("Enable Microsoft Excel");
    await expect(fs.stat(path.join(dataDir, "computer-use/excel-native/setup.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("checks whether Excel is running without launching it or asking for permission", async () => {
    const { control, adapter, dataDir } = await fixture();
    expect(await control.running()).toBe(false);
    const running = vi.fn().mockResolvedValue(true);
    const probing = new NativeExcelControl({ dataDir, platform: "darwin", adapter: { ...adapter, running } });
    expect(await probing.running()).toBe(true);
    running.mockRejectedValueOnce(new Error("process list unavailable"));
    expect(await probing.running()).toBe(false);
    expect(await new NativeExcelControl({ dataDir, platform: "linux", adapter: { ...adapter, running } }).running()).toBe(false);
    expect(adapter.authorize).not.toHaveBeenCalled();
    expect(adapter.status).not.toHaveBeenCalled();
  });

  it("keeps the application enabled when Excel has no workbook", async () => {
    const { control } = await fixture({ connected: false, workbooks: [], activeWorkbookId: null });
    expect(await control.setEnabled(true)).toMatchObject({ enabled: true, configured: true, connected: false, connectionCount: 0 });
  });

  it("coalesces overlapping status polls while Excel is busy", async () => {
    const { control, adapter, state } = await fixture();
    await control.setEnabled(true);
    let finish!: (value: NativeExcelStatus) => void;
    adapter.status.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const one = control.status();
    const two = control.status();
    await vi.waitFor(() => expect(adapter.status).toHaveBeenCalledTimes(1));
    finish(state);
    expect(await one).toEqual(await two);
    expect(adapter.status).toHaveBeenCalledTimes(1);
  });

  it.each(["Automation denied (-1743)", "Automation permission required (-1744)"])("does not persist a failed grant, and only explicit retry reauthorizes (%s)", async message => {
    const { control, adapter, dataDir } = await fixture();
    adapter.authorize.mockRejectedValueOnce(new Error(message));
    await expect(control.setEnabled(true)).rejects.toThrow(message);
    expect(await control.status()).toMatchObject({ enabled: false, permissionRequired: true, error: message });
    await expect(fs.stat(path.join(dataDir, "computer-use/excel-native/setup.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await control.status();
    expect(adapter.status).not.toHaveBeenCalled();
    expect(adapter.authorize).toHaveBeenCalledTimes(1);
    expect((await control.setEnabled(true)).permissionRequired).toBe(false);
  });

  it("stops polling a revoked permission and never falls back to a different executor", async () => {
    const { control, adapter } = await fixture();
    await control.setEnabled(true);
    adapter.status.mockRejectedValueOnce(new Error("Automation denied (-1743)"));
    expect(await control.status()).toMatchObject({ enabled: true, connected: false, permissionRequired: true });
    await control.status();
    await expect(control.invoke({ kind: "read_range", address: "A1" })).rejects.toThrow("Automation denied");
    expect(adapter.status).toHaveBeenCalledTimes(1);
    expect(adapter.invoke).not.toHaveBeenCalled();
  });

  it("rejects unbound writes, oversized requests and cancelled actions before dispatch", async () => {
    const { control, adapter } = await fixture();
    await control.setEnabled(true);
    await expect(control.invoke({ kind: "write_range", address: "A1", values: [[1]] })).rejects.toThrow("exact workbook ID");
    await expect(control.invoke({ kind: "write_range", workbook: "/tmp/two.xlsx", address: "A1:P1", values: [Array(16).fill("x".repeat(32_000))] })).rejects.toThrow("too large");
    const cancelled = new AbortController(); cancelled.abort();
    await expect(control.invoke({ kind: "read_range", address: "A1" }, cancelled.signal)).rejects.toThrow("cancelled before dispatch");
    expect(adapter.invoke).not.toHaveBeenCalled();
  });

  it("serializes actions, then disabling prevents further native access across restarts", async () => {
    const { control, adapter, dataDir } = await fixture();
    await control.setEnabled(true);
    let finish!: (value: unknown) => void;
    adapter.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = control.invoke({ kind: "read_range", address: "A1" });
    await vi.waitFor(() => expect(adapter.invoke).toHaveBeenCalledTimes(1));
    const disabled = control.setEnabled(false);
    const later = control.invoke({ kind: "read_range", address: "B1" });
    const rejected = expect(later).rejects.toThrow("Enable Microsoft Excel");
    finish({ values: [[1]] });
    await first; await disabled; await rejected;
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
    const reopened = new NativeExcelControl({ dataDir, platform: "darwin", adapter });
    expect((await reopened.status()).enabled).toBe(false);
  });
});

it("native runner passes arbitrary text on stdin without evaluating it", async () => {
  const input = '中文 \\ " $(echo secret) `whoami`\n';
  expect(await nativeExcelRunner()(process.execPath, ["-e", 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(s))'], input)).toBe(input.trim());
});

it("a timed-out native request executes once and reports an unknown result", async () => {
  const run = nativeExcelRunner({ timeoutMs: 30 });
  await expect(run(process.execPath, ["-e", "setTimeout(()=>process.stdout.write('late'),1000)"])).rejects.toThrow("unknown and was not replayed");
});
