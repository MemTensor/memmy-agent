import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import { Icon } from "../components/Icon";
import { AgentSearchBar } from "../components/AgentSearchBar";
import { appendSourceAgentParam } from "../components/AgentSourceSelect";
import { RefreshButton } from "../components/RefreshButton";
import { Markdown } from "../components/Markdown";
import { Pager } from "../components/Pager";
import { t } from "../stores/i18n";
import { displayMemoryId } from "../utils/memory-id";
import { userMemoryTypeLabel } from "./user-memory-label";

type UserMemoryStatus = "active" | "archived" | "deleted";
type StatusFilter = "" | "active" | "archived";

interface UserMemoryDTO {
  id: string;
  title: string;
  content: string;
  memoryTypes: string[];
  status: UserMemoryStatus;
  sourceTurnId: string;
  sourceTurnRefs: string[];
  replacesMemoryId: string;
  replacedByMemoryId: string;
  archiveReason: string;
  createdAt: number;
  updatedAt: number;
}

interface ListResponse {
  userMemories: UserMemoryDTO[];
  limit: number;
  offset: number;
  nextOffset?: number;
  total: number;
}

const DEFAULT_PAGE_SIZE = 20;

export function UserMemoriesView() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [sourceAgentFilter, setSourceAgentFilter] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [items, setItems] = useState<UserMemoryDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserMemoryDTO | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        limit: String(pageSize),
        offset: String(page * pageSize),
      });
      if (query.trim()) qs.set("q", query.trim());
      if (status) qs.set("status", status);
      appendSourceAgentParam(qs, sourceAgentFilter);
      const response = await api.get<ListResponse>(`/api/v1/memories?${qs}`, { signal });
      setItems(response.userMemories ?? []);
      setTotal(response.total ?? 0);
      setError(null);
    } catch (nextError) {
      if ((nextError as Error).name !== "AbortError") {
        setItems([]);
        setTotal(0);
        setError((nextError as Error).message || t("memories.user.loadError"));
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => void load(controller.signal), 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, status, sourceAgentFilter, page, pageSize]);

  const remove = async (memory: UserMemoryDTO) => {
    if (!confirm(t("memories.user.delete.confirm"))) return;
    try {
      await api.del(`/api/v1/memory/${encodeURIComponent(memory.id)}`);
      if (detail?.id === memory.id) setDetail(null);
      setToast(t("memories.delete.done"));
      setTimeout(() => setToast(null), 2400);
      await load();
    } catch (nextError) {
      setError((nextError as Error).message || t("memories.user.loadError"));
    }
  };

  return (
    <>
      <div class="view-header">
        <div class="view-header__title">
          <h1>{t("userMemories.title")}</h1>
          <p>{t("userMemories.subtitle")}</p>
        </div>
      </div>
      <div class="toolbar">
        <AgentSearchBar
          query={query}
          placeholder={t("memories.user.search.placeholder")}
          sourceAgent={sourceAgentFilter}
          onQueryChange={(value) => {
            setPage(0);
            setQuery(value);
          }}
          onSourceAgentChange={(value) => {
            setPage(0);
            setSourceAgentFilter(value);
          }}
        />
        <RefreshButton onRefresh={() => load()} />
      </div>

      <div class="toolbar" style="margin-top:calc(-1 * var(--sp-2))">
        <div class="toolbar__group" role="group" aria-label={t("memories.user.status")}>
          {([
            ["", "common.all"],
            ["active", "memories.user.status.active"],
            ["archived", "memories.user.status.archived"],
          ] as const).map(([value, key]) => (
            <button
              key={value}
              class="chip"
              aria-pressed={status === value}
              onClick={() => {
                setPage(0);
                setStatus(value);
              }}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </div>

      {!loading && error && (
        <div class="empty">
          <div class="empty__icon"><Icon name="circle-alert" size={22} /></div>
          <div class="empty__title">{t("memories.user.loadError")}</div>
          <div class="empty__hint">{error}</div>
        </div>
      )}

      {loading && items.length === 0 && !error && (
        <div class="list">
          {[0, 1, 2, 3].map((index) => <div key={index} class="skeleton" style="height:82px" />)}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div class="empty">
          <div class="empty__icon"><Icon name="brain-circuit" size={22} /></div>
          <div class="empty__title">{t("memories.user.empty")}</div>
          <div class="empty__hint">{t("memories.user.empty.hint")}</div>
        </div>
      )}

      {items.length > 0 && (
        <div class="list">
          {items.map((memory) => (
            <div
              key={memory.id}
              class="mem-card"
              role="button"
              tabIndex={0}
              onClick={() => setDetail(memory)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setDetail(memory);
                }
              }}
            >
              <div class="mem-card__body">
                <div class="mem-card__title">{memory.content || memory.title}</div>
                <div class="mem-card__meta">
                  <span class={`pill pill--${memory.status === "active" ? "active" : "archived"}`}>
                    {t(`memories.user.status.${memory.status}` as never)}
                  </span>
                  {memory.memoryTypes.map((type) => (
                    <span key={type} class="pill pill--info">{userMemoryTypeLabel(type, t)}</span>
                  ))}
                  <span>{formatTime(memory.updatedAt || memory.createdAt)}</span>
                </div>
              </div>
              <div class="mem-card__tail"><Icon name="chevron-right" size={16} /></div>
            </div>
          ))}
        </div>
      )}

      {(total > pageSize || page > 0) && (
        <Pager
          page={page}
          totalItems={total}
          pageSize={pageSize}
          loading={loading}
          onPageSizeChange={(nextSize) => {
            setPage(0);
            setPageSize(nextSize);
          }}
          onPageChange={setPage}
        />
      )}

      {detail && (
        <UserMemoryDrawer
          memory={detail}
          onClose={() => setDetail(null)}
          onDelete={() => void remove(detail)}
        />
      )}

      {toast && <div class="toast-stack"><div class="toast toast--success">{toast}</div></div>}
    </>
  );
}

function UserMemoryDrawer({
  memory,
  onClose,
  onDelete,
}: {
  memory: UserMemoryDTO;
  onClose: () => void;
  onDelete: () => void;
}) {
  return (
    <div class="drawer-backdrop" onClick={onClose}>
      <aside class="drawer" role="dialog" onClick={(event) => event.stopPropagation()}>
        <header class="drawer__header">
          <div style="min-width:0">
            <div class="muted mono" style="font-size:var(--fs-xs);margin-bottom:2px;overflow-wrap:anywhere">
              {displayMemoryId(memory.id)}
            </div>
            <h2 class="drawer__title truncate">{memory.title || memory.content}</h2>
          </div>
          <button class="btn btn--ghost btn--icon" onClick={onClose} aria-label={t("common.close")}>
            <Icon name="x" size={16} />
          </button>
        </header>

        <div class="drawer__body">
          <section class="card card--flat">
            <div class="muted" style="font-size:var(--fs-xs);margin-bottom:4px">
              {t("memories.user.content")}
            </div>
            <Markdown text={memory.content} />
          </section>

          <section class="card card--flat">
            <h3 class="card__title" style="font-size:var(--fs-md)">{t("tasks.detail.meta")}</h3>
            <dl style="display:grid;grid-template-columns:160px 1fr;gap:6px 16px;margin:0;font-size:var(--fs-sm)">
              <dt class="muted">{t("memories.field.status")}</dt>
              <dd>{t(`memories.user.status.${memory.status}` as never)}</dd>
              <dt class="muted">{t("memories.user.types")}</dt>
              <dd>{memory.memoryTypes.length ? memory.memoryTypes.map((type) => userMemoryTypeLabel(type, t)).join(" · ") : "—"}</dd>
              <dt class="muted">{t("memories.field.createdAt")}</dt>
              <dd>{formatTime(memory.createdAt)}</dd>
              <dt class="muted">{t("memories.field.updatedAt")}</dt>
              <dd>{formatTime(memory.updatedAt)}</dd>
              {memory.sourceTurnId && (
                <>
                  <dt class="muted">{t("memories.user.sourceTurn")}</dt>
                  <dd class="mono">{memory.sourceTurnId}</dd>
                </>
              )}
              {memory.replacedByMemoryId && (
                <>
                  <dt class="muted">{t("memories.user.replacedBy")}</dt>
                  <dd class="mono">{memory.replacedByMemoryId}</dd>
                </>
              )}
              {memory.archiveReason && (
                <>
                  <dt class="muted">{t("memories.user.archiveReason")}</dt>
                  <dd>{memory.archiveReason}</dd>
                </>
              )}
            </dl>
          </section>
        </div>

        <footer class="drawer__footer">
          <button class="btn btn--danger btn--sm" onClick={onDelete}>
            <Icon name="trash-2" size={14} />
            {t("memories.act.delete")}
          </button>
          <div class="batch-bar__spacer" />
          <button class="btn btn--ghost btn--sm" onClick={onClose}>{t("common.close")}</button>
        </footer>
      </aside>
    </div>
  );
}

function formatTime(timestamp: number): string {
  return timestamp ? new Date(timestamp).toLocaleString() : "—";
}
