import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveExpectedWindowsStoreMigrationIdentity,
  type WindowsStoreMigrationEdition,
  type WindowsStoreMigrationPolicy
} from "../src/main/windows-store-migration-config.js";
import {
  createWindowsStoreWebInstaller,
  verifyWindowsStoreWebInstaller
} from "../src/main/windows-store-web-installer.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn(), spawn: vi.fn() }));

const temporaryDirectories: string[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const signatureResult = {
  status: "Valid",
  subject: "CN=Microsoft Corporation\r\nO=Microsoft Corporation\r\nC=US"
};

beforeEach(() => {
  vi.resetAllMocks();
  // Exercise Windows process construction on every CI OS; child processes stay mocked.
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  vi.stubEnv("SystemRoot", "C:\\Windows");
  mockSignature(signatureResult);
});

afterEach(async () => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const policyFor = (edition: WindowsStoreMigrationEdition = "cn"): WindowsStoreMigrationPolicy => {
  const identity = resolveExpectedWindowsStoreMigrationIdentity(edition);
  return { kind: "store-migration", ...identity, acquisitionUri: canonicalUrl(identity.storeId) };
};

const canonicalUrl = (storeId: string) => `https://get.microsoft.com/installer/download/${storeId}`;
const readyPath = (root: string, policy = policyFor()) =>
  join(root, "store-web-install", `${policy.edition}-${policy.storeId}`, "Memmy-WebInstall.exe");

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "memmy-store-web-install-"));
  temporaryDirectories.push(root);
  const download = vi.fn(async (_url: string, path: string) => { await writeFile(path, executableBytes()); });
  const launch = vi.fn(async (_path: string) => undefined);
  const options = { updatesDirectory: root, download, launch };
  return { root, download, launch, options, service: createWindowsStoreWebInstaller(options) };
};

const stageBytes = async (path: string, bytes = executableBytes()) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
};

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  return { promise, release };
};

// A bounded PE fixture, not a signed binary. Only the OS signature response is mocked.
const executableBytes = (pe64 = false): Buffer => {
  const bytes = Buffer.alloc(1024);
  bytes.write("MZ");
  bytes.writeUInt32LE(128, 0x3c);
  bytes.write("PE\0\0", 128);
  bytes.writeUInt16LE(pe64 ? 0x8664 : 0x14c, 132);
  bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(pe64 ? 240 : 224, 148);
  bytes.writeUInt16LE(0x0002, 150);
  const optional = 152;
  bytes.writeUInt16LE(pe64 ? 0x20b : 0x10b, optional);
  bytes.writeUInt32LE(512, optional + 60);
  bytes.writeUInt32LE(16, optional + (pe64 ? 108 : 92));
  const section = optional + (pe64 ? 240 : 224);
  bytes.write(".text", section);
  bytes.writeUInt32LE(512, section + 16);
  bytes.writeUInt32LE(512, section + 20);
  return bytes;
};

const mockSignature = (result: unknown, error: Error | null = null) => {
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    queueMicrotask(() => callback(error, typeof result === "string" ? result : JSON.stringify(result), ""));
    return new EventEmitter() as ChildProcess;
  });
};

describe("Windows Store Web Install preparation", () => {
  it("goes from unprepared to verified preparation to launch, surviving a new service instance", async () => {
    const fixture = await createFixture();
    const policy = policyFor();
    const path = readyPath(fixture.root);
    await expect(fixture.service.findPrepared(policy)).resolves.toBeNull();
    await expect(fixture.service.launchPrepared(policy)).rejects.toThrow();
    expect(fixture.download).not.toHaveBeenCalled();
    expect(fixture.launch).not.toHaveBeenCalled();

    await expect(fixture.service.prepare(policy)).resolves.toBe(path);
    expect(fixture.download).toHaveBeenCalledOnce();
    expect(fixture.download.mock.calls[0]?.[0]).toBe(canonicalUrl(policy.storeId));
    const temporaryPath = fixture.download.mock.calls[0]![1];
    expect(dirname(temporaryPath)).toBe(dirname(path));
    expect(temporaryPath).not.toBe(path);
    expect(temporaryPath.endsWith(".exe")).toBe(true);
    expect(existsSync(temporaryPath)).toBe(false);
    expect(fixture.launch).not.toHaveBeenCalled();

    const restarted = createWindowsStoreWebInstaller(fixture.options);
    await expect(restarted.findPrepared(policy)).resolves.toBe(path);
    await expect(restarted.prepare(policy)).resolves.toBe(path);
    await expect(restarted.launchPrepared(policy)).resolves.toBe(path);
    expect(fixture.download).toHaveBeenCalledOnce();
    expect(fixture.launch).toHaveBeenCalledExactlyOnceWith(path);
    expect(execFile).toHaveBeenCalledTimes(4);
    await expect(readdir(dirname(path))).resolves.toEqual(["Memmy-WebInstall.exe"]);
  });

  it.each(["cn", "intl"] as const)("normalizes all supported %s acquisition URIs", async (edition) => {
    const fixture = await createFixture();
    const policy = policyFor(edition);
    for (const acquisitionUri of [
      policy.acquisitionUri,
      `ms-windows-store://pdp/?ProductId=${policy.storeId}`,
      `https://apps.microsoft.com/detail/${policy.storeId.toLowerCase()}`
    ]) {
      await fixture.service.prepare({ ...policy, acquisitionUri });
      await rm(readyPath(fixture.root, policy));
    }
    expect(fixture.download.mock.calls.map(([url]) => url)).toEqual(Array(3).fill(canonicalUrl(policy.storeId)));
  });

  it("keeps CN and INTL downloads and locks independent", async () => {
    const fixture = await createFixture();
    const started = deferred();
    const release = deferred();
    fixture.download.mockImplementationOnce(async (_url, path) => {
      started.release();
      await release.promise;
      await writeFile(path, executableBytes());
    });
    const cnPreparation = fixture.service.prepare(policyFor("cn"));
    await started.promise;
    try {
      await expect(fixture.service.prepare(policyFor("intl"))).resolves.toBe(readyPath(fixture.root, policyFor("intl")));
      await expect(fixture.service.findPrepared(policyFor("cn"))).resolves.toBeNull();
    } finally { release.release(); }
    await expect(cnPreparation).resolves.toBe(readyPath(fixture.root));
    expect(fixture.download).toHaveBeenCalledTimes(2);
  });

  it("singleflights concurrent instances and URI aliases without sharing their progress closures", async () => {
    const fixture = await createFixture();
    const started = deferred();
    const release = deferred();
    fixture.download.mockImplementationOnce(async (_url, path) => {
      await writeFile(path, executableBytes());
      started.release();
      await release.promise;
    });
    const otherDownload = vi.fn(async () => { throw new Error("second progress target must not download"); });
    const other = createWindowsStoreWebInstaller({
      ...fixture.options,
      updatesDirectory: join(fixture.root, "child", ".."),
      download: otherDownload
    });
    const first = fixture.service.prepare(policyFor());
    await started.promise;
    const alias = { ...policyFor(), acquisitionUri: `https://apps.microsoft.com/detail/${policyFor().storeId}` };
    const duplicate = other.prepare(alias);
    const sameInstance = fixture.service.prepare(policyFor());
    try {
      await expect(other.findPrepared(policyFor())).resolves.toBeNull();
      await expect(other.launchPrepared(policyFor())).rejects.toThrow();
      expect(fixture.launch).not.toHaveBeenCalled();
      expect(existsSync(readyPath(fixture.root))).toBe(false);
    } finally { release.release(); }
    expect(await Promise.all([first, duplicate, sameInstance])).toEqual(Array(3).fill(readyPath(fixture.root)));
    expect(fixture.download).toHaveBeenCalledOnce();
    expect(otherDownload).not.toHaveBeenCalled();
  });

  it("does not share locks across separate updates directories", async () => {
    const [first, second] = await Promise.all([createFixture(), createFixture()]);
    await Promise.all([first.service.prepare(policyFor()), second.service.prepare(policyFor())]);
    expect(first.download).toHaveBeenCalledOnce();
    expect(second.download).toHaveBeenCalledOnce();
  });

  it.each(["download", "verify"] as const)("cleans only its partial file and releases cross-instance locks after failed %s", async (failure) => {
    const fixture = await createFixture();
    const started = deferred();
    const release = deferred();
    const verify = vi.fn(async () => undefined);
    if (failure === "verify") verify.mockRejectedValueOnce(new Error("verify failed"));
    fixture.download.mockImplementationOnce(async (_url, path) => {
      await writeFile(path, executableBytes());
      started.release();
      await release.promise;
      if (failure === "download") throw new Error("download failed");
    });
    const options = { ...fixture.options, verify };
    const first = createWindowsStoreWebInstaller(options).prepare(policyFor());
    await started.promise;
    const duplicate = createWindowsStoreWebInstaller(options).prepare(policyFor());
    const path = readyPath(fixture.root);
    const unrelated = join(dirname(path), "other-download.partial.exe");
    await writeFile(unrelated, "owned by another attempt");
    const firstFailure = expect(first).rejects.toThrow(`${failure} failed`);
    const duplicateFailure = expect(duplicate).rejects.toThrow(`${failure} failed`);
    release.release();
    await Promise.all([firstFailure, duplicateFailure]);
    expect(existsSync(path)).toBe(false);
    await expect(readdir(dirname(path))).resolves.toEqual(["other-download.partial.exe"]);
    await expect(createWindowsStoreWebInstaller(options).prepare(policyFor())).resolves.toBe(path);
    expect(fixture.download).toHaveBeenCalledTimes(2);
    await expect(readFile(unrelated, "utf8")).resolves.toBe("owned by another attempt");
  });

  it("does not publish the ready name until verification finishes", async () => {
    const fixture = await createFixture();
    const started = deferred();
    const release = deferred();
    const service = createWindowsStoreWebInstaller({
      ...fixture.options,
      verify: async () => { started.release(); await release.promise; }
    });
    const preparation = service.prepare(policyFor());
    await started.promise;
    try {
      expect(existsSync(readyPath(fixture.root))).toBe(false);
      await expect(service.findPrepared(policyFor())).resolves.toBeNull();
    } finally { release.release(); }
    await expect(preparation).resolves.toBe(readyPath(fixture.root));
  });

  it("rejects a downloader that resolves without creating its file, then permits retry", async () => {
    const fixture = await createFixture();
    fixture.download.mockResolvedValueOnce(undefined);
    await expect(fixture.service.prepare(policyFor())).rejects.toThrow();
    await expect(fixture.service.findPrepared(policyFor())).resolves.toBeNull();
    await expect(fixture.service.prepare(policyFor())).resolves.toBe(readyPath(fixture.root));
  });

  it("invalidates damaged and untrusted ready files, then replaces them atomically", async () => {
    const fixture = await createFixture();
    const path = await fixture.service.prepare(policyFor());
    await writeFile(path, "<html>download error</html>");
    await expect(fixture.service.findPrepared(policyFor())).resolves.toBeNull();
    await expect(fixture.service.launchPrepared(policyFor())).rejects.toThrow();
    expect(fixture.launch).not.toHaveBeenCalled();
    await expect(fixture.service.prepare(policyFor())).resolves.toBe(path);
    mockSignature({ ...signatureResult, status: "HashMismatch" });
    await expect(fixture.service.findPrepared(policyFor())).resolves.toBeNull();
    await expect(fixture.service.launchPrepared(policyFor())).rejects.toThrow();
    mockSignature(signatureResult);
    await expect(fixture.service.launchPrepared(policyFor())).resolves.toBe(path);
  });

  it("keeps a ready cache when launch fails and reverifies on each retry", async () => {
    const fixture = await createFixture();
    const path = await fixture.service.prepare(policyFor());
    fixture.launch.mockRejectedValueOnce(new Error("launch failed"));
    await expect(fixture.service.launchPrepared(policyFor())).rejects.toThrow("launch failed");
    expect(existsSync(path)).toBe(true);
    await expect(fixture.service.launchPrepared(policyFor())).resolves.toBe(path);
    expect(fixture.download).toHaveBeenCalledOnce();
    expect(fixture.launch).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it("treats a directory named like the ready exe as invalid, even with injected verification", async () => {
    const fixture = await createFixture();
    await mkdir(readyPath(fixture.root), { recursive: true });
    const verify = vi.fn(async () => undefined);
    const service = createWindowsStoreWebInstaller({ ...fixture.options, verify });
    await expect(service.findPrepared(policyFor())).resolves.toBeNull();
    await expect(service.launchPrepared(policyFor())).rejects.toThrow();
    expect(verify).not.toHaveBeenCalled();
    expect(fixture.launch).not.toHaveBeenCalled();
  });

  it("does not use renderer-supplied paths or installer arguments", async () => {
    const fixture = await createFixture();
    const policy = { ...policyFor(), filePath: "C:\\evil.exe", path: "C:\\other.exe", args: ["/S", "/D=C:\\evil"] };
    await fixture.service.prepare(policy);
    await fixture.service.launchPrepared(policy);
    expect(fixture.launch).toHaveBeenCalledExactlyOnceWith(readyPath(fixture.root));
  });

  it("preserves the nested ready exe through the legacy top-level installer cleanup selection", async () => {
    const fixture = await createFixture();
    const path = await fixture.service.prepare(policyFor());
    await writeFile(join(fixture.root, "Memmy-1.1.3.exe"), "old NSIS package");
    for (const entry of await readdir(fixture.root)) {
      if (/\.(exe|dmg)$|\.staged\.app$/i.test(entry)) await rm(join(fixture.root, entry));
    }
    await expect(fixture.service.findPrepared(policyFor())).resolves.toBe(path);
    await expect(readdir(fixture.root)).resolves.toEqual(["store-web-install"]);
  });
});

describe("Windows Store Web Install policy boundary", () => {
  it.each([
    null, "C:\\evil.exe", {},
    { kind: "installer" }, { edition: "../../escape" }, { storeId: "../../escape" },
    { storeId: policyFor("intl").storeId }, { packageFamilyName: "Attacker_family" }, { aumid: "Attacker!App" },
    ...[
      "https://evil.example/installer.exe", "http://get.microsoft.com/installer/download/9MZGLKWMZZV6",
      "file:///C:/evil.exe", "https://get.microsoft.com.evil.example/installer/download/9MZGLKWMZZV6",
      "https://user:pass@get.microsoft.com/installer/download/9MZGLKWMZZV6",
      "https://get.microsoft.com:444/installer/download/9MZGLKWMZZV6",
      "https://get.microsoft.com/installer/download/9MZGLKWMZZV6?url=https://evil.example",
      "https://get.microsoft.com/installer/download/9MZGLKWMZZV6#fragment",
      "https://get.microsoft.com/installer/download/9NFVJC9K7ZK9",
      "ms-windows-store://pdp/?ProductId=9MZGLKWMZZV6&ProductId=9NFVJC9K7ZK9",
      "ms-windows-store://pdp/?ProductId=9NFVJC9K7ZK9",
      " https://get.microsoft.com/installer/download/9MZGLKWMZZV6"
    ].map((acquisitionUri) => ({ acquisitionUri }))
  ])("rejects hostile policy %j before touching the cache or calling dependencies", async (override) => {
    const fixture = await createFixture();
    const policy = (override && typeof override === "object" ? { ...policyFor(), ...override } : override) as WindowsStoreMigrationPolicy;
    // An empty raw object is also an invalid policy, rather than a no-op override.
    const input = override && typeof override === "object" && Object.keys(override).length === 0
      ? override as WindowsStoreMigrationPolicy : policy;
    await expect(fixture.service.findPrepared(input)).rejects.toThrow(/policy/i);
    await expect(fixture.service.prepare(input)).rejects.toThrow(/policy/i);
    await expect(fixture.service.launchPrepared(input)).rejects.toThrow(/policy/i);
    expect(fixture.download).not.toHaveBeenCalled();
    expect(fixture.launch).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    await expect(readdir(fixture.root)).resolves.toEqual([]);
  });
});

describe("Windows Store Web Install native launch", () => {
  it("waits for spawn before unref and resolves without NSIS switches or inherited pipes", async () => {
    const fixture = await createFixture();
    const path = await fixture.service.prepare(policyFor());
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const called = deferred();
    vi.mocked(spawn).mockImplementation(() => { called.release(); return child as unknown as ChildProcess; });
    const service = createWindowsStoreWebInstaller({ updatesDirectory: fixture.root, download: fixture.download });
    let settled = false;
    const launched = service.launchPrepared(policyFor()).then((result) => { settled = true; return result; });
    await called.promise;
    expect(settled).toBe(false);
    expect(child.unref).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledExactlyOnceWith(path, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.emit("spawn");
    await expect(launched).resolves.toBe(path);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(existsSync(path)).toBe(true);
  });

  it.each(["event", "throw"] as const)("rejects spawn %s errors and allows a later retry", async (mode) => {
    const fixture = await createFixture();
    const path = await fixture.service.prepare(policyFor());
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockImplementationOnce(() => {
      if (mode === "throw") throw new Error("spawn EACCES");
      queueMicrotask(() => child.emit("error", new Error("spawn EACCES")));
      return child as unknown as ChildProcess;
    });
    const service = createWindowsStoreWebInstaller({ updatesDirectory: fixture.root, download: fixture.download });
    await expect(service.launchPrepared(policyFor())).rejects.toThrow("spawn EACCES");
    expect(child.unref).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(true);
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child as unknown as ChildProcess;
    });
    await expect(service.launchPrepared(policyFor())).resolves.toBe(path);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(fixture.download).toHaveBeenCalledOnce();
  });
});

describe("Windows Store Web Install production verifier", () => {
  it.each([false, true])("validates bounded PE headers before invoking Windows PowerShell (PE64=%s)", async (pe64) => {
    const fixture = await createFixture();
    const path = join(fixture.root, "quote' 空格 $x ` [literal].exe");
    await writeFile(path, executableBytes(pe64));
    await expect(verifyWindowsStoreWebInstaller(path)).resolves.toBeUndefined();
    const [executable, args, options] = vi.mocked(execFile).mock.calls[0]!;
    expect(executable).toBe(win32.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    expect(args).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand", expect.any(String)]);
    const command = Buffer.from((args as string[])[3]!, "base64").toString("utf16le");
    expect(command).toContain("Microsoft.PowerShell.Security\\Get-AuthenticodeSignature");
    expect(command).toContain(`-LiteralPath '${resolve(path).replace(/'/g, "''")}'`);
    expect(command).toContain("UseNewLines");
    expect(command).toContain("$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')");
    expect(options).toMatchObject({ timeout: 30_000, windowsHide: true, encoding: "utf8" });
    expect(options).not.toHaveProperty("shell", true);
  });

  it.each([
    ["empty", () => Buffer.alloc(0)],
    ["HTML", () => Buffer.from("<html>not an installer</html>".repeat(100))],
    ["DOS stub only", () => executableBytes().subarray(0, 64)],
    ["bad PE signature", () => { const b = executableBytes(); b.write("NOPE", 128); return b; }],
    ["out-of-bounds PE offset", () => { const b = executableBytes(); b.writeUInt32LE(0xfffffff0, 0x3c); return b; }],
    ["invalid optional header", () => { const b = executableBytes(); b.writeUInt16LE(0, 152); return b; }],
    ["missing executable bit", () => { const b = executableBytes(); b.writeUInt16LE(0, 150); return b; }],
    ["DLL", () => { const b = executableBytes(); b.writeUInt16LE(0x2002, 150); return b; }],
    ["no sections", () => { const b = executableBytes(); b.writeUInt16LE(0, 134); return b; }],
    ["truncated section table", () => { const b = executableBytes(); b.writeUInt16LE(96, 134); return b; }],
    ["truncated section data", () => executableBytes().subarray(0, 1000)],
    ["truncated headers", () => { const b = executableBytes(); b.writeUInt32LE(2048, 212); return b; }],
    ["truncated certificate", () => {
      const b = executableBytes(); b.writeUInt32LE(1024, 280); b.writeUInt32LE(128, 284); return b;
    }]
  ] as const)("rejects %s without starting PowerShell", async (_name, makeBytes) => {
    const fixture = await createFixture();
    const path = readyPath(fixture.root);
    await stageBytes(path, makeBytes());
    await expect(verifyWindowsStoreWebInstaller(path)).rejects.toThrow(/PE executable/i);
    await expect(fixture.service.findPrepared(policyFor())).resolves.toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([
    { ...signatureResult, status: "NotSigned" },
    { ...signatureResult, status: "HashMismatch" },
    { ...signatureResult, status: "UnknownError" },
    { status: "Valid", subject: "CN=Microsoft Corporation\nO=Other Company" },
    { status: "Valid", subject: "CN=Other Company\nO=Microsoft Corporation Evil" },
    { status: "Valid", subject: 'CN="Example, O=Microsoft Corporation"\nO=Other Company' },
    { status: "Valid", subject: null },
    { status: "Valid" }, null, {}, "not JSON"
  ])("fails closed for signature result %j", async (result) => {
    const fixture = await createFixture();
    const path = readyPath(fixture.root);
    await stageBytes(path);
    mockSignature(result);
    await expect(verifyWindowsStoreWebInstaller(path)).rejects.toThrow();
    await expect(fixture.service.findPrepared(policyFor())).resolves.toBeNull();
    await expect(fixture.service.launchPrepared(policyFor())).rejects.toThrow();
    expect(fixture.launch).not.toHaveBeenCalled();
  });

  it.each(["timeout", "ENOENT"])("rejects PowerShell %s failures and allows verification retry", async (message) => {
    const fixture = await createFixture();
    const path = readyPath(fixture.root);
    await stageBytes(path);
    mockSignature("", new Error(message));
    await expect(verifyWindowsStoreWebInstaller(path)).rejects.toThrow(message);
    mockSignature(signatureResult);
    await expect(verifyWindowsStoreWebInstaller(path)).resolves.toBeUndefined();
  });

  it.each([undefined, "relative-windows"])("refuses an unavailable or relative SystemRoot (%s)", async (systemRoot) => {
    const fixture = await createFixture();
    const path = readyPath(fixture.root);
    await stageBytes(path);
    vi.stubEnv("SystemRoot", systemRoot);
    await expect(verifyWindowsStoreWebInstaller(path)).rejects.toThrow(/SystemRoot/);
    expect(execFile).not.toHaveBeenCalled();
  });
});
