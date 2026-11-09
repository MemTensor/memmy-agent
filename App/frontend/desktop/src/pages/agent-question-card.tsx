import { createContext, useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Check, ChevronLeft, ChevronRight, Loader2, MessageCircleQuestionMark, PenLine, X } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import { questionWaitingLabel } from "../app/plugin-interaction-waiting-label.js";
import "./agent-confirmation-dock.css";
import "./agent-question-card.css";

/** Undefined keeps standalone cards interactive; chat history only owns the answer record. */
export const AgentQuestionActiveRequestContext = createContext<string | null | undefined>(undefined);
/** Undefined keeps standalone cards inline; null waits for the chat dock to mount. */
export const AgentQuestionDockContext = createContext<HTMLElement | null | undefined>(undefined);

export type AgentQuestionOption = {
  id: string;
  label: string;
  description?: string;
};

export type AgentQuestion = {
  id: string;
  prompt: string;
  options: AgentQuestionOption[];
  allowMultiple: boolean;
  allowOther: boolean;
};

export type AgentQuestionCardPayload = {
  version: 1;
  requestId: string;
  title?: string;
  questions: AgentQuestion[];
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

const QUESTION_RESPONSE_RE = /(?:\r?\n)?<!--\s*memmy-question-response:([^>\s]+)\s*-->\s*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readAgentQuestionCard(value: unknown): AgentQuestionCardPayload | null {
  if (!isRecord(value)) return null;
  const raw = isRecord(value.questionCard) ? value.questionCard : null;
  if (!raw || raw.version !== 1) return null;
  const requestId = nonemptyString(raw.requestId);
  if (!requestId || !Array.isArray(raw.questions) || raw.questions.length === 0) return null;
  const questions: AgentQuestion[] = [];
  for (const item of raw.questions) {
    if (!isRecord(item)) return null;
    const id = nonemptyString(item.id);
    const prompt = nonemptyString(item.prompt);
    if (!id || !prompt || !Array.isArray(item.options) || item.options.length < 2) return null;
    const options: AgentQuestionOption[] = [];
    for (const option of item.options) {
      if (!isRecord(option)) return null;
      const optionId = nonemptyString(option.id);
      const label = nonemptyString(option.label);
      if (!optionId || !label) return null;
      const description = nonemptyString(option.description);
      options.push({ id: optionId, label, ...(description ? { description } : {}) });
    }
    questions.push({
      id,
      prompt,
      options,
      allowMultiple: item.allowMultiple === true,
      allowOther: item.allowOther !== false,
    });
  }
  const title = nonemptyString(raw.title);
  return {
    version: 1,
    requestId,
    ...(title ? { title } : {}),
    questions,
  };
}

export function serializeAgentQuestionResponse(
  card: AgentQuestionCardPayload,
  response: AgentQuestionResponse,
): { content: string; displayContent: string } {
  const lines = card.questions.map((question) => {
    const answer = response.answers.find((item) => item.questionId === question.id);
    const selectedLabels = (answer?.selectedOptionIds ?? [])
      .map((id) => question.options.find((option) => option.id === id)?.label)
      .filter((label): label is string => Boolean(label));
    if (answer?.otherText?.trim()) selectedLabels.push(answer.otherText.trim());
    return `${question.prompt}：${selectedLabels.join("、") || "(skipped)"}`;
  });
  const displayContent = lines.join("\n");
  const encoded = encodeURIComponent(JSON.stringify(response));
  return {
    content: `${displayContent}\n<!-- memmy-question-response:${encoded} -->`,
    displayContent,
  };
}

export function readAgentQuestionResponse(content: string): AgentQuestionResponse | null {
  const encoded = content.match(QUESTION_RESPONSE_RE)?.[1];
  if (!encoded) return null;
  try {
    return normalizeAgentQuestionResponse(JSON.parse(decodeURIComponent(encoded)));
  } catch {
    return null;
  }
}

export function normalizeAgentQuestionResponse(value: unknown): AgentQuestionResponse | null {
  if (!isRecord(value)) return null;
  const requestId = nonemptyString(value.requestId);
  if (!requestId || !Array.isArray(value.answers)) return null;
  const answers: AgentQuestionAnswer[] = [];
  for (const item of value.answers) {
    if (!isRecord(item)) return null;
    const questionId = nonemptyString(item.questionId);
    if (!questionId || !Array.isArray(item.selectedOptionIds)) return null;
    const selectedOptionIds = item.selectedOptionIds
      .map(nonemptyString)
      .filter((id): id is string => Boolean(id));
    const otherText = nonemptyString(item.otherText);
    answers.push({ questionId, selectedOptionIds, ...(otherText ? { otherText } : {}) });
  }
  return { requestId, answers, ...(value.cancelled === true ? { cancelled: true } : {}) };
}

export function visibleAgentQuestionResponseContent(content: string): string {
  return content.replace(QUESTION_RESPONSE_RE, "").trimEnd();
}

type AgentQuestionMessage = { agentUi?: unknown; questionResponse?: unknown; questionInterrupted?: boolean; turnId?: string; role: string; content: string };

export function pendingAgentQuestion(messages: ReadonlyArray<AgentQuestionMessage>, activeTurnId: string | null): AgentQuestionCardPayload | null {
  if (!activeTurnId) return null;
  const answered = new Set(messages.flatMap((message) => {
    const response = message.role === "user" ? readAgentQuestionResponse(message.content) : normalizeAgentQuestionResponse(message.questionResponse);
    return response ? [response.requestId] : [];
  }));
  for (const message of [...messages].reverse()) {
    if (message.turnId !== activeTurnId) continue;
    const card = readAgentQuestionCard(message.agentUi);
    if (card && !message.questionInterrupted && !answered.has(card.requestId)) return card;
  }
  return null;
}

export function hasPendingAgentQuestion(messages: ReadonlyArray<AgentQuestionMessage>, activeTurnId: string | null): boolean {
  return pendingAgentQuestion(messages, activeTurnId) !== null;
}

type DraftAnswer = {
  selectedOptionIds: string[];
  otherSelected: boolean;
  otherText: string;
  skipped: boolean;
};

function initialDraft(card: AgentQuestionCardPayload): Record<string, DraftAnswer> {
  return Object.fromEntries(card.questions.map((question) => [
    question.id,
    { selectedOptionIds: [], otherSelected: false, otherText: "", skipped: false },
  ]));
}

function hasAnswer(answer: DraftAnswer | undefined): boolean {
  return Boolean(
    answer?.skipped
    || answer?.selectedOptionIds.length
    || (answer?.otherSelected && answer.otherText.trim()),
  );
}

function responseFromDraft(card: AgentQuestionCardPayload, draft: Record<string, DraftAnswer>): AgentQuestionResponse {
  return {
    requestId: card.requestId,
    answers: card.questions.map((question) => {
      const answer = draft[question.id];
      return {
        questionId: question.id,
        selectedOptionIds: answer?.skipped ? [] : (answer?.selectedOptionIds ?? []),
        ...(!answer?.skipped && answer?.otherSelected && answer.otherText.trim()
          ? { otherText: answer.otherText.trim() } : {}),
      };
    }),
  };
}

function responseLabel(question: AgentQuestion, answer: AgentQuestionAnswer | undefined, unansweredLabel: string): string {
  const labels = (answer?.selectedOptionIds ?? [])
    .map((id) => question.options.find((option) => option.id === id)?.label)
    .filter((label): label is string => Boolean(label));
  if (answer?.otherText) labels.push(answer.otherText);
  return labels.join("、") || unansweredLabel;
}

export function AgentQuestionCard(props: {
  card: AgentQuestionCardPayload;
  response?: AgentQuestionResponse | null;
  processView?: boolean;
  interrupted?: boolean;
  onSubmit?: (response: AgentQuestionResponse) => Promise<boolean> | boolean;
}) {
  const { t, language } = useTranslation();
  const dock = useContext(AgentQuestionDockContext);
  const activeRequestId = useContext(AgentQuestionActiveRequestContext);
  const [draft, setDraft] = useState(() => initialDraft(props.card));
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [submittedResponse, setSubmittedResponse] = useState<AgentQuestionResponse | null>(null);
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [answerExpanded, setAnswerExpanded] = useState(() => props.processView === true);
  const persistedResponse = props.response?.requestId === props.card.requestId ? props.response : null;
  const completedResponse = persistedResponse ?? submittedResponse;
  const answered = completedResponse != null;
  const processRecordLabel = props.card.title ?? t("home.question.asked");
  const canSubmit = useMemo(
    () => props.card.questions.every((question) => hasAnswer(draft[question.id])),
    [draft, props.card.questions],
  );
  const questionIndex = Math.min(activeQuestionIndex, props.card.questions.length - 1);
  const activeQuestion = props.card.questions[questionIndex]!;
  const activeDraft = draft[activeQuestion.id]!;
  const isLastQuestion = questionIndex === props.card.questions.length - 1;
  const selectedCount = activeDraft.selectedOptionIds.length
    + (activeDraft.otherSelected && activeDraft.otherText.trim() ? 1 : 0);
  const currentAnswered = hasAnswer(activeDraft);

  const submitDraft = async (nextDraft: Record<string, DraftAnswer>) => {
    if (!props.onSubmit || answered || submitting) return;
    setSubmitting(true);
    setSubmitFailed(false);
    try {
      const response = responseFromDraft(props.card, nextDraft);
      if (await props.onSubmit(response)) setSubmittedResponse(response);
      else setSubmitFailed(true);
    } catch {
      setSubmitFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  const advanceOrSubmit = (nextDraft: Record<string, DraftAnswer>) => {
    if (!isLastQuestion) {
      setActiveQuestionIndex(questionIndex + 1);
      return;
    }
    const firstUnanswered = props.card.questions.findIndex((question) => !hasAnswer(nextDraft[question.id]));
    if (firstUnanswered >= 0) setActiveQuestionIndex(firstUnanswered);
    else void submitDraft(nextDraft);
  };

  const toggleOption = (question: AgentQuestion, optionId: string) => {
    if (answered || submitting) return;
    setSubmitFailed(false);
    const previous = draft[question.id] ?? { selectedOptionIds: [], otherSelected: false, otherText: "", skipped: false };
    const selectedOptionIds = question.allowMultiple
      ? previous.selectedOptionIds.includes(optionId)
        ? previous.selectedOptionIds.filter((id) => id !== optionId)
        : [...previous.selectedOptionIds, optionId]
      : [optionId];
    const nextDraft = {
      ...draft,
      [question.id]: {
        ...previous,
        skipped: false,
        selectedOptionIds,
        ...(!question.allowMultiple ? { otherSelected: false, otherText: "" } : {}),
      },
    };
    setDraft(nextDraft);
    if (!question.allowMultiple) advanceOrSubmit(nextDraft);
  };

  const activateOther = (question: AgentQuestion) => {
    if (answered || submitting) return;
    setSubmitFailed(false);
    setDraft((current) => {
      const previous = current[question.id] ?? { selectedOptionIds: [], otherSelected: false, otherText: "", skipped: false };
      return {
        ...current,
        [question.id]: {
          ...previous,
          skipped: false,
          otherSelected: true,
          ...(!question.allowMultiple ? { selectedOptionIds: [] } : {}),
        },
      };
    });
  };

  const skipQuestion = (questionId: string) => {
    if (answered || submitting) return;
    setSubmitFailed(false);
    const nextDraft = {
      ...draft,
      [questionId]: { selectedOptionIds: [], otherSelected: false, otherText: "", skipped: true },
    };
    setDraft(nextDraft);
    advanceOrSubmit(nextDraft);
  };

  const closeQuestionCard = () => {
    if (answered || submitting) return;
    const skippedDraft = Object.fromEntries(props.card.questions.map((question) => [
      question.id,
      { selectedOptionIds: [], otherSelected: false, otherText: "", skipped: true },
    ]));
    void submitDraft(skippedDraft);
  };

  if (props.interrupted || completedResponse?.cancelled || (!answered && props.processView && activeRequestId !== undefined && activeRequestId !== props.card.requestId)) {
    return <div className="agent-question-answer agent-question-answer--interrupted">
      <MessageCircleQuestionMark size={14} aria-hidden="true" />
      <span>{props.processView ? processRecordLabel : t("home.question.asked")}</span>
    </div>;
  }

  if (answered) {
    const hasRecordedAnswer = completedResponse.answers.some((answer) => answer.selectedOptionIds.length > 0 || Boolean(answer.otherText?.trim()));
    return <details className={`agent-question-answer${props.processView ? " agent-question-answer--process" : ""}`}
      open={answerExpanded} onToggle={(event) => setAnswerExpanded(event.currentTarget.open)}>
      <summary>{props.processView ? <MessageCircleQuestionMark size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}<span>{props.processView
        ? processRecordLabel
        : t(hasRecordedAnswer ? "home.question.responseReceived" : "home.question.unanswered")}</span><ChevronRight size={13} aria-hidden="true" /></summary>
      <dl className="agent-question-answer__details">{props.card.questions.map((question) => <div key={question.id}><dt>{question.prompt}</dt><dd>{responseLabel(question, completedResponse.answers.find((answer) => answer.questionId === question.id), t("home.question.unanswered"))}</dd></div>)}</dl>
    </details>;
  }

  if (!answered && props.processView && activeRequestId === props.card.requestId) {
    return <div className="agent-question-answer agent-question-answer--review" data-waiting-input-anchor={props.card.requestId}>
      <MessageCircleQuestionMark size={14} aria-hidden="true" />
      <span>{questionWaitingLabel(props.card.title, language === "en-US")}</span>
    </div>;
  }
  const card = (
    <section
      className="agent-confirmation-card agent-question-card"
      aria-label={props.card.title ?? t("home.question.title")}
    >
      <div className="agent-confirmation-card__header agent-question-card__header">
        <span className="agent-question-card__prompt">
          {activeQuestion.prompt}
        </span>
        <div className="agent-question-card__header-actions">
          <nav className="agent-question-card__pagination" aria-label={t("home.question.count", { count: props.card.questions.length })}>
            <button type="button" disabled={questionIndex === 0 || submitting}
              aria-label={t("home.question.previous")}
              onClick={() => setActiveQuestionIndex((index) => Math.max(0, index - 1))}>
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <span aria-live="polite">{questionIndex + 1}/{props.card.questions.length}</span>
            <button type="button" disabled={isLastQuestion || submitting}
              aria-label={t("home.question.next")}
              onClick={() => setActiveQuestionIndex((index) => Math.min(props.card.questions.length - 1, index + 1))}>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </nav>
          <button type="button" className="agent-question-card__close" disabled={submitting}
            aria-label={t("home.question.close")}
            title={t("home.question.close")}
            onClick={closeQuestionCard}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="agent-confirmation-card__body agent-question-card__body"
          role="group" aria-label={activeQuestion.prompt} key={activeQuestion.id}>
          <div className="agent-question-card__options">
            {activeQuestion.options.map((option, index) => {
              const selected = activeDraft.selectedOptionIds.includes(option.id);
              return (
                <button key={option.id} type="button" disabled={submitting}
                  aria-pressed={selected} title={option.description}
                  data-multiple={activeQuestion.allowMultiple}
                  onClick={() => toggleOption(activeQuestion, option.id)}
                  className={"agent-question-card__option" + (selected ? " agent-question-card__option--selected" : "")}>
                  <span className={"agent-question-card__choice" + (activeQuestion.allowMultiple ? " agent-question-card__choice--multiple" : "")} aria-hidden="true">
                    {activeQuestion.allowMultiple ? (selected ? <Check size={12} /> : null) : index + 1}
                  </span>
                  <span className="agent-question-card__option-copy">
                    <span>{option.label}</span>
                  </span>
                  {!activeQuestion.allowMultiple ? <ArrowRight size={17} className="agent-question-card__option-arrow" aria-hidden="true" /> : null}
                </button>
              );
            })}
            {activeQuestion.allowOther ? (
              <div className="agent-question-card__other">
                <span className="agent-question-card__other-icon" aria-hidden="true">
                  <PenLine size={14} aria-hidden="true" />
                </span>
                <input type="text" disabled={submitting}
                  value={activeDraft.otherText}
                  onFocus={() => activateOther(activeQuestion)}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    [activeQuestion.id]: {
                      ...current[activeQuestion.id]!,
                      otherText: event.target.value,
                      otherSelected: true,
                      skipped: false,
                    },
                  }))}
                  placeholder={t("home.question.other")}
                  aria-label={t("home.question.otherPlaceholder")}
                />
              </div>
            ) : null}
          </div>
      </div>
      <div className="agent-confirmation-card__footer agent-question-card__footer">
          {activeQuestion.allowMultiple && selectedCount > 0 ? (
            <span className="agent-question-card__selection">{t("home.question.selectedCount", { count: selectedCount })}</span>
          ) : <span className="agent-question-card__selection" />}
          {submitFailed ? <span className="agent-question-card__error">{t("home.question.submitFailed")}</span> : null}
          <button type="button" className="agent-question-card__skip" disabled={submitting}
            onClick={() => skipQuestion(activeQuestion.id)}>
            {t("home.question.skip")}
          </button>
          {currentAnswered && (activeQuestion.allowMultiple || activeDraft.otherSelected) ? (
            <button type="button" className="agent-question-card__continue"
              disabled={submitting || !props.onSubmit || !currentAnswered}
              onClick={() => advanceOrSubmit(draft)}>
              {submitting ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : null}
              {t(isLastQuestion && canSubmit ? "home.question.confirm" : "home.question.next")}
            </button>
          ) : null}
      </div>
    </section>
  );
  return dock === undefined ? card : dock ? createPortal(card, dock, props.card.requestId) : null;
}
