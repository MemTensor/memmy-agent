import {
  GoalRuntime,
  GoalRuntimeError,
} from "../goal-runtime.js";
import { publicGoalState } from "../../session/goal-state.js";
import { parseTurnSource } from "../../runtime-messages/events.js";
import { Tool } from "./base.js";
import { RequestContext } from "./context.js";

function formatGoal(value: ReturnType<GoalRuntime["get"]>): string {
  return JSON.stringify(publicGoalState(value), null, 2);
}

function errorResult(error: unknown): string {
  if (error instanceof GoalRuntimeError) return `Error: ${error.code}`;
  const message = error instanceof Error ? error.message : String(error);
  return `Error: ${message || "goal_runtime_failed"}`;
}

abstract class GoalTool extends Tool {
  static scopes = new Set(["core"]);
  protected readonly goalRuntime: GoalRuntime;
  protected requestContext: RequestContext | null = null;

  constructor(goalRuntime: GoalRuntime) {
    super();
    this.goalRuntime = goalRuntime;
  }

  static enabled(ctx: { goalRuntime?: GoalRuntime }): boolean {
    return ctx.goalRuntime instanceof GoalRuntime;
  }

  setContext(context: RequestContext): void {
    this.requestContext = context;
  }

  protected sessionKey(): string {
    const sessionKey = this.requestContext?.sessionKey;
    if (!sessionKey) throw new GoalRuntimeError("goal_session_unavailable");
    return sessionKey;
  }
}

export class CreateGoalTool extends GoalTool {
  static create(ctx: { goalRuntime: GoalRuntime }): Tool {
    return new CreateGoalTool(ctx.goalRuntime);
  }

  get name(): string {
    return "create_goal";
  }

  get description(): string {
    return (
      "Create a persistent Goal only when the user or system explicitly requests one. "
      + "Do not infer Goal mode from task length. The objective must be self-contained. "
      + "Set token_budget only when the user explicitly supplied a token budget."
    );
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        objective: { type: "string", maxLength: 12_000 },
        token_budget: { type: "integer", minimum: 1 },
      },
      required: ["objective"],
      additionalProperties: false,
    };
  }

  async execute(params: { objective?: string; token_budget?: number } = {}): Promise<string> {
    try {
      const context = this.requestContext;
      const channel = String(context?.channel ?? "").trim();
      const chatId = String(context?.chatId ?? "").trim();
      const turnId = String(context?.metadata?.turn_id ?? "").trim();
      const source = parseTurnSource(context?.metadata?.turn_source);
      if (!channel || !chatId || !turnId) throw new GoalRuntimeError("goal_route_unavailable");
      const goal = await this.goalRuntime.create({
        sessionKey: this.sessionKey(),
        objective: params.objective ?? "",
        ...(params.token_budget === undefined ? {} : { tokenBudget: params.token_budget }),
        route: { channel, chatId, ...(source ? { source } : {}) },
        turnId,
      });
      return `Goal created.\n${formatGoal(goal)}`;
    } catch (error) {
      return errorResult(error);
    }
  }
}

export class GetGoalTool extends GoalTool {
  static create(ctx: { goalRuntime: GoalRuntime }): Tool {
    return new GetGoalTool(ctx.goalRuntime);
  }

  get name(): string {
    return "get_goal";
  }

  get description(): string {
    return "Return the current persistent Goal status, budget, usage, and elapsed time.";
  }

  get parameters() {
    return { type: "object", properties: {}, additionalProperties: false };
  }

  async execute(): Promise<string> {
    try {
      return `Goal status.\n${formatGoal(this.goalRuntime.get(this.sessionKey()))}`;
    } catch (error) {
      return errorResult(error);
    }
  }
}

export class UpdateGoalTool extends GoalTool {
  static create(ctx: { goalRuntime: GoalRuntime }): Tool {
    return new UpdateGoalTool(ctx.goalRuntime);
  }

  get name(): string {
    return "update_goal";
  }

  get description(): string {
    return (
      "Update the current Goal to completed only after every objective requirement is actually achieved "
      + "and verified. Use blocked only after the same blocking condition has persisted for at least three "
      + "consecutive Goal turns and no meaningful progress is possible without external change. "
      + "This tool cannot pause, resume, cancel, replace, or redirect a Goal."
    );
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "blocked"] },
      },
      required: ["status"],
      additionalProperties: false,
    };
  }

  async execute(params: { status?: "completed" | "blocked" } = {}): Promise<string> {
    try {
      if (params.status !== "completed" && params.status !== "blocked") {
        throw new GoalRuntimeError("invalid_transition");
      }
      const sessionKey = this.sessionKey();
      const current = this.goalRuntime.get(sessionKey);
      if (!current) throw new GoalRuntimeError("goal_not_found");
      const goal = await this.goalRuntime.updateFromModel(sessionKey, current.goalId, params.status);
      return `Goal updated.\n${formatGoal(goal)}`;
    } catch (error) {
      return errorResult(error);
    }
  }
}
