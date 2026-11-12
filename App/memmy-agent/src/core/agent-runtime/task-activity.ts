/** Whole-turn activity, including model thinking and waits between tool calls. */
export class AgentTaskActivity {
  private active = 0;

  get busy(): boolean { return this.active > 0; }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.active++;
    try { return await operation(); }
    finally { this.active--; }
  }
}

// The gateway, AgentLoop and subagent manager run in the same runtime process.
export const agentTaskActivity = new AgentTaskActivity();
