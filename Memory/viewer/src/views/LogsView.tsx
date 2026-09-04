/**
 * Logs view — structured trail of `memory_search` and `memory_add`
 * calls. Each row shows the retrieved / filtered candidates
 * each row shows the retrieved / filtered candidates (with scores
 * and origin tags) for search and the per-turn stored items for
 * ingest — not just raw log text.
 *
 * Backing data: `GET /api/v1/api-logs?tool=…&limit=&offset=`
 *   - Response row shape (ApiLogDTO): { id, toolName, inputJson,
 *     outputJson, sourceAgent?, durationMs, success, calledAt }
 *   - Both JSON blobs are stored verbatim and the client is the
 *     single source of truth for how to render them — per-tool
 *     templates live in this file, one per known tool name.
 *
 */
import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import { t } from "../stores/i18n";
import { Icon } from "../components/Icon";
import { AgentSearchBar } from "../components/AgentSearchBar";
import { Markdown } from "../components/Markdown";
import { Pager } from "../components/Pager";
import { RefreshButton } from "../components/RefreshButton";
import { agentClass, sourceAgentLabel } from "../components/AgentSourceSelect";
import type { ApiLogDTO } from "../api/types";
import {
  buildMemoryLogSummary,
  firstLogText,
  memoryAddSourceAgent,
  memorySearchCandidateKey,
  memorySearchCandidateLayerLabel,
  memorySearchCandidates,
  type AddOutput,
  type SearchCandidate,
  type SearchInput,
  type SearchOutput,
} from "./log-utils";

type ToolFilter = "memory_search" | "memory_add";
type LogTag = "" | ToolFilter;

const LOG_TAGS: Array<{ v: LogTag; k: string }> = [
  { v: "", k: "common.all" },
  { v: "memory_add", k: "logs.tag.memoryAdd" },
  { v: "memory_search", k: "logs.tag.memorySearch" },
];

const ALLOWED_TOOLS: Record<LogTag, readonly ToolFilter[]> = {
  "": ["memory_add", "memory_search"],
  memory_add: ["memory_add"],
  memory_search: ["memory_search"],
};

interface ApiLogsResponse {
  logs: ApiLogDTO[];
  total: number;
  limit: number;
  offset: number;
  nextOffset?: number;
}

const DEFAULT_PAGE_SIZE = 25;

export function LogsView() {
  const [tag, setTag] = useState<LogTag>("");
  const [query, setQuery] = useState("");
  const [sourceAgentFilter, setSourceAgentFilter] = useState("");
  const [logs, setLogs] = useState<ApiLogDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const currentAllowed = ALLOWED_TOOLS[tag];
  const clientFilterActive = query.trim().length > 0;

  const load = async (opts: {
    tag: LogTag;
    page: number;
    query: string;
    sourceAgent: string;
  }) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      const allowed = ALLOWED_TOOLS[opts.tag];
      const needsClient = opts.query.trim().length > 0;
      const limit = needsClient ? 500 : pageSize;
      qs.set("limit", String(limit));
      qs.set("offset", String(needsClient ? 0 : opts.page * pageSize));
      qs.set("tools", allowed.join(","));
      if (opts.sourceAgent) qs.set("sourceAgent", opts.sourceAgent);
      const res = await api.get<ApiLogsResponse>(`/api/v1/api-logs?${qs.toString()}`);
      setLogs(res.logs);
      setTotal(needsClient ? res.logs.length : res.total);
      setPage(opts.page);
    } catch {
      setLogs([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load({ tag, page: 0, query, sourceAgent: sourceAgentFilter });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, pageSize, sourceAgentFilter]);

  // Debounced client-side refresh when the search query changes.
  useEffect(() => {
    const h = setTimeout(() => {
      void load({ tag, page: 0, query, sourceAgent: sourceAgentFilter });
    }, 200);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, pageSize, sourceAgentFilter]);

  const toggleExpand = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const needle = query.trim().toLowerCase();
  const filtered = logs.filter((log) => {
        if (!currentAllowed.includes(log.toolName as ToolFilter)) return false;
        if (!clientFilterActive) return true;
        const hay = `${log.toolName} ${log.inputJson ?? ""} ${log.outputJson ?? ""}`.toLowerCase();
        return hay.includes(needle);
      });
  const pagedRows = clientFilterActive
    ? filtered.slice(page * pageSize, (page + 1) * pageSize)
    : filtered;
  const displayTotal = clientFilterActive ? filtered.length : total;


  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("logs.title")}</h1>
          <p>{t("logs.subtitle")}</p>
        </div>
        <div class="view-header__actions hstack">
          <RefreshButton onRefresh={() => load({ tag, page, query, sourceAgent: sourceAgentFilter })} />
        </div>
      </div>

      {/* Row 1: text and Agent source search, matching Memmy. */}
      <div class="toolbar">
        <AgentSearchBar
          query={query}
          placeholder={t("logs.search.placeholder")}
          sourceAgent={sourceAgentFilter}
          onQueryChange={setQuery}
          onSourceAgentChange={setSourceAgentFilter}
        />
      </div>

      {/* Row 2: flat tag chips, same as other views. */}
      <div class="toolbar" style="margin-top:calc(-1 * var(--sp-2))">
        <div class="toolbar__group" role="group" aria-label={t("common.filter")}>
          {LOG_TAGS.map((c) => (
            <button
              key={c.v}
              class="chip"
              aria-pressed={tag === c.v}
              onClick={() => setTag(c.v)}
            >
              {t(c.k as never)}
            </button>
          ))}
        </div>
        <div class="toolbar__spacer" />
        {displayTotal > 0 && (
            <span class="muted" style="font-size:var(--fs-xs)">
              {t("logs.totalRows", { n: displayTotal })}
            </span>
        )}
      </div>

      {loading && pagedRows.length === 0 && (
        <div class="list">
          {[0, 1, 2].map((i) => (
            <div key={i} class="skeleton" style="height:96px" />
          ))}
        </div>
      )}

      {!loading && pagedRows.length === 0 && (
          <div class="empty">
            <div class="empty__icon">
              <Icon name="scroll-text" size={22} />
            </div>
            <div class="empty__title">{t("logs.empty.title")}</div>
            <div class="empty__hint">{t("logs.empty.hint")}</div>
          </div>
        )}

      {pagedRows.length > 0 && (
        <div class="list">
          {pagedRows.map((lg) => (
            <LogCard
              key={lg.id}
              log={lg}
              expanded={expanded.has(lg.id)}
              onToggle={() => toggleExpand(lg.id)}
            />
          ))}
        </div>
      )}

      {displayTotal > pageSize && (
        <Pager
          page={page}
          totalItems={displayTotal}
          pageSize={pageSize}
          loading={loading}
          onPageSizeChange={setPageSize}
          onPageChange={(nextPage) => {
            if (clientFilterActive) setPage(nextPage);
            else void load({
              tag,
              page: nextPage,
              query,
              sourceAgent: sourceAgentFilter,
            });
          }}
        />
      )}
    </>
  );
}

// ─── One log row ─────────────────────────────────────────────────────────

function LogCard({
  log,
  expanded,
  onToggle,
}: {
  log: ApiLogDTO;
  expanded: boolean;
  onToggle: () => void;
}) {
  const input = parseJson(log.inputJson);
  const output = parseJson(log.outputJson);
  const summary = buildMemoryLogSummary(log, input, output) ?? {
    text: "memory item",
  };
  return (
    <div class={`log-card${expanded ? " log-card--expanded" : ""}`}>
      <header class="log-card__header" onClick={onToggle}>
        <span
          class={`log-card__status log-card__status--${log.success ? "ok" : "fail"}`}
          aria-hidden="true"
        />
        <span class={`pill pill--tool pill--tool-${sanitize(log.toolName)}`}>
          {log.toolName}
        </span>
        <span class={`log-card__summary${summary.tail ? " log-card__summary--with-tail" : ""}`}>
          {summary.text}
        </span>
        {summary.tail && <span class="log-card__summary-tail">{summary.tail}</span>}
        <span class="muted mono" style="font-size:var(--fs-xs)">
          {formatLogDuration(log)}
        </span>
        <span class="muted" style="font-size:var(--fs-xs)">
          {formatTs(log.calledAt)}
        </span>
        <Icon name={expanded ? "chevron-up" : "chevron-down"} size={14} />
      </header>

      {expanded && (
        <div class="log-card__body">
          <LogDetailBody log={log} input={input} output={output} />
        </div>
      )}
    </div>
  );
}

function LogDetailBody({
  log,
  input,
  output,
}: {
  log: ApiLogDTO;
  input: unknown;
  output: unknown;
}) {
  if (log.toolName === "memory_search") {
    return <MemorySearchDetail sourceAgent={log.sourceAgent} input={input} output={output} />;
  }
  if (log.toolName === "memory_add") {
    return <MemoryAddDetail sourceAgent={log.sourceAgent} input={input} output={output} />;
  }
  return null;
}

// ─── memory_search template ────────────────────────────────────────────

function MemorySearchDetail({
  sourceAgent,
  input,
  output,
}: {
  sourceAgent?: string;
  input: unknown;
  output: unknown;
}) {
  const inp = (input ?? {}) as SearchInput;
  const out = (output ?? {}) as SearchOutput;
  const candidates = memorySearchCandidates(out);
  const filtered = out.filtered ?? [];
  const keptCandidateKeys = new Set(filtered.map(memorySearchCandidateKey));
  return (
    <div class="memory-log-detail">
      <LogMetaList
        items={[
          sourceAgent
            ? { label: t("logs.sourceAgent"), value: sourceAgent, tone: "agent" as const }
            : null,
        ]}
      />
      {inp.query && <LogTextBlock label={t("logs.search.query")} value={inp.query} tone="query" />}
      {out.error ? (
        <LogTextBlock label="Error" value={out.error} tone="error" />
      ) : (
        <CandidateSection rows={candidates} keptCandidateKeys={keptCandidateKeys} />
      )}
    </div>
  );
}

function CandidateSection({
  rows,
  keptCandidateKeys,
}: {
  rows: SearchCandidate[];
  keptCandidateKeys: Set<string>;
}) {
  const keptRows = rows.filter((candidate) =>
    keptCandidateKeys.has(memorySearchCandidateKey(candidate))
  );
  const droppedRows = rows.filter((candidate) =>
    !keptCandidateKeys.has(memorySearchCandidateKey(candidate))
  );
  return (
    <section class="memory-log-section">
      <div class="memory-log-candidate-groups">
        <CandidateGroup
          title={t("logs.search.keptColumn")}
          rows={keptRows}
          emptyLabel={t("logs.search.emptyKept")}
        />
        <CandidateGroup
          title={t("logs.search.filteredColumn")}
          rows={droppedRows}
          emptyLabel={t("logs.search.emptyFiltered")}
          muted
        />
      </div>
    </section>
  );
}

function CandidateGroup({
  title,
  rows,
  emptyLabel,
  muted = false,
}: {
  title: string;
  rows: SearchCandidate[];
  emptyLabel: string;
  muted?: boolean;
}) {
  return (
    <div class={`memory-log-candidate-group${muted ? " memory-log-candidate-group--muted" : ""}`}>
      <div class="memory-log-section__header">
        <span class="memory-log-section__title">{title}</span>
        <span class="memory-log-count">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <div class="memory-log-empty">{emptyLabel}</div>
      ) : (
        <div class="memory-log-candidate-list">
          {rows.slice(0, 20).map((candidate, index) => (
            <CandidateRow
              key={`${candidate.refId ?? "candidate"}-${index}`}
              candidate={candidate}
              muted={muted}
            />
          ))}
          {rows.length > 20 && <div class="memory-log-empty">+{rows.length - 20} more</div>}
        </div>
      )}
    </div>
  );
}

function CandidateRow({ candidate, muted }: { candidate: SearchCandidate; muted?: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const score = typeof candidate.score === "number" ? candidate.score : 0;
  const band = score >= 0.7 ? "high" : score >= 0.4 ? "mid" : "low";
  const text = (candidate.content ?? candidate.snippet ?? candidate.summary ?? "").toString();
  const displayText = text || "(empty)";
  return (
    <details
      class={`memory-log-candidate${muted ? " memory-log-candidate--dropped" : ""}`}
      onToggle={(event) => setIsExpanded(event.currentTarget.open)}
    >
      <summary class="memory-log-candidate__summary">
        <span class={`log-score log-score--${band}`}>{score.toFixed(3)}</span>
        <span class="memory-log-layer">{memorySearchCandidateLayerLabel(candidate)}</span>
        <span class="memory-log-candidate__text">{displayText}</span>
      </summary>
      {isExpanded && (
        <div class="memory-log-candidate__markdown">
          <Markdown text={displayText} />
        </div>
      )}
    </details>
  );
}

// ─── memory_add template ────────────────────────────────────────────────

function MemoryAddDetail({
  sourceAgent: logSourceAgent,
  input,
  output,
}: {
  sourceAgent?: string;
  input: unknown;
  output: unknown;
}) {
  const out = (output ?? {}) as AddOutput;
  const warnings = out.warnings ?? [];
  const details = out.details ?? [];
  const detail = details[0] ?? {};
  const sourceAgent = firstLogText(logSourceAgent, memoryAddSourceAgent(out));
  const traceId = firstLogText(detail.traceId);
  const episodeId = firstLogText(detail.episodeId);
  const query = firstLogText(detail.query);
  const agent = firstLogText(detail.agent);
  return (
    <div class="memory-log-detail">
      <LogMetaList
        items={[
          sourceAgent
            ? { label: t("logs.sourceAgent"), value: sourceAgent, tone: "agent" as const }
            : null,
          traceId ? { label: "Trace ID", value: traceId } : null,
          episodeId ? { label: "Episode ID", value: episodeId } : null,
        ]}
      />

      {query && <LogTextBlock label="User" value={query} tone="query" />}
      {agent && <LogTextBlock label="Assistant" value={agent} tone="agent" />}

      {warnings.length > 0 && (
        <section
          class="card card--flat"
          style="border-color:var(--warning);background:var(--warning-soft)"
        >
          <div style="font-size:var(--fs-xs);color:var(--warning);margin-bottom:4px">
            {t("logs.add.warnings")}
          </div>
          <ul style="margin:0;padding-left:20px;font-size:var(--fs-sm)">
            {warnings.map((w, i) => (
              <li key={i}>
                <span class="mono" style="font-size:var(--fs-xs)">{w.stage}</span>{" "}
                {w.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!query && !agent && !traceId && details.length > 0 && (
        <LogTextBlock
          label={t("logs.add.details")}
          value={detail.summary || detail.content || detail.reason || detail.traceId || "(empty)"}
        />
      )}
    </div>
  );
}

function LogMetaList({
  items,
}: {
  items: Array<{ label: string; value: string; tone?: "agent" } | null>;
}) {
  const visibleItems = items.filter(
    (item): item is { label: string; value: string; tone?: "agent" } => Boolean(item)
  );
  if (visibleItems.length === 0) return null;
  return (
    <section class="memory-log-section memory-log-section--meta">
      <div class="memory-log-meta-list">
        {visibleItems.map((item) => (
          <div class="memory-log-meta" key={item.label}>
            <span class="memory-log-meta__label">{item.label}</span>
            {item.tone === "agent" ? (
              <span class={`pill pill--agent pill--agent-${agentClass(item.value)}`}>
                {sourceAgentLabel(item.value)}
              </span>
            ) : (
              <span class="memory-log-meta__value">{item.value}</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function LogTextBlock({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "query" | "agent" | "error";
}) {
  return (
    <div class={`memory-log-text${tone ? ` memory-log-text--${tone}` : ""}`}>
      <div class="memory-log-text__label">{label}</div>
      <div class="memory-log-text__value">
        <Markdown text={value} />
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

function formatLogDuration(log: ApiLogDTO): string {
  return log.durationMs > 0 ? `${log.durationMs}ms` : "<1ms";
}

function parseJson(value: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function formatTs(timestamp: number): string {
  if (!timestamp) return "—";
  return new Date(timestamp).toLocaleString();
}

function sanitize(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
}
