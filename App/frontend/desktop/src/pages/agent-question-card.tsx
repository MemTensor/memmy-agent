import { useMemo, useState } from "react";
import { Check, CircleHelp, Loader2 } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";

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
    return `${question.prompt}：${selectedLabels.join("、")}`;
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
  return { requestId, answers };
}

export function visibleAgentQuestionResponseContent(content: string): string {
  return content.replace(QUESTION_RESPONSE_RE, "").trimEnd();
}

type DraftAnswer = {
  selectedOptionIds: string[];
  otherSelected: boolean;
  otherText: string;
};

function initialDraft(card: AgentQuestionCardPayload): Record<string, DraftAnswer> {
  return Object.fromEntries(card.questions.map((question) => [
    question.id,
    { selectedOptionIds: [], otherSelected: false, otherText: "" },
  ]));
}

function responseLabel(question: AgentQuestion, answer: AgentQuestionAnswer | undefined): string {
  const labels = (answer?.selectedOptionIds ?? [])
    .map((id) => question.options.find((option) => option.id === id)?.label)
    .filter((label): label is string => Boolean(label));
  if (answer?.otherText) labels.push(answer.otherText);
  return labels.join("、");
}

export function AgentQuestionCard(props: {
  card: AgentQuestionCardPayload;
  response?: AgentQuestionResponse | null;
  onSubmit?: (response: AgentQuestionResponse) => Promise<boolean> | boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(() => initialDraft(props.card));
  const [submitting, setSubmitting] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [submittedResponse, setSubmittedResponse] = useState<AgentQuestionResponse | null>(null);
  const persistedResponse = props.response?.requestId === props.card.requestId ? props.response : null;
  const completedResponse = persistedResponse ?? submittedResponse;
  const answered = completedResponse != null;
  const canSubmit = useMemo(
    () => props.card.questions.every((question) => {
      const answer = draft[question.id];
      return Boolean(
        answer?.selectedOptionIds.length
        || (answer?.otherSelected && answer.otherText.trim()),
      );
    }),
    [draft, props.card.questions],
  );

  const toggleOption = (question: AgentQuestion, optionId: string) => {
    if (answered || submitting) return;
    setSubmitFailed(false);
    setDraft((current) => {
      const previous = current[question.id] ?? { selectedOptionIds: [], otherSelected: false, otherText: "" };
      const selectedOptionIds = question.allowMultiple
        ? previous.selectedOptionIds.includes(optionId)
          ? previous.selectedOptionIds.filter((id) => id !== optionId)
          : [...previous.selectedOptionIds, optionId]
        : [optionId];
      return {
        ...current,
        [question.id]: {
          ...previous,
          selectedOptionIds,
          ...(!question.allowMultiple ? { otherSelected: false, otherText: "" } : {}),
        },
      };
    });
  };

  const toggleOther = (question: AgentQuestion) => {
    if (answered || submitting) return;
    setSubmitFailed(false);
    setDraft((current) => {
      const previous = current[question.id] ?? { selectedOptionIds: [], otherSelected: false, otherText: "" };
      const otherSelected = !previous.otherSelected;
      return {
        ...current,
        [question.id]: {
          ...previous,
          otherSelected,
          ...(!question.allowMultiple && otherSelected ? { selectedOptionIds: [] } : {}),
        },
      };
    });
  };

  const submit = async () => {
    if (!canSubmit || !props.onSubmit || answered || submitting) return;
    setSubmitting(true);
    setSubmitFailed(false);
    const response: AgentQuestionResponse = {
      requestId: props.card.requestId,
      answers: props.card.questions.map((question) => {
        const answer = draft[question.id]!;
        return {
          questionId: question.id,
          selectedOptionIds: answer.selectedOptionIds,
          ...(answer.otherSelected && answer.otherText.trim() ? { otherText: answer.otherText.trim() } : {}),
        };
      }),
    };
    try {
      if (await props.onSubmit(response)) setSubmittedResponse(response);
      else setSubmitFailed(true);
    } catch {
      setSubmitFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-[18px] border border-border-stone/55 bg-background-paper p-4 shadow-sm" aria-label={props.card.title ?? t("home.question.title")}>
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-ink">
        <CircleHelp size={17} className="text-action-sky" aria-hidden="true" />
        <span>{props.card.title ?? t("home.question.title")}</span>
      </div>
      <div className="space-y-4">
        {props.card.questions.map((question) => {
          const draftAnswer = draft[question.id]!;
          const savedAnswer = completedResponse?.answers.find((answer) => answer.questionId === question.id);
          return (
            <fieldset key={question.id} className="space-y-2" disabled={answered || submitting}>
              <legend className="mb-2 text-sm leading-relaxed text-text-ink">{question.prompt}</legend>
              {answered ? (
                <div className="flex items-center gap-2 rounded-xl bg-action-sky/8 px-3 py-2 text-sm text-text-ink">
                  <Check size={15} className="shrink-0 text-action-sky" aria-hidden="true" />
                  <span>{responseLabel(question, savedAnswer)}</span>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap gap-2">
                    {question.options.map((option) => {
                      const selected = draftAnswer.selectedOptionIds.includes(option.id);
                      return (
                        <button
                          key={option.id}
                          type="button"
                          aria-pressed={selected}
                          title={option.description}
                          onClick={() => toggleOption(question, option.id)}
                          className={`rounded-xl border px-3 py-2 text-left text-sm transition-colors ${
                            selected
                              ? "border-action-sky bg-action-sky/10 text-text-ink"
                              : "border-border-stone/55 bg-canvas-oat/45 text-text-ink/75 hover:border-action-sky/45 hover:bg-action-sky/5"
                          }`}
                        >
                          <span className="font-medium">{option.label}</span>
                          {option.description ? <span className="mt-0.5 block text-xs text-text-ink/50">{option.description}</span> : null}
                        </button>
                      );
                    })}
                    {question.allowOther ? (
                      <button
                        type="button"
                        aria-pressed={draftAnswer.otherSelected}
                        onClick={() => toggleOther(question)}
                        className={`rounded-xl border px-3 py-2 text-sm transition-colors ${
                          draftAnswer.otherSelected
                            ? "border-action-sky bg-action-sky/10 text-text-ink"
                            : "border-border-stone/55 bg-canvas-oat/45 text-text-ink/75 hover:border-action-sky/45 hover:bg-action-sky/5"
                        }`}
                      >
                        {t("home.question.other")}
                      </button>
                    ) : null}
                  </div>
                  {draftAnswer.otherSelected ? (
                    <textarea
                      value={draftAnswer.otherText}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        [question.id]: { ...current[question.id]!, otherText: event.target.value },
                      }))}
                      placeholder={t("home.question.otherPlaceholder")}
                      rows={2}
                      className="w-full resize-y rounded-xl border border-border-stone/55 bg-background-paper px-3 py-2 text-sm text-text-ink outline-none transition focus:border-action-sky focus:ring-2 focus:ring-action-sky/15"
                    />
                  ) : null}
                </>
              )}
            </fieldset>
          );
        })}
      </div>
      {!answered ? (
        <div className="mt-4 flex items-center justify-end gap-3">
          {submitFailed ? <span className="text-xs text-red-600">{t("home.question.submitFailed")}</span> : null}
          <button
            type="button"
            disabled={!canSubmit || !props.onSubmit || submitting}
            onClick={() => void submit()}
            className="inline-flex min-h-9 items-center justify-center gap-2 rounded-xl bg-action-sky px-4 py-2 text-sm font-semibold text-white transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {submitting ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : null}
            {submitting ? t("home.question.submitting") : t("home.question.submit")}
          </button>
        </div>
      ) : (
        <div className="mt-3 text-xs text-text-ink/45">
          {persistedResponse ? t("home.question.answered") : t("home.question.submitted")}
        </div>
      )}
    </section>
  );
}
