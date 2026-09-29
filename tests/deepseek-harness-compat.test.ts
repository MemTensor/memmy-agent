import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as desktopPaths from "../App/backend/src/adapters/outbound/agent-paths.js";
import * as memoryPaths from "../Memory/src/agent-source/agent-paths.js";
import { createDeepseekHarnessSourceAdapter as desktopAdapter } from "../App/backend/src/adapters/outbound/agent-source/deepseek-harness/adapter.js";
import { createDeepseekHarnessSourceAdapter as memoryAdapter } from "../Memory/src/agent-source/adapters/deepseek-harness/adapter.js";
import * as desktopReader from "../App/backend/src/adapters/outbound/agent-source/deepseek-harness/session-reader.js";
import * as memoryReader from "../Memory/src/agent-source/adapters/deepseek-harness/session-reader.js";
import { discoverDeepseekHarnessSessions as desktopDiscover } from "../App/backend/src/adapters/outbound/agent-source/deepseek-harness/session-discovery.js";
import { discoverDeepseekHarnessSessions as memoryDiscover } from "../Memory/src/agent-source/adapters/deepseek-harness/session-discovery.js";
import { openAppAgentSourceScanStore } from "../App/backend/src/infrastructure/agent-source-scan-store/index.js";
import { openMemoryAgentSourceScanStore } from "../Memory/src/agent-source/scan-store.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "memmy-dsh-compat-"));
  directories.push(directory);
  return directory;
}

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const messages: T[] = [];
  for await (const message of input) messages.push(message);
  return messages;
}

function fixture(file: string, sessionId = "conversation", header = true) {
  const key = ["sk-", "abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMN"].join("");
  const rows = [
    ...(header ? [{ type: "session", id: sessionId, cwd: "/fictional/project" }] : []),
    { type: "user/message", seq: 1, time: "2026-09-28T10:00:00Z", data: {
      role: "user", source: { kind: "user" }, content: [{ type: "text", text: `Remember OPENAI_API_KEY=${key}` }]
    } },
    { type: "user/message", seq: 2, time: "2026-09-28T10:00:01Z", data: {
      role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "Do not import recalled context" }]
    } },
    { type: "assistant/message", seq: 3, time: "2026-09-28T10:00:02Z", data: { message: {
      role: "assistant", content: [{ type: "text", text: "DSH compatibility test response" }]
    } } }
  ];
  const lines = rows.map((row) => Buffer.from(JSON.stringify(row) + "\n"));
  mkdirSync(dirname(file), { recursive: true });
  // Independent frames match real append-only DSH session logs.
  writeFileSync(file, Buffer.concat(file.includes(".zstd") ? lines.map((line) => zstdCompressSync(line)) : lines));
}

const implementations = [
  { name: "desktop", paths: desktopPaths, adapter: desktopAdapter, reader: desktopReader, discover: desktopDiscover, store: openAppAgentSourceScanStore },
  { name: "standalone memory", paths: memoryPaths, adapter: memoryAdapter, reader: memoryReader, discover: memoryDiscover, store: openMemoryAgentSourceScanStore }
];

describe.each(implementations)("DSH compatibility: $name", ({ paths, adapter, reader, discover, store: openStore }) => {
  it.each([
    ["win32", "C:\\Users\\测试 用户", {}, "C:\\Users\\测试 用户\\AppData\\Roaming\\dsh-desktop\\harness\\sessions"],
    ["win32", "C:\\Users\\alice", { APPDATA: "D:\\自定义 数据" }, "D:\\自定义 数据\\dsh-desktop\\harness\\sessions"],
    ["darwin", "/Users/测试 用户", {}, "/Users/测试 用户/Library/Application Support/dsh-desktop/harness/sessions"],
    ["linux", "/home/alice", {}, "/home/alice/.config/dsh-desktop/harness/sessions"],
    ["linux", "/home/alice", { XDG_CONFIG_HOME: "/mnt/自定义 配置" }, "/mnt/自定义 配置/dsh-desktop/harness/sessions"]
  ] as const)("resolves CLI and Desktop session roots on %s (%s, %j)", (platform, homeDirectory, environment, desktopRoot) => {
    const path = platform === "win32" ? win32 : posix;
    expect(paths.resolveDeepseekHarnessSessionsDirectories({ platform, homeDirectory, environment })).toEqual([
      path.join(homeDirectory, ".dsh", "sessions"), desktopRoot
    ]);
  });

  it.each(["win32", "darwin", "linux"] as const)("honors the exclusive custom DSH_HOME on %s", (platform) => {
    const path = platform === "win32" ? win32 : posix;
    const homeDirectory = platform === "win32" ? "C:\\Users\\alice" : "/home/alice";
    const options = { platform, homeDirectory, environment: { DSH_HOME: " ~/自定义 DSH " } };
    expect(paths.resolveDeepseekHarnessSessionsDirectories(options)).toEqual([path.join(homeDirectory, "自定义 DSH", "sessions")]);
  });

  it("uses the configured DSH_HOME in a real scan, including spaces and Unicode", async () => {
    const home = join(temporaryDirectory(), "自定义 DSH");
    vi.stubEnv("DSH_HOME", home);
    fixture(join(home, "sessions", "nested", "session.v4.jsonl.zstd.bak-1790604319265"));
    const source = adapter();
    expect(source.descriptor.dataPath).toBe(join(home, "sessions"));
    await expect(source.detect()).resolves.toBe(true);
    expect(await collect(source.scan({ fullHistory: true }))).toHaveLength(2);
  });

  it("preserves detection of an installed home without any conversations", async () => {
    const rootDirectory = temporaryDirectory();
    const source = adapter({ rootDirectory });
    await expect(source.detect()).resolves.toBe(true);
    expect(await collect(source.scan({}))).toEqual([]);
  });

  it("honors Windows drive and network-share custom homes", () => {
    for (const DSH_HOME of ["D:\\自定义 DSH", "\\\\server\\share\\DSH"])
      expect(paths.resolveDeepseekHarnessSessionsDirectories({ platform: "win32", homeDirectory: "C:\\Users\\alice", environment: { DSH_HOME } })).toEqual([win32.join(DSH_HOME, "sessions")]);
  });

  it.each([
    "session.jsonl", "session.jsonl.zstd", "session.v4.jsonl", "session.v4.jsonl.zstd",
    "session.jsonl.bak-1790604319265", "session.jsonl.zstd.bak-1790604319265",
    "session.v4.jsonl.bak-1790604319265", "session.v4.jsonl.zstd.bak-1790604319265"
  ])("discovers and reads %s without changing message identity", async (fileName) => {
    const root = temporaryDirectory();
    const file = join(root, "sessions", "workspace", "conversation", fileName);
    fixture(file);
    const source = adapter({ rootDirectory: root });
    await expect(source.detect()).resolves.toBe(true);
    expect(await discover({ root: join(root, "sessions") })).toHaveLength(1);
    const streamed = await collect(reader.streamDeepseekHarnessSession(file));
    expect(streamed).toEqual(await reader.readDeepseekHarnessSession(file));
    expect(streamed.map((message) => message.messageId)).toEqual(["conversation:1", "conversation:3"]);
    const scanned = await collect(source.scan({ fullHistory: true }));
    expect(scanned).toHaveLength(2);
    expect(scanned[0]?.content).toBe("Remember OPENAI_API_KEY=[REDACTED:openai_api_key]");
    expect(scanned[1]?.content).toBe("DSH compatibility test response");
  });

  it("does not scan unrelated files or unsupported suffixes", async () => {
    const root = temporaryDirectory();
    for (const name of ["credentials.jsonl", "session.jsonl.orig", "session.jsonl.zstd.tmp", "session.jsonl.zstd.bak-not-a-timestamp", "session.v0.jsonl", "session.jsonl.bak-123.extra"])
      writeFileSync(join(root, name), "not a session");
    expect(await discover({ root })).toEqual([]);
  });

  it("reports corrupt compressed backups instead of silently reading them as text", async () => {
    const root = temporaryDirectory();
    const file = join(root, "session.jsonl.zstd.bak-1790604319265");
    writeFileSync(file, "not a zstd frame");
    await expect(reader.readDeepseekHarnessSession(file)).rejects.toThrow();
    await expect(collect(reader.streamDeepseekHarnessSession(file))).rejects.toThrow();
  });

  it("detects a Desktop/custom sessions root when the CLI home is absent, including late creation", async () => {
    const root = temporaryDirectory();
    const missing = join(root, ".dsh", "sessions");
    const desktop = join(root, "Application Data", "dsh-desktop", "harness", "sessions");
    const source = adapter({ sessionsRoots: [missing, desktop] });
    await expect(source.detect()).resolves.toBe(false);
    fixture(join(desktop, "nested", "session.v4.jsonl.zstd"));
    await expect(source.detect()).resolves.toBe(true);
    expect(source.descriptor.dataPath).toBe(desktop);
    expect(await collect(source.scan({}))).toHaveLength(2);
    await expect(adapter({ sessionsRoot: desktop }).detect()).resolves.toBe(true);
  });

  it("scans both installed roots and applies recent-first and limits globally", async () => {
    const root = temporaryDirectory();
    const cli = join(root, "cli");
    const desktop = join(root, "desktop");
    const old = join(cli, "session.jsonl");
    const recent = join(desktop, "session.v4.jsonl.zstd.bak-1790604319265");
    fixture(old, "old"); fixture(recent, "recent");
    utimesSync(old, 1, 1); utimesSync(recent, 2, 2);
    const source = adapter({ sessionsRoots: [cli, desktop] });
    expect(await collect(source.scan({ fullHistory: true }))).toHaveLength(4);
    const limited = await collect(source.scan({ fullHistory: true, order: "recent_first", maxScanTargets: 1, maxMessages: 1 }));
    expect(limited).toHaveLength(1);
    expect(limited[0]?.conversationId).toBe("recent");
  });

  it("does not discover the same root twice through a junction or symlink", async () => {
    const root = temporaryDirectory();
    const real = join(root, "real");
    fixture(join(real, "nested", "session.jsonl"));
    const alias = join(root, "alias");
    symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await discover({ root: real, roots: [real, alias] })).toHaveLength(1);
  });

  it("preserves incremental conversation windows and cancellation", async () => {
    const root = temporaryDirectory();
    fixture(join(root, "session.v4.jsonl.zstd.bak-1790604319265"));
    const source = adapter({ sessionsRoot: root });
    expect(await collect(source.scan({ since: "2026-09-28T10:00:01Z" }))).toHaveLength(2);
    expect(await collect(source.scan({ since: "2026-09-29T00:00:00Z" }))).toHaveLength(0);
    expect(await collect(source.scan({ fullHistory: true, maxMessages: 0 }))).toHaveLength(0);
    const controller = new AbortController(); controller.abort();
    await expect(collect(source.scan({ signal: controller.signal }))).rejects.toThrow();
  });

  it.each([true, false])("deduplicates live and backup messages in the production scan store (header=%s)", async (header) => {
    const root = temporaryDirectory();
    const file = join(root, "session.v4.jsonl.zstd");
    fixture(file, "conversation", header);
    copyFileSync(file, `${file}.bak-1790604319265`);
    const messages = await collect(adapter({ sessionsRoot: root }).scan({ fullHistory: true }));
    expect(messages).toHaveLength(4);
    const store = await openStore(join(root, "scan.sqlite"), { jobId: "job", sourceId: "deepseek_harness", mode: "full", phase: "stage", createdAt: "2026-09-29", updatedAt: "2026-09-29" });
    try {
      expect(store.stageBatch(messages)).toBe(2);
      expect(store.stageBatch(messages)).toBe(0);
      expect(store.count("deepseek_harness")).toBe(2);
    } finally { store.close(); }
  });
});
