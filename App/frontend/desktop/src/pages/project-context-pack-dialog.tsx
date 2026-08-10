import { useEffect, useState, type ReactNode } from "react";
import type { GetMemoryOutput, MemoryHistoryOutput, MemoryListItem, ProjectContextGoalDecisionInput, ProjectContextPackOutput, ProjectContextReadState, ProjectGoalRecord, ProjectWorkItemRecord, RuntimeNamespace } from "@memmy/local-api-contracts";
import { ArrowLeft, BookOpen, Check, Copy, Network, RefreshCw, Target, X } from "lucide-react";
import type { MemoryRuntimeClient } from "../api/memory-runtime-client.js";
import { Modal } from "../components/modal.js";
import type { MessageKey } from "../i18n/messages.js";
import { ContextPackRelationGraph } from "./context-pack-relation-graph.js";

type Translate = (key: MessageKey) => string;

type ContextPackState =
  | { status: "loading"; pack: null }
  | { status: "ready"; pack: ProjectContextPackOutput }
  | { status: "error"; pack: null };

type MemoryDetailState =
  | { status: "loading"; detail: null }
  | { status: "ready"; detail: GetMemoryOutput }
  | { status: "error"; detail: null };

type MemoryHistoryState =
  | { status: "loading"; history: null }
  | { status: "ready"; history: MemoryHistoryOutput }
  | { status: "error"; history: null };

type RestoreState =
  | { status: "idle" }
  | { status: "restoring"; targetVersion: number }
  | { status: "success"; targetVersion: number }
  | { status: "error"; targetVersion: number };
type GovernanceState =
  | { status: "loading"; context: null; error: false }
  | { status: "ready"; context: ProjectContextReadState; error: boolean }
  | { status: "error"; context: null; error: true };


type SelectedMemory = { projectId: string; memoryId: string };

const sections = [
  ["conventions", "home.contextPack.conventions"],
  ["commands", "home.contextPack.commands"],
  ["architectureFacts", "home.contextPack.architectureFacts"],
  ["recentTasks", "home.contextPack.recentTasks"],
  ["userPreferences", "home.contextPack.userPreferences"]
] as const;

export function ProjectContextPackDialog(props: {
  open: boolean;
  projectId: string;
  projectName: string;
  client: Pick<MemoryRuntimeClient, "getProjectContextPack" | "getMemory" | "getMemoryHistory" | "restoreMemory" | "getProjectContextState" | "approveProjectGoal" | "rejectProjectGoal" | "setProjectFocus"> | null;
  t: Translate;
  onClose: () => void;
}) {
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<ContextPackState>({ status: "loading", pack: null });
  const [copied, setCopied] = useState(false);
  const [selectedMemory, setSelectedMemory] = useState<SelectedMemory | null>(null);
  const [detailState, setDetailState] = useState<MemoryDetailState | null>(null);
  const [detailRequestKey, setDetailRequestKey] = useState(0);
  const [graphOpen, setGraphOpen] = useState(false);
  const [historyState, setHistoryState] = useState<MemoryHistoryState | null>(null);
  const [pendingRestoreVersion, setPendingRestoreVersion] = useState<number | null>(null);
  const [restoreState, setRestoreState] = useState<RestoreState>({ status: "idle" });
  const [governanceRequestKey, setGovernanceRequestKey] = useState(0);
  const [governanceState, setGovernanceState] = useState<GovernanceState>({ status: "loading", context: null, error: false });
  const [pendingGovernanceAction, setPendingGovernanceAction] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open || !props.client) return undefined;
    let active = true;
    setState({ status: "loading", pack: null });
    setCopied(false);
    void props.client.getProjectContextPack(props.projectId)
      .then((pack) => {
        if (active) setState({ status: "ready", pack });
      })
      .catch(() => {
        if (active) setState({ status: "error", pack: null });
      });
    return () => { active = false; };
  }, [props.client, props.open, props.projectId, requestKey]);
  const namespace = projectNamespace(props.projectId);

  useEffect(() => {
    if (!props.open || !props.client) return undefined;
    let active = true;
    setGovernanceState({ status: "loading", context: null, error: false });
    void props.client.getProjectContextState(namespace)
      .then((context) => { if (active) setGovernanceState({ status: "ready", context, error: false }); })
      .catch(() => { if (active) setGovernanceState({ status: "error", context: null, error: true }); });
    return () => { active = false; };
  }, [props.client, props.open, props.projectId, governanceRequestKey]);

  const selectedMemoryId = selectedMemory?.projectId === props.projectId
    ? selectedMemory.memoryId
    : null;

  useEffect(() => {
    if (!props.open || !props.client || !selectedMemoryId) {
      setDetailState(null);
      return undefined;
    }

    const controller = new AbortController();
    setDetailState({ status: "loading", detail: null });
    setHistoryState({ status: "loading", history: null });
    void props.client.getMemory(selectedMemoryId, { signal: controller.signal })
      .then((detail) => {
        if (!controller.signal.aborted) setDetailState({ status: "ready", detail });
      })
      .catch(() => {
        if (!controller.signal.aborted) setDetailState({ status: "error", detail: null });
      });
    void props.client.getMemoryHistory(selectedMemoryId, { signal: controller.signal })
      .then((history) => {
        if (!controller.signal.aborted) setHistoryState({ status: "ready", history });
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistoryState({ status: "error", history: null });
      });

    return () => controller.abort();
  }, [props.client, props.open, props.projectId, selectedMemoryId, detailRequestKey]);

  useEffect(() => {
    setPendingRestoreVersion(null);
    setRestoreState({ status: "idle" });
  }, [selectedMemoryId]);

  useEffect(() => {
    setSelectedMemory(null);
    setDetailState(null);
    setHistoryState(null);
    setGraphOpen(false);
  }, [props.projectId]);

  const pack = state.pack;
  const itemCount = pack
    ? sections.reduce((total, [key]) => total + pack[key].length, 0)
    : 0;

  async function copyMarkdown() {
    if (!pack) return;
    await navigator.clipboard.writeText(pack.markdown);
    setCopied(true);
  }

  function openMemory(memoryId: string) {
    setGraphOpen(false);
    setSelectedMemory({ projectId: props.projectId, memoryId });
  }

  function closeDialog() {
    setSelectedMemory(null);
    setDetailState(null);
    setHistoryState(null);
    setGraphOpen(false);
    props.onClose();
  }

  async function restoreSelectedMemory(targetVersion: number) {
    if (!props.client || !selectedMemoryId || detailState?.status !== "ready") return;
    setRestoreState({ status: "restoring", targetVersion });
    try {
      await props.client.restoreMemory(selectedMemoryId, targetVersion, {
        version: detailState.detail.version,
        reason: "restored from desktop context pack"
      });
      setPendingRestoreVersion(null);
      setRestoreState({ status: "success", targetVersion });
      setDetailRequestKey((value) => value + 1);
    } catch {
      setRestoreState({ status: "error", targetVersion });
    }
  }
  async function runGovernanceAction(actionKey: string, action: (input: ProjectContextGoalDecisionInput) => Promise<unknown>) {
    if (!props.client || pendingGovernanceAction) return;
    setPendingGovernanceAction(actionKey);
    try {
      await action(mutationEnvelope(props.projectId));
      const [context] = await Promise.all([
        props.client.getProjectContextState(namespace),
        props.client.getProjectContextPack(props.projectId).then((nextPack) => setState({ status: "ready", pack: nextPack }))
      ]);
      setGovernanceState({ status: "ready", context, error: false });
    } catch {
      setGovernanceState((current) => current.context
        ? { status: "ready", context: current.context, error: true }
        : { status: "error", context: null, error: true });
    } finally {
      setPendingGovernanceAction(null);
    }
  }


  const title = graphOpen
    ? props.t("home.contextPack.graph.title")
    : selectedMemoryId
      ? props.t("home.contextPack.detail.title")
      : props.t("home.contextPack.title");

  return (
    <Modal
      open={props.open}
      title={title}
      subtitle={selectedMemoryId ?? props.projectName}
      headerIcon={<BookOpen size={17} />}
      closeLabel={props.t("common.close")}
      closeContent={<X size={16} />}
      className={`project-context-pack-dialog${graphOpen ? " project-context-pack-dialog--graph" : ""}`}
      bodyClassName="project-context-pack-dialog__body"
      onClose={closeDialog}
    >
      {selectedMemoryId && graphOpen && pack ? (
        <ContextPackRelationGraph
          graph={pack.graph}
          anchorId={selectedMemoryId}
          t={props.t}
          onBack={() => setGraphOpen(false)}
          onOpenMemory={openMemory}
        />
      ) : selectedMemoryId ? (
        <MemoryDetailView
          state={detailState}
          historyState={historyState}
          restoreState={restoreState}
          pendingRestoreVersion={pendingRestoreVersion}
          graph={pack?.graph ?? null}
          memoryId={selectedMemoryId}
          t={props.t}
          onBack={() => setSelectedMemory(null)}
          onOpenGraph={() => setGraphOpen(true)}
          onOpenMemory={openMemory}
          onRequestRestore={setPendingRestoreVersion}
          onCancelRestore={() => setPendingRestoreVersion(null)}
          onConfirmRestore={(version) => void restoreSelectedMemory(version)}
          onRetry={() => setDetailRequestKey((value) => value + 1)}
        />
      ) : state.status === "loading" ? (
        <ContextPackStatus>{props.t("home.contextPack.loading")}</ContextPackStatus>
      ) : state.status === "error" ? (
        <ContextPackStatus>
          <span>{props.t("home.contextPack.error")}</span>
          <button type="button" className="project-context-pack-dialog__retry" onClick={() => setRequestKey((value) => value + 1)}>
            <RefreshCw size={14} />
            {props.t("common.retry")}
          </button>
        </ContextPackStatus>
      ) : (
        <>
          <div className="project-context-pack-dialog__summary">
            <span>{props.t("home.contextPack.generated")}</span>
            <button type="button" className="project-context-pack-dialog__copy" onClick={() => void copyMarkdown()}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {props.t(copied ? "home.contextPack.copied" : "home.contextPack.copy")}
            </button>
          </div>
          <ContextGovernance
            state={governanceState}
            pendingAction={pendingGovernanceAction}
            t={props.t}
            onRetry={() => setGovernanceRequestKey((value) => value + 1)}
            onApprove={(goal) => void runGovernanceAction(`approve:${goal.id}`, (input) => props.client!.approveProjectGoal(goal.id, input))}
            onReject={(goal) => void runGovernanceAction(`reject:${goal.id}`, (input) => props.client!.rejectProjectGoal(goal.id, input))}
            onFocus={(item) => void runGovernanceAction(`focus:${item.id}`, (input) => props.client!.setProjectFocus({ ...input, workItemId: item.id }))}
            onClearFocus={() => void runGovernanceAction("focus:clear", (input) => props.client!.setProjectFocus({ ...input, workItemId: null }))}
          />
          {itemCount === 0 ? <ContextPackStatus>{props.t("home.contextPack.empty")}</ContextPackStatus> : (
          <div className="project-context-pack-dialog__sections">
            {sections.map(([key, label]) => {
              const items = pack![key];
              if (items.length === 0) return null;
              return (
                <section key={key} className="project-context-pack-dialog__section">
                  <h3>{props.t(label)}</h3>
                  <ul>
                    {items.map((item) => (
                      <ContextPackItem key={item.id} item={item} onOpen={openMemory} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
          )}
        </>
      )}
    </Modal>
  );
}

function ContextGovernance(props: {
  state: GovernanceState;
  pendingAction: string | null;
  t: Translate;
  onRetry: () => void;
  onApprove: (goal: ProjectGoalRecord) => void;
  onReject: (goal: ProjectGoalRecord) => void;
  onFocus: (item: ProjectWorkItemRecord) => void;
  onClearFocus: () => void;
}) {
  if (props.state.status === "loading") return <div className="project-context-governance__status">{props.t("home.contextPack.governance.loading")}</div>;
  if (!props.state.context) return (
    <div className="project-context-governance__status project-context-governance__status--error">
      <span>{props.t("home.contextPack.governance.error")}</span>
      <button type="button" onClick={props.onRetry}><RefreshCw size={13} />{props.t("common.retry")}</button>
    </div>
  );
  const candidates = props.state.context.goals.filter((goal) => goal.status === "candidate");
  const focusedId = props.state.context.focusedWorkItem?.id;
  return (
    <section className="project-context-governance">
      <div className="project-context-governance__heading"><Target size={15} /><h3>{props.t("home.contextPack.governance.title")}</h3></div>
      {props.state.error ? <p className="project-context-governance__error" role="alert">{props.t("home.contextPack.governance.mutationError")}</p> : null}
      <div className="project-context-governance__current">
        <span>{props.t("home.contextPack.governance.currentGoal")}</span>
        <strong>{props.state.context.activeGoal?.title ?? props.t("home.contextPack.governance.none")}</strong>
        <span>{props.t("home.contextPack.governance.currentFocus")}</span>
        <strong>{props.state.context.focusedWorkItem?.title ?? props.t("home.contextPack.governance.none")}</strong>
        {focusedId ? <button type="button" disabled={props.pendingAction !== null} onClick={props.onClearFocus}>{props.t("home.contextPack.governance.clearFocus")}</button> : null}
      </div>
      {candidates.map((goal) => <div key={goal.id} className="project-context-governance__row"><div><span>{props.t("home.contextPack.governance.candidate")}</span><strong>{goal.title}</strong></div><div className="project-context-governance__actions"><button type="button" disabled={props.pendingAction !== null} onClick={() => props.onReject(goal)}>{props.t("home.contextPack.governance.reject")}</button><button type="button" className="project-context-governance__primary" disabled={props.pendingAction !== null} onClick={() => props.onApprove(goal)}>{props.t("home.contextPack.governance.approve")}</button></div></div>)}
      {props.state.context.workItems.filter((item) => item.status !== "completed" && item.status !== "archived").map((item) => <div key={item.id} className="project-context-governance__row"><div><span>{props.t("home.contextPack.governance.workItem")}</span><strong>{item.title}</strong>{item.nextStep ? <small>{item.nextStep}</small> : null}</div>{item.id !== focusedId ? <button type="button" disabled={props.pendingAction !== null} onClick={() => props.onFocus(item)}>{props.t("home.contextPack.governance.setFocus")}</button> : null}</div>)}
    </section>
  );
}

function projectNamespace(projectId: string): RuntimeNamespace {
  return { source: "desktop", profileId: "default", projectId };
}

function mutationEnvelope(projectId: string) {
  const requestId = `desktop-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    namespace: projectNamespace(projectId),
    source: "desktop",
    adapterId: "memmy-desktop",
    requestId,
    provenance: { sourceAgent: "memmy-desktop", sourceMemoryIds: [], capturedAt: new Date().toISOString(), projectId, adapterId: "memmy-desktop", requestId }
  };
}

function ContextPackItem(props: {
  item: MemoryListItem | ProjectContextPackOutput["recentTasks"][number];
  onOpen: (memoryId: string) => void;
}) {
  const title = props.item.title || ("summary" in props.item ? props.item.summary : "") || props.item.id;
  const summary = "summary" in props.item ? props.item.summary : "";

  return (
    <li>
      {"memoryLayer" in props.item ? (
        <button
          type="button"
          className="project-context-pack-dialog__item"
          onClick={() => props.onOpen(props.item.id)}
        >
          <strong>{title}</strong>
          {summary && summary !== props.item.title ? <span>{summary}</span> : null}
        </button>
      ) : (
        <div className="project-context-pack-dialog__item project-context-pack-dialog__item--static">
          <strong>{title}</strong>
        </div>
      )}
    </li>
  );
}

function MemoryDetailView(props: {
  state: MemoryDetailState | null;
  historyState: MemoryHistoryState | null;
  restoreState: RestoreState;
  pendingRestoreVersion: number | null;
  graph: ProjectContextPackOutput["graph"] | null;
  memoryId: string;
  t: Translate;
  onBack: () => void;
  onOpenGraph: () => void;
  onOpenMemory: (memoryId: string) => void;
  onRequestRestore: (version: number) => void;
  onCancelRestore: () => void;
  onConfirmRestore: (version: number) => void;
  onRetry: () => void;
}) {
  const hasGraphNode = props.graph?.nodes.some((node) => node.id === props.memoryId) ?? false;
  return (
    <div className="project-context-pack-detail">
      <div className="project-context-pack-detail__toolbar">
        <button type="button" className="project-context-pack-detail__back" onClick={props.onBack}>
          <ArrowLeft size={15} />
          {props.t("home.contextPack.detail.back")}
        </button>
        {hasGraphNode ? (
          <button type="button" className="project-context-pack-detail__graph" onClick={props.onOpenGraph}>
            <Network size={14} />
            {props.t("home.contextPack.detail.openGraph")}
          </button>
        ) : null}
      </div>
      {!props.state || props.state.status === "loading" ? (
        <ContextPackStatus>{props.t("home.contextPack.detail.loading")}</ContextPackStatus>
      ) : props.state.status === "error" ? (
        <ContextPackStatus>
          <span>{props.t("home.contextPack.detail.error")}</span>
          <button type="button" className="project-context-pack-dialog__retry" onClick={props.onRetry}>
            <RefreshCw size={14} />
            {props.t("common.retry")}
          </button>
        </ContextPackStatus>
      ) : (
        <MemoryDetailContent
          detail={props.state.detail}
          historyState={props.historyState}
          restoreState={props.restoreState}
          pendingRestoreVersion={props.pendingRestoreVersion}
          t={props.t}
          onOpenMemory={props.onOpenMemory}
          onRequestRestore={props.onRequestRestore}
          onCancelRestore={props.onCancelRestore}
          onConfirmRestore={props.onConfirmRestore}
        />
      )}
    </div>
  );
}

function MemoryDetailContent(props: {
  detail: GetMemoryOutput;
  historyState: MemoryHistoryState | null;
  restoreState: RestoreState;
  pendingRestoreVersion: number | null;
  t: Translate;
  onOpenMemory: (memoryId: string) => void;
  onRequestRestore: (version: number) => void;
  onCancelRestore: () => void;
  onConfirmRestore: (version: number) => void;
}) {
  const item = props.detail.item;
  const evidenceIds = uniqueIds([
    ...item.sourceMemoryIds,
    ...(item.policy?.evidenceMemoryIds ?? []),
    ...(item.worldModel?.sourceMemoryIds ?? []),
    ...(item.skill?.sourcePolicyIds ?? []),
    ...(item.skill?.sourceWorldModelIds ?? [])
  ]);
  const source = item.provenance?.sourceAgent
    ?? (typeof item.metadata.source === "string" ? item.metadata.source : undefined)
    ?? props.t("home.contextPack.detail.unknown");

  return (
    <div className="project-context-pack-detail__content">
      <div className="project-context-pack-detail__heading">
        <h3>{item.title}</h3>
        {item.summary && item.summary !== item.title ? <p>{item.summary}</p> : null}
      </div>
      <section>
        <h4>{props.t("home.contextPack.detail.metadata")}</h4>
        <dl className="project-context-pack-detail__grid">
          <DetailField label={props.t("memory.memories.layer")} value={item.memoryLayer} />
          <DetailField label={props.t("memory.memories.source")} value={source} />
          <DetailField label={props.t("memory.memories.status")} value={statusLabel(item.status, props.t)} />
          <DetailField label={props.t("memory.memories.createdAt")} value={formatDateTime(item.createdAt)} />
          <DetailField label={props.t("memory.memories.updatedAt")} value={formatDateTime(item.updatedAt)} />
          <DetailField label={props.t("memory.memories.version")} value={String(props.detail.version)} />
        </dl>
      </section>
      <section>
        <h4>{props.t("home.contextPack.detail.content")}</h4>
        <p className="project-context-pack-detail__body">{item.body || props.t("home.contextPack.detail.empty")}</p>
      </section>
      <IdSection
        title={props.t("home.contextPack.detail.evidence")}
        ids={evidenceIds}
        empty={props.t("home.contextPack.detail.none")}
        onOpenMemory={props.onOpenMemory}
      />
      <VersionRelations detail={props.detail} t={props.t} onOpenMemory={props.onOpenMemory} />
      <MemoryHistorySection
        currentVersion={props.detail.version}
        state={props.historyState}
        restoreState={props.restoreState}
        pendingRestoreVersion={props.pendingRestoreVersion}
        t={props.t}
        onRequestRestore={props.onRequestRestore}
        onCancelRestore={props.onCancelRestore}
        onConfirmRestore={props.onConfirmRestore}
      />
      {item.provenance ? (
        <section>
          <h4>{props.t("home.contextPack.detail.provenance")}</h4>
          <dl className="project-context-pack-detail__grid">
            <DetailField label={props.t("home.contextPack.detail.agent")} value={item.provenance.sourceAgent} />
            {item.provenance.repository ? <DetailField label={props.t("home.contextPack.detail.repository")} value={item.provenance.repository} /> : null}
            {item.provenance.branch ? <DetailField label={props.t("home.contextPack.detail.branch")} value={item.provenance.branch} /> : null}
            {item.provenance.commit ? <DetailField label={props.t("home.contextPack.detail.commit")} value={item.provenance.commit} /> : null}
            <DetailField label={props.t("home.contextPack.detail.capturedAt")} value={formatDateTime(item.provenance.capturedAt)} />
          </dl>
        </section>
      ) : null}
    </div>
  );
}

function DetailField(props: { label: string; value: string }) {
  return <><dt>{props.label}</dt><dd>{props.value}</dd></>;
}

function IdSection(props: {
  title: string;
  ids: string[];
  empty: string;
  onOpenMemory: (memoryId: string) => void;
}) {
  return (
    <section>
      <h4>{props.title}</h4>
      {props.ids.length > 0 ? (
        <ul className="project-context-pack-detail__ids">
          {props.ids.map((id) => (
            <li key={id}>
              <button type="button" onClick={() => props.onOpenMemory(id)}><code>{id}</code></button>
            </li>
          ))}
        </ul>
      ) : <p className="project-context-pack-detail__empty">{props.empty}</p>}
    </section>
  );
}

function VersionRelations(props: {
  detail: GetMemoryOutput;
  t: Translate;
  onOpenMemory: (memoryId: string) => void;
}) {
  const supersession = props.detail.item.supersession;
  const relatedIds = supersession
    ? uniqueIds([...supersession.supersedesMemoryIds, ...(supersession.supersededByMemoryId ? [supersession.supersededByMemoryId] : [])])
    : [];
  return (
    <section>
      <h4>{props.t("home.contextPack.detail.versionRelations")}</h4>
      {relatedIds.length > 0 ? (
        <div className="project-context-pack-detail__relations">
          {supersession!.supersedesMemoryIds.length > 0 ? (
            <LinkedRelation label={props.t("home.contextPack.detail.supersedes")} ids={supersession!.supersedesMemoryIds} onOpenMemory={props.onOpenMemory} />
          ) : null}
          {supersession!.supersededByMemoryId ? (
            <LinkedRelation label={props.t("home.contextPack.detail.supersededBy")} ids={[supersession!.supersededByMemoryId]} onOpenMemory={props.onOpenMemory} />
          ) : null}
          {supersession!.reason ? <p>{props.t("home.contextPack.detail.reason")}: {supersession!.reason}</p> : null}
        </div>
      ) : <p className="project-context-pack-detail__empty">{props.t("home.contextPack.detail.none")}</p>}
    </section>
  );
}

function LinkedRelation(props: {
  label: string;
  ids: string[];
  onOpenMemory: (memoryId: string) => void;
}) {
  return (
    <div>
      <span>{props.label}</span>
      {props.ids.map((id) => (
        <button key={id} type="button" onClick={() => props.onOpenMemory(id)}><code>{id}</code></button>
      ))}
    </div>
  );
}

function MemoryHistorySection(props: {
  currentVersion: number;
  state: MemoryHistoryState | null;
  restoreState: RestoreState;
  pendingRestoreVersion: number | null;
  t: Translate;
  onRequestRestore: (version: number) => void;
  onCancelRestore: () => void;
  onConfirmRestore: (version: number) => void;
}) {
  return (
    <section className="project-context-pack-history">
      <h4>{props.t("home.contextPack.history.title")}</h4>
      {!props.state || props.state.status === "loading" ? (
        <p className="project-context-pack-detail__empty">{props.t("home.contextPack.history.loading")}</p>
      ) : props.state.status === "error" ? (
        <p className="project-context-pack-history__feedback project-context-pack-history__feedback--error">
          {props.t("home.contextPack.history.error")}
        </p>
      ) : props.state.history.items.length === 0 ? (
        <p className="project-context-pack-detail__empty">{props.t("home.contextPack.history.empty")}</p>
      ) : (
        <div className="project-context-pack-history__list">
          {props.state.history.items.map((entry) => {
            const version = entry.version;
            const current = version === props.currentVersion;
            const restorable = version !== undefined && entry.after !== undefined && !current;
            const confirming = version !== undefined && props.pendingRestoreVersion === version;
            const restoring = version !== undefined
              && props.restoreState.status === "restoring"
              && props.restoreState.targetVersion === version;
            return (
              <div key={entry.seq} className="project-context-pack-history__item">
                <div className="project-context-pack-history__summary">
                  <strong>{version === undefined ? "-" : `v${version}`} · {historySnapshotTitle(entry.after, entry.changeType)}</strong>
                  <span>{entry.changeType} · {entry.source} · {formatDateTime(entry.createdAt)}</span>
                  {historySnapshotBody(entry.after) ? <p>{historySnapshotBody(entry.after)}</p> : null}
                </div>
                {confirming ? (
                  <div className="project-context-pack-history__confirm">
                    <p>{props.t("home.contextPack.history.confirm")}</p>
                    <div>
                      <button type="button" disabled={restoring} onClick={props.onCancelRestore}>{props.t("home.contextPack.history.cancel")}</button>
                      <button type="button" disabled={restoring} onClick={() => props.onConfirmRestore(version!)}>
                        {restoring ? props.t("home.contextPack.history.restoring") : props.t("home.contextPack.history.confirmAction")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="project-context-pack-history__restore"
                    disabled={!restorable || props.restoreState.status === "restoring"}
                    onClick={() => version !== undefined && props.onRequestRestore(version)}
                  >
                    {current ? props.t("home.contextPack.history.current") : props.t("home.contextPack.history.restore")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {props.restoreState.status === "success" ? (
        <p className="project-context-pack-history__feedback" role="status">
          {props.t("home.contextPack.history.success")} v{props.restoreState.targetVersion}
        </p>
      ) : null}
      {props.restoreState.status === "error" ? (
        <p className="project-context-pack-history__feedback project-context-pack-history__feedback--error" role="alert">
          {props.t("home.contextPack.history.restoreError")}
        </p>
      ) : null}
    </section>
  );
}

function historySnapshotTitle(snapshot: unknown, fallback: string): string {
  const record = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : null;
  const info = record && typeof record.info === "object" && record.info !== null
    ? record.info as Record<string, unknown>
    : null;
  return typeof info?.title === "string" && info.title.trim()
    ? info.title
    : fallback;
}

function historySnapshotBody(snapshot: unknown): string {
  const record = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : null;
  return typeof record?.memoryValue === "string" ? record.memoryValue : "";
}

function statusLabel(status: GetMemoryOutput["item"]["status"], t: Translate): string {
  const keys = {
    activated: "memory.memories.status.activated",
    resolving: "memory.memories.status.resolving",
    archived: "memory.memories.status.archived",
    deleted: "memory.memories.status.deleted"
  } as const;
  return t(keys[status]);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function ContextPackStatus(props: { children: ReactNode }) {
  return <div className="project-context-pack-dialog__status">{props.children}</div>;
}
