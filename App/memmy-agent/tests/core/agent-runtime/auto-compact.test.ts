import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AutoCompact } from "../../../src/core/agent-runtime/autocompact.js";
import { AgentDefaults } from "../../../src/config/schema.js";
import { FILE_MAX_MESSAGES, Session, SessionManager } from "../../../src/core/session/manager.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memmy-autocompact-"));
}

function addTurns(session: Session, turns: number, prefix = "msg"): void {
  for (let index = 0; index < turns; index += 1) {
    session.addMessage("user", `${prefix} user ${index}`);
    session.addMessage("assistant", `${prefix} assistant ${index}`);
  }
}

function setUpdatedAt(session: Session, value: string): void {
  session.updatedAt = value;
}

function fakeCompact(
  sessions: SessionManager,
  {
    summary = "Summary.",
    fail = false,
    archived = null,
  }: { summary?: string | null; fail?: boolean; archived?: Record<string, any>[] | null } = {},
) {
  const state = { count: 0, calls: [] as Array<[string, number]> };
  return {
    state,
    async compactIdleSession(key: string, maxSuffix = AutoCompact.RECENT_SUFFIX_MESSAGES): Promise<string | null> {
      state.count += 1;
      state.calls.push([key, maxSuffix]);
      if (fail) throw new Error("archive failed");
      const session = sessions.getOrCreate(key);
      const tail = session.messages.slice(session.lastConsolidated);
      if (!tail.length) {
        session.updatedAt = new Date().toISOString();
        sessions.save(session);
        return "";
      }
      const probe = new Session({
        key: session.key,
        messages: tail.map((message) => ({ ...message })),
        metadata: {},
        lastConsolidated: 0,
      });
      probe.retainRecentLegalSuffix(maxSuffix);
      const kept = probe.messages;
      const cut = tail.length - kept.length;
      const archiveMessages = tail.slice(0, cut);
      if (archived) archived.push(...archiveMessages);
      const lastActive = session.updatedAt;
      if (archiveMessages.length && summary && summary !== "(nothing)") {
        session.metadata.lastSummary = { text: summary, lastActive: lastActive };
      }
      session.messages = kept;
      session.lastConsolidated = 0;
      session.updatedAt = new Date().toISOString();
      sessions.save(session);
      return archiveMessages.length ? summary : "";
    },
  };
}

describe("AutoCompact session preparation", () => {
  it("defaults session idle compact TTL to disabled", () => {
    expect(new AgentDefaults().sessionTtlMinutes).toBe(0);
  });

  it("stores custom session idle compact TTL values", () => {
    const defaults = new AgentDefaults({ sessionTtlMinutes: 30 });

    expect(defaults.sessionTtlMinutes).toBe(30);
  });

  it("accepts idleCompactAfterMinutes as the user-facing TTL alias", () => {
    const defaults = AgentDefaults.fromObject({ idleCompactAfterMinutes: 30 });

    expect(defaults.sessionTtlMinutes).toBe(30);
  });

  it("still accepts legacy sessionTtlMinutes TTL config", () => {
    const defaults = AgentDefaults.fromObject({ sessionTtlMinutes: 30 });

    expect(defaults.sessionTtlMinutes).toBe(30);
  });

  it("serializes TTL with the user-facing alias", () => {
    const defaults = new AgentDefaults({ sessionTtlMinutes: 30 });
    const data = defaults.toObject();

    expect(data.idleCompactAfterMinutes).toBe(30);
    expect(data.sessionTtlMinutes).toBeUndefined();
  });

  it("keeps the session file cap as an internal constant", () => {
    expect(FILE_MAX_MESSAGES).toBe(2000);
  });

  it("trims sessions to the file cap without archiving already consolidated drops", () => {
    const archived: Record<string, any>[][] = [];
    const session = new Session({ key: "cli:direct" });
    for (let i = 0; i < 8; i += 1) session.addMessage("user", `u${i}`);
    session.lastConsolidated = 6;

    session.enforceFileCap((messages) => archived.push(messages), 4);

    expect(session.messages).toHaveLength(4);
    expect(archived).toEqual([]);
  });

  it("archives only the unconsolidated prefix dropped by the file cap", () => {
    const archived: Record<string, any>[][] = [];
    const session = new Session({ key: "cli:direct" });
    for (let i = 0; i < 8; i += 1) session.addMessage("user", `u${i}`);
    session.lastConsolidated = 2;

    session.enforceFileCap((messages) => archived.push(messages), 4);

    expect(session.messages).toHaveLength(4);
    expect(archived).toHaveLength(1);
    expect(archived[0].map((message) => message.content)).toEqual(["u2", "u3"]);
  });

  it("returns hot summaries once and preserves active sessions", () => {
    const sessions = new SessionManager(tmpRoot());
    const compact = new AutoCompact(sessions, null, 1);
    const session = new Session({ key: "s1" });
    const lastActive = new Date("2026-05-28T00:00:00Z");
    compact.summaries.set("s1", ["old context", lastActive]);

    const [prepared, summary] = compact.prepareSession(session, "s1");

    expect(prepared).toBe(session);
    expect(summary).toContain("old context");
    expect(summary).toContain(lastActive.toISOString());
    expect(compact.prepareSession(session, "s1")[1]).toBeNull();
  });

  it("honors disabled TTL and the exact expiration boundary", () => {
    const disabled = new AutoCompact(new SessionManager(tmpRoot()), null, 0);
    const old = new Date(Date.now() - 60 * 60_000);
    expect(disabled.isExpired(old)).toBe(false);

    const compact = new AutoCompact(new SessionManager(tmpRoot()), null, 15);
    const now = new Date("2026-05-28T12:00:00Z");
    expect(compact.isExpired("2026-05-28T11:45:00.000Z", now)).toBe(true);
    expect(compact.isExpired("2026-05-28T11:45:01.000Z", now)).toBe(false);
    expect(compact.isExpired(null, now)).toBe(false);
  });

  it("schedules only expired idle sessions and skips active sessions", () => {
    const sessions = new SessionManager(tmpRoot());
    const oldSession = new Session({ key: "old", updatedAt: "2000-01-01T00:00:00.000Z" });
    const activeSession = new Session({ key: "active", updatedAt: "2000-01-01T00:00:00.000Z" });
    const freshSession = new Session({ key: "fresh", updatedAt: new Date().toISOString() });
    sessions.save(oldSession);
    sessions.save(activeSession);
    sessions.save(freshSession);
    const compact = new AutoCompact(sessions, { compactIdleSession: async () => "(nothing)" }, 15);
    const scheduled: Promise<any>[] = [];

    compact.checkExpired((promise) => scheduled.push(promise), ["active"]);

    expect(scheduled).toHaveLength(1);
    expect(compact.archiving.has("old")).toBe(true);
    expect(compact.archiving.has("active")).toBe(false);
    expect(compact.archiving.has("fresh")).toBe(false);
  });

  it("archives summaries for hot reuse and clears archiving state", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "s1", updatedAt: "2026-05-28T11:00:00.000Z" });
    sessions.save(session);
    const compact = new AutoCompact(sessions, {
      compactIdleSession: async (key: string) => {
        const current = sessions.getOrCreate(key);
        current.metadata.lastSummary = { text: "Summary.", lastActive: "2026-05-28T11:00:00.000Z" };
        sessions.save(current);
        return "Summary.";
      },
    }, 15);
    compact.archiving.add("s1");

    await compact.archiveExpiredSession("s1");

    expect(compact.archiving.has("s1")).toBe(false);
    expect(compact.prepareSession(sessions.getOrCreate("s1"), "s1")[1]).toContain("Summary.");
  });

  it("swallows archive failures and clears archiving state", async () => {
    const compact = new AutoCompact(new SessionManager(tmpRoot()), {
      compactIdleSession: async () => {
        throw new Error("boom");
      },
    }, 15);
    compact.archiving.add("bad");

    await expect(compact.archiveExpiredSession("bad")).resolves.toBeUndefined();
    expect(compact.archiving.has("bad")).toBe(false);
  });
});

describe("AutoCompact parity behavior", () => {
  it("stores the configured TTL on construction", () => {
    expect(new AutoCompact(new SessionManager(tmpRoot()), null, 25).ttl).toBe(25);
  });

  it("uses zero as the default TTL", () => {
    expect(new AutoCompact(new SessionManager(tmpRoot())).ttl).toBe(0);
  });

  it("parses expired ISO string timestamps", () => {
    const compact = new AutoCompact(new SessionManager(tmpRoot()), null, 15);

    expect(compact.isExpired("2026-05-28T11:40:00.000Z", new Date("2026-05-28T12:00:00.000Z"))).toBe(true);
  });

  it("treats invalid timestamps as not expired", () => {
    const compact = new AutoCompact(new SessionManager(tmpRoot()), null, 15);

    expect(compact.isExpired("not-a-date")).toBe(false);
  });

  it("does not schedule checks when TTL is disabled", () => {
    const sessions = new SessionManager(tmpRoot());
    sessions.save(new Session({ key: "old", updatedAt: "2000-01-01T00:00:00.000Z" }));
    const compact = new AutoCompact(sessions, fakeCompact(sessions), 0);
    const scheduled: Promise<any>[] = [];

    compact.checkExpired((promise) => scheduled.push(promise));

    expect(scheduled).toEqual([]);
  });

  it("schedules expired sessions with compactIdleSession", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test", updatedAt: "2000-01-01T00:00:00.000Z" });
    addTurns(session, 6, "old");
    setUpdatedAt(session, "2000-01-01T00:00:00.000Z");
    sessions.save(session);
    const consolidator = fakeCompact(sessions);
    const compact = new AutoCompact(sessions, consolidator, 15);
    const scheduled: Promise<any>[] = [];

    compact.checkExpired((promise) => scheduled.push(promise));
    await Promise.all(scheduled);

    expect(consolidator.state.calls).toEqual([["cli:test", AutoCompact.RECENT_SUFFIX_MESSAGES]]);
  });

  it("skips sessions that are already being archived", () => {
    const sessions = new SessionManager(tmpRoot());
    sessions.save(new Session({ key: "cli:test", updatedAt: "2000-01-01T00:00:00.000Z" }));
    const compact = new AutoCompact(sessions, fakeCompact(sessions), 15);
    compact.archiving.add("cli:test");
    const scheduled: Promise<any>[] = [];

    compact.checkExpired((promise) => scheduled.push(promise));

    expect(scheduled).toEqual([]);
  });

  it("skips active session keys during proactive checks", () => {
    const sessions = new SessionManager(tmpRoot());
    sessions.save(new Session({ key: "cli:test", updatedAt: "2000-01-01T00:00:00.000Z" }));
    const compact = new AutoCompact(sessions, fakeCompact(sessions), 15);
    const scheduled: Promise<any>[] = [];

    compact.checkExpired((promise) => scheduled.push(promise), ["cli:test"]);

    expect(scheduled).toEqual([]);
  });

  it("archives only expired inactive sessions from a mixed set", async () => {
    const sessions = new SessionManager(tmpRoot());
    const expiredIdle = new Session({ key: "cli:expired_idle", updatedAt: "2000-01-01T00:00:00.000Z" });
    const expiredActive = new Session({ key: "cli:expired_active", updatedAt: "2000-01-01T00:00:00.000Z" });
    const recent = new Session({ key: "cli:recent", updatedAt: new Date().toISOString() });
    addTurns(expiredIdle, 6, "a");
    addTurns(expiredActive, 6, "b");
    setUpdatedAt(expiredIdle, "2000-01-01T00:00:00.000Z");
    setUpdatedAt(expiredActive, "2000-01-01T00:00:00.000Z");
    recent.addMessage("user", "recent");
    sessions.save(expiredIdle);
    sessions.save(expiredActive);
    sessions.save(recent);
    const consolidator = fakeCompact(sessions);
    const compact = new AutoCompact(sessions, consolidator, 15);
    const scheduled: Promise<any>[] = [];

    compact.checkExpired((promise) => scheduled.push(promise), ["cli:expired_active"]);
    await Promise.all(scheduled);

    expect(consolidator.state.calls.map(([key]) => key)).toEqual(["cli:expired_idle"]);
    expect(sessions.getOrCreate("cli:expired_active").messages).toHaveLength(12);
    expect(sessions.getOrCreate("cli:recent").messages).toHaveLength(1);
  });

  it("stores hot summaries after archive", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test", updatedAt: "2026-05-28T11:00:00.000Z" });
    addTurns(session, 6, "hello");
    sessions.save(session);
    const compact = new AutoCompact(sessions, fakeCompact(sessions, { summary: "User said hello." }), 15);

    await compact.archiveExpiredSession("cli:test");

    expect(compact.summaries.get("cli:test")?.[0]).toBe("User said hello.");
  });

  it("does not store '(nothing)' summaries", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test", updatedAt: "2026-05-28T11:00:00.000Z" });
    addTurns(session, 6);
    sessions.save(session);
    const compact = new AutoCompact(sessions, fakeCompact(sessions, { summary: "(nothing)" }), 15);

    await compact.archiveExpiredSession("cli:test");

    expect(compact.summaries.has("cli:test")).toBe(false);
  });

  it("does not store summaries for empty sessions", async () => {
    const sessions = new SessionManager(tmpRoot());
    sessions.save(new Session({ key: "cli:test", updatedAt: "2000-01-01T00:00:00.000Z" }));
    const compact = new AutoCompact(sessions, fakeCompact(sessions), 15);

    await compact.archiveExpiredSession("cli:test");

    expect(compact.summaries.has("cli:test")).toBe(false);
  });

  it("refreshes empty session timestamps to avoid immediate reschedule", async () => {
    const sessions = new SessionManager(tmpRoot());
    sessions.save(new Session({ key: "cli:test", updatedAt: "2000-01-01T00:00:00.000Z" }));
    const consolidator = fakeCompact(sessions);
    const compact = new AutoCompact(sessions, consolidator, 15);
    const scheduled: Promise<any>[] = [];

    compact.checkExpired((promise) => scheduled.push(promise));
    await Promise.all(scheduled);
    compact.checkExpired((promise) => scheduled.push(promise));

    expect(consolidator.state.count).toBe(1);
  });

  it("does not reschedule after a successful archive refreshes updatedAt", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test", updatedAt: "2000-01-01T00:00:00.000Z" });
    addTurns(session, 5, "old");
    setUpdatedAt(session, "2000-01-01T00:00:00.000Z");
    sessions.save(session);
    const consolidator = fakeCompact(sessions);
    const compact = new AutoCompact(sessions, consolidator, 15);
    const scheduled: Promise<any>[] = [];

    compact.checkExpired((promise) => scheduled.push(promise));
    await Promise.all(scheduled);
    compact.checkExpired((promise) => scheduled.push(promise));

    expect(consolidator.state.count).toBe(1);
  });

  it("clears archiving state after archive errors", async () => {
    const compact = new AutoCompact(new SessionManager(tmpRoot()), fakeCompact(new SessionManager(tmpRoot()), { fail: true }), 15);
    compact.archiving.add("cli:test");

    await compact.archiveExpiredSession("cli:test");

    expect(compact.archiving.has("cli:test")).toBe(false);
  });

  it("allows future scheduling after an archive error", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test", updatedAt: "2000-01-01T00:00:00.000Z" });
    addTurns(session, 6);
    setUpdatedAt(session, "2000-01-01T00:00:00.000Z");
    sessions.save(session);
    const consolidator = fakeCompact(sessions, { fail: true });
    const compact = new AutoCompact(sessions, consolidator, 15);
    const scheduled: Promise<any>[] = [];

    compact.checkExpired((promise) => scheduled.push(promise));
    await Promise.all(scheduled);
    compact.checkExpired((promise) => scheduled.push(promise));

    expect(consolidator.state.count).toBe(2);
  });

  it("archives the prefix and keeps the recent legal suffix", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test" });
    addTurns(session, 6);
    sessions.save(session);
    const archived: Record<string, any>[] = [];
    const compact = new AutoCompact(sessions, fakeCompact(sessions, { archived }), 15);

    await compact.archiveExpiredSession("cli:test");

    expect(archived.map((message) => message.content)).toEqual(["msg user 0", "msg assistant 0", "msg user 1", "msg assistant 1"]);
    expect(sessions.getOrCreate("cli:test").messages).toHaveLength(AutoCompact.RECENT_SUFFIX_MESSAGES);
  });

  it("respects lastConsolidated when archiving idle sessions", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test" });
    addTurns(session, 14);
    session.lastConsolidated = 18;
    sessions.save(session);
    const archived: Record<string, any>[] = [];
    const compact = new AutoCompact(sessions, fakeCompact(sessions, { archived }), 15);

    await compact.archiveExpiredSession("cli:test");

    expect(archived).toHaveLength(2);
    expect(archived.map((message) => message.content)).toEqual(["msg user 9", "msg assistant 9"]);
  });

  it("keeps short sessions intact while refreshing them", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test" });
    session.addMessage("user", "previous message");
    sessions.save(session);
    const archived: Record<string, any>[] = [];
    const compact = new AutoCompact(sessions, fakeCompact(sessions, { archived }), 15);

    await compact.archiveExpiredSession("cli:test");

    expect(archived).toEqual([]);
    expect(sessions.getOrCreate("cli:test").messages.map((message) => message.content)).toEqual(["previous message"]);
  });

  it("prepares hot summaries once", () => {
    const sessions = new SessionManager(tmpRoot());
    const compact = new AutoCompact(sessions, null, 15);
    const session = new Session({ key: "cli:test" });
    compact.summaries.set("cli:test", ["Summary.", new Date("2026-05-28T11:00:00.000Z")]);

    expect(compact.prepareSession(session, "cli:test")[1]).toContain("Summary.");
    expect(compact.prepareSession(session, "cli:test")[1]).toBeNull();
  });

  it("recovers summaries from session metadata after restart", () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test", metadata: { lastSummary: { text: "Recovered.", lastActive: "2026-05-28T11:00:00.000Z" } } });
    const compact = new AutoCompact(sessions, null, 15);

    const [, summary] = compact.prepareSession(session, "cli:test");

    expect(summary).toContain("Recovered.");
    expect(summary).toContain("Previous conversation summary");
  });

  it("returns metadata summaries repeatedly for restart survival", () => {
    const session = new Session({ key: "cli:test", metadata: { lastSummary: { text: "Persisted.", lastActive: "2026-05-28T11:00:00.000Z" } } });
    const compact = new AutoCompact(new SessionManager(tmpRoot()), null, 15);

    expect(compact.prepareSession(session, "cli:test")[1]).toContain("Persisted.");
    expect(compact.prepareSession(session, "cli:test")[1]).toContain("Persisted.");
  });

  it("ignores malformed summary metadata", () => {
    const session = new Session({ key: "cli:test", metadata: { lastSummary: { text: "Bad.", lastActive: "bad-date" } } });
    const compact = new AutoCompact(new SessionManager(tmpRoot()), null, 15);

    expect(compact.prepareSession(session, "cli:test")[1]).toBeNull();
  });

  it("invalidates and reloads sessions while archive is in progress", () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test" });
    session.addMessage("user", "old");
    sessions.save(session);
    session.addMessage("user", "unsaved");
    const compact = new AutoCompact(sessions, null, 15);
    compact.archiving.add("cli:test");

    const [prepared] = compact.prepareSession(session, "cli:test");

    expect(prepared.messages.map((message) => message.content)).toEqual(["old"]);
  });

  it("invalidates and reloads expired sessions before use", () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test", updatedAt: "2000-01-01T00:00:00.000Z" });
    session.addMessage("user", "old");
    setUpdatedAt(session, "2000-01-01T00:00:00.000Z");
    sessions.save(session);
    session.addMessage("user", "unsaved");
    setUpdatedAt(session, "2000-01-01T00:00:00.000Z");
    const compact = new AutoCompact(sessions, null, 15);

    const [prepared] = compact.prepareSession(session, "cli:test");

    expect(prepared.messages.map((message) => message.content)).toEqual(["old"]);
  });

  it("formats summaries with last-active timestamps", () => {
    expect(AutoCompact.formatSummary("Summary.", new Date("2026-05-28T11:00:00.000Z"))).toContain("2026-05-28T11:00:00.000Z");
  });

  it("Session.clear removes persisted last summaries", () => {
    const session = new Session({ key: "cli:test", metadata: { lastSummary: { text: "Old", lastActive: "2026-05-28T11:00:00.000Z" } } });

    session.clear();

    expect(session.metadata.lastSummary).toBeUndefined();
  });

  it("can compact again after new messages arrive and become idle", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test" });
    addTurns(session, 5, "first");
    sessions.save(session);
    const consolidator = fakeCompact(sessions);
    const compact = new AutoCompact(sessions, consolidator, 15);

    await compact.archiveExpiredSession("cli:test");
    const afterFirst = sessions.getOrCreate("cli:test");
    addTurns(afterFirst, 4, "second");
    afterFirst.updatedAt = "2000-01-01T00:00:00.000Z";
    sessions.save(afterFirst);
    await compact.archiveExpiredSession("cli:test");

    expect(consolidator.state.count).toBe(2);
  });

  it("new summaries override old hot summaries", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test" });
    addTurns(session, 6, "first");
    sessions.save(session);
    const compact = new AutoCompact(sessions, fakeCompact(sessions, { summary: "First summary." }), 15);
    await compact.archiveExpiredSession("cli:test");
    expect(compact.prepareSession(sessions.getOrCreate("cli:test"), "cli:test")[1]).toContain("First summary.");

    const reloaded = sessions.getOrCreate("cli:test");
    addTurns(reloaded, 4, "second");
    reloaded.updatedAt = "2000-01-01T00:00:00.000Z";
    sessions.save(reloaded);
    compact.consolidator = fakeCompact(sessions, { summary: "Second summary." });
    await compact.archiveExpiredSession("cli:test");

    expect(compact.prepareSession(sessions.getOrCreate("cli:test"), "cli:test")[1]).toContain("Second summary.");
  });

  it("persists lastSummary in session metadata", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test", updatedAt: "2026-05-28T11:00:00.000Z" });
    addTurns(session, 6, "hello");
    sessions.save(session);
    const compact = new AutoCompact(sessions, fakeCompact(sessions, { summary: "User said hello." }), 15);

    await compact.archiveExpiredSession("cli:test");

    expect(sessions.getOrCreate("cli:test").metadata.lastSummary).toMatchObject({ text: "User said hello." });
  });

  it("keeps lastSummary metadata after prepareSession metadata path", () => {
    const session = new Session({ key: "cli:test", metadata: { lastSummary: { text: "Persisted.", lastActive: "2026-05-28T11:00:00.000Z" } } });
    const compact = new AutoCompact(new SessionManager(tmpRoot()), null, 15);

    compact.prepareSession(session, "cli:test");

    expect(session.metadata.lastSummary.text).toBe("Persisted.");
  });

  it("keeps lastSummary metadata after prepareSession hot path", () => {
    const session = new Session({ key: "cli:test", metadata: { lastSummary: { text: "Persisted.", lastActive: "2026-05-28T11:00:00.000Z" } } });
    const compact = new AutoCompact(new SessionManager(tmpRoot()), null, 15);
    compact.summaries.set("cli:test", ["Hot.", new Date("2026-05-28T11:00:00.000Z")]);

    compact.prepareSession(session, "cli:test");

    expect(session.metadata.lastSummary.text).toBe("Persisted.");
  });

  it("uses compactIdleSession for archiving", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test", updatedAt: "2026-05-28T11:00:00.000Z" });
    addTurns(session, 6);
    sessions.save(session);
    const state = { calls: 0 };
    const compact = new AutoCompact(sessions, {
      async compactIdleSession(key: string, maxSuffix: number) {
        state.calls += 1;
        const current = sessions.getOrCreate(key);
        current.metadata.lastSummary = { text: `summary ${maxSuffix}`, lastActive: "2026-05-28T11:00:00.000Z" };
        sessions.save(current);
        return `summary ${maxSuffix}`;
      },
    }, 15);

    await compact.archiveExpiredSession("cli:test");

    expect(state.calls).toBe(1);
    expect(compact.summaries.get("cli:test")?.[0]).toBe(`summary ${AutoCompact.RECENT_SUFFIX_MESSAGES}`);
  });

  it("does not archive already fresh sessions on checkExpired", () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:fresh", updatedAt: new Date().toISOString() });
    addTurns(session, 6);
    sessions.save(session);
    const compact = new AutoCompact(sessions, fakeCompact(sessions), 15);
    const scheduled: Promise<any>[] = [];

    compact.checkExpired((promise) => scheduled.push(promise));

    expect(scheduled).toEqual([]);
  });

  it("checkExpired schedules expired sessions", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test" });
    addTurns(session, 6);
    setUpdatedAt(session, "2000-01-01T00:00:00.000Z");
    sessions.save(session);
    const consolidator = fakeCompact(sessions);
    const compact = new AutoCompact(sessions, consolidator, 15);
    const scheduled: Promise<any>[] = [];

    compact.checkExpired((promise) => scheduled.push(promise));
    await Promise.all(scheduled);

    expect(consolidator.state.count).toBe(1);
  });

  it("prepareSession returns pending summaries", () => {
    const compact = new AutoCompact(new SessionManager(tmpRoot()), null, 15);
    const session = new Session({ key: "cli:test" });
    compact.summaries.set("cli:test", ["Alias summary.", new Date("2026-05-28T11:00:00.000Z")]);

    expect(compact.prepareSession(session, "cli:test")[1]).toContain("Alias summary.");
  });

  it("records no summary when compact returns null", async () => {
    const sessions = new SessionManager(tmpRoot());
    const session = new Session({ key: "cli:test", updatedAt: "2026-05-28T11:00:00.000Z" });
    addTurns(session, 6);
    sessions.save(session);
    const compact = new AutoCompact(sessions, { compactIdleSession: async () => null }, 15);

    await compact.archiveExpiredSession("cli:test");

    expect(compact.summaries.has("cli:test")).toBe(false);
  });
});
