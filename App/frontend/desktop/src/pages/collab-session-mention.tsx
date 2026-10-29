/**
 * The @ menu in a task input: the online project sessions a message can reference. Typing @ lists the most
 * recent sessions the person can reach; typing after it matches titles, questions and members.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CollabClient, CollabProjectSession } from "../api/collab-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { memberColor } from "./collab-member-color.js";

/** How many sessions the menu lists before the person types anything. */
export const MENTION_DEFAULT_LIMIT = 5;
/** How many it lists while narrowing by keyword. */
export const MENTION_SEARCH_LIMIT = 10;
const SEARCH_DEBOUNCE_MS = 140;

export interface MentionQuery {
  /** Index of the `@` in the input. */
  start: number;
  /** What was typed after it, which narrows the list. */
  query: string;
}

/**
 * The @ the caret sits in, if any. Only an `@` that opens a word counts, so an email address or a mid-word @
 * does not open the menu, and a space after it closes it.
 */
export function mentionQueryFromInput(input: string, caret: number): MentionQuery | null {
  const upToCaret = input.slice(0, Math.max(0, Math.min(caret, input.length)));
  const at = upToCaret.lastIndexOf("@");
  if (at < 0) return null;
  const before = at === 0 ? "" : upToCaret[at - 1]!;
  if (before && !/\s/u.test(before)) return null;
  const query = upToCaret.slice(at + 1);
  // Whitespace ends the mention: the person moved on to writing the question.
  if (/\s/u.test(query)) return null;
  return { start: at, query };
}

/**
 * Replaces the `@query` the caret sat in with the reference the agent reads. A trailing space keeps the person
 * typing after the reference instead of appending to it.
 */
export function applyMention(input: string, mention: MentionQuery, reference: string): string {
  const end = mention.start + 1 + mention.query.length;
  const head = input.slice(0, mention.start);
  const tail = input.slice(end).replace(/^\s+/u, "");
  const separator = tail ? " " : "";
  return `${head}${reference}${separator}${tail}`;
}

/**
 * Keeps the menu's candidates in step with what was typed. Without a query it shows the most recent few; with one
 * it asks the cloud to match keywords, which also reaches sessions other members shared.
 */
export function useCollabSessionCandidates(input: {
  client: CollabClient | null;
  mention: MentionQuery | null;
  /** The online project the task belongs to; without one there is nothing scoped to offer. */
  projectId: string | null;
}): CollabProjectSession[] {
  const [candidates, setCandidates] = useState<CollabProjectSession[]>([]);
  const query = input.mention?.query ?? "";
  const client = input.client;
  const projectId = input.projectId;
  const enabled = input.mention !== null && Boolean(projectId);
  const requestId = useRef(0);

  useEffect(() => {
    if (!client || !enabled || !projectId) {
      setCandidates([]);
      return;
    }
    const current = ++requestId.current;
    const timer = setTimeout(() => {
      const limit = query ? MENTION_SEARCH_LIMIT : MENTION_DEFAULT_LIMIT;
      void client.listCandidateSessions({ projectId, ...(query ? { query } : {}), limit })
        .then((sessions) => {
          // A slower earlier request must not overwrite a newer answer.
          if (current === requestId.current) setCandidates(sessions);
        })
        .catch(() => {
          if (current === requestId.current) setCandidates([]);
        });
    }, query ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [client, enabled, projectId, query]);

  return useMemo(() => (enabled ? candidates : []), [candidates, enabled]);
}

/**
 * What the menu says when it has no row to show. An empty project is not the same as a task outside every
 * project, and saying which one it is keeps an @ from looking like it did nothing.
 */
export function mentionEmptyLabelKey(
  input: { projectName: string | null }
): { key: "home.mention.empty"; values: { project: string } } | { key: "home.mention.noProject" } {
  return input.projectName === null
    ? { key: "home.mention.noProject" }
    : { key: "home.mention.empty", values: { project: input.projectName } };
}

/**
 * The second line of a row: who started the session, then what it was about. The project is left out because the
 * menu only ever offers sessions of the project the task already belongs to, so it would repeat on every row.
 */
export function mentionSessionLine(input: { memberName: string; lastQuestion: string }): string {
  return [input.memberName, input.lastQuestion].filter(Boolean).join(" · ");
}

/** The @ menu itself: one row per session, keyboard selection included. */
export function CollabSessionMentionMenu(props: {
  sessions: CollabProjectSession[];
  selectedIndex: number;
  heading: string;
  emptyLabel: string;
  onSelect: (session: CollabProjectSession) => void;
}) {
  const { t, language } = useTranslation();
  const dayFormat = new Intl.DateTimeFormat(language, { month: "short", day: "numeric" });
  const dayLabel = (value: string | null) => {
    if (!value) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : dayFormat.format(date);
  };
  return (
    <div className="w-full rounded-card border border-border-stone/40 bg-background-paper shadow-xl overflow-hidden">
      <div className="px-3 pt-3 pb-1 text-xs text-text-ink/50">{props.heading}</div>
      <div
        role="listbox"
        aria-label={props.heading}
        className="px-1.5 pb-1.5 overflow-y-auto"
        style={{ maxHeight: "min(340px, calc(100vh - 260px))" }}
      >
        {props.sessions.length === 0 ? (
          <p className="px-2.5 py-3 text-xs text-text-ink/45">{props.emptyLabel}</p>
        ) : props.sessions.map((session, index) => {
          const name = session.memberName || (session.mine ? t("collab.session.you") : "");
          const line = mentionSessionLine({ memberName: name, lastQuestion: session.lastQuestion });
          const selected = index === props.selectedIndex;
          return (
            <button
              key={session.id}
              type="button"
              role="option"
              aria-selected={selected}
              title={[session.title, line].filter(Boolean).join("\n")}
              onClick={() => props.onSelect(session)}
              className={`w-full rounded-btn px-2.5 py-2 text-left cursor-pointer transition-colors flex items-start gap-2.5 ${selected ? "bg-canvas-oat/80" : "hover:bg-canvas-oat/50"}`}
            >
              {/* Same mark as the project board's session list, so one member keeps one colour across the app. */}
              <span
                className="mt-[1px] grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full text-[11px] font-bold leading-none"
                style={{ background: memberColor(name), color: "#fff" }}
                aria-hidden="true"
              >
                {Array.from(name)[0] ?? "?"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-text-ink">{session.title}</span>
                {line ? (
                  <span className="mt-0.5 block truncate text-[11px] text-text-ink/45">{line}</span>
                ) : null}
              </span>
              <span className="mt-[1px] shrink-0 text-[11px] text-text-ink/40">{dayLabel(session.lastActiveAt)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
