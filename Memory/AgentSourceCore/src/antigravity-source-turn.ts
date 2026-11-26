import { lstat, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readJsonlObjects } from "./jsonl-lines.js";
import { redactSecrets } from "./secret-redactor.js";
import { redactSourceTurn, stageSourceTurnMessages, type RawSourceMessage, type SourceTurn } from "./source-turn.js";

export const ANTIGRAVITY_SOURCE_ID = "antigravity";
export const ANTIGRAVITY_TRANSCRIPT_NAME = "transcript.jsonl";
export const ANTIGRAVITY_FULL_TRANSCRIPT_NAME = "transcript_full.jsonl";
export const ANTIGRAVITY_MEMORY_CONTEXT_TAG = '<memmy_memory_context source="antigravity">';
export const ANTIGRAVITY_RESUME_CONTEXT_TAG = '<memmy_resume source="antigravity">';

export function antigravityAppDirectory(home = homedir()): string {
  return join(home, ".gemini", "antigravity");
}

export function antigravityConfigDirectory(home = homedir()): string {
  return join(home, ".gemini", "config");
}

export function antigravityConversationId(transcriptPath: string): string {
  return basename(dirname(dirname(dirname(transcriptPath))));
}

export async function findAntigravityTranscript(
  logs: string,
  options: { followFileSymlinks?: boolean } = {}
): Promise<{ path: string; mtime: number } | null> {
  const inspectFile = options.followFileSymlinks === false ? lstat : stat;
  for (const name of [ANTIGRAVITY_FULL_TRANSCRIPT_NAME, ANTIGRAVITY_TRANSCRIPT_NAME]) {
    const path = join(logs, name);
    try {
      const file = await inspectFile(path);
      if (file.isFile()) return { path, mtime: file.mtimeMs };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return null;
}

export function antigravityUserText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  // Antigravity's transcript can wrap the prompt and append machine-generated settings and time metadata.
  return (/^<USER_REQUEST>\s*\n([\s\S]*?)\n<\/USER_REQUEST>/u.exec(text)?.[1] ?? text).trim();
}

export function isAntigravityResumeCommand(prompt: string): boolean {
  return /^\/?memmy-resume(?:\s|$)/u.test(prompt);
}

interface AntigravityStep {
  index: number;
  createdAt: string;
  role: "user" | "assistant";
  content: string;
  final: boolean;
}

export function parseAntigravityStep(record: Readonly<Record<string, unknown>>): AntigravityStep | null {
  const { step_index: index, created_at: time, content } = record;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || typeof time !== "string") return null;
  const timestamp = Date.parse(time);
  if (!Number.isFinite(timestamp)) return null;
  const createdAt = new Date(timestamp).toISOString();
  const text = typeof content === "string" ? content.trim() : "";
  if (record.type === "USER_INPUT" && record.source === "USER_EXPLICIT") {
    return { index, createdAt, role: "user", content: antigravityUserText(text), final: false };
  }
  if (record.type === "PLANNER_RESPONSE" && record.source === "MODEL") {
    const final = record.status === "DONE" && !!text && !(Array.isArray(record.tool_calls) && record.tool_calls.length > 0);
    return { index, createdAt, role: "assistant", content: text, final };
  }
  return null;
}

interface TranscriptTurn {
  id: string;
  user: AntigravityStep;
  assistant?: AntigravityStep;
  invoked: boolean;
  recalled: boolean;
  resume: boolean;
}

async function* readTranscriptTurns(transcriptPath: string, signal?: AbortSignal): AsyncIterable<TranscriptTurn> {
  let turn: TranscriptTurn | undefined;
  for await (const record of readJsonlObjects(transcriptPath, signal)) {
    const step = parseAntigravityStep(record);
    if (step?.role === "user") {
      if (turn) yield turn;
      turn = {
        id: `step-${step.index}-${Date.parse(step.createdAt)}`,
        user: step,
        invoked: false,
        recalled: false,
        resume: isAntigravityResumeCommand(step.content)
      };
    } else if (turn && step?.role === "assistant") {
      turn.invoked = true;
      turn.assistant = step.final ? step : undefined;
    } else if (turn && record.type === "SYSTEM_MESSAGE" && typeof record.content === "string") {
      turn.recalled ||= record.content.includes(ANTIGRAVITY_MEMORY_CONTEXT_TAG);
      turn.resume ||= record.content.includes(ANTIGRAVITY_RESUME_CONTEXT_TAG);
    }
  }
  if (turn) yield turn;
}

export interface AntigravityTranscript {
  transcriptPath: string;
  conversationId: string;
  workspacePath?: string;
  signal?: AbortSignal;
}

function completedTurn(input: AntigravityTranscript, turn: TranscriptTurn): SourceTurn | undefined {
  const { user, assistant } = turn;
  if (turn.resume || !user.content || !assistant || assistant.createdAt < user.createdAt) return undefined;
  return redactSourceTurn({
    source: ANTIGRAVITY_SOURCE_ID,
    profileId: "default",
    conversationId: input.conversationId,
    turnId: turn.id,
    startedAt: user.createdAt,
    completedAt: assistant.createdAt,
    sequence: user.index,
    completionEvidence: `planner_response:${assistant.index}`,
    query: user.content,
    answer: assistant.content,
    status: "succeeded",
    toolCalls: [],
    toolResults: [],
    workspacePath: input.workspacePath
  });
}

export async function readAntigravityHookTurn(input: AntigravityTranscript) {
  let latest: TranscriptTurn | undefined;
  for await (const turn of readTranscriptTurns(input.transcriptPath, input.signal)) latest = turn;
  if (!latest?.user.content) return null;
  return {
    id: latest.id,
    prompt: latest.user.content,
    query: redactSecrets(latest.user.content),
    canRecall: !latest.invoked && !latest.recalled,
    completed: completedTurn(input, latest)
  };
}

export async function* readAntigravityTranscript(
  input: AntigravityTranscript & { latestTurnRunning?: boolean }
): AsyncIterable<RawSourceMessage> {
  let remaining: TranscriptTurn | undefined;
  for await (const turn of readTranscriptTurns(input.transcriptPath, input.signal)) {
    if (remaining) yield* stageTurn(input, remaining, false);
    remaining = turn;
  }
  if (remaining) yield* stageTurn(input, remaining, input.latestTurnRunning === true);
}

function stageTurn(input: AntigravityTranscript, current: TranscriptTurn, running: boolean): RawSourceMessage[] {
  if (current.resume) return [];
  const steps = [current.user, current.assistant].filter((step): step is AntigravityStep => !!step?.content);
  const turn = running ? undefined : completedTurn(input, current);
  return stageSourceTurnMessages(steps.map(step => ({
    messageId: `antigravity:${input.conversationId}:${step.index}:${step.createdAt}`,
    conversationId: input.conversationId,
    createdAt: step.createdAt,
    role: step.role,
    content: redactSecrets(step.content),
    ordinal: step.index,
    rawMeta: {}
  })), {
    turnId: current.id,
    sequence: current.user.index,
    startedAt: current.user.createdAt,
    ...(turn ? { turn } : { reason: "turn_incomplete" })
  });
}
