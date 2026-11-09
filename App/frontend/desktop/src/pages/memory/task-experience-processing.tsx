import { useEffect, useRef, useState } from "react";
import type { MemoryRuntimeClient, TaskExperienceProcessing } from "../../api/memory-runtime-client.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { toErrorMessage } from "./remote-state.js";

/** Separate from task outcome and Skill status: either can succeed while experience generation fails. */
export function TaskExperienceProcessingCard({ client, episodeId }: { client: MemoryRuntimeClient; episodeId: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TaskExperienceProcessing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0), requestVersion = useRef(0), submitting = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    let reading = false;
    submitting.current = false; setBusy(false); setStatus(null); setError("");
    const refresh = async () => {
      if (reading || submitting.current || !client.taskExperienceProcessing) return;
      reading = true;
      const version = ++requestVersion.current;
      try {
        const result = await client.taskExperienceProcessing(episodeId);
        if (generation.current === current && requestVersion.current === version && !submitting.current) { setStatus(result); setError(""); }
      } catch (err) {
        if (generation.current === current && requestVersion.current === version && !submitting.current) setError(toErrorMessage(err));
      } finally { reading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { generation.current++; window.clearInterval(timer); };
  }, [client, episodeId]);

  async function retry() {
    if (submitting.current || !client.retryTaskExperienceProcessing || !status?.canRetry) return;
    const current = generation.current;
    requestVersion.current++;
    submitting.current = true; setBusy(true); setError("");
    try {
      const result = await client.retryTaskExperienceProcessing(episodeId);
      if (current === generation.current) setStatus(result);
    } catch (err) {
      if (current === generation.current) setError(toErrorMessage(err));
    } finally {
      if (current === generation.current) { submitting.current = false; setBusy(false); }
    }
  }
  if (!client.taskExperienceProcessing) return null;
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
