import { OutboundMessage } from "../../runtime-messages/events.js";
import {
  GOAL_STATE_KEY,
  goalStateRaw,
  goalStateWsBlob,
  parseGoalState,
} from "../../session/goal-state.js";
import { Tool } from "./base.js";
import { RequestContext } from "./context.js";

function isoNow(): string {
  return new Date().toISOString();
}

class GoalToolsMixin {
  protected sessions: any;
  protected bus: any;
  protected requestCtx: RequestContext | null = null;

  constructor({ sessions, bus = null }: { sessions?: any; bus?: any } = {}) {
    this.sessions = sessions;
    this.bus = bus;
  }

  setContext(ctx: RequestContext): void {
    this.requestCtx = ctx;
  }

  protected session(): any | null {
    const key = this.requestCtx?.sessionKey;
    if (!key || !this.sessions) return null;
    return this.sessions.getOrCreate?.(key) ?? null;
  }

  protected save(session: any): void {
    this.sessions?.save?.(session);
  }

  protected async publishGoalStateWs(metadata: Record<string, any>): Promise<void> {
    const ctx = this.requestCtx;
    if (!this.bus || !ctx || ctx.channel !== "websocket") return;
    const chatId = String(ctx.chatId ?? "").trim();
    if (!chatId) return;
    const message = new OutboundMessage({
      channel: "websocket",
      chatId,
      content: "",
      metadata: { goalStateSync: true, goalState: goalStateWsBlob(metadata) },
    });
    if (typeof this.bus.publishOutbound === "function") await this.bus.publishOutbound(message);
  }

}

export class LongTaskTool extends Tool {
  static scopes = new Set(["core"]);
  private mixin: GoalToolsMixin;
  metadata: Record<string, any>;

  constructor({ sessions, bus = null, metadata = {} }: { sessions?: any; bus?: any; metadata?: Record<string, any> } = {}) {
    super();
    this.mixin = new GoalToolsMixin({ sessions, bus });
    this.metadata = metadata;
  }

  static enabled(ctx: any): boolean {
    return Boolean(ctx?.sessions);
  }

  static create(ctx: any): Tool {
    return new LongTaskTool({ sessions: ctx?.sessions, bus: ctx?.bus });
  }

  setContext(ctx: RequestContext): void {
    this.mixin.setContext(ctx);
  }

  get name(): string {
    return "long_task";
  }

  get description(): string {
    return (
      "Mark this thread as a sustained long-running task. The active goal is mirrored in Runtime Context each turn. " +
      "Use normal tools until done, then call complete_goal when the objective is satisfied, cancelled, or replaced."
    );
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        goal: { type: "string", maxLength: 12_000 },
        objective: { type: "string", maxLength: 12_000 },
        uiSummary: { type: ["string", "null"], maxLength: 120 },
      },
    };
  }

  async execute(params: { goal?: string; objective?: string; uiSummary?: string | null; status?: string } = {}): Promise<string> {
    const goal = String(params.goal ?? params.objective ?? "").trim();
    if (!goal) return "Error: long_task requires a non-empty goal.";
    const session = (this.mixin as any).session();
    if (!session) return "Error: long_task requires an active chat session (missing routing context).";
    const prior = parseGoalState(goalStateRaw(session.metadata));
    if (prior?.status === "active") {
      return "Error: a sustained goal is already active. Use complete_goal when finished, or ask the user before replacing it.";
    }
    const summary = String(params.uiSummary ?? "").trim().slice(0, 120);
    session.metadata[GOAL_STATE_KEY] = {
      status: "active",
      objective: goal,
      uiSummary: summary,
      startedAt: isoNow(),
    };
    (this.mixin as any).save(session);
    await (this.mixin as any).publishGoalStateWs(session.metadata);
    const extra = summary ? `\nSummary line: ${summary}` : "";
    return (
      "Goal recorded. Keep working toward the objective using ordinary tools. " +
      "When fully done (verified against what was asked), call complete_goal with a short recap." +
      extra
    );
  }
}

export class CompleteGoalTool extends Tool {
  static scopes = new Set(["core"]);
  private mixin: GoalToolsMixin;

  constructor({ sessions, bus = null }: { sessions?: any; bus?: any } = {}) {
    super();
    this.mixin = new GoalToolsMixin({ sessions, bus });
  }

  static enabled(ctx: any): boolean {
    return Boolean(ctx?.sessions);
  }

  static create(ctx: any): Tool {
    return new CompleteGoalTool({ sessions: ctx?.sessions, bus: ctx?.bus });
  }

  setContext(ctx: RequestContext): void {
    this.mixin.setContext(ctx);
  }

  get name(): string {
    return "complete_goal";
  }

  get description(): string {
    return "End bookkeeping for the active sustained goal after it is achieved, cancelled, redirected, or replaced.";
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        recap: { type: ["string", "null"], maxLength: 8000 },
      },
    };
  }

  async execute(params: { recap?: string | null } = {}): Promise<string> {
    const session = (this.mixin as any).session();
    if (!session) return "Error: complete_goal requires an active chat session.";
    const prior = parseGoalState(goalStateRaw(session.metadata));
    if (prior?.status !== "active") return "No active goal to complete.";
    const ended = isoNow();
    const recap = String(params.recap ?? "").trim();
    session.metadata[GOAL_STATE_KEY] = {
      ...prior,
      status: "completed",
      completedAt: ended,
      recap,
    };
    (this.mixin as any).save(session);
    await (this.mixin as any).publishGoalStateWs(session.metadata);
    return recap ? `Goal marked complete (${ended}). Recap:\n${recap}` : `Goal marked complete (${ended}).`;
  }
}
