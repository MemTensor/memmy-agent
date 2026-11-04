/** Whole-turn activity, including model thinking and waits between tool calls. */
export class AgentTaskActivity {
  private active = 0;
  private update: { done: Promise<void>; release: () => void } | null = null;

  get busy(): boolean { return this.active > 0; }

  /** Admission and reservation are synchronous in the runtime's event loop. */
  tryBlockTasks(): (() => void) | null {
    if (this.busy || this.update) return null;
    let resolve!: () => void;
    const done = new Promise<void>(release => { resolve = release; });
    const update = { done, release: resolve };
    this.update = update;
    return () => {
      if (this.update !== update) return;
      this.update = null;
      update.release();
    };
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
    while (this.update) {
      const done = this.update.done;
      await new Promise<void>((resolve, reject) => {
        const aborted = () => {
          const error = new Error("task cancelled"); error.name = "TaskCancelledError";
          signal?.removeEventListener("abort", aborted); reject(error);
        };
        if (signal?.aborted) { aborted(); return; }
        signal?.addEventListener("abort", aborted, { once: true });
        void done.then(() => { signal?.removeEventListener("abort", aborted); resolve(); });
      });
      if (signal?.aborted) {
        const error = new Error("task cancelled"); error.name = "TaskCancelledError"; throw error;
      }
    }
    this.active++;
    try { return await operation(); }
    finally { this.active--; }
  }
}

// The gateway, AgentLoop and subagent manager run in the same runtime process.
export const agentTaskActivity = new AgentTaskActivity();
