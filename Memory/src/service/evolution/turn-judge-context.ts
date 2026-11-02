import type { RawTurnRecord, Repositories } from "../../storage/repositories.js";
import { isRecord } from "../../utils/json.js";
import { normalizeCaptureSummaryUserText } from "./capture-summary.js";
import {
  isSubagentCompleteTurnId,
  turnJudgeNoiseKind,
  type TurnJudgeTaskSoFar
} from "./turn-judge.js";

export interface TurnJudgeContext {
  // Where the session's previous completed turn is filed. Undefined for the
  // first turn. The turn is judged against it only while it is open.
  baseEpisodeId?: string;
  // The previous result Part 2 judges: the last prior turn of the base task and its L1.
  previousRawTurnId?: string;
  previousL1MemoryId?: string;
  // Undefined when TASK SO FAR is empty and the turn is filed by rule.
  taskSoFar?: TurnJudgeTaskSoFar;
  // catch_up: an earlier turn of the task captured late along with this one;
  // its relation was not judged when it completed and is not judged now.
  // previous_task_closed: the previous turn's task is already closed, so this
  // turn starts a new task by rule, like the first turn of a session.
  filedByRule?: "first_turn" | "subagent_complete" | "catch_up" | "previous_task_closed";
}

// Builds TASK SO FAR from the stored turns as they were before this turn.
export function loadTurnJudgeContext(
  repos: Pick<Repositories, "runtime" | "memories">,
  rawTurn: RawTurnRecord
): TurnJudgeContext {
  const sessionTurns = repos.runtime.completedRawTurnsBefore(rawTurn.id);
  const previous = sessionTurns[sessionTurns.length - 1];
  const baseEpisodeId = previous?.episodeId;
  if (isSubagentCompleteTurnId(rawTurn.turnId)) {
    return { ...(baseEpisodeId ? { baseEpisodeId } : {}), filedByRule: "subagent_complete" };
  }
  if (!baseEpisodeId) return { filedByRule: "first_turn" };
  const episode = repos.runtime.getEpisode(baseEpisodeId);
  if (episode?.status !== "open") return { baseEpisodeId, filedByRule: "previous_task_closed" };
  const prior = sessionTurns
    .filter((turn) => turn.episodeId === baseEpisodeId)
    .filter((turn) => !turnJudgeNoiseKind(turn.userText));
  if (prior.length === 0) return { baseEpisodeId, filedByRule: "first_turn" };

  const l1ByRawTurn = new Map<string, { id: string; title: string }>();
  for (const memory of repos.memories.getMany(episode.l1MemoryIds)) {
    const rawTurnId = typeof memory.info.raw_turn_id === "string"
      ? memory.info.raw_turn_id
      : typeof memory.properties.internal_info.raw_turn_id === "string"
        ? memory.properties.internal_info.raw_turn_id
        : undefined;
    if (!rawTurnId) continue;
    const decision = isRecord(memory.properties.internal_info.capture_decision)
      ? memory.properties.internal_info.capture_decision
      : undefined;
    if (decision?.status === "rejected") continue;
    // Pending L1 has no title yet: only records that were accepted carry one.
    const title = decision?.status === "pending" ? "" : typeof memory.info.title === "string" ? memory.info.title.trim() : "";
    l1ByRawTurn.set(rawTurnId, { id: memory.id, title });
  }
  const requestText = (turn: RawTurnRecord) => normalizeCaptureSummaryUserText(turn.userText ?? "").requestText;
  const last = prior[prior.length - 1]!;
  const previousL1 = l1ByRawTurn.get(last.id);
  return {
    baseEpisodeId,
    previousRawTurnId: last.id,
    ...(previousL1 ? { previousL1MemoryId: previousL1.id } : {}),
    taskSoFar: {
      firstUserMessage: requestText(prior[0]!),
      recentUserMessages: prior.slice(1).map(requestText).slice(-3),
      recordedTitles: prior
        .map((turn) => l1ByRawTurn.get(turn.id)?.title ?? "")
        .filter(Boolean)
        .slice(-20),
      previousAssistantReply: last.assistantText ?? ""
    }
  };
}
