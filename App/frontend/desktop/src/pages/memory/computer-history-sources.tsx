import { useEffect, useState } from "react";
import type { ComputerHistoryObservationSettings } from "../../api/computer-history-contract.js";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { useTranslation } from "../../i18n/use-translation.js";

/** The compact settings rows; app and website rules are edited in the scope dialog. */
export function ComputerHistorySources({ client, syncStatus, onChoose }: {
  client: MemmyAgentClient | null;
  onChoose(): void;
  syncStatus?: { lastSyncedAt: string | null; error: string | null;
    skillError?: string | null; pendingDeletionCount?: number };
}) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<ComputerHistoryObservationSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSettings(null);
    setError(null);
    if (!client) return;
    let active = true;
    void client.getComputerHistorySettings().then((value) => {
      if (active) setSettings(value);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, [client]);

  const selectedCount = settings?.observation.rules.length ?? 0;
  const pendingDeletion = syncStatus?.pendingDeletionCount ?? 0;
  const skillError = syncStatus?.skillError ?? "";
  const skillStatuses = [...new Set(skillError ? skillError.split("; ").map((error) => {
    const prefix = "local Memory Skill suggestion failed (409): ";
    const reason = error.startsWith(prefix) ? error.slice(prefix.length) : "";
    const key = reason === "source meaningful memory requires retry"
      ? "computerHistory.sources.skillSourceRetryRequired"
      : reason === "source summary model is not configured" || reason === "evolution model is not configured"
        ? "computerHistory.sources.skillModelNotConfigured"
        : reason === "Skill evolution is disabled"
          ? "computerHistory.sources.skillEvolutionDisabled"
          : reason === "source meaningful memory is still processing or requires retry"
            ? "computerHistory.sources.skillSourceProcessing"
            : "computerHistory.sources.skillSuggestionDelayed";
    return t(key, { error });
  }) : [])];
  return <section className="ch__sources" aria-label={t("computerHistory.sources.title")}>
    <div className="ch__sources-row">
      <div className="ch__sources-copy">
        <div className="ch__setting-label">{t("computerHistory.sources.permissions")}</div>
        <p className="ch__setting-description">{t("computerHistory.sources.permissionsDescription")}</p>
      </div>
      <button type="button" className="ch__sources-choose" disabled={!client || busy} onClick={onChoose}>
        {selectedCount === 0
          ? t("computerHistory.sources.choose")
          : t("computerHistory.sources.selectedCount", { count: selectedCount })}
      </button>
    </div>
    {syncStatus?.error ? <p className="ch__sources-status" role="status">
      {t(pendingDeletion > 0 ? "computerHistory.sources.memoryRevokeFailed"
        : "computerHistory.sources.memorySyncFailed", { error: syncStatus.error })}
    </p> : null}
    {!syncStatus?.error && pendingDeletion > 0 ? <p className="ch__sources-status" role="status">
      {t("computerHistory.sources.memoryRevokePending")}
    </p> : null}
    {skillStatuses.map((message) => <p key={message} className="ch__sources-status" role="status">
      {message}
    </p>)}
    {error ? <p className="ch__sources-status ch__sources-status--error" role="alert">{error}</p> : null}
  </section>;
}
