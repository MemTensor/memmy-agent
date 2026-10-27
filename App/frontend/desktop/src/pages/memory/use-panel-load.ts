import { useEffect, useRef } from "react";

/** Search alone waits; initial entry, filters and page navigation run immediately. */
export function usePanelLoad<T>(input: {
  query: string;
  identity: readonly unknown[];
  load: () => Promise<T>;
  invalidate: () => void;
}): (load?: () => Promise<T>, nextIdentity?: readonly unknown[]) => Promise<T> {
  const latest = useRef(input);
  latest.current = input;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previous = useRef<{ query: string; identity: readonly unknown[] } | undefined>(undefined);
  const submitted = useRef<{ query: string; identity: readonly unknown[] } | undefined>(undefined);
  const sameIdentity = (a: readonly unknown[], b: readonly unknown[]) =>
    a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

  function submit(load = latest.current.load, nextIdentity = latest.current.identity): Promise<T> {
    clearTimeout(timer.current);
    timer.current = undefined;
    const old = previous.current;
    submitted.current =
      !old || old.query !== latest.current.query || !sameIdentity(old.identity, nextIdentity)
        ? { query: latest.current.query, identity: nextIdentity }
        : undefined;
    return load();
  }

  useEffect(() => {
    const current = latest.current;
    const old = previous.current;
    previous.current = { query: current.query, identity: current.identity };
    const alreadySubmitted =
      submitted.current &&
      submitted.current.query === current.query &&
      sameIdentity(submitted.current.identity, current.identity);
    submitted.current = undefined;
    const searchChanged = old && old.query !== current.query;
    const run = () => {
      timer.current = undefined;
      void latest.current.load().catch(() => undefined);
    };
    if (!alreadySubmitted) {
      if (searchChanged) timer.current = setTimeout(run, 180);
      else run();
    }
    return () => {
      clearTimeout(timer.current);
      timer.current = undefined;
      if (!submitted.current) latest.current.invalidate();
    };
    // Identity is deliberately supplied by callers: client, page, filters and language.
  }, [input.query, ...input.identity]);

  useEffect(() => () => latest.current.invalidate(), []);

  return submit;
}
