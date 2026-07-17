import { useEffect, useMemo, useState } from "react";
import type { MemoryApiLog, MemoryApiLogsOutput, MemoryApiLogToolName } from "@memmy/local-api-contracts";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { ApiRequestError } from "../../api/http.js";
import { MEMORY_ADD_STATUS_SUMMARIES, type MessageKey, type MessageValues } from "../../i18n/messages.js";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import { useTranslation } from "../../i18n/use-translation.js";
import {
  MEMORY_SOURCE_AGENT_EXCLUSIONS,
  MemoryAgentFilter,
  OTHER_MEMORY_SOURCE_AGENT
} from "./memory-agent-filter.js";
import { MemoryAgentSourceTag } from "./memory-agent-source-tag.js";
import { ScrollText, Search } from "./memory-prototype-icons.js";
import {
  memoryPanelCacheKey,
  memoryPanelLatestCacheKey,
  readMemoryPanelCacheFirst,
  writeMemoryPanelCaches
} from "./memory-panel-cache.js";
import { MemoryPagination, type MemoryPageInfo, normalizePage } from "./memory-pagination.js";
import { MemoryRefreshButton } from "./memory-refresh-button.js";
import { type RemoteData, toErrorMessage } from "./remote-state.js";

const VISIBLE_TOOLS: MemoryApiLogToolName[] = ["memory_add", "memory_search"];
const LOGS_PAGE_SIZE = 20;
const LOGS_CACHE_SECTION = "logs";
const ADD_STATUS_SUMMARIES = new Set<string>(MEMORY_ADD_STATUS_SUMMARIES);
const LOG_MARKDOWN_COMPONENTS: Components = {
  a: ({ children }) => <>{children}</>,
  img: ({ alt }) => <>{alt ?? ""}</>
};
export const OTHER_LOG_SOURCE_AGENT = OTHER_MEMORY_SOURCE_AGENT;

type Translate = (key: MessageKey, values?: MessageValues) => string;

export interface LogsSubPageProps {
  client: MemoryRuntimeClient | null;
}

export async function loadLogsData(
  client: MemoryRuntimeClient,
  page = 1,
  tool: "" | MemoryApiLogToolName = "",
  sourceAgent = ""
): Promise<MemoryApiLogsOutput> {
  const normalizedPage = normalizePage(page);
  const sourceAgentFilter = sourceAgent === OTHER_LOG_SOURCE_AGENT
    ? { excludedSourceAgents: MEMORY_SOURCE_AGENT_EXCLUSIONS }
    : sourceAgent
      ? { sourceAgent }
      : {};
  try {
    return await client.listMemoryLogs({
      tools: tool ? [tool] : VISIBLE_TOOLS,
      ...sourceAgentFilter,
      limit: LOGS_PAGE_SIZE,
      offset: (normalizedPage - 1) * LOGS_PAGE_SIZE
    });
  } catch (error) {
    if (isMissingLogsRoute(error)) {
      return emptyLogsOutput((normalizedPage - 1) * LOGS_PAGE_SIZE);
    }
    throw error;
  }
}

function logsCacheKeys(page: number, tool: "" | MemoryApiLogToolName, sourceAgent: string): string[] {
  const exactKey = memoryPanelCacheKey(LOGS_CACHE_SECTION, tool, sourceAgent, normalizePage(page));
  return sourceAgent ? [exactKey] : [exactKey, memoryPanelLatestCacheKey(LOGS_CACHE_SECTION)];
}

export function LogsSubPage(props: LogsSubPageProps) {
  const { t } = useTranslation();
  const [tool, setTool] = useState<"" | MemoryApiLogToolName>("");
  const [sourceAgent, setSourceAgent] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<RemoteData<MemoryApiLogsOutput>>({ status: "loading" });

  function refresh(nextPage = page, nextTool = tool, nextSourceAgent = sourceAgent, options: { useCache?: boolean } = {}): Promise<void> {
    if (!props.client) {
      const message = t("memory.clientNotReady");
      setState({ status: "error", message });
      return Promise.reject(new Error(message));
    }

    const cacheKeys = logsCacheKeys(nextPage, nextTool, nextSourceAgent);
    const cached = (options.useCache ?? true) ? readMemoryPanelCacheFirst<MemoryApiLogsOutput>(cacheKeys) : null;
    setState((current) => cached ? { status: "ready", data: cached } : current.status === "ready" ? current : { status: "loading" });
    return loadLogsData(props.client, nextPage, nextTool, nextSourceAgent)
      .then((data) => {
        writeMemoryPanelCaches(cacheKeys, data);
        setState({ status: "ready", data });
      })
      .catch((error) => {
        setState({ status: "error", message: toErrorMessage(error) });
        throw error;
      });
  }

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [props.client, page, sourceAgent, tool, t]);

  return (
    <LogsSubPageView
      state={state}
      tool={tool}
      sourceAgent={sourceAgent}
      onToolChange={(nextTool) => {
        setTool(nextTool);
        setPage(1);
      }}
      onSourceAgentChange={(nextSourceAgent) => {
        setSourceAgent(nextSourceAgent);
        setPage(1);
      }}
      onPageChange={(nextPage) => setPage(normalizePage(nextPage))}
      onRefresh={() => refresh(page, tool, sourceAgent, { useCache: false })}
    />
  );
}

export interface LogsSubPageViewProps {
  state: RemoteData<MemoryApiLogsOutput>;
  tool: "" | MemoryApiLogToolName;
  sourceAgent: string;
  onToolChange: (tool: "" | MemoryApiLogToolName) => void;
  onSourceAgentChange: (sourceAgent: string) => void;
  onPageChange: (page: number) => void;
  onRefresh: () => void | Promise<void>;
}

export function LogsSubPageView(props: LogsSubPageViewProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const logs = props.state.status === "ready" ? props.state.data.logs : [];
  const filteredLogs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return logs.filter((log) => {
      if (!needle) {
        return true;
      }
      return `${log.toolName} ${log.inputJson} ${log.outputJson}`.toLowerCase().includes(needle);
    });
  }, [logs, query]);
  const pagination = props.state.status === "ready"
    ? logsPageInfo(props.state.data, query.trim() ? filteredLogs.length : undefined)
    : null;

  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  return (
    <section className="memory-panel">
      <div className="memory-panel__header memory-panel__header--single-line">
        <h3 className="memory-panel__title">
          <ScrollText size={18} className="text-text-ink/60" />
          {t("memory.logs.title")}
        </h3>
        <div className="memory-panel__header-actions">
          <MemoryRefreshButton onClick={props.onRefresh} />
        </div>
      </div>

      <div className="memory-toolbar">
        <div className="memory-source-search-control">
          <label className="memory-search">
            <Search size={15} className="memory-search__icon" />
            <input
              className="memory-search__input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("memory.logs.searchPlaceholder")}
              type="search"
            />
          </label>
          <MemoryAgentFilter
            id="memory-log-agent-filter"
            label={t("memory.logs.agentFilter.label")}
            value={props.sourceAgent}
            onValueChange={props.onSourceAgentChange}
            allLabel={t("memory.logs.agentFilter.all")}
            otherLabel={t("memory.logs.agentFilter.other")}
          />
        </div>
        <div className="memory-log-filter-group">
          {[
            { value: "", label: "all" },
            { value: "memory_add", label: "memory_add" },
            { value: "memory_search", label: "memory_search" }
          ].map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={props.tool === item.value}
              onClick={() => props.onToolChange(item.value as "" | MemoryApiLogToolName)}
              className={`memory-log-filter${props.tool === item.value ? " memory-log-filter--active" : ""}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {props.state.status === "loading" && <StateBox message={t("memory.logs.loading")} />}
      {props.state.status === "error" && <StateBox message={props.state.message} tone="error" />}
      {props.state.status === "ready" && filteredLogs.length === 0 && <StateBox message={t("memory.logs.empty")} />}
      {props.state.status === "ready" && filteredLogs.length > 0 && (
        <div className="memory-list">
          {filteredLogs.map((log) => {
            const input = parseJson(log.inputJson);
            const output = parseJson(log.outputJson);
            const isExpanded = expanded.has(log.id);
            const summary = buildSummary(log, input, output, t);
            return (
              <article key={log.id} className={`memory-log-card${isExpanded ? " memory-log-card--expanded" : ""}`}>
                <button
                  type="button"
                  onClick={() => toggleExpanded(log.id)}
                  className="memory-log-card__button"
                >
                  <span className={`memory-log-tool ${logToolClass(log.toolName)}`}>
                    {log.toolName}
                  </span>
                  <span className={`memory-log-card__summary${summary.tail ? " memory-log-card__summary--with-tail" : ""}`}>{summary.text}</span>
                  {summary.tail && <span className="memory-log-card__summary-tail">{summary.tail}</span>}
                  <span className="memory-log-card__meta">{formatDuration(log.durationMs)}</span>
                  <span className="memory-log-card__meta">{formatDate(log.calledAt)}</span>
                  <span className="memory-log-card__action">{isExpanded ? t("memory.logs.collapse") : t("memory.logs.expand")}</span>
                </button>
                {isExpanded && (
                  <div className="memory-log-card__details">
                    <LogDetail log={log} input={input} output={output} />
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {pagination && (
        <MemoryPagination data={pagination} onPageChange={props.onPageChange} />
      )}
    </section>
  );
}

interface SearchInput {
  query?: string;
  sessionId?: string;
  episodeId?: string;
}

interface SearchOutput {
  candidates?: SearchCandidate[];
  filtered?: SearchCandidate[];
  droppedByLlm?: SearchCandidate[];
  stats?: SearchStats;
  error?: string;
}

interface SearchStats {
  raw?: number;
  ranked?: number;
  finalReturned?: number;
  llmFilter?: {
    kept?: number;
    dropped?: number;
    outcome?: string;
  };
}

export interface SearchCandidate {
  refKind?: string;
  refId?: string;
  score?: number;
  tier?: string;
  memoryLayer?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  origin?: string;
  role?: string;
  owner?: string;
}

interface AddInput {
  sessionId?: string;
  episodeId?: string;
  turnCount?: number;
  layer?: string;
  source?: string;
  sourceAgent?: string;
  query?: string;
}

interface AddOutput {
  stored?: number;
  warnings?: Array<{ stage?: string; message?: string }>;
  details?: AddDetail[];
}

interface AddDetail {
  role?: string;
  action?: string;
  summary?: string | null;
  content?: string;
  traceId?: string;
  episodeId?: string;
  sourceAgent?: string;
  query?: string;
  agent?: string;
  reason?: string;
}

function LogDetail(props: { log: MemoryApiLog; input: unknown; output: unknown }) {
  if (props.log.toolName === "memory_search") {
    return <MemorySearchDetail sourceAgent={props.log.sourceAgent} input={props.input} output={props.output} />;
  }
  return <MemoryAddDetail sourceAgent={props.log.sourceAgent} input={props.input} output={props.output} />;
}

export function MemorySearchDetail(props: { sourceAgent?: string; input: unknown; output: unknown }) {
  const { t } = useTranslation();
  const input = asRecord(props.input) as SearchInput;
  const output = asRecord(props.output) as SearchOutput;
  const candidates = output.candidates ?? [];
  const filtered = output.filtered ?? [];
  const keptCandidateKeys = new Set(filtered.map(memorySearchCandidateKey));
  const sourceAgent = firstLogText(props.sourceAgent);

  return (
    <div className="memory-log-detail">
      <LogMetaList
        items={[
          sourceAgent ? { label: t("memory.logs.sourceAgent"), value: sourceAgent, tone: "agent" as const } : null
        ]}
      />
      {input.query && <LogTextBlock label={t("memory.logs.search.query")} value={input.query} tone="query" />}
      {output.error ? (
        <LogTextBlock label="Error" value={output.error} tone="error" />
      ) : (
        <CandidateSection
          rows={candidates}
          keptCandidateKeys={keptCandidateKeys}
          t={t}
        />
      )}
    </div>
  );
}

function CandidateSection(props: {
  rows: SearchCandidate[];
  keptCandidateKeys: Set<string>;
  t: Translate;
}) {
  const keptRows = props.rows.filter((candidate) => props.keptCandidateKeys.has(memorySearchCandidateKey(candidate)));
  const droppedRows = props.rows.filter((candidate) => !props.keptCandidateKeys.has(memorySearchCandidateKey(candidate)));

  return (
    <section className="memory-log-section">
      <div className="memory-log-candidate-groups">
        <CandidateGroup
          title={props.t("memory.logs.search.keptColumn")}
          count={keptRows.length}
          rows={keptRows}
          emptyLabel={props.t("memory.logs.search.emptyKept")}
        />
        <CandidateGroup
          title={props.t("memory.logs.search.filteredColumn")}
          count={droppedRows.length}
          rows={droppedRows}
          emptyLabel={props.t("memory.logs.search.emptyFiltered")}
          tone="muted"
        />
      </div>
    </section>
  );
}

function CandidateGroup(props: { title: string; count: number; rows: SearchCandidate[]; emptyLabel: string; tone?: "muted" }) {
  const visibleRows = props.rows.slice(0, 20);
  return (
    <div className={`memory-log-candidate-group${props.tone === "muted" ? " memory-log-candidate-group--muted" : ""}`}>
      <div className="memory-log-section__header memory-log-section__header--group">
        <span className="memory-log-section__title">{props.title}</span>
        <span className="memory-log-count">{props.count}</span>
      </div>
      {props.rows.length === 0 ? (
        <div className="memory-log-empty">{props.emptyLabel}</div>
      ) : (
        <div className="memory-log-candidate-list">
          {visibleRows.map((candidate, index) => (
            <CandidateRow
              candidate={candidate}
              isMuted={props.tone === "muted"}
              key={`${candidate.refId ?? "candidate"}-${index}`}
            />
          ))}
          {props.rows.length > 20 && <div className="memory-log-empty">+{props.rows.length - 20} more</div>}
        </div>
      )}
    </div>
  );
}

function CandidateRow(props: { candidate: SearchCandidate; isMuted?: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const candidate = props.candidate;
  const score = typeof candidate.score === "number" ? candidate.score : 0;
  const text = candidate.content ?? candidate.snippet ?? candidate.summary ?? "";
  const displayText = text || "(empty)";
  const layer = memorySearchCandidateLayerLabel(candidate);
  return (
    <details
      className={`memory-log-candidate${props.isMuted ? " memory-log-candidate--dropped" : ""}`}
      onToggle={(event) => setIsExpanded(event.currentTarget.open)}
    >
      <summary className="memory-log-candidate__summary">
        <span className="memory-log-score">{score.toFixed(3)}</span>
        <span className="memory-log-candidate__tags">
          <span className="memory-log-layer">{layer}</span>
        </span>
        <span className="memory-log-candidate__text">{displayText}</span>
      </summary>
      {isExpanded && <MemoryLogMarkdown className="memory-log-candidate__markdown" text={displayText} />}
    </details>
  );
}

function MemoryLogMarkdown(props: { text: string; className?: string }) {
  return (
    <div className={`memory-markdown memory-log-markdown${props.className ? ` ${props.className}` : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={LOG_MARKDOWN_COMPONENTS} skipHtml>
        {props.text}
      </ReactMarkdown>
    </div>
  );
}

function memorySearchCandidateKey(candidate: SearchCandidate): string {
  if (candidate.refId) {
    return `${candidate.refKind ?? "memory"}:${candidate.refId}`;
  }
  return [
    candidate.refKind ?? "",
    candidate.tier ?? "",
    candidate.memoryLayer ?? "",
    candidate.content ?? candidate.snippet ?? candidate.summary ?? ""
  ].join("|");
}

export function memorySearchCandidateLayerLabel(candidate: SearchCandidate): string {
  switch (candidate.tier ?? candidate.memoryLayer ?? candidate.refKind) {
    case "L1":
    case "trace":
    case "episode":
      return "L1";
    case "L2":
    case "policy":
    case "experience":
      return "L2";
    case "L3":
    case "world_model":
    case "world-model":
      return "L3";
    case "Skill":
    case "skill":
      return "Skill";
    default:
      return "Memory";
  }
}

export function MemoryAddDetail(props: { sourceAgent?: string; input: unknown; output: unknown }) {
  const { t } = useTranslation();
  const output = asRecord(props.output) as AddOutput;
  const warnings = output.warnings ?? [];
  const details = output.details ?? [];
  const detail = details[0] ?? {};
  const sourceAgent = firstLogText(props.sourceAgent, memoryAddSourceAgent(output));
  const traceId = firstLogText(detail.traceId);
  const episodeId = firstLogText(detail.episodeId);
  const query = firstLogText(detail.query);
  const agent = firstLogText(detail.agent);

  return (
    <div className="memory-log-detail">
      <LogMetaList
        items={[
          sourceAgent ? { label: t("memory.logs.sourceAgent"), value: sourceAgent, tone: "agent" as const } : null,
          traceId ? { label: "Trace ID", value: traceId } : null,
          episodeId ? { label: "Episode ID", value: episodeId } : null
        ]}
      />

      {query && <LogTextBlock label="User" value={query} tone="query" />}
      {agent && <LogTextBlock label="Assistant" value={agent} tone="agent" />}

      {warnings.length > 0 && (
        <section className="rounded-card border border-action-sky/25 bg-action-sky/8 p-3 text-sm text-text-ink/70">
          <div className="mb-1 text-xs text-action-sky">{t("memory.logs.add.warnings")}</div>
          <ul className="m-0 list-disc pl-5">
            {warnings.map((warning, index) => (
              <li key={`${warning.stage ?? "warning"}-${index}`}>
                {warning.stage && <span className="font-mono text-xs">{warning.stage} </span>}
                {warning.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!query && !agent && !traceId && details.length > 0 && (
        <LogTextBlock label={t("memory.logs.add.details")} value={detail.summary || detail.content || detail.reason || detail.traceId || "(empty)"} />
      )}
    </div>
  );
}

function LogMetaList(props: { items: Array<{ label: string; value: string; tone?: "agent" } | null> }) {
  const items = props.items.filter((item): item is { label: string; value: string; tone?: "agent" } => Boolean(item));
  if (items.length === 0) {
    return null;
  }

  return (
    <section className="memory-log-section memory-log-section--meta">
      <div className="memory-log-meta-list">
        {items.map((item) => (
          <div className={`memory-log-meta${item.tone === "agent" ? " memory-log-meta--agent" : ""}`} key={item.label}>
            <span className="memory-log-meta__label">{item.label}</span>
            {item.tone === "agent" ? (
              <MemoryAgentSourceTag sourceAgent={item.value} label={item.label} />
            ) : (
              <span className="memory-log-meta__value">{item.value}</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function LogTextBlock(props: { label: string; value: string; tone?: "query" | "agent" | "error" }) {
  return (
    <div className={`memory-log-text${props.tone ? ` memory-log-text--${props.tone}` : ""}`}>
      <div className="memory-log-text__label">{props.label}</div>
      <MemoryLogMarkdown className="memory-log-text__value" text={props.value} />
    </div>
  );
}

function logToolClass(toolName: MemoryApiLogToolName): string {
  return toolName === "memory_add" ? "memory-log-tool--add" : "memory-log-tool--search";
}

interface LogSummary {
  text: string;
  tail?: string;
}

function buildSummary(log: MemoryApiLog, input: unknown, output: unknown, t: Translate): LogSummary {
  if (log.toolName === "memory_search") {
    const searchInput = asRecord(input) as SearchInput;
    const searchOutput = asRecord(output) as SearchOutput;
    const query = searchInput.query?.trim();
    const counts = memorySearchSummaryCounts(searchOutput);
    const result = t("memory.logs.search.summary", {
      candidates: counts.candidates,
      filtered: counts.filtered
    });
    return query ? { text: query, tail: `· ${result}` } : { text: result };
  }
  const addInput = asRecord(input) as AddInput;
  const addOutput = asRecord(output) as AddOutput;
  const firstDetail = addOutput.details?.[0];
  return {
    text: firstLogText(
      usableAddSummary(firstDetail?.summary),
      firstDetail?.query,
      addInput.query,
      firstDetail?.content,
      firstDetail?.traceId
    ) ?? "memory item"
  };
}

function usableAddSummary(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  if (!text || ADD_STATUS_SUMMARIES.has(text)) {
    return undefined;
  }
  return text;
}

function memorySearchSummaryCounts(output: SearchOutput): { candidates: number; filtered: number } {
  const statsCandidateCount = firstNonNegativeInt(output.stats?.raw, output.stats?.ranked);
  const statsFilteredCount = firstNonNegativeInt(output.stats?.finalReturned, output.stats?.llmFilter?.kept);
  const candidateArrayCount = output.candidates?.length;
  const filteredArrayCount = output.filtered?.length;

  return {
    candidates: candidateArrayCount !== undefined && candidateArrayCount > 0
      ? candidateArrayCount
      : statsCandidateCount ?? candidateArrayCount ?? 0,
    filtered: filteredArrayCount !== undefined && filteredArrayCount > 0
      ? filteredArrayCount
      : statsFilteredCount ?? filteredArrayCount ?? 0
  };
}

function firstNonNegativeInt(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
  }
  return undefined;
}

function memoryAddSourceAgent(output: unknown): string | undefined {
  const addOutput = asRecord(output) as AddOutput;
  return firstLogText(...(addOutput.details ?? []).map((detail) => detail.sourceAgent));
}

function firstLogText(...values: Array<string | null | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function formatDuration(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function isMissingLogsRoute(error: unknown): boolean {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  const message = typeof candidate.message === "string" ? candidate.message : "";
  return (
    (error instanceof ApiRequestError || message.length > 0) &&
    candidate.status === 404 &&
    candidate.code === "not_found" &&
    message.toLowerCase().includes("logs")
  );
}

function emptyLogsOutput(offset: number): MemoryApiLogsOutput {
  return {
    logs: [],
    total: 0,
    limit: LOGS_PAGE_SIZE,
    offset,
    serverTime: new Date().toISOString()
  };
}

export function logsPageInfo(data: MemoryApiLogsOutput, visibleTotal?: number): MemoryPageInfo {
  const pageSize = Math.max(1, data.limit);
  if (visibleTotal !== undefined) {
    return {
      page: 1,
      pageSize,
      total: visibleTotal,
      totalPages: 1,
      hasPrev: false,
      hasNext: false
    };
  }
  const page = Math.floor(data.offset / pageSize) + 1;
  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
  return {
    page,
    pageSize,
    total: data.total,
    totalPages,
    hasPrev: page > 1,
    hasNext: data.nextOffset !== undefined || data.offset + data.logs.length < data.total
  };
}

function StateBox(props: { message: string; tone?: "error" }) {
  return <div className={`bg-background-paper rounded-card p-5 text-sm ${props.tone === "error" ? "border border-status-error/25 text-status-error" : "border-content-panel text-text-ink/60"}`}>{props.message}</div>;
}
