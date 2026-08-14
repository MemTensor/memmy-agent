import { Pause, Pencil, Play, Trash2, type LucideIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties
} from "react";
import type {
  AgentGoalControlAction,
  AgentGoalState
} from "../api/memmy-agent-client.js";
import { Tooltip } from "../components/tooltip.js";
import type { I18nContextValue } from "../i18n/i18n-provider.js";
import { useTranslation } from "../i18n/use-translation.js";
import type { AgentGoalRunClock } from "../state/agent-chat-slice.js";

type AgentGoalBarControlAction = Exclude<AgentGoalControlAction, "set_budget">;

export type AgentGoalControlRequest = {
  chatId: string;
  goalId: string;
  action: AgentGoalBarControlAction;
  objective?: string;
};

export interface AgentGoalBarProps {
  chatId: string;
  goal: AgentGoalState;
  clock: AgentGoalRunClock | null;
  pending: boolean;
  onControl: (request: AgentGoalControlRequest) => void;
}

type GoalForm = {
  chatId: string;
  goalId: string;
  value: string;
};

const OBJECTIVE_MAX_LENGTH = 12_000;

export function displayedGoalTimeSeconds(
  goal: AgentGoalState,
  clock: AgentGoalRunClock | null,
  nowMs = Date.now()
): number {
  if (!goal.goal_id || !clock || clock.goalId !== goal.goal_id) {
    return goal.time_used_seconds;
  }
  const elapsedSeconds = Math.max(0, Math.floor(nowMs / 1000 - clock.startedAt));
  return Math.max(goal.time_used_seconds, clock.baseSeconds + elapsedSeconds);
}

export function formatGoalDuration(totalSeconds: number, t: I18nContextValue["t"]): string {
  const normalizedSeconds = Number.isFinite(totalSeconds)
    ? Math.max(0, Math.floor(totalSeconds))
    : 0;
  const hours = Math.floor(normalizedSeconds / 3_600);
  const minutes = Math.floor(normalizedSeconds % 3_600 / 60);
  const seconds = normalizedSeconds % 60;

  if (hours > 0) {
    return t("home.goal.time.hours", { hours, minutes, seconds });
  }
  if (minutes > 0) {
    return t("home.goal.time.minutes", { minutes, seconds });
  }
  return t("home.goal.time.seconds", { seconds });
}

export function AgentGoalBar(props: AgentGoalBarProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<GoalForm | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const status = props.goal.status;
  const goalId = props.goal.goal_id;

  useEffect(() => {
    if (form && (form.chatId !== props.chatId || form.goalId !== goalId)) {
      setForm(null);
      setValidationError(null);
    }
  }, [form, goalId, props.chatId]);

  useEffect(() => {
    if (!status || status === "completed" || !goalId || props.clock?.goalId !== goalId) return;
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [goalId, props.clock?.goalId, props.clock?.startedAt, props.clock?.turnId, status]);

  if (!status || !goalId || status === "completed") return null;

  const canResume = status === "paused" || status === "blocked" || status === "usage_limited";
  const canEdit = status !== "active";
  const timeUsedSeconds = displayedGoalTimeSeconds(props.goal, props.clock, nowMs);
  const statusLabel = t(`home.goal.status.${status}`);
  const statusHint = status === "usage_limited"
    ? t("home.goal.usageLimitedHint")
    : status === "budget_limited"
      ? t("home.goal.budgetLimitedHint")
      : null;
  const timeLabel = formatGoalDuration(timeUsedSeconds, t);

  const control = (action: AgentGoalBarControlAction) => {
    props.onControl({ chatId: props.chatId, goalId, action });
  };

  const openEdit = () => {
    setValidationError(null);
    setForm({
      chatId: props.chatId,
      goalId,
      value: props.goal.objective
    });
  };

  const submitControl = (request: AgentGoalControlRequest) => {
    setForm(null);
    setValidationError(null);
    props.onControl(request);
  };

  const submitForm = () => {
    if (!form) return;
    const objective = form.value.trim();
    if (!objective || objective.length > OBJECTIVE_MAX_LENGTH) {
      setValidationError(t("home.goal.objectiveInvalid"));
      return;
    }
    submitControl({
      chatId: form.chatId,
      goalId: form.goalId,
      action: "edit",
      objective
    });
  };

  return (
    <section className="agent-goal-bar" aria-label={t("home.goal.title")}>
      <div className="agent-goal-bar__row">
        <Tooltip content={statusHint ? `${statusLabel} · ${statusHint}` : statusLabel}>
          <span
            className={`agent-goal-bar__status agent-goal-bar__status--${status}`}
            tabIndex={0}
          >
            {statusLabel}
          </span>
        </Tooltip>

        <GoalObjectiveMarquee objective={props.goal.objective} />

        <span className="agent-goal-bar__time">{timeLabel}</span>

        <div className="agent-goal-bar__actions">
          {status === "active" ? (
            <GoalIconButton
              icon={Pause}
              label={t("home.goal.pause")}
              disabled={props.pending}
              onClick={() => control("pause")}
            />
          ) : null}
          {canResume ? (
            <GoalIconButton
              icon={Play}
              label={t("home.goal.resume")}
              disabled={props.pending}
              onClick={() => control("resume")}
            />
          ) : null}
          {canEdit ? (
            <GoalIconButton
              icon={Pencil}
              label={t("common.edit")}
              disabled={props.pending}
              onClick={openEdit}
            />
          ) : null}
          <GoalIconButton
            icon={Trash2}
            label={t("home.goal.clear")}
            disabled={props.pending}
            danger
            onClick={() => control("clear")}
          />
        </div>
      </div>

      {form ? (
        <div className="agent-goal-bar__form">
          <textarea
            value={form.value}
            maxLength={OBJECTIVE_MAX_LENGTH + 1}
            disabled={props.pending}
            aria-label={t("home.goal.objective")}
            onChange={(event) => {
              setValidationError(null);
              setForm({ ...form, value: event.target.value });
            }}
          />
          {validationError ? <p role="alert" className="agent-goal-bar__validation">{validationError}</p> : null}
          <div className="agent-goal-bar__form-actions">
            <GoalFormButton disabled={props.pending} onClick={submitForm}>{t("common.save")}</GoalFormButton>
            <GoalFormButton disabled={props.pending} onClick={() => setForm(null)}>{t("common.cancel")}</GoalFormButton>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function GoalObjectiveMarquee(props: { objective: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);
  const objective = props.objective.replace(/\s+/gu, " ").trim();

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) return;

    const update = () => {
      setDistance(Math.max(0, text.scrollWidth - viewport.clientWidth));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [objective]);

  const marqueeStyle = {
    "--agent-goal-marquee-distance": `${distance}px`,
    "--agent-goal-marquee-duration": `${Math.min(8, Math.max(2.2, distance / 28))}s`
  } as CSSProperties;

  return (
    <span
      ref={viewportRef}
      className="agent-goal-bar__objective-viewport"
      aria-label={objective}
      tabIndex={distance > 1 ? 0 : undefined}
    >
      <span
        ref={textRef}
        className="agent-goal-bar__objective-text"
        data-overflow={distance > 1 ? "true" : undefined}
        style={marqueeStyle}
      >
        {objective}
      </span>
    </span>
  );
}

function GoalIconButton(props: {
  icon: LucideIcon;
  label: string;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <Tooltip content={props.label}>
      <button
        type="button"
        aria-label={props.label}
        disabled={props.disabled}
        className={props.danger
          ? "agent-goal-bar__icon-button agent-goal-bar__icon-button--danger"
          : "agent-goal-bar__icon-button"}
        onClick={props.onClick}
      >
        <Icon aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

function GoalFormButton(props: {
  children: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      className="agent-goal-bar__form-button"
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
