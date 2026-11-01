/** Orders local sessions for the association picker. */
import type { LocalSession } from "./local-session-reader.js";

/** What the person is doing when they ask for candidates. */
export interface LocalSessionRankContext {
  /** Keyword typed in the picker; empty when they just want recent sessions. */
  query: string;
  /** Directory whose sessions rank first, when the caller has one. */
  cwd: string | null;
}

/**
 * Returns the sessions to offer, best first. The caller keeps only the first few,
 * so whatever ranks low here is effectively invisible.
 */
export function rankLocalSessions(sessions: readonly LocalSession[], context: LocalSessionRankContext): LocalSession[] {
  // Most keywords matched first, then the asking conversation's directory, then the most recent.
  // Matching any single keyword keeps a long pasted title from returning nothing at all.
  return sessions
    .map((session) => ({ session, score: matchScore(session, context.query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      Number(isSameWorkspace(right.session, context.cwd)) - Number(isSameWorkspace(left.session, context.cwd)) ||
      lastActivityMs(right.session) - lastActivityMs(left.session))
    .map((entry) => entry.session);
}

/**
 * How many whitespace-separated keywords appear in the title, a question or the agent name.
 * An empty query keeps everything, so the caller can list recents.
 */
export function matchScore(session: LocalSession, query: string): number {
  const keywords = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (!keywords.length) {
    return 1;
  }
  const haystack = [session.title, session.agentName, ...session.turns.map((turn) => turn.question)]
    .join("\n")
    .toLowerCase();
  return keywords.filter((keyword) => haystack.includes(keyword)).length;
}

/** True when at least one keyword matches. */
export function matchesQuery(session: LocalSession, query: string): boolean {
  return matchScore(session, query) > 0;
}

/** True when the session ran in the same directory as the asking conversation, or inside it. */
export function isSameWorkspace(session: LocalSession, cwd: string | null): boolean {
  if (!cwd || !session.workspacePath) {
    return false;
  }
  const base = cwd.replace(/\/+$/u, "");
  return session.workspacePath === base || session.workspacePath.startsWith(`${base}/`);
}

/** Last activity as epoch milliseconds; unknown times sort last. */
export function lastActivityMs(session: LocalSession): number {
  const parsed = Date.parse(session.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}
