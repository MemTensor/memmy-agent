import "./agent-confirmation-dock.css";
import { createContext, useContext, useState } from "react";
import { ChevronRight, MessageCircleQuestionMark } from "lucide-react";
import type { CapabilityEvent, InstalledPlugin } from "@memmy/local-api-contracts";
import { useOptionalPluginUi, type PluginUiCall } from "../app/plugin-ui-context.js";
import type { LegalQuestionRecord } from "../app/legal-question-history.js";
import { pluginInteractionCompletedLabel, questionWaitingLabel, reviewInteractionCompletedLabel } from "../app/plugin-interaction-waiting-label.js";
import { useTranslation } from "../i18n/use-translation.js";
import { reviewActionLabelsZh, reviewSkillLabels } from "../i18n/messages.js";
import type { AgentToolProgressEvent } from "../state/agent-tool-traces.js";

export function isPluginToolFailure(event: AgentToolProgressEvent): boolean {
  const name = event.name ?? event.function?.name ?? "";
  if (typeof name !== "string" || !name.startsWith("mcp_plugins_")) return false;
  if (event.phase === "error") return true;
  const result = event.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return (result as { isError?: unknown }).isError === true;
  }
  return typeof result === "string" && /^\s*(?:Error:|\(MCP tool call (?:was cancelled|timed out|failed))/iu.test(result);
}

/** Attach plugin detail only to the exact tool call that produced it. */
export function PluginToolActivity(props: { toolCallId?: string | null }) {
  const ui = useOptionalPluginUi();
  const { t, language } = useTranslation();
  if (!props.toolCallId || !ui) return null;
  const call = ui.calls.find((item) => item.agentToolCallId === props.toolCallId);
  const records = ui.legalQuestionHistory.filter((item) => item.agentToolCallId === props.toolCallId);
  const interactions = completedInteractions(call, ui.answeredInteractions, records);
  const terminal = call?.events.some((event) => event.type === "result" || event.type === "error");
  const progress = terminal ? undefined : call?.events.slice().reverse().find((event) => event.type === "progress");
  const tasks = terminal ? undefined : call?.events.slice().reverse().find((event) => event.type === "task-list");
  if (!records.length && !interactions.length && !progress && !tasks) return null;
  return <>
    {progress || tasks ? <div className="plugin-tool-activity">
      {progress?.type === "progress" && progress.message ? <p role="status">{progress.message}</p> : null}
      {tasks?.type === "task-list" ? <ul>{tasks.tasks.map((task) => <li key={task.id}>
        {task.title} · {t(`plugin.ui.task.${task.status}`)}
      </li>)}</ul> : null}
    </div> : null}
    {interactions.map((event) => <div key={event.request.interactionId}
      className="agent-question-answer agent-question-answer--process agent-question-answer--review">
      <MessageCircleQuestionMark size={14} aria-hidden="true" />
      <span className="agent-question-answer--review__label">{pluginInteractionCompletedLabel({
        call: { ...call!, events: [event] }, type: event.request.type,
        cardType: typeof event.request.payload === "object" && event.request.payload !== null
          && "cardType" in event.request.payload && typeof event.request.payload.cardType === "string"
          ? event.request.payload.cardType : ""
      }, language === "en-US")}</span>
    </div>)}
    {records.map((record) => <LegalQuestionProcessRecord key={record.interactionId} record={record} />)}
  </>;
}

function completedInteractions(
  call: PluginUiCall | undefined,
  answered: ReadonlySet<string>,
  questionRecords: readonly LegalQuestionRecord[]
): Array<Extract<CapabilityEvent, { type: "interaction" }>> {
  if (!call || call.origin !== "agent") return [];
  const completedCall = call.events.some((event) => event.type === "result");
  const questionIds = new Set(questionRecords.map((record) => record.interactionId));
  return call.events.filter((event): event is Extract<CapabilityEvent, { type: "interaction" }> =>
    event.type === "interaction" && !questionIds.has(event.request.interactionId)
      && (completedCall || answered.has(`${call.pluginId}:${call.callId}:${event.request.interactionId}`)));
}

export function useHasCompletedPluginInteraction(toolCallId?: string | null): boolean {
  const ui = useOptionalPluginUi();
  if (!toolCallId || !ui) return false;
  const call = ui.calls.find((item) => item.agentToolCallId === toolCallId);
  const records = ui.legalQuestionHistory.filter((item) => item.agentToolCallId === toolCallId);
  return completedInteractions(call, ui.answeredInteractions, records).length > 0;
}

function LegalQuestionProcessRecord({ record }: { record: LegalQuestionRecord }) {
  const { t, language } = useTranslation();
  const [open, setOpen] = useState(true);
  const label = record.status === "pending" ? questionWaitingLabel(record.title, language === "en-US")
    : t("home.question.asked");
  return record.status === "pending"
    ? <div className="agent-question-answer agent-question-answer--review">
        <MessageCircleQuestionMark size={14} aria-hidden="true" />
        <span className="agent-question-answer--review__label">{label}</span>
      </div>
    : <details className="agent-question-answer agent-question-answer--process" open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary><MessageCircleQuestionMark size={14} aria-hidden="true" />
          <span>{label}</span>
          <ChevronRight size={13} aria-hidden="true" />
        </summary>
        <dl className="agent-question-answer__details">{record.questions.map((question) => <div key={question.id}>
          <dt>{question.label}</dt><dd>{record.answers?.[question.id] || t("home.question.unanswered")}</dd>
        </div>)}</dl>
      </details>;
}

const EMPTY_LABELS: ReadonlyMap<string, string> = new Map();
export const PluginCapabilityLabelsContext = createContext<ReadonlyMap<string, string>>(EMPTY_LABELS);
const capabilityKey = (id: string) => id.toLowerCase().replace(/[^a-z0-9_]+/g, "_");

export function buildPluginCapabilityLabels(plugins: readonly InstalledPlugin[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const plugin of plugins) for (const capability of plugin.manifest.capabilities) {
    const key = capabilityKey(capability.id);
    const previous = labels.get(key);
    if (previous && previous !== capability.name) ambiguous.add(key);
    else labels.set(key, capability.name);
  }
  for (const key of ambiguous) labels.delete(key);
  return labels;
}
export function usePluginCapabilityLabel(event: AgentToolProgressEvent): string | undefined {
  const labels = useContext(PluginCapabilityLabelsContext);
  const { language } = useTranslation();
  const name = event.name ?? event.function?.name;
  if (typeof name !== "string") return undefined;
  if (name === "mcp_plugins_read_plugin_skill") {
    const args = event.arguments ?? event.function?.arguments;
    const pluginId = args && typeof args === "object" && "pluginId" in args ? args.pluginId : null;
    if (pluginId === "literature-review") return reviewSkillLabels[language].review;
    return reviewSkillLabels[language].generic;
  }
  if (!name.startsWith("mcp_plugins_plugin_")) return undefined;
  const key = capabilityKey(name.slice("mcp_plugins_plugin_".length).replace(/_[a-f0-9]{8}$/i, ""));
  if (key === "review_request_interaction") {
    const raw = event.arguments ?? event.function?.arguments;
    let args: unknown = raw;
    if (typeof raw === "string") {
      try { args = JSON.parse(raw); } catch { args = null; }
    }
    const cardType = args && typeof args === "object" && !Array.isArray(args)
      && typeof (args as { type?: unknown }).type === "string" ? (args as { type: string }).type : "";
    const action = reviewInteractionCompletedLabel(cardType, language === "en-US");
    if (action) return action;
  }
  if (language === "zh-CN" && key in reviewActionLabelsZh) return reviewActionLabelsZh[key];
  return labels.get(key);
}
