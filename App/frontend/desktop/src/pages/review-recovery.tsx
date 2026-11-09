import { useRef, useState } from "react";
import type { PluginUiCall } from "../app/plugin-ui-context.js";
import { useOptionalApiClients } from "../app/providers.js";
import { useTranslation } from "../i18n/use-translation.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function reviewRecovery(call: PluginUiCall) {
  if (call.pluginId !== "literature-review") return null;
  const terminal = call.events.find(event => event.type === "error" || event.type === "result");
  if (!terminal) return null;
  if (terminal.type === "error" && terminal.recovery) {
    return { taskId: terminal.recovery.taskId, runId: terminal.recovery.runId, capabilityId: "review_resume", input: terminal.recovery };
  }
  if (terminal.type !== "result") return null;
  const output = record(terminal.output);
  const data = record(output.data);
  const generation = record(data.generation ?? record(data.result).generation);
  if (typeof output.taskId !== "string" || !generation.safeToResume || !Array.isArray(output.suggestedNextTools)) return null;
  const next = output.suggestedNextTools.map(record).find(tool => tool.toolName === "review_generate_sections");
  if (!next) return null;
  return { taskId: output.taskId, runId: undefined, capabilityId: "review_generate_sections", input: { ...record(next.args), taskId: output.taskId } };
}

export function ReviewRecovery({ call }: { call: PluginUiCall }) {
  const { clients } = useOptionalApiClients();
  const { t } = useTranslation();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState<{ sections: number; paragraphs: number }>();
  const [continuation, setContinuation] = useState<PluginUiCall>();
  const recovery = reviewRecovery(continuation ?? call);
  if (!clients || !recovery) return null;
  const resume = async () => {
    if (busyRef.current || started) return;
    busyRef.current = true; setBusy(true); setNotice("");
    try {
      const status = await clients.plugins.invoke(call.pluginId, "review_get_status", { conversationId: call.conversationId, origin: "user", input: { taskId: recovery.taskId } });
      if (status.event.type !== "result") throw new Error("Status unavailable");
      const output = record(status.event.output);
      if (output.ok !== true) throw new Error("Status failed");
      const data = record(output.data);
      const runs = Array.isArray(data.runs) ? data.runs.map(record) : [];
      if (data.cancelled === true) { setStarted(true); setNotice(t("review.recovery.done")); return; }
      if (runs.some(run => run.status === "running")) { setNotice(t("review.recovery.running")); return; }
      const generation = record(data.sectionGeneration);
      const paragraphs = Array.isArray(generation.paragraphProgress) ? generation.paragraphProgress.map(record).reduce((sum, item) => sum + Number(item.savedModelParagraphs ?? 0), 0) : 0;
      setSaved({ sections: Array.isArray(generation.completedOutlineNodeIds) ? generation.completedOutlineNodeIds.length : 0, paragraphs });
      if (recovery.runId) {
        const recoverable = Array.isArray(data.recoverableRuns) ? data.recoverableRuns.map(record) : [];
        if (!recoverable.some(run => run.runId === recovery.runId)) { setStarted(true); setNotice(t("review.recovery.done")); return; }
      } else if (!Array.isArray(generation.pendingOutlineNodeIds) || generation.pendingOutlineNodeIds.length === 0) {
        setStarted(true); setNotice(t("review.recovery.done")); return;
      }
      const result = await clients.plugins.invoke(call.pluginId, recovery.capabilityId, { conversationId: call.conversationId, origin: "user", input: recovery.input });
      if (result.event.type === "error" || (result.event.type === "result" && record(result.event.output).ok === false)) throw new Error("Resume failed");
      const nextCall = { ...call, callId: result.callId, events: [result.event] };
      if (reviewRecovery(nextCall)) setContinuation(nextCall);
      else setStarted(true);
      setNotice(result.event.type === "result" && typeof record(result.event.output).summary === "string"
        ? String(record(result.event.output).summary) : t("review.recovery.started"));
    } catch { setNotice(t("review.recovery.failed")); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className="plugin-tool-activity">
    <p>{t("review.recovery.saved")}</p>
    {saved ? <p>{t("review.recovery.progress", saved)}</p> : null}
    <button type="button" disabled={busy || started} onClick={() => void resume()}>{t(busy ? "review.recovery.busy" : "review.recovery.continue")}</button>
    {notice ? <p role="status">{notice}</p> : null}
  </div>;
}
