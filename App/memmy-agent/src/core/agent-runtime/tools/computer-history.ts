import { Tool } from "./base.js";
import {
  ComputerHistoryApiError,
  getComputerHistoryDemoService,
} from "../../../entrypoints/frontend-bridge/computer-history-api.js";
import type { ComputerHistoryDemoService } from "../../../entrypoints/frontend-bridge/computer-history-api.js";

const PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["search", "replay"],
      description: "Use search to inspect matching recordings; use replay only when the user explicitly asks to reproduce, repeat, resume, or continue a recorded computer behavior.",
    },
    query: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "The user's request or a concise description of the recorded behavior to find.",
    },
    history_id: {
      type: ["string", "null"],
      description: "Optional exact Computer History entry id. Omit to select the most relevant reusable entry.",
    },
  },
  required: ["action", "query"],
  additionalProperties: false,
};

export class ComputerHistoryTool extends Tool {
  static scopes = new Set(["core"]);
  private readonly service: Pick<ComputerHistoryDemoService, "searchHistories" | "prepareReplayUserRequest">;

  constructor(service = getComputerHistoryDemoService()) {
    super();
    this.service = service;
  }

  static enabled(): boolean {
    return process.env.MEMMY_COMPUTER_HISTORY !== "0";
  }

  get name(): string {
    return "computer_history";
  }

  get description(): string {
    return "Search explicit human Computer History recordings. When the user asks to reproduce or continue one, replay prepares a semantic workflow for this same Agent turn; after it returns, immediately use the Open Computer Use MCP tools whose names start with mcp_open_computer_use_ to perform and verify the workflow. Use the built-in computer_* tools only when that MCP server is unavailable, never start CUA for this path, and never guess missing task variables.";
  }

  get parameters() {
    return structuredClone(PARAMETERS);
  }

  async execute(params: { action: "search" | "replay"; query: string; history_id?: string | null }): Promise<string> {
    try {
      if (params.action === "search") {
        const matches = this.service.searchHistories(params.query, 5);
        return JSON.stringify({
          status: "ok",
          matches: matches.map(({ history, score, matchedTerms }) => ({
            id: history.id,
            title: history.title,
            source_type: history.sourceType,
            captured_at: history.createdAt,
            score,
            matched_terms: matchedTerms,
            summary: history.markdown.slice(0, 1_200),
          })),
        });
      }

      const result = this.service.prepareReplayUserRequest({
        userRequest: params.query,
        historyId: params.history_id ?? null,
      });
      return JSON.stringify({
        status: "ready_for_open_computer_use",
        executor: "open_computer_use_mcp",
        fallback_executor: "builtin_computer_use",
        history: { id: result.history.id, title: result.history.title },
        workflow: { id: result.workflow.id, title: result.workflow.title, file_path: result.workflow.filePath },
        steps: result.steps,
        next_action: "Call mcp_open_computer_use_list_apps and mcp_open_computer_use_get_app_state now, then execute the semantic steps with the mcp_open_computer_use_* tools in this same Agent turn. Use only element indexes from the latest returned state, treat each action result as refreshed post-action state, and stop at the user's requested boundary.",
        safety_note: "Do not call mcp_cua or replay-cua.sh. Do not replay raw coordinates or stale element indexes. Fall back to built-in computer_* only if the Open Computer Use MCP tools are unavailable. If a truly required business value is absent, stop instead of guessing it.",
      });
    } catch (error) {
      if (error instanceof ComputerHistoryApiError) {
        return `Error: Computer History ${error.status}: ${error.message}`;
      }
      throw error;
    }
  }
}
