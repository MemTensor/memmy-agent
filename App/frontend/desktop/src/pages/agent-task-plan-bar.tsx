import "./agent-task-plan-bar.css";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Circle,
  ListChecks,
  LoaderCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AgentTaskPlanItemStatus,
  AgentTaskPlanState,
} from "../api/memmy-agent-client.js";
import { useTranslation } from "../i18n/use-translation.js";

export interface AgentTaskPlanBarProps {
  plan: AgentTaskPlanState;
  /** The enclosing turn process supplies the disclosure and status. */
  embeddedInProcess?: boolean;
  /** Keep the checklist open while its owning turn is running. */
  runActive?: boolean;
}

export function AgentTaskPlanBar({ plan, embeddedInProcess = false, runActive = false }: AgentTaskPlanBarProps) {
  const { t } = useTranslation();
  const autoCollapsed = plan.status !== "active" || !runActive;
  const [collapsed, setCollapsed] = useState(autoCollapsed);

  useEffect(() => {
    setCollapsed(autoCollapsed);
  }, [autoCollapsed, plan.plan_id]);

  if (!plan.plan_id || !plan.status || plan.items.length === 0) return null;

  const completed = plan.items.filter((item) => item.status === "completed").length;
  const progressLabel = t("home.taskPlan.progress", {
    completed,
    total: plan.items.length,
  });
  const visibleStatus = plan.status === "active" && !runActive ? "paused" : plan.status;
  const header = <>
    <span className="agent-task-plan-bar__heading">
      <ListChecks aria-hidden="true" />
      <span className="agent-task-plan-bar__title">{t("home.taskPlan.title")}</span>
    </span>
    <span className="agent-task-plan-bar__summary">
      {!embeddedInProcess ? <span className={`agent-task-plan-bar__status agent-task-plan-bar__status--${visibleStatus}`}>
        {t(`home.taskPlan.status.${visibleStatus}`)}
      </span> : null}
      <span className="agent-task-plan-bar__progress">{progressLabel}</span>
      <ChevronDown className="agent-task-plan-bar__chevron" aria-hidden="true" />
    </span>
  </>;

  return (
    <section
      className={`agent-task-plan-bar agent-task-plan-bar--${plan.status}${embeddedInProcess ? " agent-task-plan-bar--embedded" : ""}`}
      aria-label={t("home.taskPlan.title")}
    >
      <button
        type="button"
        className="agent-task-plan-bar__header"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >{header}</button>

      {!collapsed ? (
        <ol className="agent-task-plan-bar__items">
          {plan.items.map((item) => {
            const status = !runActive && item.status === "in_progress" ? "pending" : item.status;
            return (
            <li
              key={item.id}
              className={`agent-task-plan-bar__item agent-task-plan-bar__item--${status}`}
            >
              <TaskPlanItemIcon status={status} />
              <span>{item.content}</span>
            </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

function TaskPlanItemIcon({ status }: { status: AgentTaskPlanItemStatus }) {
  if (status === "completed") return <CheckCircle2 aria-hidden="true" />;
  if (status === "in_progress") return <LoaderCircle aria-hidden="true" />;
  if (status === "blocked") return <AlertCircle aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
}
