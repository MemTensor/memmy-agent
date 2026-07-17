import { useEffect, useState } from "react";
import type { GetMemoryOutput, MemoryListItem, PanelItemsOutput } from "@memmy/local-api-contracts";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import type { MessageKey } from "../../i18n/messages.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { ChevronRight, Search, Sparkles, X } from "./memory-prototype-icons.js";
import { MemoryDrawerDeleteAction } from "./memory-delete-action.js";
import { toMemoryDetailErrorMessage } from "./memory-detail-error.js";
import { cleanMemoryBody, displayMemoryTitle, drawerEyebrow } from "./memory-display.js";
import {
  clearMemoryPanelCache,
  memoryPanelCacheKey,
  memoryPanelLatestCacheKey,
  readMemoryPanelCacheFirst,
  writeMemoryPanelCaches
} from "./memory-panel-cache.js";
import { MemoryPagination, normalizePage } from "./memory-pagination.js";
import { MemoryRefreshButton } from "./memory-refresh-button.js";
import { MemoryStateBox } from "./memory-state-box.js";
import { type RemoteData, toErrorMessage } from "./remote-state.js";

type DetailState = RemoteData<GetMemoryOutput> | null;
const POLICIES_CACHE_SECTION = "policies";
type PolicyStatusTone = "candidate" | "active" | "archived" | "deleted" | "unknown";

interface ExperienceView {
  title: string;
  status?: string;
  trigger?: string;
  procedure?: string;
  verification?: string;
  boundary?: string;
  support?: number;
  gain?: number;
  rawGain?: number;
  confidence?: number;
  sourceEpisodes: string[];
  sourceTraces: string[];
  preference: string[];
  antiPattern: string[];
  source?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PoliciesSubPageProps {
  client: MemoryRuntimeClient | null;
}

function policiesCacheKeys(query: string, page: number): string[] {
  return [
    memoryPanelCacheKey(POLICIES_CACHE_SECTION, query.trim(), normalizePage(page)),
    memoryPanelLatestCacheKey(POLICIES_CACHE_SECTION)
  ];
}

export function PoliciesSubPage(props: PoliciesSubPageProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<RemoteData<PanelItemsOutput>>({ status: "loading" });
  const [detail, setDetail] = useState<DetailState>(null);

  function refresh(nextPage = page, options: { useCache?: boolean } = {}): Promise<void> {
    if (!props.client) {
      const message = t("memory.clientNotReady");
      setState({ status: "error", message });
      return Promise.reject(new Error(message));
    }

    const normalizedPage = normalizePage(nextPage);
    const cacheKeys = policiesCacheKeys(query, normalizedPage);
    const cached = (options.useCache ?? true) ? readMemoryPanelCacheFirst<PanelItemsOutput>(cacheKeys) : null;
    if (cached) {
      setState({ status: "ready", data: cached });
    } else {
      setState((current) => current.status === "ready" ? current : { status: "loading" });
    }

    return props.client
      .listPanelItems({ layer: "L2", q: query.trim() || undefined, page: normalizedPage })
      .then((data) => {
        writeMemoryPanelCaches(cacheKeys, data);
        setState({ status: "ready", data });
      })
      .catch((error) => {
        setState({ status: "error", message: toErrorMessage(error) });
        throw error;
      });
  }

  function changeQuery(value: string) {
    setQuery(value);
    setDetail(null);
    setPage(1);
  }

  function runSearch() {
    setDetail(null);
    setPage(1);
    void refresh(1).catch(() => undefined);
  }

  function changePage(nextPage: number) {
    const normalizedPage = normalizePage(nextPage);
    if (normalizedPage === page) {
      return;
    }

    setDetail(null);
    setPage(normalizedPage);
    void refresh(normalizedPage).catch(() => undefined);
  }

  function openDetail(item: MemoryListItem) {
    if (!props.client) {
      setDetail({ status: "error", message: t("memory.clientNotReady") });
      return;
    }

    setDetail({ status: "loading" });
    void props.client
      .getMemory(item.id)
      .then((data) => setDetail({ status: "ready", data }))
      .catch((error) => setDetail({ status: "error", message: toMemoryDetailErrorMessage(error, t("memory.detailUnavailable")) }));
  }

  async function deleteDetail(id: string) {
    if (!props.client) {
      throw new Error(t("memory.clientNotReady"));
    }

    await props.client.deleteMemory(id);
    clearMemoryPanelCache();
    setDetail(null);
    void refresh(page, { useCache: false }).catch(() => undefined);
  }

  useEffect(() => {
    void refresh().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.client, t]);

  return (
    <section className="memory-panel">
      <div className="memory-panel__header">
        <div className="memory-panel__header-main">
          <h3 className="memory-panel__title">
            <Sparkles size={18} className="text-text-ink/60" />
            {t("memory.policies.title")}
          </h3>
          <p className="memory-panel__subtitle">{t("memory.policies.description")}</p>
        </div>
        <MemoryRefreshButton onClick={() => refresh(page, { useCache: false })} />
      </div>
      <div className="memory-toolbar">
        <label className="memory-search">
          <Search size={15} className="memory-search__icon" />
          <input
            type="search"
            value={query}
            placeholder={t("memory.policies.searchPlaceholder")}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                runSearch();
              }
            }}
            className="memory-search__input"
          />
        </label>
      </div>
      <ExperienceState
        state={state}
        detail={detail}
        onOpenDetail={openDetail}
        onDeleteDetail={deleteDetail}
        onCloseDetail={() => setDetail(null)}
        onPageChange={changePage}
      />
    </section>
  );
}

function ExperienceState(props: {
  state: RemoteData<PanelItemsOutput>;
  detail: DetailState;
  onOpenDetail: (item: MemoryListItem) => void;
  onDeleteDetail: (id: string) => Promise<void>;
  onCloseDetail: () => void;
  onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation();

  if (props.state.status === "loading") {
    return <MemoryStateBox message={t("memory.policies.loading")} />;
  }

  if (props.state.status === "error") {
    return <MemoryStateBox message={props.state.message} tone="error" />;
  }

  if (props.state.data.items.length === 0) {
    return <MemoryStateBox message={t("memory.policies.empty")} />;
  }

  return (
    <>
      <div className="memory-list">
        {props.state.data.items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => props.onOpenDetail(item)}
            className="memory-card"
          >
            <div className="memory-card__body">
              <div className="memory-card__title">{displayMemoryTitle(item)}</div>
              <div className="memory-card__meta">
                <PolicyStatusPill status={item.status} />
                <span>{t("memory.memories.updatedAt")}: {formatDateTime(item.updatedAt)}</span>
                {item.tags.slice(0, 4).map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            </div>
            <div className="memory-card__tail">
              <ChevronRight size={16} />
            </div>
          </button>
        ))}
      </div>
      <MemoryPagination data={props.state.data} onPageChange={props.onPageChange} />
      <ExperienceDrawer detail={props.detail} onClose={props.onCloseDetail} onDelete={props.onDeleteDetail} />
    </>
  );
}

function ExperienceDrawer(props: { detail: DetailState; onClose: () => void; onDelete: (id: string) => Promise<void> }) {
  const { t } = useTranslation();

  if (!props.detail) {
    return null;
  }

  const readyDetail = props.detail.status === "ready" ? props.detail.data : null;
  const title = readyDetail ? experienceFromDetail(readyDetail).title : t("memory.policies.detailTitle");
  const eyebrow = readyDetail ? drawerEyebrow(readyDetail.item) : t("memory.policies.detailTitle");

  return (
    <div className="memory-drawer-backdrop" onClick={props.onClose}>
      <button type="button" className="memory-drawer-backdrop__close" tabIndex={-1} aria-hidden="true" onClick={(e) => {
        e.stopPropagation();
        props.onClose();
      }} />
      <aside className="memory-drawer" role="dialog" aria-modal="true" aria-labelledby="memory-policy-title" onClick={(e) => e.stopPropagation()}>
        <header className="memory-drawer__header">
          <div>
            <div className="memory-drawer__identity">
              <span className="memory-drawer__eyebrow">{eyebrow}</span>
            </div>
            <h4 id="memory-policy-title" className="memory-drawer__title">{title}</h4>
          </div>
          <button type="button" className="memory-drawer__close" onClick={props.onClose} aria-label={t("common.close")}>
            <X size={16} />
          </button>
        </header>
        <div className="memory-drawer__body">
          {props.detail.status === "loading" && <MemoryStateBox message={t("memory.policies.detailLoading")} />}
          {props.detail.status === "error" && <MemoryStateBox message={props.detail.message} tone="error" />}
          {props.detail.status === "ready" && <ExperienceDetail detail={props.detail.data} />}
        </div>
        {readyDetail && <MemoryDrawerDeleteAction onDelete={() => props.onDelete(readyDetail.item.id)} />}
      </aside>
    </div>
  );
}

function ExperienceDetail(props: { detail: GetMemoryOutput }) {
  const { t } = useTranslation();
  const experience = experienceFromDetail(props.detail);

  return (
    <>
      <section className="memory-detail-card memory-detail-card--meta">
        <h5 className="memory-detail-card__label">{t("memory.memories.meta")}</h5>
        <div className="memory-detail-metrics">
          <Metric label={t("memory.memories.status")} value={policyStatusLabel(experience.status ?? props.detail.item.status, t)} />
          <Metric label={t("memory.policies.support")} value={formatNumber(experience.support, 0)} />
          <Metric label={t("memory.policies.gain")} value={formatNumber(experience.gain, 3)} />
          <Metric label={t("memory.policies.confidence")} value={formatNumber(experience.confidence, 2)} />
          <Metric label={t("memory.memories.createdAt")} value={formatDateTime(experience.createdAt ?? props.detail.item.createdAt)} />
          <Metric label={t("memory.memories.updatedAt")} value={formatDateTime(experience.updatedAt ?? props.detail.item.updatedAt)} />
        </div>
        {experience.source && (
          <div className="memory-policy-source">
            <span>{t("memory.tasks.source")}</span>
            {experience.source}
          </div>
        )}
      </section>

      <PolicySection title={t("memory.policies.trigger")} body={experience.trigger ?? props.detail.item.summary} />
      <PolicySection title={t("memory.policies.procedure")} body={experience.procedure ?? props.detail.item.body} />
      <PolicySection title={t("memory.policies.verification")} body={experience.verification} />
      <PolicySection title={t("memory.policies.boundary")} body={experience.boundary} />

      <GuidanceSection preference={experience.preference} antiPattern={experience.antiPattern} />

      <LinkedIdsSection
        title={t("memory.policies.sourceTasks")}
        ids={experience.sourceEpisodes}
        empty={t("memory.policies.noSourceTasks")}
      />
      <LinkedIdsSection
        title={t("memory.policies.sourceMemories")}
        ids={experience.sourceTraces.length > 0 ? experience.sourceTraces : props.detail.item.sourceMemoryIds}
        empty={t("memory.policies.noSourceMemories")}
      />
    </>
  );
}

function Metric(props: { label: string; value: string }) {
  return (
    <div className="memory-detail-metric">
      <div className="memory-detail-metric__label">{props.label}</div>
      <div className="memory-detail-metric__value">{props.value}</div>
    </div>
  );
}

function PolicySection(props: { title: string; body?: string }) {
  return (
    <section className="memory-detail-card">
      <h5 className="memory-detail-card__label">{props.title}</h5>
      <div className="memory-policy-section-body">{cleanMemoryBody(props.body) || "-"}</div>
    </section>
  );
}

function GuidanceSection(props: { preference: string[]; antiPattern: string[] }) {
  const { t } = useTranslation();
  const hasGuidance = props.preference.length > 0 || props.antiPattern.length > 0;

  return (
    <section className="memory-detail-card">
      <h5 className="memory-detail-card__label">{t("memory.policies.guidance")}</h5>
      {!hasGuidance && <div className="memory-policy-empty">{t("memory.policies.guidanceEmpty")}</div>}
      {props.preference.length > 0 && <GuidanceList title={t("memory.policies.prefer")} entries={props.preference} tone="prefer" />}
      {props.antiPattern.length > 0 && <GuidanceList title={t("memory.policies.avoid")} entries={props.antiPattern} tone="avoid" />}
    </section>
  );
}

function GuidanceList(props: { title: string; entries: string[]; tone: "prefer" | "avoid" }) {
  return (
    <div className={`memory-policy-guidance memory-policy-guidance--${props.tone}`}>
      <div className="memory-policy-guidance__title">{props.title}</div>
      <ul className="memory-policy-guidance__list">
        {props.entries.map((entry, index) => (
          <li key={`${props.tone}-${index}`}>{entry}</li>
        ))}
      </ul>
    </div>
  );
}

function LinkedIdsSection(props: { title: string; ids: string[]; empty: string }) {
  const uniqueIds = uniqueStrings(props.ids);

  return (
    <section className="memory-detail-card">
      <h5 className="memory-detail-card__label">{props.title}</h5>
      {uniqueIds.length === 0 ? (
        <div className="memory-policy-empty">{props.empty}</div>
      ) : (
        <div className="memory-policy-id-list">
          {uniqueIds.map((id) => (
            <span key={id} className="memory-policy-id">{compactId(id)}</span>
          ))}
        </div>
      )}
    </section>
  );
}

export function PolicyStatusPill(props: { status?: string }) {
  const { t } = useTranslation();

  return <span className={`memory-pill memory-pill--policy-${policyStatusTone(props.status)}`}>{policyStatusLabel(props.status, t)}</span>;
}

function experienceFromDetail(detail: GetMemoryOutput): ExperienceView {
  const metadata = detail.item.metadata;
  const properties = recordValue(metadata.properties);
  const info = recordValue(metadata.info);
  const internalInfo = recordValue(properties.internal_info);
  const policy = recordValue(internalInfo.policy);
  const decisionGuidance = recordValue(
    firstDefined(policy.decision_guidance, policy.decisionGuidance, internalInfo.decision_guidance, internalInfo.decisionGuidance)
  );

  return {
    title: displayMemoryTitle(detail.item, firstString(policy.title, internalInfo.title)),
    status: firstString(policy.status, internalInfo.status, info.status, detail.item.status),
    trigger: firstString(policy.trigger, internalInfo.trigger, parseBodyField(detail.item.body, "Trigger")),
    procedure: firstString(policy.procedure, policy.action, internalInfo.procedure, parseBodyField(detail.item.body, "Procedure")),
    verification: firstString(policy.verification, internalInfo.verification, parseBodyField(detail.item.body, "Verification")),
    boundary: firstString(policy.boundary, policy.caveats, internalInfo.boundary, parseBodyField(detail.item.body, "Boundary")),
    support: numberValue(policy.support) ?? numberValue(internalInfo.support) ?? numberValue(info.support),
    gain: numberValue(policy.gain) ?? numberValue(internalInfo.gain) ?? numberValue(info.gain),
    rawGain: numberValue(policy.raw_gain) ?? numberValue(policy.rawGain) ?? numberValue(internalInfo.raw_gain) ?? numberValue(info.raw_gain),
    confidence: numberValue(policy.policy_confidence) ?? numberValue(internalInfo.policy_confidence) ?? numberValue(info.policy_confidence),
    sourceEpisodes: stringArray(policy.source_episode_ids ?? internalInfo.source_episode_ids),
    sourceTraces: stringArray(policy.source_trace_ids ?? internalInfo.source_trace_ids ?? internalInfo.source_memory_ids),
    preference: stringArray(decisionGuidance.preference),
    antiPattern: stringArray(decisionGuidance.antiPattern ?? decisionGuidance.anti_pattern),
    source: firstString(metadata.source, internalInfo.source),
    createdAt: detail.item.createdAt,
    updatedAt: detail.item.updatedAt
  };
}

function parseBodyField(body: string, label: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.toLowerCase().startsWith(`${label.toLowerCase()}:`));
  if (startIndex < 0) {
    return undefined;
  }

  const first = (lines[startIndex] ?? "").slice(label.length + 1).trim();
  const chunks = first ? [first] : [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^[A-Z][A-Za-z ]{1,30}:\s*/.test(line)) {
      break;
    }
    chunks.push(line);
  }

  return chunks.join("\n").trim() || undefined;
}

export function policyStatusTone(status: string | undefined): PolicyStatusTone {
  const toneByStatus: Record<string, PolicyStatusTone> = {
    resolving: "candidate",
    candidate: "candidate",
    activated: "active",
    active: "active",
    archived: "archived",
    deleted: "deleted"
  };

  return toneByStatus[status ?? ""] ?? "unknown";
}

function policyStatusLabel(status: string | undefined, t: (key: MessageKey) => string): string {
  const keyByTone: Record<PolicyStatusTone, MessageKey> = {
    candidate: "memory.policies.status.candidate",
    active: "memory.policies.status.active",
    archived: "memory.policies.status.archived",
    deleted: "memory.memories.status.deleted",
    unknown: "memory.policies.status.unknown"
  };

  return t(keyByTone[policyStatusTone(status)]);
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function formatNumber(value: number | undefined, digits: number): string {
  return value === undefined ? "-" : value.toFixed(digits);
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function compactId(id: string): string {
  const parts = id.split("::");
  const value = parts[parts.length - 1] ?? id;
  return value.length > 22 ? `${value.slice(0, 18)}...` : value;
}
