import { useEffect, useState, type RefObject } from "react";
import type { AgentChatMessage } from "../state/agent-chat-slice.js";

/** How long the thread may go without new output before its last line shimmers. */
export const AGENT_STALL_SHIMMER_DELAY_MS = 3000;

export const AGENT_STALL_SHIMMER_CLASS = "agent-stall-shimmer";

/**
 * Every element that reads as a line (or a block of lines) of Agent output.
 * A folded panel contributes only its header: its body is either not
 * rendered or sits in a closed `<details>`, which `isLineVisible` rejects,
 * so the header row becomes the last line.
 */
const OUTPUT_LINE_SELECTOR = [
  ".agent-message-content__p",
  ".agent-message-content li",
  ".agent-message-content h1",
  ".agent-message-content h2",
  ".agent-message-content h3",
  ".agent-message-content h4",
  ".agent-message-content h5",
  ".agent-message-content h6",
  ".agent-message-content__pre",
  ".agent-message-content__th",
  ".agent-message-content__td",
  ".agent-activity-cluster__toggle > span",
  ".agent-reasoning-panel__toggle > span",
  ".agent-narration-block__label",
  ".agent-narration-block__preview",
  ".agent-activity-segment__label",
  ".agent-activity-timeline-item__line",
  ".agent-activity-timeline-item__error",
  ".agent-thinking-placeholder > span:last-child",
  ".agent-retry-wait-line__label",
  ".agent-context-compaction-divider__label"
].join(", ");

const EXCLUDED_SELECTOR = ".agent-user-turn, .sr-only, .agent-message-copy-cluster, .plugin-capability-region";

/** Lines that already animate while their own process runs. */
const SELF_ANIMATED_SELECTOR = ".agent-retry-wait-line--running, .agent-context-compaction-divider--running";

/**
 * Changes whenever the Agent produces something the user can read: answer
 * text, reasoning, or a new tool or file row. Equal signatures mean nothing
 * new appeared.
 */
export function agentOutputSignature(messages: readonly AgentChatMessage[]): string {
  let size = 0;
  for (const message of messages) {
    size += message.content.length
      + (message.reasoning?.length ?? 0)
      + (message.toolEvents?.length ?? 0)
      + (message.fileEdits?.length ?? 0)
      + (message.traces?.length ?? 0);
  }
  return `${messages.length}:${size}`;
}

/**
 * The bottom line of the current turn as the user sees it, or null when the
 * turn has shown nothing yet.
 */
export function findLastOutputLine(container: HTMLElement): HTMLElement | null {
  const userTurns = container.querySelectorAll(".agent-user-turn");
  const lastUserTurn = userTurns[userTurns.length - 1] ?? null;
  const candidates = container.querySelectorAll<HTMLElement>(OUTPUT_LINE_SELECTOR);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]!;
    // Anything above the latest question belongs to an earlier answer.
    if (lastUserTurn && !(lastUserTurn.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING)) return null;
    if (isLineVisible(candidate)) return candidate;
  }
  return null;
}

function isLineVisible(element: HTMLElement): boolean {
  if (!element.textContent?.trim() || element.closest(EXCLUDED_SELECTOR)) return false;
  for (let details = element.closest("details"); details; details = details.parentElement?.closest("details") ?? null) {
    if (!details.open && !isInOwnSummary(element, details)) return false;
  }
  return typeof element.checkVisibility !== "function" || element.checkVisibility();
}

function isInOwnSummary(element: HTMLElement, details: HTMLDetailsElement): boolean {
  for (let summary = element.closest("summary"); summary; summary = summary.parentElement?.closest("summary") ?? null) {
    if (summary.parentElement === details) return true;
  }
  return false;
}

/** Where the last rendered line sits inside the element's background area. */
interface LineBox {
  top: number;
  left: number;
  right: number;
  height: number;
}

function measureLastLine(element: HTMLElement): LineBox | null {
  const style = window.getComputedStyle(element);
  if (style.display === "inline") {
    // An inline element paints one background across its line fragments laid
    // end to end, so its last line is the tail of that strip.
    const fragments = Array.from(element.getClientRects()).filter((rect) => rect.width > 0);
    const last = fragments[fragments.length - 1];
    if (!last) return null;
    const strip = fragments.reduce((total, rect) => total + rect.width, 0);
    return { top: 0, left: strip - last.width, right: strip, height: last.height };
  }
  const range = document.createRange();
  range.selectNodeContents(element);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  range.detach();
  if (!rects.length) return null;
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  const lastLine = rects.filter((rect) => rect.bottom > bottom - rect.height / 2);
  const box = element.getBoundingClientRect();
  const originX = box.left + element.clientLeft;
  const originY = box.top + element.clientTop;
  const top = Math.min(...lastLine.map((rect) => rect.top));
  return {
    top: top - originY,
    left: Math.max(0, Math.min(...lastLine.map((rect) => rect.left)) - originX),
    // Truncated rows report their full text width; the band stops at the edge.
    right: Math.min(element.clientWidth || Infinity, Math.max(...lastLine.map((rect) => rect.right)) - originX),
    height: bottom - top
  };
}

function markLine(element: HTMLElement): void {
  if (element.closest(SELF_ANIMATED_SELECTOR)) return;
  const line = measureLastLine(element);
  if (!line || line.right <= line.left) return;
  const band = Math.round(Math.min(180, Math.max(48, (line.right - line.left) * 0.5)));
  const sweepDistance = line.right - line.left + band;
  const SWEEP_SPEED_PX_PER_SEC = 300;
  const PAUSE_SEC = 0.8;
  const sweepDuration = sweepDistance / SWEEP_SPEED_PX_PER_SEC;
  const totalDuration = sweepDuration + PAUSE_SEC;
  const sweepFraction = sweepDuration / totalDuration;
  const timing = `linear(0, 1 ${(sweepFraction * 100).toFixed(1)}%, 1)`;
  const properties: Record<string, string> = {
    "--agent-stall-ink": window.getComputedStyle(element).color,
    "--agent-stall-band": `${band}px`,
    "--agent-stall-y": `${Math.floor(line.top)}px`,
    "--agent-stall-height": `${Math.ceil(line.height)}px`,
    "--agent-stall-from": `${Math.floor(line.left - band)}px`,
    "--agent-stall-to": `${Math.ceil(line.right)}px`
  };
  for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value);
  element.style.animation = `agent-stall-sweep ${totalDuration.toFixed(2)}s ${timing} infinite`;
  element.classList.add(AGENT_STALL_SHIMMER_CLASS);
}

function unmarkLine(element: HTMLElement): void {
  element.classList.remove(AGENT_STALL_SHIMMER_CLASS);
  element.style.animation = "";
  for (const name of ["--agent-stall-ink", "--agent-stall-band", "--agent-stall-y", "--agent-stall-height", "--agent-stall-from", "--agent-stall-to"]) {
    element.style.removeProperty(name);
  }
}

/**
 * Sweeps a highlight across the thread's bottom line once the Agent has gone
 * `AGENT_STALL_SHIMMER_DELAY_MS` without new output, so a long tool call or
 * a slow model reads as "still working" rather than "stuck". New output
 * clears it and restarts the wait.
 *
 * The line is found in the DOM rather than from the messages because what
 * counts as the last line depends on which panels the user has folded.
 */
export function useStalledOutputShimmer(containerRef: RefObject<HTMLElement | null>, active: boolean, signature: string): void {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    setStalled(false);
    if (!active) return undefined;
    const timer = window.setTimeout(() => setStalled(true), AGENT_STALL_SHIMMER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [active, signature]);

  useEffect(() => {
    const container = containerRef.current;
    if (!stalled || !container) return undefined;
    let marked: HTMLElement | null = null;
    // Opening or folding a panel changes which line is last, and a React
    // re-render can rewrite the marked element's class; both land here.
    const sync = (remeasure = false) => {
      const next = findLastOutputLine(container);
      if (!remeasure && next === marked && (!next || next.classList.contains(AGENT_STALL_SHIMMER_CLASS))) return;
      if (marked) unmarkLine(marked);
      marked = next;
      if (marked) markLine(marked);
    };
    sync();
    const mutations = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => sync());
    mutations?.observe(container, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["open", "class"] });
    // A narrower column rewraps the text, moving the last line.
    const resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => sync(true));
    resizes?.observe(container);
    return () => {
      mutations?.disconnect();
      resizes?.disconnect();
      if (marked) unmarkLine(marked);
    };
  }, [containerRef, stalled]);
}
