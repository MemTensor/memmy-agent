import fs from "node:fs";
import path from "node:path";
import type { EventCaptureSubscription } from "../computer-history/core/event-capture-source.js";
import { prepareBrowserHistoryEvent, type BrowserHistoryCaptureIntent,
  type BrowserHistoryTrustedContext } from "../computer-history/browser-semantic-history.js";

export interface TeachingBrowserBridge {
  subscribeTeachingBrowserHistory(listener: (payload: unknown, context: BrowserHistoryTrustedContext) => void): () => void;
  teachingBrowserCaptureIntent(): BrowserHistoryCaptureIntent;
  hasBrowserHistoryConnection(): boolean;
}

/** Optional, session-local browser evidence. It never writes into a History segment. */
export function createTeachingBrowserEnhancement(bridge: TeachingBrowserBridge) {
  return {
    async acquire(sessionId: string, directory: string): Promise<EventCaptureSubscription> {
      const file = path.join(directory, "browser-enhancement.jsonl");
      const fd = fs.openSync(file, "wx", 0o600);
      const seen = new Set<string>();
      let sequence = 0, closed = false, failed = false;
      let hadConnection = bridge.hasBrowserHistoryConnection(), disconnected = false;
      const unsubscribe = bridge.subscribeTeachingBrowserHistory((payload, context) => {
        if (closed || failed) return;
        const prepared = prepareBrowserHistoryEvent(payload, context, bridge.teachingBrowserCaptureIntent());
        if (!prepared || seen.has(prepared.deduplicationKey)) return;
        seen.add(prepared.deduplicationKey);
        if (seen.size > 4096) seen.delete(seen.values().next().value!);
        try {
          const line = Buffer.from(`${JSON.stringify({ ...prepared.event, sequence: ++sequence })}\n`);
          for (let written = 0; written < line.length;) {
            const count = fs.writeSync(fd, line, written, line.length - written);
            if (!count) throw new Error("browser_enhancement_write_failed");
            written += count;
          }
        } catch { failed = true; }
      });
      return {
        async checkpoint() {
          const connected = bridge.hasBrowserHistoryConnection();
          if (hadConnection && !connected) disconnected = true;
          if (connected) hadConnection = true;
          try { fs.fsyncSync(fd); } catch { failed = true; }
          const limitations = [
            ...(!connected ? ["Browser extension is not connected; browser steps rely on desktop accessibility."] : []),
            ...(disconnected ? ["Browser extension disconnected during teaching; some page details may be missing."] : []),
            ...(failed ? ["Browser enhancement could not be saved; desktop capture continues."] : []),
          ];
          return { streams: [{ id: `browser:${sessionId}`, file, size: fs.statSync(file).size }],
            running: true, complete: !failed && !disconnected, rangeEvaluated: true, limitations };
        },
        async release() {
          if (closed) return;
          closed = true; unsubscribe(); fs.closeSync(fd);
        },
      };
    },
  };
}
