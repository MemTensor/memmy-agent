import { useCallback, useEffect, useRef, useState } from "react";

export const THREAD_SEARCH_HIGHLIGHT = "memmy-thread-search";
export const THREAD_SEARCH_CURRENT_HIGHLIGHT = "memmy-thread-search-current";
export const THREAD_SEARCH_DEBOUNCE_MS = 150;
export const THREAD_SEARCH_SCROLL_OFFSET = 60;
// Every live Range is updated on each DOM mutation, so streaming stays fast only with a bounded set.
export const THREAD_SEARCH_MAX_HITS = 1000;

const SEARCH_ROOT_SELECTOR = "[data-agent-search-root]";
const SEARCH_SKIP_SELECTOR = "[data-chat-search-skip], .katex, svg, script, style, textarea, input, button";

export type ThreadSearchHit = {
  messageId: string | null;
  range: Range;
};

export type ThreadSearchState = {
  total: number;
  current: number;
  capped: boolean;
};

type HighlightRegistryLike = {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
};

type HighlightConstructor = new (...ranges: Range[]) => { priority: number };

export function findThreadSearchOffsets(text: string, query: string): Array<[number, number]> {
  const needle = query.trim();
  if (!needle || !text) return [];
  const pattern = new RegExp(escapeRegExp(needle), "giu");
  const offsets: Array<[number, number]> = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (match[0].length > 0) offsets.push([start, start + match[0].length]);
  }
  return offsets;
}

export function collectThreadSearchHits(
  root: ParentNode | null,
  query: string,
  limit = THREAD_SEARCH_MAX_HITS,
): ThreadSearchHit[] {
  if (!root || !query.trim() || typeof document === "undefined") return [];
  const hits: ThreadSearchHit[] = [];
  for (const container of root.querySelectorAll<HTMLElement>(SEARCH_ROOT_SELECTOR)) {
    if (hits.length >= limit) break;
    const messageId = container.closest<HTMLElement>("[data-agent-message-id]")?.dataset.agentMessageId ?? null;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
        return parent.closest(SEARCH_SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(); node && hits.length < limit; node = walker.nextNode()) {
      for (const [start, end] of findThreadSearchOffsets(node.nodeValue ?? "", query)) {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        hits.push({ messageId, range });
        if (hits.length >= limit) break;
      }
    }
  }
  return hits;
}

export function paintThreadSearchHits(hits: ThreadSearchHit[], current: number): void {
  const api = highlightApi();
  if (!api) return;
  if (!hits.length) {
    clearThreadSearchPaint();
    return;
  }
  api.registry.set(THREAD_SEARCH_HIGHLIGHT, new api.Highlight(...hits.map((hit) => hit.range)));
  const currentHit = hits[current];
  if (currentHit) {
    const highlight = new api.Highlight(currentHit.range);
    highlight.priority = 1;
    api.registry.set(THREAD_SEARCH_CURRENT_HIGHLIGHT, highlight);
  } else {
    api.registry.delete(THREAD_SEARCH_CURRENT_HIGHLIGHT);
  }
}

export function clearThreadSearchPaint(): void {
  const api = highlightApi();
  api?.registry.delete(THREAD_SEARCH_HIGHLIGHT);
  api?.registry.delete(THREAD_SEARCH_CURRENT_HIGHLIGHT);
}

export function scrollThreadSearchHitIntoView(hit: ThreadSearchHit, scroller: HTMLElement | null): void {
  const target = hit.range.startContainer.parentElement;
  if (!scroller) {
    target?.scrollIntoView({ block: "center" });
    return;
  }
  const rect = hit.range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    target?.scrollIntoView({ block: "center" });
    return;
  }
  const box = scroller.getBoundingClientRect();
  scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + rect.top - box.top - THREAD_SEARCH_SCROLL_OFFSET), behavior: "auto" });
}

export function useThreadSearch(options: {
  open: boolean;
  query: string;
  getRoot: () => HTMLElement | null;
  contentVersion: unknown;
  onNavigate?: () => void;
}): ThreadSearchState & { next: () => void; previous: () => void } {
  const { open, query, getRoot, contentVersion } = options;
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [state, setState] = useState<ThreadSearchState>({ total: 0, current: -1, capped: false });
  const hitsRef = useRef<ThreadSearchHit[]>([]);
  const currentRef = useRef(-1);
  const onNavigateRef = useRef(options.onNavigate);
  onNavigateRef.current = options.onNavigate;

  const apply = useCallback((current: number, scroll: boolean) => {
    const hits = hitsRef.current;
    const normalized = hits.length ? Math.min(Math.max(current, 0), hits.length - 1) : -1;
    currentRef.current = normalized;
    paintThreadSearchHits(hits, normalized);
    const capped = hits.length >= THREAD_SEARCH_MAX_HITS;
    setState((previous) => (
      previous.total === hits.length && previous.current === normalized && previous.capped === capped
        ? previous
        : { total: hits.length, current: normalized, capped }
    ));
    const hit = hits[normalized];
    if (!scroll || !hit) return;
    onNavigateRef.current?.();
    scrollThreadSearchHitIntoView(hit, getRoot());
  }, [getRoot]);

  const recollect = useCallback((targetQuery: string, current: number, scroll: boolean) => {
    hitsRef.current = collectThreadSearchHits(getRoot(), targetQuery);
    apply(current, scroll);
  }, [apply, getRoot]);

  useEffect(() => {
    if (!open) {
      setDebouncedQuery("");
      return;
    }
    const timer = window.setTimeout(() => setDebouncedQuery(query), THREAD_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  useEffect(() => {
    if (!open || !debouncedQuery.trim()) {
      hitsRef.current = [];
      currentRef.current = -1;
      clearThreadSearchPaint();
      setState({ total: 0, current: -1, capped: false });
      return;
    }
    recollect(debouncedQuery, 0, true);
  }, [debouncedQuery, open, recollect]);

  useEffect(() => {
    if (!open || !debouncedQuery.trim()) return;
    recollect(debouncedQuery, currentRef.current, false);
  }, [contentVersion, debouncedQuery, open, recollect]);

  useEffect(() => {
    const root = getRoot();
    if (!open || !debouncedQuery.trim() || !root || typeof MutationObserver === "undefined") return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        recollect(debouncedQuery, currentRef.current, false);
      });
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [debouncedQuery, getRoot, open, recollect]);

  useEffect(() => () => clearThreadSearchPaint(), []);

  const move = useCallback((direction: 1 | -1) => {
    const total = hitsRef.current.length;
    if (!total) return;
    const base = currentRef.current < 0 ? 0 : currentRef.current;
    apply((base + direction + total) % total, true);
  }, [apply]);

  return {
    ...state,
    next: useCallback(() => move(1), [move]),
    previous: useCallback(() => move(-1), [move]),
  };
}

function highlightApi(): { registry: HighlightRegistryLike; Highlight: HighlightConstructor } | null {
  if (typeof CSS === "undefined" || typeof globalThis === "undefined") return null;
  const registry = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  const Highlight = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
  return registry && typeof Highlight === "function" ? { registry, Highlight } : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
