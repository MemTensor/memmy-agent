import { AgentHook } from "../core/agent-runtime/hook.js";
import type { DagTurnInput } from "./types.js";
import type { SessionDagQueueManager } from "./queue.js";

export class SessionDagHook extends AgentHook {
  constructor(private readonly queue: SessionDagQueueManager | null) {
    super(false);
  }

  enqueueSavedTurn(sessionKey: string, turn: DagTurnInput): void {
    this.queue?.enqueueSavedTurn(sessionKey, turn);
  }
}
