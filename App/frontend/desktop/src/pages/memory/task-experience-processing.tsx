import { useEffect, useRef, useState } from "react";
import type { MemoryRuntimeClient, TaskExperienceProcessing } from "../../api/memory-runtime-client.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { usePanelReadGuard, usePanelVisible } from "./panel-visibility.js";
import { toErrorMessage } from "./remote-state.js";

/** Separate from task outcome and Skill status: either can succeed while experience generation fails. */
export function TaskExperienceProcessingCard({ client, episodeId }: { client: MemoryRuntimeClient; episodeId: string }) {
  const { t } = useTranslation();
  const visible = usePanelVisible();
  const canRead = usePanelReadGuard(client);
  const activeRead = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<TaskExperienceProcessing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0), requestVersion = useRef(0), submitting = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    let reading = false;
    submitting.current = false; setBusy(false); setStatus(null); setError("");
    if (!visible) return;
    const refresh = async () => {
      if (!canRead() || reading || submitting.current || !client.taskExperienceProcessing) return;
      reading = true;
      const version = ++requestVersion.current;
      const controller = new AbortController();
      activeRead.current = controller;
      try {
        const result = await client.taskExperienceProcessing(episodeId, controller.signal);
        if (!controller.signal.aborted && canRead() && generation.current === current && requestVersion.current === version && !submitting.current) { setStatus(result); setError(""); }
      } catch (err) {
        if (!controller.signal.aborted && canRead() && generation.current === current && requestVersion.current === version && !submitting.current) setError(toErrorMessage(err));
      } finally { reading = false; if (activeRead.current === controller) activeRead.current = null; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { generation.current++; activeRead.current?.abort(); activeRead.current = null; window.clearInterval(timer); };
  }, [client, episodeId, visible]);

  async function retry() {
    if (!canRead() || submitting.current || !client.retryTaskExperienceProcessing || !status?.canRetry) return;
    const current = generation.current;
    requestVersion.current++;
    activeRead.current?.abort();
    submitting.current = true; setBusy(true); setError("");
    try {
      const result = await client.retryTaskExperienceProcessing(episodeId);
      if (canRead() && current === generation.current) setStatus(result);
    } catch (err) {
      if (canRead() && current === generation.current) setError(toErrorMessage(err));
    } finally {
      if (canRead() && current === generation.current) { submitting.current = false; setBusy(false); }
    }
  }
  if (!visible || !client.taskExperienceProcessing) return null;
  return <section className="memory-detail-card" aria-label={t("memory.tasks.experience.title")}>
    <h5 className="memory-detail-card__label">{t("memory.tasks.experience.title")}</h5>
    <div role="status">{status ? t(`memory.tasks.experience.${status.state}`) : t("memory.tasks.experience.loading")}</div>
    {status && status.pendingCount > 0 && <p>{t("memory.tasks.experience.pendingCount", { count: status.pendingCount })}</p>}
    {status?.errorCode && status.state === "failed" && <p>{t(`memory.tasks.experience.${status.errorCode}`)}</p>}
    {error && <p role="alert">{error}</p>}
    {status?.canRetry && <button type="button" className="memory-processing-action memory-processing-action--primary" disabled={busy} onClick={() => void retry()}>
      {t(busy ? "memory.tasks.experience.submitting" : "memory.tasks.experience.retry")}
    </button>}
  </section>;
}
