/** Overview view — memory quantities, configured models, and daily activity. */
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import { health } from "../stores/health";
import { t } from "../stores/i18n";
import { navigate } from "../stores/router";
import { DailyActivityCard, type DailyActivityPoint } from "./overview/DailyActivityCard";
import {
  formatModelStatusLine,
  modelScalarText,
  modelStatusFromInfo,
  type ModelInfo,
} from "./overview/model-status";

interface SkillStats {
  total: number;
  active: number;
  candidate: number;
  archived: number;
}
interface PolicyStats {
  total: number;
  active: number;
  candidate: number;
  archived: number;
}
interface OverviewSummary {
  ok?: boolean;
  version?: string;
  episodes?: number;
  traces?: number;
  userMemories?: number;
  skills?: SkillStats;
  policies?: PolicyStats;
  worldModels?: number;
  llm?: ModelInfo;
  embedder?: ModelInfo;
  skillEvolver?: ModelInfo;
  dailyActivity?: DailyActivityPoint[];
}

export function OverviewView() {
  const [summary, setSummary] = useState<OverviewSummary | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      api
        .get<OverviewSummary>("/api/v1/overview", { signal: ctrl.signal })
        .then(setSummary)
        .catch(() => void 0);
    void load();
    // Re-poll every 20s so the numbers drift as the agent runs.
    const id = window.setInterval(load, 20_000);
    return () => {
      ctrl.abort();
      window.clearInterval(id);
    };
  }, []);

  const h = health.value;
  const skills = summary?.skills;
  const policies = summary?.policies;
  // Prefer summary model info (freshly aggregated) and fall back to the
  // health ping for first-paint before `/api/v1/overview` resolves.
  const llm = summary?.llm ?? h?.llm;
  const embedder = summary?.embedder ?? h?.embedder;
  const skillEvolver = summary?.skillEvolver ?? h?.skillEvolver;

  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("overview.title")}</h1>
        </div>
      </div>

      <section class="metric-grid">
        <QuantityCard
          label={t("overview.metric.memories")}
          value={summary?.traces}
          onClick={() => navigate("/memories")}
        />
        <QuantityCard
          label={t("overview.metric.policies")}
          value={policies?.total}
          hint={
            policies
              ? t("overview.metric.policies.breakdown", {
                  active: policies.active,
                  candidate: policies.candidate,
                })
              : undefined
          }
          onClick={() => navigate("/policies")}
        />
        <QuantityCard
          label={t("overview.metric.worldModels")}
          value={summary?.worldModels}
          onClick={() => navigate("/world-models")}
        />
        <QuantityCard
          label={t("overview.metric.skills")}
          value={skills?.total}
          hint={
            skills
              ? t("overview.metric.skills.breakdown", {
                  active: skills.active,
                  candidate: skills.candidate,
                })
              : undefined
          }
          onClick={() => navigate("/skills")}
        />
        <QuantityCard
          label={t("overview.metric.userMemories")}
          value={summary?.userMemories}
          onClick={() => navigate("/user-memories")}
        />
      </section>

      <section class="metric-grid">
        <ModelCard
          label={t("overview.metric.embedder")}
          info={embedder}
          onClick={() => navigate("/settings", { tab: "models" })}
        />
        <ModelCard
          label={t("overview.metric.llm")}
          info={llm}
          onClick={() => navigate("/settings", { tab: "models" })}
        />
        <ModelCard
          label={t("overview.metric.skillEvolver")}
          info={skillEvolver}
          hint={
            skillEvolver?.inherited
              ? t("overview.metric.skillEvolver.inherit")
              : undefined
          }
          onClick={() => navigate("/settings", { tab: "models" })}
        />
      </section>

      <DailyActivityCard values={summary?.dailyActivity ?? []} />
    </>
  );
}

function QuantityCard({
  label,
  value,
  hint,
  onClick,
}: {
  label: string;
  value: number | undefined;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      class="metric metric--clickable"
      onClick={onClick}
      aria-label={label}
    >
      <div class="metric__label">{label}</div>
      <div class="metric__value">{value == null ? "—" : value}</div>
      {/*
       * Always render the hint slot so every card in a row has the
       * same vertical rhythm — the value baseline lines up across
       * sibling cards even when some have hints and others don't.
       * Non-breaking space keeps the line height when empty.
       */}
      <div class="metric__delta">{hint ?? "\u00a0"}</div>
    </button>
  );
}

function ModelCard({
  label,
  info,
  hint,
  onClick,
}: {
  label: string;
  info: ModelInfo | undefined;
  hint?: string;
  onClick?: () => void;
}) {
  const model = modelScalarText(info?.model).trim();
  const display = model ? model : t("overview.metric.model.unconfigured");
  const status = modelStatusFromInfo(info);
  const titleAttr = status.tooltip
    ? `${model || label}\n\n${status.tooltip}`
    : model || label;
  return (
    <button
      type="button"
      class="metric metric--clickable"
      onClick={onClick}
      aria-label={label}
      title={titleAttr}
    >
      <div
        class="metric__label"
        style="display:flex;align-items:center;gap:6px;justify-content:center"
      >
        <span class={`status-dot status-dot--${status.kind}`} aria-hidden="true" />
        {label}
      </div>
      <div
        class="metric__value"
        style="font-size:var(--fs-lg);font-family:var(--font-mono, monospace);word-break:break-all"
        title={model || label}
      >
        {display}
      </div>
      <div class="metric__delta">
        {formatModelStatusLine(status.label, hint, info?.provider)}
      </div>
    </button>
  );
}
