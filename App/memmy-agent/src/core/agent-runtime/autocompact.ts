import { Session, SessionManager } from "../session/manager.js";

type Scheduler = (promise: Promise<any>) => void;

function parseDate(value?: string | Date | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export class AutoCompact {
  static RECENT_SUFFIX_MESSAGES = 8;
  recentSuffixMessages = AutoCompact.RECENT_SUFFIX_MESSAGES;
  sessions: SessionManager;
  consolidator: any;
  ttl: number;
  archiving = new Set<string>();
  summaries = new Map<string, [string, Date]>();

  constructor(sessions?: SessionManager, consolidator?: any, sessionTtlMinutes = 0) {
    this.sessions = sessions ?? new SessionManager(process.cwd());
    this.consolidator = consolidator;
    this.ttl = sessionTtlMinutes;
  }

  isExpired(ts?: string | Date | null, now: Date = new Date()): boolean {
    const date = parseDate(ts);
    if (this.ttl <= 0 || !date) return false;
    return now.getTime() - date.getTime() >= this.ttl * 60_000;
  }

  static formatSummary(text: string, lastActive: Date): string {
    return `Previous conversation summary (last active ${lastActive.toISOString()}):\n${text}`;
  }

  checkExpired(scheduleBackground: Scheduler, activeSessionKeys: Iterable<string> = []): void {
    const active = new Set(activeSessionKeys);
    const now = new Date();
    for (const info of this.sessions.listSessions()) {
      const key = String(info.key ?? "");
      if (!key || active.has(key) || this.archiving.has(key)) continue;
      if (this.isExpired(info.updatedAt, now)) {
        this.archiving.add(key);
        scheduleBackground(this.archiveExpiredSession(key));
      }
    }
  }

  async archiveExpiredSession(key: string): Promise<void> {
    try {
      const summary = await this.consolidator?.compactIdleSession?.(key, AutoCompact.RECENT_SUFFIX_MESSAGES);
      if (summary && summary !== "(nothing)") {
        const session = this.sessions.getOrCreate(key);
        const meta = session.metadata?.lastSummary;
        if (meta && typeof meta === "object" && meta.text && meta.lastActive) {
          const lastActive = parseDate(meta.lastActive);
          if (lastActive) this.summaries.set(key, [String(meta.text), lastActive]);
        }
      }
    } catch {
      // Auto-compact is opportunistic; failures should not break the agent loop.
    } finally {
      this.archiving.delete(key);
    }
  }

  prepareSession(session: Session, key: string): [Session, string | null] {
    if (this.archiving.has(key) || this.isExpired(session.updatedAt)) {
      this.sessions.invalidate?.(key);
      session = this.sessions.getOrCreate(key);
    }
    const hot = this.summaries.get(key);
    if (hot) {
      this.summaries.delete(key);
      return [session, AutoCompact.formatSummary(hot[0], hot[1])];
    }
    const meta = session.metadata?.lastSummary;
    if (meta && typeof meta === "object" && meta.text && meta.lastActive) {
      const lastActive = parseDate(meta.lastActive);
      if (lastActive) return [session, AutoCompact.formatSummary(String(meta.text), lastActive)];
    }
    return [session, null];
  }

  async maybeCompact(): Promise<boolean> {
    return false;
  }
}
