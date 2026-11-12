import {
  TaskPlanRuntime,
  TaskPlanRuntimeError,
  type TaskPlanItemInput,
} from "../task-plan-runtime.js";
import {
  publicTaskPlanState,
  type TaskPlanItemStatus,
} from "../../session/task-plan-state.js";
import { Tool } from "./base.js";
import { RequestContext } from "./context.js";

function formatTaskPlan(value: ReturnType<TaskPlanRuntime["get"]>): string {
  return JSON.stringify(publicTaskPlanState(value), null, 2);
}

function errorResult(error: unknown): string {
  if (error instanceof TaskPlanRuntimeError) return `Error: ${error.code}`;
  const message = error instanceof Error ? error.message : String(error);
  return `Error: ${message || "task_plan_runtime_failed"}`;
}

abstract class TaskPlanTool extends Tool {
  static scopes = new Set(["core"]);
  protected readonly taskPlanRuntime: TaskPlanRuntime;
  protected requestContext: RequestContext | null = null;

  constructor(taskPlanRuntime: TaskPlanRuntime) {
    super();
    this.taskPlanRuntime = taskPlanRuntime;
  }

  static enabled(ctx: { taskPlanRuntime?: TaskPlanRuntime }): boolean {
    return ctx.taskPlanRuntime instanceof TaskPlanRuntime;
  }

  setContext(context: RequestContext): void {
    this.requestContext = context;
  }

  protected sessionKey(): string {
    const sessionKey = this.requestContext?.sessionKey;
    if (!sessionKey) throw new TaskPlanRuntimeError("task_plan_session_unavailable");
    return sessionKey;
  }
}

export class CreateTaskPlanTool extends TaskPlanTool {
  static create(ctx: { taskPlanRuntime: TaskPlanRuntime }): Tool {
    return new CreateTaskPlanTool(ctx.taskPlanRuntime);
  }

  get name(): string {
    return "create_task_plan";
  }

  get description(): string {
    return (
      "Create the fixed, user-visible execution checklist for the current task. "
      + "Use it only when the user explicitly asks for a visible checklist or a currently loaded "
      + "Skill explicitly instructs you to create one. Complexity, duration, multiple execution "
      + "stages, and plugin usage do not authorize this tool by themselves. When a plugin already "
      + "shows interaction, progress, or artifact cards, default to not creating a task plan unless "
      + "its Skill explicitly requires one. Do not use it for tentative plans awaiting approval or "
      + "a Goal's long-term objective. Keep items outcome-oriented, ordered, independently verifiable, "
      + "and detailed enough that progress remains meaningful after a restart."
    );
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 300 },
        items: {
          type: "array",
          minItems: 3,
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$",
              },
              content: { type: "string", maxLength: 1_000 },
            },
            required: ["id", "content"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "items"],
      additionalProperties: false,
    };
  }

  async execute(params: {
    title?: string;
    items?: TaskPlanItemInput[];
  } = {}): Promise<string> {
    try {
      const channel = String(this.requestContext?.channel ?? "").trim();
      const chatId = String(this.requestContext?.chatId ?? "").trim();
      if (!channel || !chatId) {
        throw new TaskPlanRuntimeError("task_plan_route_unavailable");
      }
      const plan = await this.taskPlanRuntime.create({
        sessionKey: this.sessionKey(),
        title: params.title ?? "",
        items: params.items ?? [],
        route: { channel, chatId },
      });
      return `Task plan created. Mark the first item in_progress before executing it.\n${formatTaskPlan(plan)}`;
    } catch (error) {
      return errorResult(error);
    }
  }
}

export class GetTaskPlanTool extends TaskPlanTool {
  static create(ctx: { taskPlanRuntime: TaskPlanRuntime }): Tool {
    return new GetTaskPlanTool(ctx.taskPlanRuntime);
  }

  get name(): string {
    return "get_task_plan";
  }

  get description(): string {
    return "Return the current persisted execution checklist and item statuses.";
  }

  get parameters() {
    return { type: "object", properties: {}, additionalProperties: false };
  }

  async execute(): Promise<string> {
    try {
      return `Task plan status.\n${formatTaskPlan(this.taskPlanRuntime.get(this.sessionKey()))}`;
    } catch (error) {
      return errorResult(error);
    }
  }
}

export class UpdateTaskPlanTool extends TaskPlanTool {
  static create(ctx: { taskPlanRuntime: TaskPlanRuntime }): Tool {
    return new UpdateTaskPlanTool(ctx.taskPlanRuntime);
  }

  get name(): string {
    return "update_task_plan";
  }

  get description(): string {
    return (
      "Update one item in the current execution checklist. Set the next item to in_progress "
      + "before starting it, completed only after its outcome is achieved or verified, and "
      + "blocked only when a concrete external blocker prevents progress. Update promptly after "
      + "each stage; never batch fictional progress at the end. Exactly one item may be "
      + "in_progress. The plan completes automatically when every item is completed."
    );
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        item_id: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "blocked"],
        },
      },
      required: ["item_id", "status"],
      additionalProperties: false,
    };
  }

  async execute(params: {
    item_id?: string;
    status?: TaskPlanItemStatus;
  } = {}): Promise<string> {
    try {
      const plan = await this.taskPlanRuntime.updateItem(
        this.sessionKey(),
        params.item_id ?? "",
        params.status as TaskPlanItemStatus,
      );
      return `Task plan updated.\n${formatTaskPlan(plan)}`;
    } catch (error) {
      return errorResult(error);
    }
  }
}
