import { useState, type ReactNode } from "react";
import type { GetMemoryOutput } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { formatUserDateTime } from "../../lib/user-time-zone.js";
import { MemoryAgentSourceTag } from "./memory-agent-source-tag.js";
import { MemoryMarkdown } from "./memory-markdown.js";
import { MemoryReferenceTags } from "./memory-reference-tags.js";
import { cleanMemoryBody, memoryDisplaySource } from "./memory-display.js";

type ObservationItem = GetMemoryOutput["item"];

export function observationDisplayMetadata(item: ObservationItem) {
  const info = record(item.metadata.info);
  const internal = record(record(item.metadata.properties).internal_info);
  const evidence = record(internal.external_evidence);
  const observation = record(internal.observation_memory);
  const provenance = record(evidence.provenance ?? info.provenance);
  const state = observation.schema_version === 1 && (observation.status === "processed" || observation.status === "skipped")
    ? observation.status
    : "pending";
  return {
    state,
    reason: string(observation.skip_reason),
    startedAt: string(evidence.startedAt) ?? string(info.started_at),
    endedAt: string(evidence.endedAt) ?? string(info.ended_at),
    revision: string(evidence.revision),
    processedAt: string(observation.processed_at),
    sourceTitle: string(evidence.source_title) ?? item.title,
    sourceContent: string(evidence.source_content) ?? (state === "processed" ? undefined : item.body),
    historyId: string(provenance.historyId) ?? string(evidence.sourceRecordId),
    applications: Array.isArray(provenance.applications)
      ? provenance.applications.filter((value): value is string => typeof value === "string")
      : [],
  };
}

/** The file path comes from the live History service, never from memory text. */
export async function openObservationHistorySource(
  client: Pick<MemmyAgentClient, "getComputerHistory">,
  historyId: string,
  unavailableMessage: string,
): Promise<void> {
  const snapshot = await client.getComputerHistory();
  const entry = snapshot.histories.find((history) => history.id === historyId);
  const open = window.memmy?.openComputerHistoryMarkdown;
  if (!entry || typeof open !== "function") throw new Error(unavailableMessage);
  await open(entry.filePath);
}

export function ObservedMemoryDetail(props: {
  item: ObservationItem;
  processingNotice?: ReactNode;
  onOpenHistorySource?: (historyId: string) => Promise<void>;
  onOpenSourceMemory?: (memoryId: string) => void;
}) {
  const { t } = useTranslation();
  const [openingSource, setOpeningSource] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const meta = observationDisplayMetadata(props.item);
  const processing = props.item.processing;
  const failed = processing?.state === "failed";
  const waitingForModel = processing?.errorCode === "summary_model_unconfigured" && meta.state === "pending";
  const processingKey = waitingForModel
    ? "memory.memories.observationWaitingForModel"
    : failed
    ? "memory.memories.processing.failed"
    : processing?.state === "embedding_pending" || processing?.state === "embedding"
      ? "memory.memories.processing.index"
      : meta.state === "processed"
        ? "memory.memories.observationProcessed"
        : meta.state === "skipped"
          ? "memory.memories.observationSkipped"
          : "memory.memories.observationPending";

  async function openSource() {
    if (!meta.historyId || !props.onOpenHistorySource) return;
    setOpeningSource(true);
    setSourceError(null);
    try {
      await props.onOpenHistorySource(meta.historyId);
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningSource(false);
    }
  }

  return (
    <div className="memory-observation-detail">
      {props.processingNotice}
      <section className="memory-detail-card memory-detail-card--meta">
        <h5 className="memory-detail-card__label">{t("memory.memories.meta")}</h5>
        <dl className="memory-detail-grid">
          <dt>{t("memory.memories.source")}</dt>
          <dd><MemoryAgentSourceTag sourceAgent={memoryDisplaySource(props.item)} label={t("memory.memories.source")} /></dd>
          {meta.startedAt && <><dt>{t("memory.memories.activityTime")}</dt><dd>{date(meta.startedAt)}{meta.endedAt ? ` – ${date(meta.endedAt)}` : ""}</dd></>}
          {meta.revision && <><dt>{t("memory.memories.sourceSummaryUpdatedAt")}</dt><dd>{date(meta.revision)}</dd></>}
          <dt>{t("memory.memories.observationProcessing")}</dt>
          <dd>{t(processingKey)}</dd>
          {meta.processedAt && <><dt>{t("memory.memories.observationProcessedAt")}</dt><dd>{date(meta.processedAt)}</dd></>}
          {meta.applications.length > 0 && <><dt>{t("computerHistory.sources.apps")}</dt><dd className="memory-observation-apps">{meta.applications.map((application, index) => <span className="memory-observation-app" key={`${application}:${index}`}>{applicationName(application)}</span>)}</dd></>}
        </dl>
      </section>
      {meta.state === "processed" ? (
        <>
          <section className="memory-detail-card">
            <h5 className="memory-detail-card__label">{t("memory.memories.summaryForRetrieval")}</h5>
            <div className="memory-detail-text">{props.item.summary}</div>
          </section>
          <section className="memory-detail-card">
            <h5 className="memory-detail-card__label">{t("memory.memories.observationContext")}</h5>
            <MemoryMarkdown text={cleanMemoryBody(props.item.body)} />
          </section>
        </>
      ) : (
        <section className="memory-detail-card" role="status">
          <h5 className="memory-detail-card__label">{t(processingKey)}</h5>
          <p>{meta.state === "skipped"
            ? meta.reason || t("memory.memories.observationSkippedDescription")
            : t(waitingForModel ? "memory.memories.observationWaitingForModelDescription" : failed ? "memory.memories.observationFailedDescription" : "memory.memories.observationPendingDescription")}</p>
        </section>
      )}
      {(meta.sourceContent || props.onOpenHistorySource && meta.historyId) && (
        <section className="memory-detail-card memory-observation-source">
          <h5 className="memory-detail-card__label">{t("memory.memories.observationSource")}</h5>
          <div className="memory-observation-source__body">
            <p className="memory-observation-source__title">{meta.sourceTitle}</p>
            {props.onOpenHistorySource && meta.historyId && <button type="button" className="memory-processing-action" disabled={openingSource} onClick={() => void openSource()}>{t("memory.memories.openHistorySource")}</button>}
            {sourceError && <p className="memory-observation-source__error" role="alert">{sourceError}</p>}
            {meta.sourceContent && <details><summary>{t("memory.memories.observationSourceContent")}</summary><MemoryMarkdown text={meta.sourceContent} /></details>}
          </div>
        </section>
      )}
      {props.onOpenSourceMemory && props.item.sourceMemoryIds.length > 0 && <section className="memory-detail-card">
        <h5 className="memory-detail-card__label">{t("memory.memories.sourceMemoryIds")}</h5>
        <MemoryReferenceTags ids={props.item.sourceMemoryIds} fallbackPage="memories" onOpen={props.onOpenSourceMemory} />
      </section>}
    </div>
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function date(value: string): string {
  return formatUserDateTime(value) || "-";
}
function applicationName(value: string): string {
  const known: Record<string, string> = {
    "com.TickTick.task.mac": "TickTick",
    "cn.memtensor.memmy": "Memmy",
    "com.openai.codex": "Codex",
    "com.openai.chat": "ChatGPT",
    "com.google.Chrome": "Chrome",
    "com.apple.Safari": "Safari",
    "com.microsoft.VSCode": "Visual Studio Code",
    "com.todesktop.230313mzl4w4u92": "Cursor",
    "com.tencent.xinWeChat": "WeChat",
  };
  return known[value] ?? value;
}
