import { randomUUID } from "node:crypto";
import { OUTBOUND_META_AGENT_UI, OutboundMessage } from "../../runtime-messages/events.js";
import { Tool } from "./base.js";
import { RequestContext, RequestContextStore } from "./context.js";
import type { MessageSendCallback } from "./message.js";

export const AGENT_QUESTION_UI_KEY = "questionCard";
export const AGENT_QUESTION_UI_VERSION = 1;

type QuestionOption = {
  id: string;
  label: string;
  description?: string;
};

type Question = {
  id: string;
  prompt: string;
  options: QuestionOption[];
  allow_multiple?: boolean;
  allow_other?: boolean;
};

export type AgentQuestionAnswer = {
  questionId: string;
  selectedOptionIds: string[];
  otherText?: string;
};

export type AgentQuestionResponse = {
  requestId: string;
  cancelled?: boolean;
  answers: AgentQuestionAnswer[];
};

type NormalizedQuestion = {
  id: string;
  prompt: string;
  options: QuestionOption[];
  allowMultiple: boolean;
  allowOther: boolean;
};

type PendingQuestion = {
  channel: string;
  chatId: string;
  sessionKey: string | null;
  turnId: string | null;
  questions: NormalizedQuestion[];
  resolve: (response: AgentQuestionResponse) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

const pendingQuestions = new Map<string, PendingQuestion>();

function validateResponse(
  pending: PendingQuestion,
  response: AgentQuestionResponse,
): string | null {
  if (response.cancelled === true) return response.answers.length === 0 ? null : "cancelled_answer_not_empty";
  if (response.answers.length !== pending.questions.length) return "answer_count_mismatch";
  const answersByQuestion = new Map(response.answers.map((answer) => [answer.questionId, answer]));
  if (answersByQuestion.size !== response.answers.length) return "duplicate_question_answer";
  for (const question of pending.questions) {
    const answer = answersByQuestion.get(question.id);
    if (!answer) return "missing_question_answer";
    const selectedIds = new Set(answer.selectedOptionIds);
    if (selectedIds.size !== answer.selectedOptionIds.length) return "duplicate_option_answer";
    if (!question.allowMultiple && selectedIds.size > 1) return "multiple_answers_not_allowed";
    if ([...selectedIds].some((id) => !question.options.some((option) => option.id === id))) {
      return "unknown_option";
    }
    const otherText = answer.otherText?.trim() ?? "";
    if (otherText && !question.allowOther) return "other_answer_not_allowed";
    // An empty selection is an explicit skip from the question card.
  }
  return null;
}

export function respondToAgentQuestion(input: {
  chatId: string;
  response: AgentQuestionResponse;
}): { ok: true } | { ok: false; error: string } {
  const pending = pendingQuestions.get(input.response.requestId);
  if (!pending) return { ok: false, error: "question_not_pending" };
  if (pending.chatId !== input.chatId) return { ok: false, error: "question_chat_mismatch" };
  const error = validateResponse(pending, input.response);
  if (error) return { ok: false, error };
  pendingQuestions.delete(input.response.requestId);
  pending.cleanup();
  pending.resolve({
    requestId: input.response.requestId,
    ...(input.response.cancelled === true ? { cancelled: true } : {}),
    answers: input.response.answers.map((answer) => ({
      questionId: answer.questionId,
      selectedOptionIds: [...answer.selectedOptionIds],
      ...(answer.otherText?.trim() ? { otherText: answer.otherText.trim() } : {}),
    })),
  });
  return { ok: true };
}

export function isAgentQuestionPending(requestId: string, chatId: string): boolean {
  return pendingQuestions.get(requestId)?.chatId === chatId;
}

export function pendingAgentQuestionCount(): number {
  return pendingQuestions.size;
}

export function pendingAgentQuestionTurnId(input: {
  channel: string;
  chatId: string;
  sessionKey: string;
}): string | null {
  for (const pending of pendingQuestions.values()) {
    if (pending.channel === input.channel
      && pending.chatId === input.chatId
      && pending.sessionKey === input.sessionKey
      && pending.turnId) return pending.turnId;
  }
  return null;
}

function questionFallback(title: string | undefined, questions: Question[]): string {
  const lines = title?.trim() ? [title.trim(), ""] : [];
  for (const question of questions) {
    lines.push(question.prompt.trim());
    lines.push(question.options.map((option) => `- ${option.label.trim()}`).join("\n"));
    if (question.allow_other !== false) lines.push("- Other");
    lines.push("");
  }
  return lines.join("\n").trim();
}

function uniqueIds(values: Array<{ id: string }>): boolean {
  const ids = values.map((value) => value.id.trim());
  return ids.every(Boolean) && new Set(ids).size === ids.length;
}

export class AskQuestionTool extends Tool {
  static scopes = new Set(["core"]);
  private readonly sendCallback?: MessageSendCallback;
  private readonly requestContext = new RequestContextStore();

  constructor({ sendCallback }: { sendCallback?: MessageSendCallback } = {}) {
    super();
    this.sendCallback = sendCallback;
  }

  static enabled(ctx: { messageSendCallback?: MessageSendCallback | null; bus?: { publishOutbound?: MessageSendCallback } | null }): boolean {
    return typeof ctx.messageSendCallback === "function" || typeof ctx.bus?.publishOutbound === "function";
  }

  static create(ctx: {
    messageSendCallback?: MessageSendCallback | null;
    bus?: { publishOutbound?: MessageSendCallback } | null;
  }): Tool {
    return new AskQuestionTool({
      sendCallback: ctx.messageSendCallback ?? ctx.bus?.publishOutbound?.bind(ctx.bus),
    });
  }

  get name(): string {
    return "ask_question";
  }

  get description(): string {
    return (
      "Present a structured question card when you are blocked on a decision that genuinely belongs to the user. " +
      "Use this instead of asking a plain-text multiple-choice question. Each question needs at least two options. " +
      "For each question, decide whether more than one option can apply and set allow_multiple accordingly. " +
      "Use true for lists such as which categories to add, and false for mutually exclusive choices. " +
      "Only add option descriptions when they distinguish choices in a way the short labels cannot; omit repetitive or obvious descriptions. " +
      "This tool waits for the user's card response and returns the structured answers; continue the current task after it returns. " +
      "Do not use it for rhetorical questions, information you can discover yourself, or routine confirmations."
    );
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          description: "Optional concise heading for the question card.",
        },
        context: {
          type: "object",
          description: "Optional workflow/task identity for consolidating the answered card into its workflow summary. Does not grant permissions or confirm any task data.",
          properties: { workflow: { type: "string", minLength: 1, maxLength: 64 }, taskId: { type: "string", minLength: 1, maxLength: 128 } },
          required: ["workflow", "taskId"], additionalProperties: false,
        },
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: 64 },
              prompt: { type: "string", minLength: 1, maxLength: 500 },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 8,
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", minLength: 1, maxLength: 64 },
                    label: { type: "string", minLength: 1, maxLength: 120 },
                    description: {
                      type: "string",
                      maxLength: 240,
                      description: "Optional. Include only decision-critical details not already clear from the label; omit repeated explanations.",
                    },
                  },
                  required: ["id", "label"],
                },
              },
              allow_multiple: {
                type: "boolean",
                description: "Choose for this question: true when the user may select several applicable options (for example, multiple categories to add); false only when the options are mutually exclusive.",
              },
              allow_other: { type: "boolean" },
            },
            required: ["id", "prompt", "options", "allow_multiple"],
          },
        },
      },
      required: ["questions"],
    };
  }

  setContext(ctx: RequestContext): void {
    this.requestContext.set(ctx);
  }

  async execute(
    params: { title?: string; questions?: Question[]; context?: { workflow: string; taskId: string } } = {},
    executionContext?: { abortSignal?: AbortSignal | null },
  ): Promise<string> {
    const context = this.requestContext.get();
    if (!context?.channel || !context.chatId) return "Error: No active conversation is available";
    if (!this.sendCallback) return "Error: Question delivery is not configured";

    const questions = params.questions ?? [];
    if (!questions.length) return "Error: at least one question is required";
    if (!uniqueIds(questions)) return "Error: question ids must be unique";
    for (const question of questions) {
      if (!question.prompt.trim()) return `Error: question '${question.id}' prompt must not be empty`;
      if (question.options.length < 2) return `Error: question '${question.id}' needs at least two options`;
      if (!uniqueIds(question.options)) {
        return `Error: option ids must be unique within question '${question.id}'`;
      }
      if (question.options.some((option) => !option.label.trim())) {
        return `Error: option labels must not be empty within question '${question.id}'`;
      }
    }

    const workflow = params.context?.workflow?.trim();
    const taskId = params.context?.taskId?.trim();
    const workflowContext = workflow && taskId ? { workflow, taskId } : undefined;
    const requestId = randomUUID();
    const normalizedQuestions = questions.map((question) => ({
      id: question.id.trim(),
      prompt: question.prompt.trim(),
      options: question.options.map((option) => ({
        id: option.id.trim(),
        label: option.label.trim(),
        ...(option.description?.trim() ? { description: option.description.trim() } : {}),
      })),
      allowMultiple: question.allow_multiple === true,
      allowOther: question.allow_other !== false,
    }));
    const title = params.title?.trim() || undefined;
    const fallbackQuestions = questions.map((question) => ({
      ...question,
      allow_other: question.allow_other !== false,
    }));
    const buttons = normalizedQuestions.length === 1 && !normalizedQuestions[0]!.allowMultiple
      ? [normalizedQuestions[0]!.options.map((option) => option.label)]
      : [];

    const responsePromise = new Promise<AgentQuestionResponse>((resolve, reject) => {
      const signal = executionContext?.abortSignal ?? null;
      const onAbort = () => {
        if (pendingQuestions.get(requestId)) pendingQuestions.delete(requestId);
        reject(new Error("Question cancelled because the turn was interrupted"));
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      pendingQuestions.set(requestId, {
        channel: context.channel!,
        chatId: context.chatId!,
        sessionKey: context.sessionKey ?? null,
        turnId: typeof context.metadata?.turn_id === "string" ? context.metadata.turn_id : null,
        questions: normalizedQuestions,
        resolve,
        reject,
        cleanup,
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    // The delivery callback may still be pending when an abort rejects the
    // response; attach a handler immediately so cancellation is never reported
    // as an unhandled rejection before execution reaches the await below.
    void responsePromise.catch(() => undefined);

    try {
      await this.sendCallback(new OutboundMessage({
        channel: context.channel,
        chatId: context.chatId,
        content: questionFallback(title, fallbackQuestions),
        buttons,
        metadata: {
          ...(context.metadata ?? {}),
          recordChannelDelivery: true,
          [OUTBOUND_META_AGENT_UI]: {
            [AGENT_QUESTION_UI_KEY]: {
              version: AGENT_QUESTION_UI_VERSION,
              requestId,
              ...(workflowContext ? { context: workflowContext } : {}),
              ...(title ? { title } : {}),
              questions: normalizedQuestions,
            },
          },
        },
      }));
    } catch (error) {
      const pending = pendingQuestions.get(requestId);
      pendingQuestions.delete(requestId);
      pending?.cleanup();
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
      await responsePromise.catch(() => undefined);
      throw error;
    }

    const response = await responsePromise;
    if (response.cancelled) return JSON.stringify({ status: "cancelled", ...response });
    return JSON.stringify({
      status: "answered",
      ...response,
      skippedQuestionIds: response.answers
        .filter((answer) => answer.selectedOptionIds.length === 0 && !answer.otherText?.trim())
        .map((answer) => answer.questionId),
    });
  }
}
