/** World model sub page module. */
import { useEffect, useState } from "react";
import type { GetMemoryOutput, MemoryListItem, PanelItemsOutput } from "@memmy/local-api-contracts";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import type { MessageKey } from "../../i18n/messages.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { ChevronRight, Globe2, Search, X } from "./memory-prototype-icons.js";
import { MemoryDrawerDeleteAction } from "./memory-delete-action.js";
import { toMemoryDetailErrorMessage } from "./memory-detail-error.js";
import { cleanMemoryBody, cleanMemoryText, drawerEyebrow } from "./memory-display.js";
import { displayMemoryId } from "./memory-id.js";
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

type WorldModelDetailState = RemoteData<GetMemoryOutput> | null;
const WORLD_MODEL_CACHE_SECTION = "world-model";
type WorldModelStatusTone = "candidate" | "active" | "archived" | "deleted" | "unknown";

interface WorldModelStructureEntry {
  label: string;
  description: string;
  evidenceIds: string[];
}

interface WorldModelStructure {
  environment: WorldModelStructureEntry[];
  inference: WorldModelStructureEntry[];
  constraints: WorldModelStructureEntry[];
}

interface WorldModelView {
  title: string;
  status: string;
  source?: string;
  createdAt: string;
  updatedAt: string;
  body: string;
  summary: string;
  policyIds: string[];
  sourceMemoryIds: string[];
  structure: WorldModelStructure;
}

/** Contract for world model sub page props. */
export interface WorldModelSubPageProps {
  client: MemoryRuntimeClient | null;
}

/** Reads load world model data. */
export function loadWorldModelData(client: MemoryRuntimeClient, query: string): Promise<PanelItemsOutput> {
  return loadWorldModelDataPage(client, query, 1);
}

export function loadWorldModelDataPage(client: MemoryRuntimeClient, query: string, page = 1): Promise<PanelItemsOutput> {
  return client.listPanelItems({ layer: "L3", q: query.trim() || undefined, page: normalizePage(page) });
}

/** Reads load world model detail. */
export function loadWorldModelDetail(client: MemoryRuntimeClient, worldModelId: string): Promise<GetMemoryOutput> {
  return client.getMemory(worldModelId);
}

function worldModelCacheKeys(query: string, page: number): string[] {
  return [
    memoryPanelCacheKey(WORLD_MODEL_CACHE_SECTION, query.trim(), normalizePage(page)),
    memoryPanelLatestCacheKey(WORLD_MODEL_CACHE_SECTION)
  ];
}

/** Handles world model sub page. */
export function WorldModelSubPage(props: WorldModelSubPageProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<RemoteData<PanelItemsOutput>>({ status: "loading" });
  const [detail, setDetail] = useState<WorldModelDetailState>(null);
  const [selectedWorldModelId, setSelectedWorldModelId] = useState<string | null>(null);

  function search(nextPage = page, options: { useCache?: boolean } = {}): Promise<void> {
    if (!props.client) {
      const message = t("memory.clientNotReady");
      setState({ status: "error", message });
      return Promise.reject(new Error(message));
    }

    const normalizedPage = normalizePage(nextPage);
    const cacheKeys = worldModelCacheKeys(query, normalizedPage);
    const cached = (options.useCache ?? true) ? readMemoryPanelCacheFirst<PanelItemsOutput>(cacheKeys) : null;
    if (cached) {
      setState({ status: "ready", data: cached });
    } else {
      setState((current) => current.status === "ready" ? current : { status: "loading" });
    }

    return loadWorldModelDataPage(props.client, query, normalizedPage)
      .then((data) => {
        writeMemoryPanelCaches(cacheKeys, data);
        setState({ status: "ready", data });
      })
      .catch((error) => {
        setState({ status: "error", message: toErrorMessage(error) });
        throw error;
      });
  }

  function openWorldModel(item: MemoryListItem) {
    setSelectedWorldModelId(item.id);
    if (!props.client) {
      setDetail({ status: "error", message: t("memory.clientNotReady") });
      return;
    }

    setDetail({ status: "loading" });
    void loadWorldModelDetail(props.client, item.id)
      .then((data) => setDetail({ status: "ready", data }))
      .catch((error) => setDetail({ status: "error", message: toMemoryDetailErrorMessage(error, t("memory.detailUnavailable")) }));
  }

  function closeWorldModel() {
    setDetail(null);
    setSelectedWorldModelId(null);
  }

  async function deleteWorldModel(id: string) {
    if (!props.client) {
      throw new Error(t("memory.clientNotReady"));
    }

    await props.client.deleteMemory(id);
    clearMemoryPanelCache();
    closeWorldModel();
    void search(page, { useCache: false }).catch(() => undefined);
  }

  function changeQuery(value: string) {
    setQuery(value);
    closeWorldModel();
    setPage(1);
  }

  function runSearch() {
    closeWorldModel();
    setPage(1);
    void search(1).catch(() => undefined);
  }

  function changePage(nextPage: number) {
    const normalizedPage = normalizePage(nextPage);
    if (normalizedPage === page) {
      return;
    }

    closeWorldModel();
    setPage(normalizedPage);
    void search(normalizedPage).catch(() => undefined);
  }

  useEffect(() => {
    void search().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.client, t]);

  return (
    <WorldModelSubPageView
      state={state}
      detail={detail}
      selectedWorldModelId={selectedWorldModelId}
      query={query}
      onQueryChange={changeQuery}
      onSearch={runSearch}
      onPageChange={changePage}
      onRefresh={() => search(page, { useCache: false })}
      onOpenWorldModel={openWorldModel}
      onDeleteWorldModel={deleteWorldModel}
      onCloseWorldModel={closeWorldModel}
    />
  );
}

/** Contract for world model sub page view props. */
export interface WorldModelSubPageViewProps {
  state: RemoteData<PanelItemsOutput>;
  detail?: WorldModelDetailState;
  selectedWorldModelId?: string | null;
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onPageChange: (page: number) => void;
  onRefresh: () => void | Promise<void>;
  onOpenWorldModel: (item: MemoryListItem) => void;
  onDeleteWorldModel: (id: string) => Promise<void>;
  onCloseWorldModel: () => void;
}

/** Handles world model sub page view. */
export function WorldModelSubPageView(props: WorldModelSubPageViewProps) {
  const { t } = useTranslation();

  return (
    <section className="memory-panel">
      <div className="memory-panel__header">
        <div className="memory-panel__header-main">
          <h3 className="memory-panel__title">
            <Globe2 size={18} className="text-text-ink/60" />
            {t("memory.worldModel.title")}
          </h3>
          <p className="memory-panel__subtitle">{t("memory.worldModel.description")}</p>
        </div>
        <MemoryRefreshButton onClick={props.onRefresh} />
      </div>
      <div className="memory-toolbar">
        <label className="memory-search">
          <Search size={15} className="memory-search__icon" />
          <input
            type="search"
            value={props.query}
            placeholder={t("memory.worldModel.searchPlaceholder")}
            onChange={(event) => props.onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") props.onSearch();
            }}
            className="memory-search__input"
          />
        </label>
      </div>
      {props.state.status === "loading" && <MemoryStateBox message={t("memory.worldModel.loading")} />}
      {props.state.status === "error" && <MemoryStateBox message={props.state.message} tone="error" />}
      {props.state.status === "ready" && props.state.data.items.length === 0 && <MemoryStateBox message={t("memory.worldModel.empty")} />}
      {props.state.status === "ready" && props.state.data.items.length > 0 && (
        <>
        <div className="memory-list">
          {props.state.data.items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => props.onOpenWorldModel(item)}
              className={`memory-card${props.selectedWorldModelId === item.id ? " memory-card--selected" : ""}`}
            >
              <div className="memory-card__body">
                <div className="memory-card__title">{displayWorldModelTitle(item)}</div>
                <div className="memory-card__meta">
                  <WorldModelStatusPill status={item.status} />
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
        <WorldModelDrawer detail={props.detail ?? null} onClose={props.onCloseWorldModel} onDelete={props.onDeleteWorldModel} />
        </>
      )}
    </section>
  );
}

function WorldModelDrawer(props: { detail: WorldModelDetailState; onClose: () => void; onDelete: (id: string) => Promise<void> }) {
  const { t } = useTranslation();

  if (!props.detail) {
    return null;
  }

  const readyDetail = props.detail.status === "ready" ? props.detail.data : null;
  const title = readyDetail ? worldModelFromDetail(readyDetail).title : t("memory.worldModel.title");
  const eyebrow = readyDetail ? drawerEyebrow(readyDetail.item) : t("memory.worldModel.title");

  return (
    <div className="memory-drawer-backdrop" onClick={props.onClose}>
      <button type="button" className="memory-drawer-backdrop__close" tabIndex={-1} aria-hidden="true" onClick={(e) => {
        e.stopPropagation();
        props.onClose();
      }} />
      <aside className="memory-drawer" role="dialog" aria-modal="true" aria-labelledby="memory-world-model-title" onClick={(e) => e.stopPropagation()}>
        <header className="memory-drawer__header">
          <div>
            <div className="memory-drawer__identity">
              <span className="memory-drawer__eyebrow">{eyebrow}</span>
            </div>
            <h4 id="memory-world-model-title" className="memory-drawer__title">{title}</h4>
          </div>
          <button type="button" className="memory-drawer__close" onClick={props.onClose} aria-label={t("common.close")}>
            <X size={16} />
          </button>
        </header>
        <div className="memory-drawer__body">
          {props.detail.status === "loading" && <MemoryStateBox message={t("memory.memories.detailLoading")} />}
          {props.detail.status === "error" && <MemoryStateBox message={props.detail.message} tone="error" />}
          {props.detail.status === "ready" && <WorldModelDetail detail={props.detail.data} />}
        </div>
        {readyDetail && <MemoryDrawerDeleteAction onDelete={() => props.onDelete(readyDetail.item.id)} />}
      </aside>
    </div>
  );
}

function WorldModelDetail(props: { detail: GetMemoryOutput }) {
  const { t } = useTranslation();
  const worldModel = worldModelFromDetail(props.detail);

  return (
    <>
      <section className="memory-detail-card memory-detail-card--meta">
        <h5 className="memory-detail-card__label">{t("memory.memories.meta")}</h5>
        <div className="memory-detail-metrics">
          <Metric label={t("memory.memories.status")} value={worldModelStatusLabel(worldModel.status, t)} />
          <Metric label={t("memory.memories.createdAt")} value={formatDateTime(worldModel.createdAt)} />
          <Metric label={t("memory.memories.updatedAt")} value={formatDateTime(worldModel.updatedAt)} />
          <Metric label={t("memory.worldModel.relatedPolicies")} value={String(worldModel.policyIds.length)} />
          <Metric label={t("memory.memories.sourceMemoryIds")} value={String(worldModel.sourceMemoryIds.length)} />
        </div>
        {worldModel.source && (
          <div className="memory-policy-source">
            <span>{t("memory.tasks.source")}</span>
            {worldModel.source}
          </div>
        )}
      </section>

      <DetailTextSection title={t("memory.memories.summary")} body={worldModel.summary} />
      <DetailTextSection title={t("memory.memories.body")} body={worldModel.body} />
      <StructureSection structure={worldModel.structure} />
      <LinkedIdsSection title={t("memory.worldModel.relatedPolicies")} ids={worldModel.policyIds} empty={t("memory.worldModel.noRelatedPolicies")} />
      <LinkedIdsSection title={t("memory.memories.sourceMemoryIds")} ids={worldModel.sourceMemoryIds} empty={t("memory.worldModel.noSourceMemories")} />
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

function DetailTextSection(props: { title: string; body?: string }) {
  return (
    <section className="memory-detail-card">
      <h5 className="memory-detail-card__label">{props.title}</h5>
      <div className="memory-policy-section-body">{cleanMemoryBody(props.body) || "-"}</div>
    </section>
  );
}

function StructureSection(props: { structure: WorldModelStructure }) {
  const { t } = useTranslation();
  const sections = [
    { title: t("memory.worldModel.environmentTopology"), entries: props.structure.environment },
    { title: t("memory.worldModel.behaviorPatterns"), entries: props.structure.inference },
    { title: t("memory.worldModel.constraints"), entries: props.structure.constraints }
  ];
  const visibleSections = sections.filter((section) => section.entries.length > 0);

  if (visibleSections.length === 0) {
    return null;
  }

  return (
    <section className="memory-detail-card">
      <h5 className="memory-detail-card__label">{t("memory.worldModel.structuredCognition")}</h5>
      {visibleSections.map((section) => (
        <div key={section.title} className="memory-policy-guidance">
          <div className="memory-policy-guidance__title">{section.title}</div>
          <ul className="memory-policy-guidance__list">
            {section.entries.map((entry, index) => (
              <li key={`${section.title}-${index}`}>
                <strong>{entry.label}</strong>
                {entry.description ? ` - ${entry.description}` : ""}
                {entry.evidenceIds.length > 0 && (
                  <div className="memory-policy-id-list">
                    {entry.evidenceIds.map((id) => (
                      <span key={id} className="memory-policy-id">{compactId(id)}</span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function LinkedIdsSection(props: { title: string; ids: string[]; empty: string }) {
  const ids = uniqueStrings(props.ids);

  return (
    <section className="memory-detail-card">
      <h5 className="memory-detail-card__label">{props.title}</h5>
      {ids.length === 0 ? (
        <div className="memory-policy-empty">{props.empty}</div>
      ) : (
        <div className="memory-policy-id-list">
          {ids.map((id) => (
            <span key={id} className="memory-policy-id">{compactId(id)}</span>
          ))}
        </div>
      )}
    </section>
  );
}

function WorldModelStatusPill(props: { status?: string }) {
  const { t } = useTranslation();

  return <span className={`memory-pill memory-pill--world-model-${worldModelStatusTone(props.status)}`}>{worldModelStatusLabel(props.status, t)}</span>;
}

export function worldModelStatusTone(status: string | undefined): WorldModelStatusTone {
  const toneByStatus: Record<string, WorldModelStatusTone> = {
    resolving: "candidate",
    candidate: "candidate",
    activated: "active",
    active: "active",
    archived: "archived",
    deleted: "deleted"
  };

  return toneByStatus[status ?? ""] ?? "unknown";
}

function worldModelStatusLabel(status: string | undefined, t: (key: MessageKey) => string): string {
  const keyByTone: Record<WorldModelStatusTone, MessageKey> = {
    candidate: "memory.policies.status.candidate",
    active: "memory.policies.status.active",
    archived: "memory.policies.status.archived",
    deleted: "memory.memories.status.deleted",
    unknown: "memory.policies.status.unknown"
  };

  return t(keyByTone[worldModelStatusTone(status)]);
}

function worldModelFromDetail(detail: GetMemoryOutput): WorldModelView {
  const metadata = detail.item.metadata;
  const properties = recordValue(metadata.properties);
  const internalInfo = recordValue(properties.internal_info);
  const worldModel = recordValue(firstDefined(internalInfo.world_model, internalInfo.worldModel, metadata.world_model, metadata.worldModel));
  const structure = readWorldModelStructure(
    firstDefined(worldModel.structure, internalInfo.structure, properties.structure, metadata.structure)
  );

  return {
    title: displayWorldModelTitle(detail.item, firstString(worldModel.title, internalInfo.title)),
    status: firstString(worldModel.status, internalInfo.status, detail.item.status) ?? detail.item.status,
    source: firstString(metadata.source, internalInfo.source),
    createdAt: detail.item.createdAt,
    updatedAt: detail.item.updatedAt,
    body: cleanMemoryBody(detail.item.body),
    summary: displayWorldModelSummary(detail.item),
    policyIds: stringArray(firstDefined(worldModel.policyIds, worldModel.policy_ids, internalInfo.policyIds, internalInfo.policy_ids)),
    sourceMemoryIds: detail.item.sourceMemoryIds,
    structure
  };
}

function readWorldModelStructure(value: unknown): WorldModelStructure {
  const source = recordValue(parseJsonString(value));

  return {
    environment: structureEntries(firstDefined(source.environment, source.env, source.topology)),
    inference: structureEntries(firstDefined(source.inference, source.inferences, source.rules)),
    constraints: structureEntries(firstDefined(source.constraints, source.constraint, source.boundaries))
  };
}

function structureEntries(value: unknown): WorldModelStructureEntry[] {
  const parsed = parseJsonString(value);

  if (Array.isArray(parsed)) {
    return parsed.map((item) => structureEntry(item)).filter((entry): entry is WorldModelStructureEntry => Boolean(entry));
  }

  const record = recordValue(parsed);
  return Object.entries(record)
    .map(([key, item]) => structureEntry(item, key))
    .filter((entry): entry is WorldModelStructureEntry => Boolean(entry));
}

function structureEntry(value: unknown, key?: string): WorldModelStructureEntry | null {
  const parsed = parseJsonString(value);
  if (typeof parsed === "string") {
    const text = parsed.trim();
    return text ? { label: key ?? text, description: key ? text : "", evidenceIds: [] } : null;
  }

  const record = recordValue(parsed);
  const label = firstString(record.label, record.name, record.title, key);
  const description = firstString(record.description, record.body, record.summary, record.text) ?? "";
  if (!label && !description) {
    return null;
  }

  return {
    label: label ?? description,
    description,
    evidenceIds: stringArray(firstDefined(record.evidenceIds, record.evidence_ids, record.sourceMemoryIds, record.source_memory_ids))
  };
}

function displayWorldModelTitle(
  item: Pick<MemoryListItem, "id" | "title" | "summary" | "memoryLayer"> & { body?: string },
  ...candidates: Array<string | undefined>
): string {
  for (const value of [...candidates, item.title, item.summary, firstReadableWorldBodyLine(item.body)]) {
    const text = cleanWorldModelText(value);
    if (isDisplayableWorldModelText(text)) return text;
  }

  return displayMemoryId(item.id);
}

function displayWorldModelSummary(item: Pick<MemoryListItem, "title" | "summary"> & { body?: string }): string {
  for (const value of [item.summary, firstReadableWorldBodyLine(item.body), item.title]) {
    const text = cleanWorldModelText(value);
    if (isDisplayableWorldModelText(text)) return text;
  }

  return "";
}

function firstReadableWorldBodyLine(body?: string): string | undefined {
  return cleanMemoryBody(body)
    .split(/\r?\n/)
    .map(cleanWorldModelText)
    .find(isDisplayableWorldModelText);
}

function cleanWorldModelText(value?: string): string {
  return cleanMemoryText(value)
    .replace(/^[*-]\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim();
}

function isWorldModelSectionHeading(value: string): boolean {
  return /^(Environment|Inference|Constraints|Environment Knowledge|\u73af\u5883|\u73af\u5883\u62d3\u6251|\u884c\u4e3a\u89c4\u5f8b|\u7ea6\u675f\u7981\u5fcc|\u7ed3\u6784\u5316\u8ba4\u77e5)$/i.test(value.trim());
}

function isInternalMemoryKey(value: string): boolean {
  return /^(trace|policy|world|world_model|skill)[:_]/i.test(value.trim());
}

function isDisplayableWorldModelText(value: string | undefined): value is string {
  return Boolean(value && !isWorldModelSectionHeading(value) && !isInternalMemoryKey(value));
}

function recordValue(value: unknown): Record<string, unknown> {
  const parsed = parseJsonString(value);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = parseJsonString(value);
    if (typeof parsed === "string" && parsed.trim()) {
      return parsed.trim();
    }
  }

  return undefined;
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed || !/^[\[{"]/.test(trimmed)) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function stringArray(value: unknown): string[] {
  const parsed = parseJsonString(value);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((item) => firstString(item))
    .filter((item): item is string => Boolean(item));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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
