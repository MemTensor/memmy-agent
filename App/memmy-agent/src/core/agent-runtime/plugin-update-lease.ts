import type { AgentTaskActivity } from "./task-activity.js";
import type { TerminalRunControl } from "../session/terminal-session-control.js";

type Reservation = { token: string; ready: Promise<boolean>; release?: () => Promise<void>; ownerWatch?: NodeJS.Timeout };

/** Runtime-owned reservation: task admission stays closed until activation/rollback ends. */
export class PluginUpdateLease {
  private current: Reservation | null = null;
  private cancelled = new Set<string>();

  constructor(private activity: AgentTaskActivity, private terminal: TerminalRunControl | null) {}

  acquire(token: string, ownerPid = process.pid): Promise<boolean> {
    if (this.cancelled.has(token)) return Promise.resolve(false);
    if (this.current) return this.current.token === token ? this.current.ready : Promise.resolve(false);
    const unblock = this.activity.tryBlockTasks();
    if (!unblock) return Promise.resolve(false);
    const entry: Reservation = { token, ready: undefined as unknown as Promise<boolean> };
    this.current = entry;
    entry.ready = (async () => {
      let terminalRelease: (() => Promise<void>) | null = null;
      try {
        terminalRelease = await this.terminal?.tryBlockStarts() ?? null;
        if (this.terminal && (!terminalRelease || this.terminal.hasActiveRuns())) return false;
        entry.release = async () => {
          try { await terminalRelease?.(); } finally { unblock(); }
        };
        // Never expire a live activation merely because it takes a long time.
        // A crashed local backend can no longer switch versions; release its reservation.
        entry.ownerWatch = setInterval(() => {
          try { process.kill(ownerPid, 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") void this.release(token).catch(() => undefined);
          }
        }, 1_000);
        entry.ownerWatch.unref();
        return true;
      } finally {
        if (!entry.release) {
          try { await terminalRelease?.(); } finally { unblock(); this.current = null; }
        }
      }
    })();
    return entry.ready;
  }

  async release(token: string): Promise<void> {
    // Remember cancelled acquisitions, including an HTTP request whose response was lost.
    this.cancelled.add(token);
    if (this.cancelled.size > 1024) this.cancelled.delete(this.cancelled.values().next().value!);
    const entry = this.current;
    if (!entry || entry.token !== token) return;
    await entry.ready.catch(() => false);
    if (this.current !== entry) return;
    clearInterval(entry.ownerWatch);
    this.current = null;
    await entry.release?.();
  }

  async close(): Promise<void> { if (this.current) await this.release(this.current.token); }
}
