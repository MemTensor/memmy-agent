import { usePanelReadGuard } from "./panel-visibility.js";
import { canPreservePanelResult } from "./panel-view-status.js";
import {isUnsupportedPanelRoute} from "../../api/memory-runtime-client.js";
import { usePanelViewStatus } from "./panel-view-status.js";
import { usePanelLoad } from "./use-panel-load.js";
import { useEffect, useRef, useState } from "react";
import type { GetMemoryOutput, MemoryApiLog, MemoryApiLogToolName, PanelItemsOutput } from "@memmy/local-api-contracts";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import { formatUserDateTime } from "../../lib/user-time-zone.js";
import {
  buildMemoryUiDeletedEvent,
  buildMemoryUiDetailOpenedEvent,
  buildMemoryUiPanelRefreshedEvent,
  buildMemoryUiSearchSubmittedEvent
} from "../../analytics/memory-ui-analytics.js";
import { useAnalytics } from "../../analytics/use-analytics.js";
import type { MessageKey } from "../../i18n/messages.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { ChevronRight, Search, Wand2, X } from "./memory-prototype-icons.js";
import { MemoryDrawerDeleteAction } from "./memory-delete-action.js";
import { toMemoryDetailErrorMessage } from "./memory-detail-error.js";
import { cleanMemoryBody, cleanMemoryText, drawerEyebrow } from "./memory-display.js";
import { displayMemoryId } from "./memory-id.js";
import { MemoryMarkdown } from "./memory-markdown.js";
import {
  MemoryReferenceTags,
  type MemoryReferenceOpenRequest,
  type MemoryReferencePage,
  type OpenMemoryReference
} from "./memory-reference-tags.js";
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
import { demoSkillDetail, demoSkillPanelItems, demoSkillTimeline, isSkillsDemoEnabled } from "./skill-demo-data.js";
import "./skill-editor.css";

type SkillDetailState = RemoteData<SkillDetailData> | null;
const SKILLS_CACHE_SECTION = "skills";
const SKILL_TIMELINE_TOOLS: MemoryApiLogToolName[] = ["skill_generate", "skill_evolve"];
type SkillStatusTone = "candidate" | "active" | "archived" | "deleted" | "unknown";
type SkillTimelineTone = "running" | "succeeded" | "failed" | "skipped";

interface SkillDetailData {
  detail: GetMemoryOutput;
  timeline: SkillTimelineEntry[];
}

export interface SkillTimelineEntry {
  ts: string;
  kind: string;
  phase?: string;
  durationMs: number;
  success: boolean;
  summary?: string;
}

interface SkillDecisionGuidance {
  preference: string[];
  antiPattern: string[];
}

interface SkillView {
  title: string;
  status: string;
  source?: string;
  createdAt: string;
  updatedAt: string;
  body: string;
  usageGuide: string;
  decisionGuidance: SkillDecisionGuidance;
  evidenceAnchors: string[];
  sourcePolicyIds: string[];
  eta?: number;
  support?: number;
  gain?: number;
  trialsAttempted?: number;
  trialsPassed?: number;
  usageCount?: number;
  lastUsedAt?: string;
}

export interface SkillsSubPageProps {
  client: MemoryRuntimeClient | null;
  openRequest?: MemoryReferenceOpenRequest;
  onOpenMemoryReference: OpenMemoryReference;
}

export function loadSkillsData(client: MemoryRuntimeClient, query = ""): Promise<PanelItemsOutput> {
  return loadSkillsDataPage(client, query, 1);
}

export function loadSkillsDataPage(client: MemoryRuntimeClient, query = "", page = 1): Promise<PanelItemsOutput> {
  const keyword = query.trim();
  return client.listPanelItems(
    keyword ? { layer: "Skill", q: keyword, page: normalizePage(page) } : { layer: "Skill", page: normalizePage(page) }
  );
}

export function loadSkillDetail(client: MemoryRuntimeClient, skillId: string): Promise<GetMemoryOutput> {
  return client.getMemory(skillId);
}

export async function loadSkillTimeline(client: MemoryRuntimeClient, skillId: string): Promise<SkillTimelineEntry[]> {
  const output = await client.listMemoryLogs({
    tools: SKILL_TIMELINE_TOOLS,
    limit: 500,
    offset: 0
  });

  return skillTimelineFromLogs(output.logs, skillId);
}

function skillsCacheKeys(query: string, page: number): string[] {
  return [
    memoryPanelCacheKey(SKILLS_CACHE_SECTION, query.trim(), normalizePage(page)),
    memoryPanelLatestCacheKey(SKILLS_CACHE_SECTION)
  ];
}

export function SkillsSubPage(props: SkillsSubPageProps) {
  const canRead = usePanelReadGuard(props.client);
  const { t } = useTranslation();
  const { track } = useAnalytics();
  const skillsFilterLayer = "Skill";
  const demoEnabled = isSkillsDemoEnabled();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const detailGeneration = useRef(0);
  useEffect(() => () => { detailGeneration.current++; }, [props.client]);
  const requestIdRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const submitSearch = usePanelLoad({ query, identity: [props.client, page, t, demoEnabled], load: () => refresh(),
    invalidate: () => { requestIdRef.current++; requestAbortRef.current?.abort(); } });
  const [state, setState] = useState<RemoteData<PanelItemsOutput>>({ status: "loading" });
  const [detail, setDetail] = useState<SkillDetailState>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const selectedSkillIdRef = useRef(selectedSkillId);
  selectedSkillIdRef.current = selectedSkillId;

  function openSkill(skillId: string) {
    const generation = ++detailGeneration.current;
    setSelectedSkillId(skillId);
    track(buildMemoryUiDetailOpenedEvent({
      subPage: "skills",
      filterLayer: skillsFilterLayer
    }));
    if (demoEnabled) {
      const skillDetail = demoSkillDetail(skillId);
      if (!skillDetail) {
        setDetail({ status: "error", message: t("memory.detailUnavailable") });
        return;
      }

      setDetail({ status: "ready", data: { detail: skillDetail, timeline: demoSkillTimeline(skillId) } });
      return;
    }

    if (!props.client) {
      setDetail({ status: "error", message: t("memory.clientNotReady") });
      return;
    }

    setDetail({ status: "loading" });
    void Promise.all([
      loadSkillDetail(props.client, skillId),
      props.client.listPanelLogs ? Promise.resolve([]) : loadSkillTimeline(props.client, skillId)
    ])
      .then(([skillDetail, timeline]) => { if (generation === detailGeneration.current) setDetail({ status: "ready", data: { detail: skillDetail, timeline } }); })
      .catch((error) => { if (generation === detailGeneration.current) setDetail({ status: "error", message: toMemoryDetailErrorMessage(error, t("memory.detailUnavailable")) }); });
  }

  const viewStatus=usePanelViewStatus(props.client,"Skill",()=>{requestIdRef.current++; requestAbortRef.current?.abort(); closeSkill(); setState({status:"loading"});},()=>refresh());
  function refresh(nextPage = page, options: { useCache?: boolean; preserve?:boolean } = {}): Promise<PanelItemsOutput | undefined> {
    if (!canRead()) return Promise.resolve(undefined);
    const normalizedPage = normalizePage(nextPage);

    if (demoEnabled) {
      const data = demoSkillPanelItems(query, normalizedPage);
      setState({ status: "ready", data });
      if (!selectedSkillId && !detail) {
        const firstSkill = data.items[0];
        const firstDetail = firstSkill ? demoSkillDetail(firstSkill.id) : undefined;
        if (firstSkill && firstDetail) {
          setSelectedSkillId(firstSkill.id);
          setDetail({ status: "ready", data: { detail: firstDetail, timeline: demoSkillTimeline(firstSkill.id) } });
        }
      }
      return Promise.resolve(data);
    }

    if (!props.client) {
      const message = t("memory.clientNotReady");
      setState({ status: "error", message });
      return Promise.reject(new Error(message));
    }

    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const requestId = ++requestIdRef.current;
    const cacheKeys = skillsCacheKeys(query, normalizedPage);
    const cached = (options.useCache ?? true) && !props.client.resetPanelView ? readMemoryPanelCacheFirst<PanelItemsOutput>(cacheKeys) : null;
    if (cached) {
      setState({ status: "ready", data: cached });
    } else {
      setState((current) => current.status === "ready" ? current : { status: "loading" });
    }

    return props.client.listPanelItems({ layer: "Skill", q: query.trim() || undefined, page: normalizedPage }, controller.signal)
      .then((data) => {
        if (requestId !== requestIdRef.current) return undefined;
        if (!props.client?.resetPanelView) writeMemoryPanelCaches(cacheKeys, data);
        viewStatus.clear();
        setState({ status: "ready", data });
        if (data.page !== normalizedPage) setPage(data.page);
        return data;
      })
      .catch((error) => {
        if (requestId !== requestIdRef.current) return undefined;
        setState(current => options.preserve && canPreservePanelResult(error) && current.status === "ready" ? current : { status: "error", message: toErrorMessage(error) });
        throw error;
      });
  }

  function changeQuery(value: string) {
    setQuery(value);
    closeSkill();
    setPage(1);
  }

  function runSearch() {
    closeSkill();
    setPage(1);
    void submitSearch(() => refresh(1), [props.client, 1, t, demoEnabled])
      .then((data) => {
        if (!data) {
          return;
        }
        track(buildMemoryUiSearchSubmittedEvent({
          subPage: "skills",
          filterLayer: skillsFilterLayer,
          resultCount: data.total
        }));
      })
      .catch(() => undefined);
  }

  function changePage(nextPage: number) {
    const normalizedPage = normalizePage(nextPage);
    if (normalizedPage === page) {
      return;
    }

    closeSkill();
    setPage(normalizedPage);
  }

  function closeSkill() {
    detailGeneration.current++;
    setDetail(null);
    setSelectedSkillId(null);
  }

  async function deleteSkill(id: string) {
    if (demoEnabled) {
      closeSkill();
      return;
    }

    if (!props.client) {
      throw new Error(t("memory.clientNotReady"));
    }

    await props.client.deleteMemory(id);
    track(buildMemoryUiDeletedEvent({
      subPage: "skills",
      filterLayer: skillsFilterLayer
    }));
    clearMemoryPanelCache();
    closeSkill();
    void viewStatus.reloadCurrent().catch(() => undefined);
  }

  async function approveObservedSkill(id: string) {
    if (!props.client?.approveObservedSkill) throw new Error(t("memory.clientNotReady"));
    if (!canRead()) return;
    const generation=detailGeneration.current;
    const current=await loadSkillDetail(props.client,id);
    if(generation!==detailGeneration.current||current.item.id!==id)return;
    await props.client.approveObservedSkill(id);
    clearMemoryPanelCache();
    if (!canRead() || generation !== detailGeneration.current) return;
    const skillDetail = await loadSkillDetail(props.client, id);
    if(canRead() && generation === detailGeneration.current && selectedSkillIdRef.current===id)setDetail({status:"ready",data:{detail:skillDetail,timeline:[]}});
    void viewStatus.reloadCurrent().catch(() => undefined);
  }

  async function updateObservedSkill(id: string, body: string, expectedVersion: number) {
    if (!props.client?.updateObservedSkill) throw new Error(t("memory.clientNotReady"));
    if (!canRead()) return;
    const generation = detailGeneration.current;
    await props.client.updateObservedSkill(id, { body, expectedVersion });
    clearMemoryPanelCache();
    if (!canRead() || generation !== detailGeneration.current) return;
    const skillDetail = await loadSkillDetail(props.client, id);
    if (canRead() && generation === detailGeneration.current && selectedSkillIdRef.current === id) {
      setDetail((current) => ({ status: "ready", data: { detail: skillDetail,
        timeline: current?.status === "ready" ? current.data.timeline : [] } }));
    }
    void viewStatus.reloadCurrent().catch(() => undefined);
  }


  useEffect(() => {
    if (props.openRequest) {
      openSkill(props.openRequest.id);
    }

  }, [props.openRequest?.requestId]);

  return (
    <SkillsSubPageView
      state={state.status === "ready" ? { ...state, detail } : state}
      detail={detail}
      selectedSkillId={selectedSkillId}
      query={query}
      onQueryChange={changeQuery}
      onSearch={runSearch}
      onPageChange={changePage}
      onRefresh={async () => {
        props.client?.refreshPanelView?.("Skill");
        const data = await refresh(page, { useCache: false, preserve:true });
        if (data) {
          track(buildMemoryUiPanelRefreshedEvent({
            subPage: "skills",
            filterLayer: skillsFilterLayer,
            resultCount: data.total
          }));
        }
      }}
      client={props.client}
      onOpenSkill={openSkill}
      onDeleteSkill={deleteSkill}
      onApproveObservedSkill={approveObservedSkill}
      onUpdateObservedSkill={updateObservedSkill}
      onCloseSkill={closeSkill}
      onOpenMemoryReference={props.onOpenMemoryReference}
    />
  );
}

export interface SkillsSubPageViewProps {
  client?:MemoryRuntimeClient|null;
  state: RemoteData<PanelItemsOutput> | ({ status: "ready"; data: PanelItemsOutput; detail: SkillDetailState });
  detail?: SkillDetailState;
  selectedSkillId?: string | null;
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onPageChange: (page: number) => void;
  onRefresh: () => void | Promise<void>;
  onOpenSkill: (skillId: string) => void;
  onDeleteSkill: (id: string) => Promise<void>;
  onApproveObservedSkill?: (id: string) => Promise<void>;
  onUpdateObservedSkill?: (id: string, body: string, expectedVersion: number) => Promise<void>;
  onCloseSkill: () => void;
  onOpenMemoryReference: OpenMemoryReference;
}

export function SkillsSubPageView(props: SkillsSubPageViewProps) {
  const { t } = useTranslation();

  return (
    <section className="memory-panel">
      <div className="memory-panel__header">
        <div className="memory-panel__header-main">
          <h3 className="memory-panel__title">
            <Wand2 size={18} className="text-text-ink/60" />
            {t("memory.skills.title")}
          </h3>
          <p className="memory-panel__subtitle">{t("memory.skills.description")}</p>
        </div>
        <MemoryRefreshButton onClick={props.onRefresh} />
      </div>
      <div className="memory-toolbar">
        <label className="memory-search">
          <Search size={15} className="memory-search__icon" />
          <input
            type="search"
            value={props.query}
            placeholder={t("memory.skills.searchPlaceholder")}
            onChange={(event) => props.onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                props.onSearch();
              }
            }}
            className="memory-search__input"
          />
        </label>
      </div>
      {props.state.status === "loading" && <MemoryStateBox message={t("memory.skills.loading")} />}
      {props.state.status === "error" && <MemoryStateBox message={props.state.message} tone="error" />}
      {props.state.status === "ready" && props.state.data.items.length === 0 && <MemoryStateBox message={t("memory.skills.empty")} />}
      {props.state.status === "ready" && props.state.data.items.length > 0 && (
        <>
          <div className="memory-list">
            {props.state.data.items.map((skill) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => props.onOpenSkill(skill.id)}
                className={`memory-card${props.selectedSkillId === skill.id ? " memory-card--selected" : ""}`}
              >
                <div className="memory-card__body">
                  <div className="memory-card__title">{displaySkillTitle(skill)}</div>
                  <div className="memory-card__meta">
                    <SkillStatusPill status={skill.status} />
                    <span>{t("memory.memories.updatedAt")}: {formatDateTime(skill.updatedAt)}</span>
                    {skill.tags.slice(0, 4).map((tag) => (
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
        </>
      )}
      <SkillDrawer
        client={props.client}
        detail={props.detail ?? ("detail" in props.state ? props.state.detail : null)}
        onClose={props.onCloseSkill}
        onDelete={props.onDeleteSkill}
        onApprove={props.onApproveObservedSkill}
        onUpdate={props.onUpdateObservedSkill}
        onOpenMemoryReference={props.onOpenMemoryReference}
      />
    </section>
  );
}

/**
 * Renders the skill detail drawer.
 *
 * @param props.detail The skill detail remote state.
 * @param props.onClose The close callback.
 * @returns The skill detail node.
 */
function SkillDrawer(props: {
  client?:MemoryRuntimeClient|null;
  detail: SkillDetailState;
  onClose: () => void;
  onDelete: (id: string) => Promise<void>;
  onApprove?: (id: string) => Promise<void>;
  onUpdate?: (id: string, body: string, expectedVersion: number) => Promise<void>;
  onOpenMemoryReference: OpenMemoryReference;
}) {
  const { t } = useTranslation();
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editedBody, setEditedBody] = useState("");
  const [editedVersion, setEditedVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [openingEditor, setOpeningEditor] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const detailId = props.detail?.status === "ready" ? props.detail.data.detail.item.id : undefined;
  const currentDetailId = useRef(detailId);
  currentDetailId.current = detailId;
  const saveRequestEpoch = useRef(0);
  useEffect(() => {
    saveRequestEpoch.current += 1;
    setEditing(false);
    setEditedBody("");
    setEditedVersion(0);
    setSaving(false);
    setOpeningEditor(false);
    setApproving(false);
    setSaveError(null);
    setApproveError(null);
    return () => { saveRequestEpoch.current += 1; };
  }, [detailId]);

  if (!props.detail) {
    return null;
  }

  const readyDetail = props.detail.status === "ready" ? props.detail.data : null;
  const title = readyDetail ? skillFromDetail(readyDetail.detail).title : t("memory.skills.detailTitle");
  const eyebrow = readyDetail ? drawerEyebrow(readyDetail.detail.item) : t("memory.skills.detailTitle");
  const internal = recordValue(recordValue(recordValue(readyDetail?.detail.item.metadata).properties).internal_info);
  const origin = recordValue(internal.external_evidence_candidate);
  const historySkill = isHistoryDerivedSkill(origin);
  const sourceChangedHumanDraft = historySkill && readyDetail?.detail.item.status === "archived"
    && origin.human_modified === true && origin.source_status === "changed";
  const awaitingObservedReview = readyDetail?.detail.item.status === "resolving"
    && Boolean(internal.external_evidence_candidate) && !historySkill;
  const editableHistorySkill = historySkill && internal.read_only !== true
    && (readyDetail?.detail.item.status === "activated" || readyDetail?.detail.item.status === "resolving"
      || sourceChangedHumanDraft);

  return (
    <div className="memory-drawer-backdrop" onClick={props.onClose}>
      <button type="button" className="memory-drawer-backdrop__close" tabIndex={-1} aria-hidden="true" onClick={(e) => {
        e.stopPropagation();
        props.onClose();
      }} />
      <aside className="memory-drawer" role="dialog" aria-modal="true" aria-labelledby="memory-skill-title" onClick={(e) => e.stopPropagation()}>
        <header className="memory-drawer__header">
          <div>
            <div className="memory-drawer__identity">
              <span className="memory-drawer__eyebrow">{eyebrow}</span>
            </div>
            <h4 id="memory-skill-title" className="memory-drawer__title">{title}</h4>
          </div>
          <button type="button" className="memory-drawer__close" onClick={props.onClose} aria-label={t("common.close")}>
            <X size={16} />
          </button>
        </header>
        <div className="memory-drawer__body">
          {editableHistorySkill && readyDetail ? (
            <section className="memory-detail-card">
              <p>{t(sourceChangedHumanDraft ? "memory.skills.sourceChangedNotice" : readyDetail.detail.item.status === "activated"
                ? origin.human_modified === true
                  ? "memory.skills.humanEditedNotice" : "memory.skills.autoGeneratedNotice"
                : "memory.skills.historyCandidateNotice")}</p>
              {editableHistorySkill && props.onUpdate && !editing ? <button className="memory-skill-editor__button" type="button" disabled={openingEditor || !props.client} onClick={() => {
                setSaveError(null);
                if (!props.client) return;
                const id = readyDetail.detail.item.id;
                const epoch = ++saveRequestEpoch.current;
                const isCurrent = () => currentDetailId.current === id && saveRequestEpoch.current === epoch;
                setOpeningEditor(true);
                void props.client.getMemory(id).then(latest => {
                  if (latest.item.id !== id || !isCurrent()) return;
                  setEditedBody(latest.item.body);
                  setEditedVersion(latest.item.version);
                  setEditing(true);
                }).catch(error => { if (isCurrent()) setSaveError(toErrorMessage(error)); })
                  .finally(() => { if (isCurrent()) setOpeningEditor(false); });
              }}>{t(openingEditor ? "common.loading" : "common.edit")}</button> : null}
              {!editing && saveError ? <p role="alert">{saveError}</p> : null}
            </section>
          ) : null}
          {editing && readyDetail ? (
            <form className="memory-detail-card" onSubmit={(event) => {
              event.preventDefault();
              if (!props.onUpdate || !editedBody.trim() || saving) return;
              const skillId = readyDetail.detail.item.id;
              const requestEpoch = ++saveRequestEpoch.current;
              const isCurrentRequest = () => currentDetailId.current === skillId
                && saveRequestEpoch.current === requestEpoch;
              setSaving(true);
              setSaveError(null);
              void props.onUpdate(skillId, editedBody, editedVersion)
                .then(() => { if (isCurrentRequest()) setEditing(false); })
                .catch((error) => {
                  if (isCurrentRequest()) setSaveError(error instanceof Error ? error.message : String(error));
                })
                .finally(() => { if (isCurrentRequest()) setSaving(false); });
            }}>
              <label className="memory-detail-card__label" htmlFor="memory-skill-editor">{t("memory.skills.editBody")}</label>
              <textarea id="memory-skill-editor" className="memory-skill-editor__body" value={editedBody}
                disabled={saving} maxLength={50_000} onChange={(event) => setEditedBody(event.target.value)} />
              <p className="memory-policy-empty">{t("memory.skills.editHint")}</p>
              <div className="memory-skill-editor__actions">
                <button className="memory-skill-editor__button" type="submit" disabled={saving || !editedBody.trim()}>{t(saving ? "memory.skills.saving" : "common.save")}</button>
                <button className="memory-skill-editor__button" type="button" disabled={saving} onClick={() => setEditing(false)}>{t("common.cancel")}</button>
              </div>
              {saveError ? <p role="alert">{saveError}</p> : null}
            </form>
          ) : null}
          {awaitingObservedReview ? (
            <section className="memory-detail-card">
              <p>{t("memory.skills.observedCandidateReview")}</p>
              {props.onApprove ? <button className="memory-skill-editor__button" type="button" disabled={approving} onClick={() => {
                if (!readyDetail) return;
                const id = readyDetail.detail.item.id;
                const epoch = saveRequestEpoch.current;
                const isCurrent = () => currentDetailId.current === id && saveRequestEpoch.current === epoch;
                setApproving(true);
                setApproveError(null);
                void props.onApprove!(readyDetail.detail.item.id).catch((error) => {
                  if (isCurrent()) setApproveError(error instanceof Error ? error.message : String(error));
                }).finally(() => { if (isCurrent()) setApproving(false); });
              }}>{t("memory.skills.approveObservedCandidate")}</button> : null}
              {approveError ? <p role="alert">{approveError}</p> : null}
            </section>
          ) : null}
          {props.detail.status === "loading" && <MemoryStateBox message={t("memory.skills.detailLoading")} />}
          {props.detail.status === "error" && <MemoryStateBox message={props.detail.message} tone="error" />}
          {props.detail.status === "ready" && (
            <SkillDetail
              client={props.client}
              detail={props.detail.data.detail}
              timeline={props.detail.data.timeline}
              onOpenMemoryReference={props.onOpenMemoryReference}
            />
          )}
        </div>
        {readyDetail && <MemoryDrawerDeleteAction onDelete={() => props.onDelete(readyDetail.detail.item.id)} />}
      </aside>
    </div>
  );
}

/** Recognize explicit History provenance without treating other passive sources as automatic Skills. */
export function isHistoryDerivedSkill(value: unknown): boolean {
  const origin = recordValue(value);
  if (origin.source === "computer_history" || origin.activation_mode === "automatic_history") return true;
  return origin.source === "memmy" && Array.isArray(origin.sourceRecordIds)
    && new Set(origin.sourceRecordIds).size >= 2
    && origin.sourceRecordIds.every((id) => typeof id === "string"
      && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z?-(?:10min|6h)-summary$/u.test(id));
}

function generatedHistoryStepSources(detail: GetMemoryOutput): Array<{ stepIndex: number; sourceMemoryId: string }> {
  const internal = recordValue(recordValue(recordValue(detail.item.metadata).properties).internal_info);
  const origin = recordValue(internal.external_evidence_candidate);
  const raw = origin.generatedStepSources;
  if (!isHistoryDerivedSkill(origin) || origin.activation_mode !== "automatic_history"
    || origin.human_modified === true || detail.item.status !== "activated"
    || !Array.isArray(raw) || raw.length === 0 || raw.length > 12
    || !Array.isArray(detail.item.sourceMemoryIds)) return [];
  const available = new Set(detail.item.sourceMemoryIds);
  const sources = raw.map((value, stepIndex) => {
    const entry = recordValue(value);
    return Number.isSafeInteger(entry.stepIndex) && entry.stepIndex === stepIndex
      && typeof entry.sourceMemoryId === "string" && entry.sourceMemoryId.trim().length > 0
      && available.has(entry.sourceMemoryId)
      ? { stepIndex, sourceMemoryId: entry.sourceMemoryId } : null;
  });
  return sources.every((source) => source !== null) ? sources as Array<{ stepIndex: number; sourceMemoryId: string }> : [];
}

function SkillDetail(props: {
  client?:MemoryRuntimeClient|null;
  detail: GetMemoryOutput;
  timeline: SkillTimelineEntry[];
  onOpenMemoryReference: OpenMemoryReference;
}) {
  const { t } = useTranslation();
  const skill = skillFromDetail(props.detail);
  const hasDecisionGuidance = skill.decisionGuidance.preference.length > 0 || skill.decisionGuidance.antiPattern.length > 0;
  const stepSources = generatedHistoryStepSources(props.detail);
  const internal = recordValue(recordValue(recordValue(props.detail.item.metadata).properties).internal_info);
  const verificationState = recordValue(recordValue(internal.skill).verification);

  return (
    <>
      <section className="memory-detail-card memory-detail-card--meta">
        <h5 className="memory-detail-card__label">{t("memory.memories.meta")}</h5>
        <div className="memory-detail-metrics">
          <Metric label={t("memory.memories.status")} value={skillStatusLabel(skill.status, t)} />
          <Metric label={t("memory.skills.valueScore")} value={formatNumber(skill.eta, 3)} />
          <Metric label={t("memory.policies.gain")} value={formatNumber(skill.gain, 3)} />
          <Metric label={t("memory.policies.support")} value={formatNumber(skill.support, 0)} />
          <Metric label="trials" value={formatTrials(skill.trialsPassed, skill.trialsAttempted)} />
          <Metric label="usage" value={formatNumber(skill.usageCount, 0)} />
          <Metric label={t("memory.memories.createdAt")} value={formatDateTime(skill.createdAt)} />
          <Metric label={t("memory.memories.updatedAt")} value={formatDateTime(skill.updatedAt)} />
          <Metric label="last used" value={formatDateTime(skill.lastUsedAt)} />
        </div>
        {skill.source && (
          <div className="memory-policy-source">
            <span>{t("memory.tasks.source")}</span>
            {skill.source === "computer_history" ? t("memory.memories.historySource") : skill.source}
          </div>
        )}
      </section>

      {props.client?.listPanelLogs ? <PagedSkillTimeline key={props.detail.item.id} client={props.client} skillId={props.detail.item.id} /> : <SkillTimelineSection entries={props.timeline} />}
      {skill.usageGuide && <DetailTextSection title={t("memory.skills.invocationGuide")} body={skill.usageGuide} />}
      <section className="memory-detail-card">
        <h5 className="memory-detail-card__label">{t("memory.skills.body")}</h5>
        <MemoryMarkdown text={skill.body || "-"} />
      </section>

      {hasDecisionGuidance && (
        <section className="memory-detail-card">
          <h5 className="memory-detail-card__label">{t("memory.skills.decisionGuidance")}</h5>
          {skill.decisionGuidance.preference.length > 0 && (
            <GuidanceList title={t("memory.skills.prefer")} entries={skill.decisionGuidance.preference} tone="prefer" />
          )}
          {skill.decisionGuidance.antiPattern.length > 0 && (
            <GuidanceList title={t("memory.skills.avoid")} entries={skill.decisionGuidance.antiPattern} tone="avoid" />
          )}
        </section>
      )}

      {stepSources.length > 0 && (
        <section className="memory-detail-card memory-skill-step-sources">
          <h5 className="memory-detail-card__label">{t("memory.skills.stepSources")}</h5>
          <p className="memory-policy-section-body">{t(verificationState.summaryFactCheck === "not_independently_verified"
            ? "memory.skills.summaryFactCheckUnverified" : "memory.skills.summaryFactCheckUnknown")}</p>
          <p className="memory-policy-section-body">{t(verificationState.execution_verified === false
            ? "memory.skills.executionOutcomeUnverified" : "memory.skills.executionOutcomeUnknown")}</p>
          {stepSources.map((source) => (
            <div className="memory-policy-source" key={source.stepIndex}>
              <span>{t("memory.skills.stepNumber", { count: source.stepIndex + 1 })}</span>
              <MemoryReferenceTags ids={[source.sourceMemoryId]} fallbackPage="memories" onOpen={props.onOpenMemoryReference} />
            </div>
          ))}
        </section>
      )}

      <LinkedIdsSection
        title={t("memory.skills.sourceExperience")}
        ids={skill.sourcePolicyIds.length > 0 ? skill.sourcePolicyIds : props.detail.item.sourceMemoryIds}
        empty={t("memory.skills.noSourceExperience")}
        fallbackPage={skill.sourcePolicyIds.length > 0 ? "policies" : "memories"}
        onOpen={props.onOpenMemoryReference}
      />
      <LinkedIdsSection
        title={t("memory.skills.evidenceAnchors")}
        ids={skill.evidenceAnchors}
        empty={t("memory.skills.noEvidenceAnchors")}
        fallbackPage="memories"
        onOpen={props.onOpenMemoryReference}
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

function DetailTextSection(props: { title: string; body?: string }) {
  return (
    <section className="memory-detail-card">
      <h5 className="memory-detail-card__label">{props.title}</h5>
      <div className="memory-policy-section-body">{cleanMemoryBody(props.body) || "-"}</div>
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

function LinkedIdsSection(props: {
  title: string;
  ids: string[];
  empty: string;
  fallbackPage: MemoryReferencePage;
  onOpen: OpenMemoryReference;
}) {
  const hasIds = props.ids.some(Boolean);

  return (
    <section className="memory-detail-card">
      <h5 className="memory-detail-card__label">{props.title}</h5>
      {!hasIds ? (
        <div className="memory-policy-empty">{props.empty}</div>
      ) : (
        <MemoryReferenceTags ids={props.ids} fallbackPage={props.fallbackPage} onOpen={props.onOpen} />
      )}
    </section>
  );
}

function PagedSkillTimeline(props:{client:MemoryRuntimeClient;skillId:string}) {
  const {t}=useTranslation();const [logs,setLogs]=useState<MemoryApiLog[]>([]);const [legacy,setLegacy]=useState<SkillTimelineEntry[]>();
  const [cursor,setCursor]=useState<string>();const [busy,setBusy]=useState(true);const [error,setError]=useState<string>();
  const generation=useRef(0);
  async function load(next?:string) {
    const epoch = generation.current;
    const isCurrent = () => epoch === generation.current;
    setBusy(true);setError(undefined);
    try {
      let result;
      try {result=await props.client.listPanelLogs!({skillId:props.skillId,cursor:next,limit:20});}
      catch(error) {if(!isUnsupportedPanelRoute(error))throw error;const entries=await loadSkillTimeline(props.client,props.skillId);if(isCurrent())setLegacy(entries);return;}
      if(isCurrent()){setLogs(current=>next?[...current,...result.logs.filter(log=>!current.some(old=>old.id===log.id))]:result.logs);setCursor(result.nextCursor);}
    } catch(error){if(isCurrent())setError(toErrorMessage(error));}
    finally {if(isCurrent())setBusy(false);}
  }
  useEffect(() => {
    generation.current++;
    setLogs([]); setLegacy(undefined); setCursor(undefined);
    void load();
    return () => { generation.current++; };
  }, [props.client,props.skillId]);
  return <>{(logs.length > 0 || legacy !== undefined || (!busy && !error)) && <SkillTimelineSection entries={legacy??skillTimelineFromLogs(logs,props.skillId)} />}
    {busy&&<MemoryStateBox message={t("common.loading")} />}
    {error&&<p role="alert">{error}</p>}
    {(cursor||error)&&<button type="button" disabled={busy} onClick={()=>void load(cursor)}>{t("memory.tasks.loadContent")}</button>}
  </>;
}

function SkillTimelineSection(props: { entries: SkillTimelineEntry[] }) {
  const { t } = useTranslation();

  return (
    <section className="memory-detail-card">
      <h5 className="memory-detail-card__label">{t("memory.skills.evolutionTimeline")}</h5>
      {props.entries.length === 0 ? (
        <div className="memory-policy-empty">{t("memory.skills.evolutionTimeline.empty")}</div>
      ) : (
        <div className="memory-skill-timeline">
          {props.entries.map((entry, index) => (
            <div key={`${entry.ts}-${entry.kind}-${index}`} className="memory-skill-timeline__item">
              <div className="memory-skill-timeline__rail" aria-hidden="true">
                <span className={`memory-skill-timeline__dot memory-skill-timeline__dot--${skillTimelineTone(entry)}`} />
              </div>
              <div className="memory-skill-timeline__body">
                <div className="memory-skill-timeline__head">
                  <span className={`memory-pill memory-pill--skill-${skillTimelineTone(entry)}`}>
                    {skillTimelineLabel(entry.kind, entry.phase, t)}
                  </span>
                  <span className="memory-skill-timeline__time">{formatDateTime(entry.ts)}</span>
                </div>
                {entry.summary && <div className="memory-skill-timeline__summary">{entry.summary}</div>}
                {skillTimelineShowsDuration(entry) && (
                  <div className="memory-skill-timeline__meta">{t("memory.skills.timeline.duration", { duration: entry.durationMs })}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function SkillStatusPill(props: { status?: string }) {
  const { t } = useTranslation();

  return <span className={`memory-pill memory-pill--skill-${skillStatusTone(props.status)}`}>{skillStatusLabel(props.status, t)}</span>;
}

export function skillStatusTone(status: string | undefined): SkillStatusTone {
  const toneByStatus: Record<string, SkillStatusTone> = {
    resolving: "candidate",
    candidate: "candidate",
    activated: "active",
    active: "active",
    archived: "archived",
    deleted: "deleted"
  };

  return toneByStatus[status ?? ""] ?? "unknown";
}

function skillStatusLabel(status: string | undefined, t: (key: MessageKey) => string): string {
  const keyByTone: Record<SkillStatusTone, MessageKey> = {
    candidate: "memory.policies.status.candidate",
    active: "memory.policies.status.active",
    archived: "memory.policies.status.archived",
    deleted: "memory.memories.status.deleted",
    unknown: "memory.policies.status.unknown"
  };

  return t(keyByTone[skillStatusTone(status)]);
}

function skillTimelineFromLogs(logs: MemoryApiLog[], skillId: string): SkillTimelineEntry[] {
  return logs
    .flatMap((log) => {
      const input = parseJsonString(log.inputJson);
      const output = parseJsonString(log.outputJson);
      const loggedSkillId = firstString(
        recordValue(output).skillId,
        recordValue(output).skill_id,
        recordValue(input).skillId,
        recordValue(input).skill_id
      );
      if (!loggedSkillId || !isSameSkillId(loggedSkillId, skillId)) {
        return [];
      }

      const kind = firstString(recordValue(output).kind, log.toolName) ?? log.toolName;
      const phase = firstString(recordValue(input).phase, recordValue(output).phase);
      const summary = firstString(
        recordValue(output).name,
        recordValue(output).title,
        recordValue(output).summary,
        recordValue(output).reason,
        recordValue(input).summary,
        recordValue(input).reason
      );

      return [{
        ts: log.calledAt,
        kind,
        phase,
        durationMs: log.durationMs,
        success: log.success,
        summary
      }];
    })
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

function isSameSkillId(loggedSkillId: string, selectedSkillId: string): boolean {
  return compactComparableId(loggedSkillId) === compactComparableId(selectedSkillId);
}

function compactComparableId(value: string): string {
  return value.split("::").pop()?.trim() || value.trim();
}

function skillTimelineTone(entry: SkillTimelineEntry): SkillTimelineTone {
  if (!entry.success || entry.phase === "failed" || entry.kind === "skill.failed" || entry.kind === "skill.verification.failed") {
    return "failed";
  }
  if (entry.phase === "started" || entry.kind === "skill.crystallization.started") {
    return "running";
  }
  if (entry.kind === "skill.archived") {
    return "skipped";
  }
  return "succeeded";
}

function skillTimelineShowsDuration(entry: SkillTimelineEntry): boolean {
  return entry.kind === "skill.crystallized" || entry.kind === "skill.rebuilt" || entry.kind === "skill_generate";
}

function skillTimelineLabel(kind: string, phase: string | undefined, t: (key: MessageKey) => string): string {
  switch (kind) {
    case "skill.crystallized":
      return t("memory.skills.timeline.kind.crystallized");
    case "skill.crystallization.started":
      return t("memory.skills.timeline.kind.started");
    case "skill.rebuilt":
      return t("memory.skills.timeline.kind.rebuilt");
    case "skill.eta.updated":
      return t("memory.skills.timeline.kind.etaUpdated");
    case "skill.status.changed":
      return t("memory.skills.timeline.kind.statusChanged");
    case "skill.archived":
      return t("memory.skills.timeline.kind.archived");
    case "skill.verification.failed":
      return t("memory.skills.timeline.kind.verifyFailed");
    case "skill.failed":
      return t("memory.skills.timeline.kind.failed");
    case "skill_generate":
      if (phase === "started") return t("memory.skills.timeline.kind.started");
      if (phase === "failed") return t("memory.skills.timeline.kind.failed");
      return t("memory.skills.timeline.kind.crystallized");
    case "skill_evolve":
      return t("memory.skills.timeline.kind.rebuilt");
    default:
      return kind;
  }
}

function skillFromDetail(detail: GetMemoryOutput): SkillView {
  const metadata = detail.item.metadata;
  const properties = recordValue(metadata.properties);
  const info = recordValue(metadata.info);
  const internalInfo = recordValue(properties.internal_info);
  const layerSkill = recordValue(detail.item.skill);
  const skill = recordValue(firstDefined(internalInfo.skill, metadata.skill, properties.skill));
  const procedure = recordValue(firstDefined(skill.procedureJson, skill.procedure_json, internalInfo.procedureJson, internalInfo.procedure_json));
  const decisionGuidance = readDecisionGuidance(
    firstDefined(skill.decisionGuidance, skill.decision_guidance, internalInfo.decisionGuidance, internalInfo.decision_guidance)
  );
  const body = cleanMemoryBody(detail.item.body);
  const shortUsageGuide = uniqueStrings([
    firstString(layerSkill.retrievalBlurb, layerSkill.retrieval_blurb, procedure.retrievalBlurb, procedure.retrieval_blurb) ?? "",
    firstString(layerSkill.triggerContext, layerSkill.trigger_context, procedure.triggerContext, procedure.trigger_context) ?? ""
  ]).join("\n\n");
  const parsedUsageGuide = parseMarkdownSection(detail.item.body, ["When to use", "\u9002\u7528\u573a\u666f", "\u8c03\u7528\u65f6\u673a"]);
  const legacyInvocationGuide = firstString(
    layerSkill.invocationGuide,
    skill.invocationGuide,
    skill.invocation_guide,
    internalInfo.invocationGuide,
    internalInfo.invocation_guide
  );
  const distinctLegacyGuide = legacyInvocationGuide && cleanMemoryBody(legacyInvocationGuide) !== body
    ? legacyInvocationGuide
    : "";

  return {
    title: displaySkillTitle(detail.item, firstString(skill.title, internalInfo.title)),
    status: firstString(skill.status, internalInfo.status, info.status, detail.item.status) ?? detail.item.status,
    source: isHistoryDerivedSkill(internalInfo.external_evidence_candidate) ? "computer_history"
      : firstString(metadata.source, internalInfo.source),
    createdAt: detail.item.createdAt,
    updatedAt: detail.item.updatedAt,
    body,
    usageGuide: shortUsageGuide || parsedUsageGuide || distinctLegacyGuide,
    decisionGuidance,
    evidenceAnchors: readEvidenceAnchors(firstDefined(skill.evidenceAnchors, skill.evidence_anchors, internalInfo.evidenceAnchors, internalInfo.evidence_anchors)),
    sourcePolicyIds: stringArray(firstDefined(skill.sourcePolicyIds, skill.source_policy_ids, internalInfo.sourcePolicyIds, internalInfo.source_policy_ids)),
    eta: numberValue(firstDefined(skill.eta, internalInfo.eta, info.eta)),
    support: numberValue(firstDefined(skill.support, internalInfo.support, info.support)),
    gain: numberValue(firstDefined(skill.gain, internalInfo.gain, info.gain)),
    trialsAttempted: numberValue(firstDefined(skill.trialsAttempted, skill.trials_attempted, internalInfo.trialsAttempted, internalInfo.trials_attempted)),
    trialsPassed: numberValue(firstDefined(skill.trialsPassed, skill.trials_passed, internalInfo.trialsPassed, internalInfo.trials_passed)),
    usageCount: numberValue(firstDefined(skill.usageCount, skill.usage_count, internalInfo.usageCount, internalInfo.usage_count)),
    lastUsedAt: firstString(skill.lastUsedAt, skill.last_used_at, internalInfo.lastUsedAt, internalInfo.last_used_at)
  };
}

function displaySkillTitle(
  item: { id: string; title?: string; summary?: string; body?: string; memoryLayer?: string },
  ...candidates: Array<string | undefined>
): string {
  for (const value of [
    ...candidates,
    item.title,
    markdownHeadingTitle(item.body),
    item.summary,
    item.body
  ]) {
    const title = cleanSkillTitle(value);
    if (title && !isInternalSkillTitle(title)) {
      return title;
    }
  }

  return displayMemoryId(item.id);
}

function cleanSkillTitle(value?: string): string | undefined {
  const firstLine = cleanMemoryText(value)
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  if (isInternalSkillTitle(firstLine)) return undefined;
  const clipped = firstLine
    .split(/\s+(?:Use this skill|When to use|Procedure|Decision guidance)\b/i)[0]
    ?.trim();
  if (clipped && isInternalSkillTitle(clipped)) return undefined;
  return humanizeIdentifier(clipped || firstLine);
}

function markdownHeadingTitle(value?: string): string | undefined {
  const line = (value ?? "").split(/\r?\n/).find((candidate) => /^\s*#{1,6}\s+/.test(candidate));
  return line?.replace(/^\s*#{1,6}\s+/, "").trim() || undefined;
}

function isInternalSkillTitle(value: string): boolean {
  const text = value.trim();
  return /^(trace|policy|world|world_model|skill)[:_]/i.test(text)
    || /^[a-z]+_[a-f0-9]{12,}$/i.test(text);
}

function humanizeIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim();
  if (!/^[a-z0-9_:-]+$/i.test(cleaned)) return cleaned;
  return cleaned
    .replace(/^(skill|policy|trace|world)[:_]/i, "")
    .split(/[_:-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ") || undefined;
}

function readDecisionGuidance(value: unknown): SkillDecisionGuidance {
  const source = recordValue(value);

  return {
    preference: stringArray(source.preference),
    antiPattern: stringArray(firstDefined(source.antiPattern, source.anti_pattern))
  };
}

function readEvidenceAnchors(value: unknown): string[] {
  const parsed = parseJsonString(value);
  const list = Array.isArray(parsed) ? parsed : parsed === undefined || parsed === null ? [] : [parsed];

  return list
    .map((item) => {
      const record = recordValue(item);
      return firstString(item, record.traceId, record.trace_id, record.memoryId, record.memory_id, record.id, record.label, record.title);
    })
    .filter((item): item is string => Boolean(item));
}

function parseMarkdownSection(body: string, labels: string[]): string | undefined {
  const normalizedLabels = labels.map((label) => label.toLowerCase());
  const lines = body.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    return Boolean(match && normalizedLabels.includes((match[1] ?? "").trim().toLowerCase()));
  });

  if (startIndex < 0) {
    return undefined;
  }

  const chunks: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#{1,6}\s+/.test(line)) {
      break;
    }
    chunks.push(line);
  }

  return chunks.join("\n").trim() || undefined;
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
  if (!trimmed || !(trimmed.startsWith("[") || trimmed.startsWith("{") || trimmed.startsWith('"'))) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
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

function formatNumber(value: number | undefined, digits: number): string {
  return value === undefined ? "-" : value.toFixed(digits);
}

function formatTrials(passed: number | undefined, attempted: number | undefined): string {
  if (passed === undefined && attempted === undefined) {
    return "-";
  }

  return `${passed ?? 0}/${attempted ?? 0}`;
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }

  return formatUserDateTime(value);
}
