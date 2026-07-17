import { useEffect, useRef, useState, type ReactNode } from "react";
import type { GetMemoryOutput, PanelItemsInput, PanelItemsOutput } from "@memmy/local-api-contracts";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import type { MessageKey } from "../../i18n/messages.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { BrainCircuit, ChevronRight, Search, Sparkles, X } from "./memory-prototype-icons.js";
import {
  MEMORY_SOURCE_AGENT_EXCLUSIONS,
  MemoryAgentFilter,
  OTHER_MEMORY_SOURCE_AGENT
} from "./memory-agent-filter.js";
import { MemoryDrawerDeleteAction } from "./memory-delete-action.js";
import { MemoryAgentSourceTag } from "./memory-agent-source-tag.js";
import { toMemoryDetailErrorMessage } from "./memory-detail-error.js";
import { cleanMemoryBody, cleanMemoryText, displayMemoryTitle, drawerEyebrow, memoryDisplaySource } from "./memory-display.js";
import {
  clearMemoryPanelCache,
  memoryPanelCacheKey,
  readMemoryPanelCacheFirst,
  writeMemoryPanelCaches
} from "./memory-panel-cache.js";
import { MemoryPagination, normalizePage } from "./memory-pagination.js";
import { MemoryRefreshButton } from "./memory-refresh-button.js";
import { MemoryStateBox } from "./memory-state-box.js";
import { type RemoteData, toErrorMessage } from "./remote-state.js";

type MemoryDetailOutput = GetMemoryOutput;
type DetailState = RemoteData<MemoryDetailOutput> | null;
const RAW_MEMORY_LAYER = "L1";
const MEMORY_PROCESSING_STATUS_LABELS = {
  summary: "memory.memories.processing.summary",
  index: "memory.memories.processing.index",
  reflection: "memory.memories.processing.reflection"
} as const;
type MemoryProcessingStatus = keyof typeof MEMORY_PROCESSING_STATUS_LABELS;
const MEMORIES_CACHE_SECTION = "memories";
const PROCESSING_TAGS = {
  summary: "\u6458\u8981\u6392\u961F\u4E2D",
  index: "\u5EFA\u7ACB\u7D22\u5F15\u4E2D",
  indexed: "\u7D22\u5F15\u5DF2\u5EFA\u7ACB"
} as const;
const IMPORT_PROCESSING_SUMMARY_LABELS: Record<string, MemoryProcessingStatus> = {
  "\u6458\u8981\u6392\u961F\u4E2D": "summary",
  "\u6458\u8981\u6574\u7406\u4E2D": "summary",
  "\u5EFA\u7ACB\u7D22\u5F15\u4E2D": "index",
  "\u7D22\u5F15\u5EFA\u7ACB\u4E2D": "index",
  "\u53CD\u601D\u751F\u6210\u4E2D": "reflection"
};
const PENDING_IMPORT_SUMMARY_TITLES = new Set([
  "user",
  "assistant",
  "system",
  "tool",
  "developer",
  "\u6458\u8981\u6392\u961F\u4E2D",
  "\u6458\u8981\u6574\u7406\u4E2D",
  "\u5EFA\u7ACB\u7D22\u5F15\u4E2D",
  "\u7D22\u5F15\u5EFA\u7ACB\u4E2D"
]);
const PROCESSING_REFRESH_INTERVAL_MS = 2_000;
const MEMORIES_REFRESH_INTERVAL_MS = 5_000;

export interface MemoriesSubPageProps {
  client: MemoryRuntimeClient | null;
}

export interface MemorySearchFilters {
  query?: string;
  sourceAgent?: string;
  page?: number;
}

export function buildPanelItemsInput(filters: MemorySearchFilters): PanelItemsInput {
  const input: PanelItemsInput = { layer: RAW_MEMORY_LAYER, page: normalizePage(filters.page) };
  const query = filters.query?.trim();

  if (query) {
    input.q = query;
  }
  if (filters.sourceAgent === OTHER_MEMORY_SOURCE_AGENT) {
    input.excludedSourceAgents = MEMORY_SOURCE_AGENT_EXCLUSIONS;
  } else if (filters.sourceAgent) {
    input.sourceAgent = filters.sourceAgent;
  }

  return input;
}

export function loadMemoriesData(client: MemoryRuntimeClient, input: PanelItemsInput): Promise<PanelItemsOutput> {
  return client.listPanelItems(input);
}

export function loadMemoryDetail(client: MemoryRuntimeClient, item: PanelItemsOutput["items"][number]): Promise<MemoryDetailOutput> {
  return client.getMemory(item.id);
}

function memoriesCacheKeys(query: string, sourceAgent: string, page: number): string[] {
  return [
    memoryPanelCacheKey(MEMORIES_CACHE_SECTION, query.trim(), sourceAgent, normalizePage(page))
  ];
}

export function MemoriesSubPage(props: MemoriesSubPageProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [sourceAgent, setSourceAgent] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<RemoteData<PanelItemsOutput>>({ status: "loading" });
  const [detail, setDetail] = useState<DetailState>(null);
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);

  function refresh(nextPage = page, nextSourceAgent = sourceAgent, options: { useCache?: boolean } = {}): Promise<void> {
    if (!props.client) {
      const message = t("memory.clientNotReady");
      setState({ status: "error", message });
      return Promise.reject(new Error(message));
    }

    const normalizedPage = normalizePage(nextPage);
    const requestId = ++requestIdRef.current;
    const cacheKeys = memoriesCacheKeys(query, nextSourceAgent, normalizedPage);
    const useCache = options.useCache ?? true;
    const cached = useCache ? readMemoryPanelCacheFirst<PanelItemsOutput>(cacheKeys) : null;
    if (cached) {
      setState({ status: "ready", data: cached });
    } else {
      setState((current) => current.status === "ready" ? current : { status: "loading" });
    }

    return loadMemoriesData(props.client, buildPanelItemsInput({ query, sourceAgent: nextSourceAgent, page: normalizedPage }))
      .then((data) => {
        writeMemoryPanelCaches(cacheKeys, data);
        if (requestId !== requestIdRef.current) {
          return;
        }
        setState({ status: "ready", data });
        if (data.page !== normalizedPage) {
          setPage(data.page);
        }
      })
      .catch((error) => {
        if (requestId !== requestIdRef.current) {
          return;
        }
        setState({ status: "error", message: toErrorMessage(error) });
        throw error;
      });
  }

  function changeQuery(value: string) {
    detailRequestIdRef.current += 1;
    setQuery(value);
    setDetail(null);
    setSelectedMemoryId(null);
    setPage(1);
  }

  function runSearch() {
    detailRequestIdRef.current += 1;
    setDetail(null);
    setSelectedMemoryId(null);
    setPage(1);
    void refresh(1).catch(() => undefined);
  }

  function changeSourceAgent(value: string) {
    detailRequestIdRef.current += 1;
    setSourceAgent(value);
    setDetail(null);
    setSelectedMemoryId(null);
    setPage(1);
  }

  function changePage(nextPage: number) {
    const normalizedPage = normalizePage(nextPage);
    if (normalizedPage === page) {
      return;
    }

    detailRequestIdRef.current += 1;
    setDetail(null);
    setSelectedMemoryId(null);
    setPage(normalizedPage);
  }

  function openDetail(item: PanelItemsOutput["items"][number]) {
    const requestId = ++detailRequestIdRef.current;
    setSelectedMemoryId(item.id);

    if (!props.client) {
      setDetail({ status: "error", message: t("memory.clientNotReady") });
      return;
    }

    setDetail({ status: "loading" });
    void loadMemoryDetail(props.client, item)
      .then((data) => {
        if (requestId === detailRequestIdRef.current) {
          setDetail({ status: "ready", data });
        }
      })
      .catch((error) => {
        if (requestId === detailRequestIdRef.current) {
          setDetail({ status: "error", message: toMemoryDetailErrorMessage(error, t("memory.detailUnavailable")) });
        }
      });
  }

  async function deleteMemoryDetail(id: string) {
    if (!props.client) {
      throw new Error(t("memory.clientNotReady"));
    }

    await props.client.deleteMemory(id);
    detailRequestIdRef.current += 1;
    clearMemoryPanelCache();
    setDetail(null);
    setSelectedMemoryId(null);
    void refresh(page, sourceAgent, { useCache: false }).catch(() => undefined);
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh().catch(() => undefined), 180);
    return () => window.clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.client, query, sourceAgent, page, t]);

  useEffect(() => {
    if (state.status !== "ready" || !state.data.items.some(memoryProcessingStatus)) {
      return;
    }

    const timeout = window.setTimeout(() => void refresh(page, sourceAgent, { useCache: false }).catch(() => undefined), PROCESSING_REFRESH_INTERVAL_MS);
    return () => window.clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, props.client, query, sourceAgent, page, t]);

  useEffect(() => {
    if (!props.client) {
      return undefined;
    }
    const interval = window.setInterval(() => void refresh(page, sourceAgent, { useCache: false }).catch(() => undefined), MEMORIES_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.client, query, sourceAgent, page, t]);

  return (
    <MemoriesSubPageView
      state={state.status === "ready" ? { ...state, detail } : state}
      query={query}
      sourceAgent={sourceAgent}
      onQueryChange={changeQuery}
      onSourceAgentChange={changeSourceAgent}
      onSearch={runSearch}
      onPageChange={changePage}
      onRefresh={() => refresh(page, sourceAgent, { useCache: false })}
      onOpenDetail={openDetail}
      onDeleteDetail={deleteMemoryDetail}
      onCloseDetail={() => {
        detailRequestIdRef.current += 1;
        setDetail(null);
        setSelectedMemoryId(null);
      }}
      selectedMemoryId={selectedMemoryId}
    />
  );
}

export interface MemoriesSubPageViewProps {
  state: RemoteData<PanelItemsOutput> | ({ status: "ready"; data: PanelItemsOutput; detail: DetailState });
  query: string;
  sourceAgent: string;
  onQueryChange: (value: string) => void;
  onSourceAgentChange: (value: string) => void;
  onSearch: () => void;
  onPageChange: (page: number) => void;
  onRefresh: () => void | Promise<void>;
  onOpenDetail: (item: PanelItemsOutput["items"][number]) => void;
  onDeleteDetail: (id: string) => Promise<void>;
  onCloseDetail: () => void;
  selectedMemoryId?: string | null;
}

export function MemoriesSubPageView(props: MemoriesSubPageViewProps) {
  const { t } = useTranslation();

  return (
    <section className="memory-panel">
      <div className="memory-panel__header">
        <div className="memory-panel__header-main">
          <h3 className="memory-panel__title">
            <BrainCircuit size={18} className="text-text-ink/60" />
            {t("memory.memories.title")}
          </h3>
          <p className="memory-panel__subtitle">{t("memory.memories.description")}</p>
        </div>
        <MemoryRefreshButton onClick={props.onRefresh} />
      </div>
      <div className="memory-toolbar">
        <div className="memory-source-search-control">
          <label className="memory-search">
            <Search size={15} className="memory-search__icon" />
            <input
              type="search"
              value={props.query}
              placeholder={t("memory.memories.searchPlaceholder")}
              onChange={(event) => props.onQueryChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  props.onSearch();
                }
              }}
              className="memory-search__input"
            />
          </label>
          <MemoryAgentFilter
            id="memory-l1-agent-filter"
            label={t("memory.logs.agentFilter.label")}
            value={props.sourceAgent}
            onValueChange={props.onSourceAgentChange}
            allLabel={t("memory.logs.agentFilter.all")}
            otherLabel={t("memory.logs.agentFilter.other")}
          />
        </div>
      </div>
      <MemoryListState props={props} />
    </section>
  );
}

function MemoryListState(input: { props: MemoriesSubPageViewProps }) {
  const { t } = useTranslation();
  const props = input.props;

  if (props.state.status === "loading") {
    return <MemoryStateBox message={t("memory.memories.loading")} />;
  }

  if (props.state.status === "error") {
    return <MemoryStateBox message={props.state.message} tone="error" />;
  }

  const visibleItems = props.state.data.items;

  return (
    <>
      <div className="memory-list">
        {visibleItems.length === 0 && <MemoryStateBox message={t("memory.memories.empty")} />}
        {visibleItems.map((item) => {
          const selected = props.selectedMemoryId === item.id || ("detail" in props.state && props.state.detail?.status === "ready" && props.state.detail.data.item.id === item.id);
          const processingStatus = memoryProcessingStatus(item);
          return (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              aria-selected={selected}
              onClick={() => props.onOpenDetail(item)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  props.onOpenDetail(item);
                }
              }}
              className={`memory-card${selected ? " memory-card--selected" : ""}`}
            >
              <div className="memory-card__body">
                <div className="memory-card__title">{displayMemoryTitle(item)}</div>
                <div className="memory-card__meta">
                  <MemoryAgentSourceTag sourceAgent={memoryDisplaySource(item)} label={t("memory.memories.source")} />
                  <span>{formatDateTime(item.createdAt)}</span>
                  <span className="memory-card__score">{formatMemoryScore(item.metrics)}</span>
                  {processingStatus && (
                    <span className="memory-pill memory-pill--processing">{t(MEMORY_PROCESSING_STATUS_LABELS[processingStatus])}</span>
                  )}
                  {item.metrics?.reflectionDone && (
                    <span className="memory-pill memory-pill--reflection-done">
                      <Sparkles size={12} />
                      {t("memory.memories.reflection")}
                    </span>
                  )}
                </div>
              </div>
              <div className="memory-card__tail">
                <ChevronRight size={16} />
              </div>
            </div>
          );
        })}
      </div>
      <MemoryPagination data={props.state.data} onPageChange={props.onPageChange} />
      <MemoryDetailPanel detail={"detail" in props.state ? props.state.detail : null} onClose={props.onCloseDetail} onDelete={props.onDeleteDetail} />
    </>
  );
}

/**
 * Renders the detail panel.
 *
 * @param props.detail The detail remote state.
 * @param props.onClose The close callback.
 * @returns The detail panel node.
 */
function MemoryDetailPanel(props: { detail: DetailState; onClose: () => void; onDelete: (id: string) => Promise<void> }) {
  const { t } = useTranslation();

  if (!props.detail) {
    return null;
  }

  const readyDetail = props.detail.status === "ready" ? props.detail.data : null;
  const eyebrow = readyDetail ? drawerEyebrow(readyDetail.item) : t("memory.memories.detailTitle");

  return (
    <div className="memory-drawer-backdrop" onClick={props.onClose}>
      <button type="button" className="memory-drawer-backdrop__close" tabIndex={-1} aria-hidden="true" onClick={(e) => {
        e.stopPropagation();
        props.onClose();
      }} />
      <aside className="memory-drawer memory-drawer--entry" role="dialog" aria-modal="true" aria-labelledby="memory-detail-title" onClick={(e) => e.stopPropagation()}>
        <header className="memory-drawer__header">
          <div>
            <div className="memory-drawer__identity">
              <span id="memory-detail-title" className="memory-drawer__eyebrow">{eyebrow}</span>
            </div>
          </div>
          <button type="button" className="memory-drawer__close" onClick={props.onClose} aria-label={t("common.close")}>
            <X size={16} />
          </button>
        </header>
        <div className="memory-drawer__body">
          {props.detail.status === "loading" && <MemoryStateBox message={t("memory.memories.detailLoading")} />}
          {props.detail.status === "error" && <MemoryStateBox message={props.detail.message} tone="error" />}
          {props.detail.status === "ready" && <MemoryDetailBody detail={props.detail.data} />}
        </div>
        {readyDetail && <MemoryDrawerDeleteAction onDelete={() => props.onDelete(readyDetail.item.id)} />}
      </aside>
    </div>
  );
}

/**
 * Renders the memory detail body.
 *
 * @param props.detail The detail data.
 * @returns The detail body node.
 */
function MemoryDetailBody(props: { detail: MemoryDetailOutput }) {
  const { t } = useTranslation();
  const detail = props.detail;
  const item = detail.item;
  const traceDetail = readTraceDetail(detail);
  const summaryText = displayMemorySummaryText(item.summary, t);

  if (traceDetail) {
    return <TraceMemoryDetail item={item} detail={traceDetail} />;
  }

  return (
    <>
      <section className="memory-detail-card">
        <h5 className="memory-detail-card__label">{t("memory.memories.meta")}</h5>
        <dl className="memory-detail-grid">
          <dt>{t("memory.memories.source")}</dt>
          <dd><MemoryAgentSourceTag sourceAgent={memoryDisplaySource(item)} label={t("memory.memories.source")} /></dd>
          <dt>{t("memory.memories.createdAt")}</dt>
          <dd>{formatDateTime(item.createdAt)}</dd>
          <dt>{t("memory.memories.updatedAt")}</dt>
          <dd>{formatDateTime(item.updatedAt)}</dd>
        </dl>
      </section>

      {summaryText && (
        <section className="memory-detail-card">
          <h5 className="memory-detail-card__label">{t("memory.memories.summary")}</h5>
          <div className="memory-detail-text">{summaryText}</div>
        </section>
      )}

      <section className="memory-detail-card">
        <h5 className="memory-detail-card__label">{t("memory.memories.body")}</h5>
        <div className="memory-detail-text">{cleanMemoryBody(item.body) || "-"}</div>
      </section>
    </>
  );
}

interface TraceDetail {
  capturedAt?: string | number;
  value?: number;
  alpha?: number;
  priority?: number;
  rHuman?: number;
  reflection?: string;
  summary?: string;
  agentThinking?: string;
  userQuery?: string;
  finalResponse?: string;
  toolCalls: TraceToolCall[];
  steps: TraceStep[];
}

interface TraceStep {
  id?: string;
  stepIndex?: number;
  role?: string;
  summary?: string;
  capturedAt?: string | number;
  value?: number;
  alpha?: number;
  priority?: number;
  reflection?: string;
  toolCalls: TraceToolCall[];
}

interface TraceToolCall {
  id?: string;
  name: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  success?: boolean;
  startedAt?: string | number;
  endedAt?: string | number;
  thinkingBefore?: string;
  assistantTextBefore?: string;
}

type TraceTurnEvent =
  | { kind: "user"; key: string; text: string }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "tool"; key: string; call: TraceToolCall; index: number }
  | { kind: "assistant"; key: string; text: string };

/**
 * Renders the human-readable detail of an L1 memory.
 *
 * @param props.item The detail item.
 * @param props.detail The structured trace detail.
 * @returns The L1 detail node.
 */
function TraceMemoryDetail(props: { item: MemoryDetailOutput["item"]; detail: TraceDetail }) {
  const { t } = useTranslation();
  const detail = props.detail;
  const toolCalls = detail.toolCalls.length > 0
    ? detail.toolCalls
    : detail.steps.flatMap((step) => step.toolCalls);
  const turnEvents = buildTraceTurnEvents(detail, toolCalls);
  const hasTurnSteps = turnEvents.length > 0;
  const summaryText = displayMemorySummaryText(detail.summary || props.item.summary, t);

  return (
    <>
      <section className="memory-detail-card memory-detail-card--meta">
        <h5 className="memory-detail-card__label">{t("memory.memories.traceMeta")}</h5>
        <div className="memory-detail-metrics">
          <MemoryMetric
            label={t("memory.memories.source")}
            value={<MemoryAgentSourceTag sourceAgent={memoryDisplaySource(props.item)} label={t("memory.memories.source")} />}
          />
          <MemoryMetric label={t("memory.memories.meta.time")} value={formatTraceTime(detail.capturedAt ?? props.item.createdAt)} />
          <MemoryMetric label={t("memory.memories.meta.value")} value={formatDecimal(detail.value)} />
          <MemoryMetric label={t("memory.memories.meta.alpha")} value={formatDecimal(detail.alpha)} />
          <MemoryMetric label={t("memory.memories.meta.priority")} value={formatDecimal(detail.priority)} />
          <MemoryMetric label={t("memory.memories.meta.rHuman")} value={formatDecimal(detail.rHuman)} />
        </div>
      </section>

      <section className="memory-detail-card">
        <h5 className="memory-detail-card__label">{t("memory.memories.summaryForRetrieval")}</h5>
        <div className="memory-detail-text">{summaryText || "-"}</div>
      </section>

      {detail.reflection?.trim() && (
        <section className="memory-detail-card">
          <h5 className="memory-detail-card__label">{t("memory.memories.reflection")}</h5>
          <div className="memory-detail-text">{cleanMemoryBody(detail.reflection)}</div>
        </section>
      )}

      <section className="memory-detail-card">
        <h5 className="memory-detail-card__label">{t("memory.memories.turnSteps")}</h5>
        {hasTurnSteps ? (
          <div className="memory-turn">
            {turnEvents.map((event) => <TraceTurnEventBlock key={event.key} event={event} />)}
          </div>
        ) : (
          <MemoryStateBox message={t("memory.memories.noTurnSteps")} />
        )}
      </section>
    </>
  );
}

function TraceTurnEventBlock(props: { event: TraceTurnEvent }) {
  const { t } = useTranslation();
  const event = props.event;

  if (event.kind === "tool") {
    return (
      <MemoryTurnBlock label={`${t("memory.memories.toolCalls")} · ${event.call.name}`} tone="tool">
        <div className="memory-tool-list">
          <MemoryToolCallCard call={event.call} index={event.index} />
        </div>
      </MemoryTurnBlock>
    );
  }

  const label = event.kind === "user"
    ? t("memory.memories.userQuery")
    : event.kind === "thinking"
      ? t("memory.memories.agentThinking")
      : t("memory.memories.agentFinal");

  return (
    <MemoryTurnBlock label={label} tone={event.kind}>
      <MarkdownText text={event.text} />
    </MemoryTurnBlock>
  );
}

function buildTraceTurnEvents(detail: TraceDetail, toolCalls: TraceToolCall[]): TraceTurnEvent[] {
  const events: TraceTurnEvent[] = [];
  const userText = detail.userQuery?.trim();
  if (userText) {
    events.push({ kind: "user", key: "user", text: userText });
  }

  const hasToolThinking = toolCalls.some((call) => Boolean(call.thinkingBefore?.trim()));
  let remainingThinking = normalizeTurnThinking(detail.agentThinking ?? "");
  if (!hasToolThinking && remainingThinking) {
    events.push({ kind: "thinking", key: "thinking:summary", text: remainingThinking });
    remainingThinking = "";
  }

  let lastThinkingBefore = "";
  let lastAssistantBefore = "";
  for (const [index, call] of toolCalls.entries()) {
    const thinkingBefore = normalizeTurnThinking(call.thinkingBefore ?? "");
    if (thinkingBefore && thinkingBefore !== lastThinkingBefore) {
      events.push({ kind: "thinking", key: `thinking:tool:${call.id ?? index}`, text: thinkingBefore });
      remainingThinking = removeFirstTurnThinking(remainingThinking, thinkingBefore);
      lastThinkingBefore = thinkingBefore;
    } else if (!thinkingBefore) {
      lastThinkingBefore = "";
    }

    const assistantBefore = call.assistantTextBefore?.trim() ?? "";
    if (assistantBefore && assistantBefore !== lastAssistantBefore) {
      events.push({ kind: "assistant", key: `assistant:tool:${call.id ?? index}`, text: assistantBefore });
      lastAssistantBefore = assistantBefore;
    } else if (!assistantBefore) {
      lastAssistantBefore = "";
    }

    events.push({ kind: "tool", key: `tool:${call.id ?? call.name}:${index}`, call, index: index + 1 });
  }

  remainingThinking = normalizeTurnThinking(remainingThinking);
  if (remainingThinking) {
    events.push({ kind: "thinking", key: "thinking:remaining", text: remainingThinking });
  }

  const finalResponse = detail.finalResponse?.trim();
  if (finalResponse) {
    events.push({ kind: "assistant", key: "assistant:final", text: finalResponse });
  }

  return events;
}

function MemoryMetric(props: { label: string; value: ReactNode }) {
  return (
    <div className="memory-detail-metric">
      <div className="memory-detail-metric__label">{props.label}</div>
      <div className="memory-detail-metric__value">{props.value}</div>
    </div>
  );
}

function MemoryTurnBlock(props: { label: string; tone: "user" | "thinking" | "tool" | "assistant"; children: ReactNode }) {
  return (
    <section className={`memory-turn-block memory-turn-block--${props.tone}`}>
      <div className="memory-turn-block__label">{props.label}</div>
      <div className="memory-turn-block__body">{props.children}</div>
    </section>
  );
}

function MemoryToolCallCard(props: { call: TraceToolCall; index: number }) {
  const { t } = useTranslation();
  const input = formatToolPayload(props.call.input);
  const output = formatToolPayload(props.call.output);
  const error = props.call.error?.trim();
  const duration = formatToolDuration(props.call.startedAt, props.call.endedAt);
  const successLabel = error || props.call.success === false ? t("memory.memories.toolFailed") : t("memory.memories.toolOk");

  return (
    <div className={`memory-tool-card${error || props.call.success === false ? " memory-tool-card--error" : ""}`}>
      <div className="memory-tool-card__header">
        <span className="memory-tool-card__index">#{props.index}</span>
        <span className="memory-tool-card__name">{props.call.name}</span>
        <span className="memory-tool-card__status">{successLabel}</span>
        {duration && <span className="memory-tool-card__duration">{duration}</span>}
      </div>
      {input && <MemoryToolPayload label={t("memory.memories.toolInput")} value={input} />}
      {output && <MemoryToolPayload label={t("memory.memories.toolOutput")} value={output} />}
      {error && <MemoryToolPayload label={t("memory.memories.toolError")} value={error} open />}
    </div>
  );
}

function MemoryToolPayload(props: { label: string; value: string; open?: boolean }) {
  return (
    <details className="memory-tool-section" open={props.open}>
      <summary>{props.label}</summary>
      <pre className="memory-tool-pre">{clipPayload(props.value)}</pre>
    </details>
  );
}

/**
 * Formats an ISO timestamp.
 *
 * @param value The ISO timestamp string.
 * @returns Local time text.
 */
function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatMemoryScore(metrics: MemoryDetailOutput["item"]["metrics"] | undefined): string {
  return `V ${formatScoreNumber(metrics?.value)} · α ${formatScoreNumber(metrics?.alpha)}`;
}

function formatScoreNumber(value: number | undefined): string {
  return value === undefined ? "-" : value.toFixed(2);
}

function memoryProcessingStatus(item: Pick<PanelItemsOutput["items"][number], "tags" | "metrics" | "summary">): MemoryProcessingStatus | null {
  if (item.metrics?.reflectionDone || hasTag(item.tags, PROCESSING_TAGS.indexed)) {
    return null;
  }

  if (hasTag(item.tags, PROCESSING_TAGS.index)) return "index";
  if (hasTag(item.tags, PROCESSING_TAGS.summary)) return isPendingImportSummary(item.summary) ? "summary" : "index";
  return null;
}

function hasTag(tags: readonly string[], value: string): boolean {
  return tags.some((tag) => tag.trim() === value);
}

function isPendingImportSummary(value?: string | null): boolean {
  const first = value
    ?.split(/\r?\n/)
    .map((line) => line.replace(/^\s*#{1,6}\s+/, "").trim())
    .find(Boolean);
  return !first || PENDING_IMPORT_SUMMARY_TITLES.has(first.toLowerCase());
}

function displayMemorySummaryText(value: string | undefined | null, t: (key: MessageKey) => string): string {
  const cleaned = cleanMemoryText(value);
  const processingStatus = importProcessingSummaryStatus(cleaned);
  return processingStatus ? t(MEMORY_PROCESSING_STATUS_LABELS[processingStatus]) : cleaned;
}

function importProcessingSummaryStatus(value: string | undefined | null): MemoryProcessingStatus | null {
  const first = value
    ?.split(/\r?\n/)
    .map((line) => line.replace(/^\s*#{1,6}\s+/, "").trim())
    .find(Boolean)
    ?.toLowerCase();

  return first ? IMPORT_PROCESSING_SUMMARY_LABELS[first] ?? null : null;
}

/**
 * Reads the trace-specific structure from the detail metadata.
 *
 * @param metadata The backend extension metadata.
 * @returns The trace detail, or null when it is not a trace.
 */
function readTraceDetail(detail: MemoryDetailOutput): TraceDetail | null {
  const metadata = detail.item.metadata;
  const raw = metadata.traceDetail;
  if (isRecord(raw)) {
    return {
      capturedAt: timeValue(raw.capturedAt),
      value: numberValue(raw.value),
      alpha: numberValue(raw.alpha),
      priority: numberValue(raw.priority),
      rHuman: numberValue(raw.rHuman),
      reflection: stringValue(raw.reflection),
      summary: stringValue(raw.summary),
      agentThinking: stringValue(firstDefined(raw.agentThinking, raw.agent_thinking, raw.reasoningSummary)),
      userQuery: stringValue(raw.userQuery),
      finalResponse: stringValue(raw.finalResponse),
      toolCalls: arrayValue(raw.toolCalls).map(readTraceToolCall).filter((call): call is TraceToolCall => Boolean(call)),
      steps: arrayValue(raw.steps).map(readTraceStep).filter((step): step is TraceStep => Boolean(step))
    };
  }

  const rawTurn = recordValue(detail.refs?.rawTurn);
  const properties = recordValue(metadata.properties);
  const internalInfo = recordValue(properties.internal_info);
  const trace = recordValue(internalInfo.trace);
  const itemTrace = recordValue(detail.item.trace);
  const hasTraceShape = detail.item.kind === "trace" || Object.keys(trace).length > 0 || Object.keys(itemTrace).length > 0 || Object.keys(rawTurn).length > 0;

  if (!hasTraceShape) return null;

  const rawTurnToolCalls = arrayValue(rawTurn.toolCalls).map(readTraceToolCall).filter((call): call is TraceToolCall => Boolean(call));
  const traceToolCalls = arrayValue(trace.tool_calls).map(readTraceToolCall).filter((call): call is TraceToolCall => Boolean(call));
  const toolCalls = rawTurnToolCalls.length > 0 ? rawTurnToolCalls : traceToolCalls;

  return {
    capturedAt: timeValue(rawTurn.createdAt) ?? timeValue(trace.ts) ?? detail.item.createdAt,
    value: numberValue(trace.value),
    alpha: numberValue(trace.alpha),
    priority: numberValue(trace.priority),
    rHuman: numberValue(trace.rHuman) ?? numberValue(trace.r_human),
    reflection: stringValue(trace.reflection),
    summary: stringValue(trace.summary) ?? detail.item.summary,
    agentThinking: stringValue(firstDefined(rawTurn.reasoningSummary, trace.agent_thinking, trace.agentThinking)),
    userQuery: stringValue(rawTurn.userText) ?? stringValue(trace.user_text) ?? stringValue(trace.userText),
    finalResponse: stringValue(rawTurn.assistantText) ?? stringValue(trace.agent_text) ?? stringValue(trace.agentText),
    toolCalls,
    steps: arrayValue(trace.steps).map(readTraceStep).filter((step): step is TraceStep => Boolean(step))
  };
}

function readTraceStep(value: unknown): TraceStep | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    id: stringValue(value.id),
    stepIndex: numberValue(value.stepIndex),
    role: stringValue(value.role),
    summary: stringValue(value.summary),
    capturedAt: timeValue(value.capturedAt),
    value: numberValue(value.value),
    alpha: numberValue(value.alpha),
    priority: numberValue(value.priority),
    reflection: stringValue(value.reflection),
    toolCalls: arrayValue(value.toolCalls ?? value.tool_calls).map(readTraceToolCall).filter((call): call is TraceToolCall => Boolean(call))
  };
}

function readTraceToolCall(value: unknown): TraceToolCall | null {
  if (!isRecord(value)) {
    return null;
  }

  const fn = recordValue(value.function);
  const input = firstDefined(value.input, value.args, value.arguments, fn.arguments);
  const output = firstDefined(value.output, value.result);

  return {
    id: stringValue(value.id),
    name: stringValue(value.name) || stringValue(fn.name) || "tool",
    input,
    output,
    error: stringValue(value.error),
    success: typeof value.success === "boolean" ? value.success : undefined,
    startedAt: timeValue(value.startedAt),
    endedAt: timeValue(value.endedAt),
    thinkingBefore: stringValue(firstDefined(value.thinkingBefore, value.thinking_before)),
    assistantTextBefore: stringValue(firstDefined(value.assistantTextBefore, value.assistant_text_before))
  };
}

function formatTraceTime(value: string | number | undefined): string {
  if (typeof value === "number") {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return formatDateTime(new Date(millis).toISOString());
  }

  return value ? formatDateTime(value) : "-";
}

function formatDecimal(value: number | undefined): string {
  return value === undefined ? "-" : value.toFixed(3);
}

function formatToolDuration(startedAt: string | number | undefined, endedAt: string | number | undefined): string {
  const start = timeToMillis(startedAt);
  const end = timeToMillis(endedAt);

  if (start === undefined || end === undefined || end < start) {
    return "";
  }

  return `${Math.round(end - start)} ms`;
}

function formatToolPayload(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeTurnThinking(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function removeFirstTurnThinking(source: string, segment: string): string {
  const normalizedSource = normalizeTurnThinking(source);
  const normalizedSegment = normalizeTurnThinking(segment);
  if (!normalizedSource || !normalizedSegment) return normalizedSource;
  const index = normalizedSource.indexOf(normalizedSegment);
  if (index < 0) return normalizedSource;
  return normalizeTurnThinking([
    normalizedSource.slice(0, index),
    normalizedSource.slice(index + normalizedSegment.length)
  ].filter(Boolean).join("\n\n"));
}

function clipPayload(value: string, maxLength = 6000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...` : value;
}

function timeToMillis(value: string | number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function MarkdownText(props: { text: string }) {
  return <div className="memory-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(props.text) }} />;
}

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;"
};

function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith("```")) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      index += 1;
      const languageClass = language ? ` class="language-${escapeHtml(language)}"` : "";
      output.push(`<pre class="memory-markdown__pre"><code${languageClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length + 3;
      output.push(`<h${level} class="memory-markdown__heading">${inlineMarkdown(heading[2]!)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^[*-]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[*-]\s+/.test(lines[index]!)) {
        items.push(lines[index]!.replace(/^[*-]\s+/, ""));
        index += 1;
      }
      output.push(`<ul class="memory-markdown__list">${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index]!)) {
        items.push(lines[index]!.replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      output.push(`<ol class="memory-markdown__list">${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!)) {
        quoteLines.push(lines[index]!.replace(/^>\s?/, ""));
        index += 1;
      }
      output.push(`<blockquote class="memory-markdown__quote">${quoteLines.map(inlineMarkdown).join("<br/>")}</blockquote>`);
      continue;
    }

    if (line.trim() === "") {
      output.push("<br/>");
      index += 1;
      continue;
    }

    output.push(`<p class="memory-markdown__p">${inlineMarkdown(line)}</p>`);
    index += 1;
  }

  return output.join("");
}

function inlineMarkdown(value: string): string {
  let output = escapeHtml(value);
  output = output.replace(/`([^`]+)`/g, '<code class="memory-markdown__code">$1</code>');
  output = output.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/__(.+?)__/g, "<strong>$1</strong>");
  output = output.replace(/\*(.+?)\*/g, "<em>$1</em>");
  output = output.replace(/_(.+?)_/g, "<em>$1</em>");
  output = output.replace(/~~(.+?)~~/g, "<del>$1</del>");
  output = output.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_match, label: string) => label);
  return output;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPE[char] ?? char);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timeValue(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
