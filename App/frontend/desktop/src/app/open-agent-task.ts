/**
 * Opening a task in the chat page. The sidebar and a project board both list tasks, so the steps that switch the
 * window and load the conversation live here instead of being written twice.
 */
import type { Dispatch } from "react";
import { MemmyAgentRequestError, sessionKeyToChatId, type MemmyAgentClient } from "../api/memmy-agent-client.js";
import { agentActions, appActions, createAgentOperationError, type AppAction } from "../state/app-actions.js";
import type { AgentTaskView } from "../state/agent-chat-slice.js";

export interface OpenAgentTaskInput {
  /** Absent in tests and error states, where opening a task only switches the page. */
  memmyAgent: Pick<MemmyAgentClient, "readWebuiThread"> | null | undefined;
  dispatch: Dispatch<AppAction>;
  task: Pick<AgentTaskView, "sessionKey">;
}

/** Switches to the chat page and loads the task's conversation there. */
export async function openAgentTaskInChat(input: OpenAgentTaskInput): Promise<void> {
  const { memmyAgent, dispatch, task } = input;
  if (!memmyAgent) {
    dispatch(appActions.navigate("/main"));
    return;
  }

  const chatId = sessionKeyToChatId(task.sessionKey);
  const requestId = nextAgentHistoryRequestId(chatId);
  dispatch(agentActions.historyLoading(task.sessionKey, chatId, requestId));
  dispatch(appActions.navigate("/main"));
  try {
    dispatch(agentActions.historyLoaded(await memmyAgent.readWebuiThread(task.sessionKey), requestId));
  } catch (error) {
    if (error instanceof MemmyAgentRequestError && error.status === 404) {
      dispatch(agentActions.historyOpenMissing(task.sessionKey, chatId, requestId));
      return;
    }
    dispatch(agentActions.historyOpenFailed(chatId, requestId, createAgentOperationError({
      source: "history",
      message: error instanceof Error ? error.message : String(error),
      chatId
    })));
  }
}

let agentHistoryRequestCounter = 0;

export function nextAgentHistoryRequestId(chatId: string): string {
  agentHistoryRequestCounter += 1;
  return `${chatId}-${agentHistoryRequestCounter}`;
}
