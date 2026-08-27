import { useEffect, useRef, useState } from "react";
import type { MemoryListItem, PanelItemsInput, PanelItemsOutput } from "@memmy/local-api-contracts";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import type { MessageKey } from "../../i18n/messages.js";
import { formatUserDateTime } from "../../lib/user-time-zone.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { MemoryDrawerDeleteAction } from "./memory-delete-action.js";
import { MemoryPagination, normalizePage } from "./memory-pagination.js";
import { ChevronRight, Search, UserRound, X } from "./memory-prototype-icons.js";
import { MemoryRefreshButton } from "./memory-refresh-button.js";
import { MemoryStateBox } from "./memory-state-box.js";
import type { RemoteData } from "./remote-state.js";
import { toErrorMessage } from "./remote-state.js";

export interface UserMemoriesSubPageProps {
  client: MemoryRuntimeClient | null;
}

export function buildUserMemoryPanelItemsInput(query: string, page: number): PanelItemsInput {
  const input: PanelItemsInput = { layer: "UserMemory", page: normalizePage(page) };
  const normalizedQuery = query.trim();
  if (normalizedQuery) input.q = normalizedQuery;
  return input;
}

export function UserMemoriesSubPage(props: UserMemoriesSubPageProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState<RemoteData<PanelItemsOutput>>({ status: "loading" });
  const [selected, setSelected] = useState<MemoryListItem | null>(null);
  const requestIdRef = useRef(0);

  function refresh(nextPage = page): Promise<PanelItemsOutput | undefined> {
    if (!props.client) {
      const message = t("memory.clientNotReady");
      setState({ status: "error", message });
      return Promise.reject(new Error(message));
    }
    const requestId = ++requestIdRef.current;
    setState((current) => current.status === "ready" ? current : { status: "loading" });
    return props.client.listPanelItems(buildUserMemoryPanelItemsInput(query, nextPage))
      .then((data) => {
        if (requestId === requestIdRef.current) {
          setPage(data.page);
          setState({ status: "ready", data });
        }
        return data;
      })
      .catch((error) => {
        if (requestId === requestIdRef.current) {
          setState({ status: "error", message: toErrorMessage(error) });
        }
        return undefined;
      });
  }

  useEffect(() => {
    void refresh(1);
    return () => {
      requestIdRef.current += 1;
    };
  }, [props.client]);

  async function deleteSelected(): Promise<void> {
    if (!props.client || !selected) return;
    await props.client.deleteMemory(selected.id);
    setSelected(null);
    await refresh(page);
  }

  return (
    <section className="memory-panel">
      <div className="memory-panel__header">
        <div className="memory-panel__header-main">
          <h3 className="memory-panel__title">
            <UserRound size={18} className="text-text-ink/60" />
            {t("memory.userMemories.title")}
          </h3>
          <p className="memory-panel__subtitle">{t("memory.userMemories.description")}</p>
        </div>
        <MemoryRefreshButton onClick={() => void refresh()} />
      </div>

      <div className="memory-toolbar">
        <label className="memory-search">
          <Search size={15} className="memory-search__icon" />
          <input
            type="search"
            value={query}
            placeholder={t("memory.userMemories.searchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void refresh(1);
            }}
            className="memory-search__input"
          />
        </label>
      </div>

      {state.status === "loading" ? <MemoryStateBox message={t("memory.userMemories.loading")} /> : null}
      {state.status === "error" ? <MemoryStateBox message={state.message} tone="error" /> : null}
      {state.status === "ready" ? (
        <>
          <div className="memory-list">
            {state.data.items.length === 0 ? <MemoryStateBox message={t("memory.userMemories.empty")} /> : null}
            {state.data.items.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-selected={selected?.id === item.id}
                onClick={() => setSelected(item)}
                className={`memory-card w-full text-left${selected?.id === item.id ? " memory-card--selected" : ""}`}
              >
                <span className="memory-card__body">
                  <span className="memory-card__title">{item.title}</span>
                  <span className="memory-card__meta">
                    <span className="memory-pill memory-pill--kind">{userMemoryTypeLabel(item, t)}</span>
                    <UserMemoryStatusPill status={item.status} />
                    <span>{formatUserDateTime(item.updatedAt)}</span>
                  </span>
                </span>
                <span className="memory-card__tail"><ChevronRight size={16} /></span>
              </button>
            ))}
          </div>
          <MemoryPagination
            data={state.data}
            onPageChange={(nextPage) => void refresh(nextPage)}
          />
        </>
      ) : null}

      {selected ? (
        <div className="memory-drawer-backdrop" onClick={() => setSelected(null)}>
          <button
            type="button"
            className="memory-drawer-backdrop__close"
            tabIndex={-1}
            aria-hidden="true"
            onClick={(event) => {
              event.stopPropagation();
              setSelected(null);
            }}
          />
          <aside
            className="memory-drawer memory-drawer--entry"
            role="dialog"
            aria-modal="true"
            aria-labelledby="memory-user-memory-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="memory-drawer__header">
              <div>
                <div className="memory-drawer__identity">
                  <span id="memory-user-memory-title" className="memory-drawer__eyebrow">{selected.id}</span>
                </div>
              </div>
              <button
                type="button"
                className="memory-drawer__close"
                aria-label={t("common.close")}
                onClick={() => setSelected(null)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="memory-drawer__body">
              <section className="memory-detail-card">
                <h5 className="memory-detail-card__label">{t("memory.userMemories.content")}</h5>
                <p className="whitespace-pre-wrap break-words">{selected.summary}</p>
              </section>
              <section className="memory-detail-card">
                <h5 className="memory-detail-card__label">{t("memory.memories.meta")}</h5>
                <dl className="memory-detail-grid">
                  <dt>{t("memory.userMemories.type")}</dt>
                  <dd><span className="memory-pill memory-pill--kind">{userMemoryTypeLabel(selected, t)}</span></dd>
                  <dt>{t("memory.memories.status")}</dt>
                  <dd><UserMemoryStatusPill status={selected.status} /></dd>
                  <dt>{t("memory.memories.createdAt")}</dt>
                  <dd>{formatUserDateTime(selected.createdAt)}</dd>
                  <dt>{t("memory.memories.updatedAt")}</dt>
                  <dd>{formatUserDateTime(selected.updatedAt)}</dd>
                  <dt>{t("memory.userMemories.sourceTurn")}</dt>
                  <dd className="break-all">{metadataText(selected, "sourceTurnId")}</dd>
                  <dt>{t("memory.userMemories.expressionCount")}</dt>
                  <dd>{metadataArray(selected, "sourceTurnRefs").length}</dd>
                </dl>
              </section>
            </div>
            <MemoryDrawerDeleteAction onDelete={deleteSelected} />
          </aside>
        </div>
      ) : null}
    </section>
  );
}

function UserMemoryStatusPill(props: { status: MemoryListItem["status"] }) {
  const { t } = useTranslation();
  return (
    <span className={`memory-pill memory-pill--user-memory-${userMemoryStatusTone(props.status)}`}>
      {userMemoryStatusLabel(props.status, t)}
    </span>
  );
}

function userMemoryStatusTone(status: MemoryListItem["status"]): "active" | "archived" | "deleted" {
  if (status === "activated") return "active";
  if (status === "archived") return "archived";
  return "deleted";
}

function userMemoryTypeLabel(item: MemoryListItem, t: (key: MessageKey) => string): string {
  const types = metadataArray(item, "memoryTypes");
  const values = types.length > 0 ? types : item.tags;
  return values.map((type) => {
    if (type === "User Fact") return t("memory.userMemories.type.fact");
    if (type === "User Preference") return t("memory.userMemories.type.preference");
    if (type === "User Directive") return t("memory.userMemories.type.directive");
    return type;
  }).join(" · ");
}

function userMemoryStatusLabel(status: MemoryListItem["status"], t: (key: MessageKey) => string): string {
  if (status === "activated") return t("memory.userMemories.status.active");
  if (status === "archived") return t("memory.userMemories.status.archived");
  return t("memory.userMemories.status.deleted");
}

function metadataArray(item: MemoryListItem, key: string): string[] {
  const value = item.metadata?.[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function metadataText(item: MemoryListItem, key: string): string {
  const value = item.metadata?.[key];
  return typeof value === "string" ? value : "—";
}
