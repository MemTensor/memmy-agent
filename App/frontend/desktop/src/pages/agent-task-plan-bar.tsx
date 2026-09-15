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
}

export function AgentTaskPlanBar({ plan }: AgentTaskPlanBarProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(plan.status === "completed");

  useEffect(() => {
    setCollapsed(plan.status === "completed");
  }, [plan.plan_id]);

  if (!plan.plan_id || !plan.status || plan.items.length === 0) return null;

  const completed = plan.items.filter((item) => item.status === "completed").length;
  const progressLabel = t("home.taskPlan.progress", {
    completed,
    total: plan.items.length,
  });

  return (
    <section
      className={`agent-task-plan-bar agent-task-plan-bar--${plan.status}`}
      aria-label={t("home.taskPlan.title")}
    >
      <button
        type="button"
        className="agent-task-plan-bar__header"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((value) => !value)}
      >
        <span className="agent-task-plan-bar__heading">
          <ListChecks aria-hidden="true" />
          <span className="agent-task-plan-bar__title">{plan.title}</span>
        </span>
        <span className="agent-task-plan-bar__summary">
          <span className={`agent-task-plan-bar__status agent-task-plan-bar__status--${plan.status}`}>
            {t(`home.taskPlan.status.${plan.status}`)}
          </span>
          <span className="agent-task-plan-bar__progress">{progressLabel}</span>
          <ChevronDown
            className="agent-task-plan-bar__chevron"
            aria-hidden="true"
          />
        </span>
      </button>

      {!collapsed ? (
        <ol className="agent-task-plan-bar__items">
          {plan.items.map((item) => (
            <li
              key={item.id}
              className={`agent-task-plan-bar__item agent-task-plan-bar__item--${item.status}`}
            >
              <TaskPlanItemIcon status={item.status} />
              <span>{item.content}</span>
            </li>
          ))}
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
