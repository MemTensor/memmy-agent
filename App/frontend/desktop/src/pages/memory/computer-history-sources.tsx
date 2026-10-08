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
    {syncStatus?.skillError ? <p className="ch__sources-status" role="status">
      {t("computerHistory.sources.skillSuggestionDelayed", { error: syncStatus.skillError })}
    </p> : null}
    {error ? <p className="ch__sources-status ch__sources-status--error" role="alert">{error}</p> : null}
  </section>;
}
