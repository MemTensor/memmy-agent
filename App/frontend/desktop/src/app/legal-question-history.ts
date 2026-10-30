import type { PluginInteractionRequest } from "@memmy/local-api-contracts";

export interface LegalQuestionRecord {
  conversationId: string;
  callId: string;
  agentToolCallId?: string;
  turnId?: string;
  interactionId: string;
  askedAt: number;
  title?: string;
  questions: Array<{ id: string; label: string }>;
  answers: Record<string, string> | null;
  status: "pending" | "answered" | "interrupted";
}

const STORAGE_KEY = "memmy.legal-question-history.v1";
const MAX_RECORDS = 100;

export function legalQuestionRecordKey(record: Pick<LegalQuestionRecord, "conversationId" | "callId" | "interactionId">): string {
  return `${record.conversationId.replace(/^websocket:/u, "")}:${record.callId}:${record.interactionId}`;
}

export function legalQuestionFields(request: PluginInteractionRequest): LegalQuestionRecord["questions"] {
  if (request.type !== "question" || !request.payload || typeof request.payload !== "object") return [];
  const questions = (request.payload as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((question) => question && typeof question === "object"
    && typeof question.id === "string" && typeof question.label === "string"
    && question.id.trim() && question.label.trim()
    ? [{ id: question.id, label: question.label }] : []);
}

export function legalQuestionTitle(request: PluginInteractionRequest): string | undefined {
  if (!request.payload || typeof request.payload !== "object") return undefined;
  const title = (request.payload as { title?: unknown }).title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

export function upsertLegalQuestionRecord(
  records: readonly LegalQuestionRecord[], next: LegalQuestionRecord,
): LegalQuestionRecord[] {
  const key = legalQuestionRecordKey(next);
  const index = records.findIndex((record) => legalQuestionRecordKey(record) === key);
  if (index < 0) return [...records, next].slice(-MAX_RECORDS);
  const updated = [...records];
  updated[index] = { ...updated[index]!, ...next, ...(next.title ? { title: next.title } : { title: updated[index]!.title }),
    askedAt: updated[index]!.askedAt };
  return updated;
}

export function readLegalQuestionHistory(storage?: Pick<Storage, "getItem"> | null): LegalQuestionRecord[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is LegalQuestionRecord => Boolean(value)
      && typeof value === "object" && typeof value.conversationId === "string"
      && typeof value.callId === "string" && typeof value.interactionId === "string"
      && Number.isFinite(value.askedAt) && Array.isArray(value.questions)
      && (value.title === undefined || typeof value.title === "string")
      && value.questions.every((question: unknown) => Boolean(question) && typeof question === "object"
        && typeof (question as { id?: unknown }).id === "string"
        && typeof (question as { label?: unknown }).label === "string")
      && (value.answers === null || (typeof value.answers === "object" && !Array.isArray(value.answers)
        && Object.values(value.answers).every((answer) => typeof answer === "string")))
      && ["pending", "answered", "interrupted"].includes(value.status)).slice(-MAX_RECORDS);
  } catch { return []; }
}

export function writeLegalQuestionHistory(records: readonly LegalQuestionRecord[], storage?: Pick<Storage, "setItem"> | null): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(records.slice(-MAX_RECORDS))); }
  catch { /* The live process record remains available when browser storage is full. */ }
}
