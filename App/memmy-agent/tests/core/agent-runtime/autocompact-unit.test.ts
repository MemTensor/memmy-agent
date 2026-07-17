import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AutoCompact } from "../../../src/core/agent-runtime/autocompact.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { Session, SessionManager } from "../../../src/core/session/manager.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memmy-autocompact-"));
}

function makeSession({
  key = "cli:test",
  metadata = {},
  updatedAt,
}: {
  key?: string;
  metadata?: Record<string, any>;
  updatedAt?: Date | string | null;
} = {}): Session {
  const session = new Session({ key, metadata });
  if (updatedAt != null) session.updatedAt = updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt;
  return session;
}

function makeAutoCompact({
  ttl = 15,
  sessions = { listSessions: vi.fn(() => []), getOrCreate: vi.fn((key: string) => makeSession({ key })) },
  consolidator = { compactIdleSession: vi.fn(async () => "Summary.") },
}: {
  ttl?: number;
  sessions?: any;
  consolidator?: any;
} = {}): AutoCompact {
  return new AutoCompact(sessions as SessionManager, consolidator, ttl);
}

describe("AutoCompact", () => {
  it("detects expiration boundaries and formats summaries", () => {
    const ac = new AutoCompact(new SessionManager(tmpDir()), {}, 15);
    const now = new Date("2026-01-01T12:00:00.000Z");
    expect(ac.isExpired("2026-01-01T11:45:00.000Z", now)).toBe(true);
    expect(ac.isExpired("2026-01-01T11:45:01.000Z", now)).toBe(false);
    expect(ac.isExpired(null, now)).toBe(false);
    expect(AutoCompact.formatSummary("Summary.", now)).toContain("Previous conversation summary");
    expect(AutoCompact.formatSummary("Summary.", now)).toContain("2026-01-01T12:00:00.000Z");
  });

  it("schedules only expired inactive sessions and avoids duplicate archives", () => {
    const sessions = new SessionManager(tmpDir());
    const oldSession = sessions.getOrCreate("cli:old");
    oldSession.updatedAt = "2026-01-01T11:00:00.000Z";
    sessions.save(oldSession);
    const activeSession = sessions.getOrCreate("cli:active");
    activeSession.updatedAt = "2026-01-01T11:00:00.000Z";
    sessions.save(activeSession);
    const freshSession = sessions.getOrCreate("cli:fresh");
    freshSession.updatedAt = "2026-01-01T11:59:00.000Z";
    sessions.save(freshSession);

    const ac = new AutoCompact(sessions, { compactIdleSession: vi.fn(async () => "") }, 15);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    const scheduled: Promise<any>[] = [];
    try {
      ac.checkExpired((promise) => scheduled.push(promise), ["cli:active"]);
      ac.checkExpired((promise) => scheduled.push(promise), ["cli:active"]);
      expect(scheduled).toHaveLength(1);
      expect(ac.archiving.has("cli:old")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("archives through the consolidator and prepares hot/cold summaries", async () => {
    const sessions = new SessionManager(tmpDir());
    const session = sessions.getOrCreate("cli:test");
    session.metadata.lastSummary = {
      text: "The prior chat was about refactoring.",
      lastActive: "2026-05-01T10:00:00.000Z",
    };
    sessions.save(session);

    const consolidator = { compactIdleSession: vi.fn(async () => "Summary.") };
    const ac = new AutoCompact(sessions, consolidator, 15);
    await ac.archiveExpiredSession("cli:test");
    expect(consolidator.compactIdleSession).toHaveBeenCalledWith("cli:test", 8);
    expect(ac.archiving.has("cli:test")).toBe(false);
    expect(ac.summaries.get("cli:test")?.[0]).toBe("The prior chat was about refactoring.");

    const [prepared, hotSummary] = ac.prepareSession(session, "cli:test");
    expect(prepared.key).toBe("cli:test");
    expect(hotSummary).toContain("The prior chat was about refactoring.");
    expect(ac.summaries.has("cli:test")).toBe(false);

    const [, coldSummary] = ac.prepareSession(session, "cli:test");
    expect(coldSummary).toContain("The prior chat was about refactoring.");
  });

  it("is wired into AgentLoop with configured TTL", () => {
    const loop = new AgentLoop({
      workspace: tmpDir(),
      provider: { model: "test", chatWithRetry: async () => ({ content: "ok", toolCalls: [], shouldExecuteTools: false, finishReason: "stop" }) },
      model: "test",
      sessionTtlMinutes: 25,
    });
    expect(loop.autoCompact.ttl).toBe(25);
    expect(loop.autoCompact).toBeInstanceOf(AutoCompact);
  });
});

describe("AutoCompact memmy unit parity", () => {
  it("stores TTL", () => {
    expect(makeAutoCompact({ ttl: 30 }).ttl).toBe(30);
  });

  it("defaults TTL to zero", () => {
    expect(makeAutoCompact({ ttl: 0 }).ttl).toBe(0);
  });

  it("starts with an empty archiving set", () => {
    expect(makeAutoCompact().archiving.size).toBe(0);
  });

  it("starts with an empty summary map", () => {
    expect(makeAutoCompact().summaries.size).toBe(0);
  });

  it("stores the sessions reference", () => {
    const sessions = { listSessions: vi.fn(() => []) };
    expect(makeAutoCompact({ sessions }).sessions).toBe(sessions);
  });

  it("stores the consolidator reference", () => {
    const consolidator = { compactIdleSession: vi.fn(async () => "ok") };
    expect(makeAutoCompact({ consolidator }).consolidator).toBe(consolidator);
  });

  it("treats zero TTL as never expired", () => {
    expect(makeAutoCompact({ ttl: 0 }).isExpired(new Date("2025-01-01T00:00:00Z"))).toBe(false);
  });

  it("returns false for null timestamps", () => {
    expect(makeAutoCompact({ ttl: 15 }).isExpired(null)).toBe(false);
  });

  it("returns false for empty timestamps", () => {
    expect(makeAutoCompact({ ttl: 15 }).isExpired("")).toBe(false);
  });

  it("expires exactly at the TTL boundary", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    expect(makeAutoCompact({ ttl: 15 }).isExpired(new Date("2026-01-01T11:45:00Z"), now)).toBe(true);
  });

  it("does not expire timestamps just under the boundary", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    expect(makeAutoCompact({ ttl: 15 }).isExpired(new Date("2026-01-01T11:45:01Z"), now)).toBe(false);
  });

  it("parses ISO timestamp strings", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    expect(makeAutoCompact({ ttl: 15 }).isExpired("2026-01-01T11:40:00.000Z", now)).toBe(true);
  });

  it("accepts a custom now parameter", () => {
    const ac = makeAutoCompact({ ttl: 10 });
    const ts = new Date("2026-01-01T10:00:00Z");
    expect(ac.isExpired(ts, new Date("2026-01-01T10:09:00Z"))).toBe(false);
    expect(ac.isExpired(ts, new Date("2026-01-01T10:10:00Z"))).toBe(true);
  });

  it("includes ISO timestamps in formatted summaries", () => {
    const result = AutoCompact.formatSummary("Some text", new Date("2026-05-13T14:30:00Z"));
    expect(result).toContain("2026-05-13T14:30:00");
  });

  it("includes summary text in formatted summaries", () => {
    expect(AutoCompact.formatSummary("User discussed TypeScript.", new Date("2026-01-01T00:00:00Z"))).toContain(
      "User discussed TypeScript.",
    );
  });

  it("starts formatted summaries with a label", () => {
    expect(AutoCompact.formatSummary("text", new Date("2026-01-01T00:00:00Z"))).toMatch(
      /^Previous conversation summary \(last active /,
    );
  });

  it("does nothing for an empty sessions list", () => {
    const scheduler = vi.fn();
    makeAutoCompact({ sessions: { listSessions: vi.fn(() => []) } }).checkExpired(scheduler);
    expect(scheduler).not.toHaveBeenCalled();
  });

  it("skips active session keys", () => {
    const oldTs = new Date(Date.now() - 20 * 60_000).toISOString();
    const sessions = { listSessions: vi.fn(() => [{ key: "cli:busy", updatedAt: oldTs }]) };
    const scheduler = vi.fn();
    makeAutoCompact({ sessions }).checkExpired(scheduler, new Set(["cli:busy"]));
    expect(scheduler).not.toHaveBeenCalled();
  });

  it("skips sessions already being archived", () => {
    const oldTs = new Date(Date.now() - 20 * 60_000).toISOString();
    const ac = makeAutoCompact({ sessions: { listSessions: vi.fn(() => [{ key: "cli:dup", updatedAt: oldTs }]) } });
    ac.archiving.add("cli:dup");
    const scheduler = vi.fn();
    ac.checkExpired(scheduler);
    expect(scheduler).not.toHaveBeenCalled();
  });

  it("skips sessions with empty keys", () => {
    const sessions = { listSessions: vi.fn(() => [{ key: "", updatedAt: "old" }]) };
    const scheduler = vi.fn();
    makeAutoCompact({ sessions }).checkExpired(scheduler);
    expect(scheduler).not.toHaveBeenCalled();
  });

  it("skips sessions with missing key fields", () => {
    const sessions = { listSessions: vi.fn(() => [{ updatedAt: "old" }]) };
    const scheduler = vi.fn();
    makeAutoCompact({ sessions }).checkExpired(scheduler);
    expect(scheduler).not.toHaveBeenCalled();
  });

  it("calls compactIdleSession", async () => {
    const consolidator = { compactIdleSession: vi.fn(async () => "Summary.") };
    const sessions = { getOrCreate: vi.fn((key: string) => makeSession({ key })) };
    await makeAutoCompact({ sessions, consolidator }).archiveExpiredSession("cli:test");
    expect(consolidator.compactIdleSession).toHaveBeenCalledWith("cli:test", AutoCompact.RECENT_SUFFIX_MESSAGES);
  });

  it("populates summaries from metadata", async () => {
    const session = makeSession({
      metadata: { lastSummary: { text: "Hello.", lastActive: "2026-05-13T10:00:00.000Z" } },
    });
    const sessions = { getOrCreate: vi.fn(() => session) };
    const ac = makeAutoCompact({ sessions, consolidator: { compactIdleSession: vi.fn(async () => "Hello.") } });
    await ac.archiveExpiredSession("cli:test");
    expect(ac.summaries.get("cli:test")?.[0]).toBe("Hello.");
  });

  it("stores no summary when compact returns an empty string", async () => {
    const ac = makeAutoCompact({ consolidator: { compactIdleSession: vi.fn(async () => "") } });
    await ac.archiveExpiredSession("cli:test");
    expect(ac.summaries.has("cli:test")).toBe(false);
  });

  it("stores no summary when compact returns nothing marker", async () => {
    const ac = makeAutoCompact({ consolidator: { compactIdleSession: vi.fn(async () => "(nothing)") } });
    await ac.archiveExpiredSession("cli:test");
    expect(ac.summaries.has("cli:test")).toBe(false);
  });

  it("removes archiving entries after exceptions", async () => {
    const ac = makeAutoCompact({ consolidator: { compactIdleSession: vi.fn(async () => { throw new Error("fail"); }) } });
    ac.archiving.add("cli:test");
    await ac.archiveExpiredSession("cli:test");
    expect(ac.archiving.has("cli:test")).toBe(false);
  });

  it("reloads sessions currently being archived", () => {
    const reloaded = makeSession({ key: "cli:test" });
    const sessions = { getOrCreate: vi.fn(() => reloaded), invalidate: vi.fn() };
    const ac = makeAutoCompact({ sessions });
    ac.archiving.add("cli:test");
    const original = makeSession({ key: "cli:test" });
    const [result] = ac.prepareSession(original, "cli:test");
    expect(sessions.getOrCreate).toHaveBeenCalledWith("cli:test");
    expect(result).toBe(reloaded);
  });

  it("reloads expired sessions", () => {
    const reloaded = makeSession({ key: "cli:test" });
    const sessions = { getOrCreate: vi.fn(() => reloaded), invalidate: vi.fn() };
    const ac = makeAutoCompact({ ttl: 15, sessions });
    const old = makeSession({ key: "cli:test", updatedAt: new Date(Date.now() - 20 * 60_000) });
    const [result] = ac.prepareSession(old, "cli:test");
    expect(sessions.getOrCreate).toHaveBeenCalledWith("cli:test");
    expect(result).toBe(reloaded);
  });

  it("returns hot path summaries", () => {
    const ac = makeAutoCompact();
    const session = makeSession();
    ac.summaries.set("cli:test", ["Hot summary.", new Date("2026-05-13T14:00:00Z")]);
    const [result, summary] = ac.prepareSession(session, "cli:test");
    expect(result).toBe(session);
    expect(summary).toContain("Hot summary.");
    expect(summary).toContain("Previous conversation summary");
  });

  it("pops hot path summaries one time", () => {
    const ac = makeAutoCompact();
    const session = makeSession();
    ac.summaries.set("cli:test", ["One-shot.", new Date("2026-01-01T00:00:00Z")]);
    const [, first] = ac.prepareSession(session, "cli:test");
    const [, second] = ac.prepareSession(session, "cli:test");
    expect(first).toContain("One-shot.");
    expect(second).toBeNull();
  });

  it("returns no cold path summary when metadata is not an object", () => {
    const session = makeSession({ metadata: { lastSummary: "not a object" } });
    const [result, summary] = makeAutoCompact().prepareSession(session, "cli:test");
    expect(result).toBe(session);
    expect(summary).toBeNull();
  });
});
