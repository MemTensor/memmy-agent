/**
 * Literature review agent workflow (design-complete mock).
 *
 * Implements the interaction prototype end to end: requirement clarification
 * cards -> keyword / outline / reference wizard cards with agent thinking and
 * search progress in between -> autonomous to-do execution with the file
 * preview workspace on the right. All content comes from
 * `literature-review-demo-data.ts`; no backend calls are made.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type MouseEvent, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Files,
  Folder,
  GripVertical,
  LibraryBig,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Pencil,
  Plus,
  Send,
  X
} from "lucide-react";
import { FileTypeIcon } from "../components/file-type-icon.js";
import { useApiClients } from "../app/providers.js";
import { AppFrame } from "./app-frame.js";
import { AgentAttachmentCard } from "./agent-file-attachment-chip.js";
import { SidebarResizeHandle, useResizableSidebar } from "./sidebar-resize.js";
import { Button } from "../components/button.js";
import { useTranslation } from "../i18n/use-translation.js";
import {
  dataTransferHasComposerReference,
  mergeComposerContextReferences,
  readComposerReferenceDrag,
  writeComposerReferenceDrag
} from "../lib/composer-file-reference.js";
import { registerAgentManagedFiles } from "../lib/agent-managed-files.js";
import { agentActions } from "../state/app-actions.js";
import { agentChatScopeKey, type ComposerContextReference } from "../state/agent-composer-state.js";
import { useAppState } from "../state/app-state.js";
import { buildDemoKnowledgeBases, buildDemoLibraryFiles, type KbKnowledgeBase } from "./knowledge-demo-data.js";
import { ComposerQuickActionButtons, ComposerReferencePanel, HomeContextChips } from "./home-composer-quick-actions.js";
import { mergeVoiceTranscript, useAsrRecorder } from "./asr-recorder.js";
import { Mic, Pause } from "./memory/memory-prototype-icons.js";
import {
  LITREV_ASSISTANT_INTRO,
  LITREV_BODY_ARTIFACT,
  LITREV_CONTEXT_STORAGE_KEY,
  LITREV_DEFAULT_PROMPT,
  LITREV_EXECUTION_PHASE,
  LITREV_EXECUTION_INTRO,
  LITREV_OUTLINE_ARTIFACT,
  LITREV_OUTLINE_PHASE,
  LITREV_PLANNING_PHASE,
  LITREV_PROJECT_CONTEXT_STORAGE_KEY,
  LITREV_PROMPT_STORAGE_KEY,
  LITREV_SOURCE_INPUT_STORAGE_KEY,
  LITREV_RESULT_LINE,
  LITREV_SEARCH_PHASE,
  LITREV_SUPPLEMENT_ACK,
  LITREV_TODO_ITEMS,
  LITREV_TOPIC_QUESTION,
  buildDemoKeywords,
  buildDemoOutline,
  buildDemoReferences,
  buildDemoTaskFiles,
  buildHomeReferenceItems,
  buildLitrevSetupQuestions,
  litrevPreviewContentFor,
  moveOutlineItem,
  type HomeReferenceItem,
  type LitrevKeyword,
  type LitrevLaunchContext,
  type LitrevOutlineItem,
  type LitrevPreviewFolder,
  type LitrevReference,
  type LitrevThinkingPhase
} from "./literature-review-demo-data.js";

const THINKING_STAGE_MS = 900;
const TODO_STEP_MS = 2800;
const LITREV_PREVIEW_WIDTH_STORAGE_KEY = "memmy.literatureReview.previewWidth";
const LITREV_FILE_BROWSER_WIDTH_STORAGE_KEY = "memmy.literatureReview.fileBrowserWidth";

type ThinkingKind = "planning" | "outline" | "search" | "execution";
type LitrevStageKind = "questions" | "keywords" | "outline" | "references" | "tasks";
type PreviewScope = "task" | "knowledge" | "project";
type QuestionCardStatus = "preparing" | "waiting" | "cancelled";

type LitrevPhase =
  | { kind: "setup" }
  | { kind: "thinking"; thinking: ThinkingKind; stage: number }
  | { kind: "wizard"; step: 0 | 1 | 2 }
  | { kind: "task" };

function stageKindForPhase(phase: LitrevPhase): LitrevStageKind {
  if (phase.kind === "setup") return "questions";
  if (phase.kind === "wizard") return phase.step === 0 ? "keywords" : phase.step === 1 ? "outline" : "references";
  if (phase.kind === "task") return "tasks";
  return phase.thinking === "planning"
    ? "keywords"
    : phase.thinking === "outline"
      ? "outline"
      : phase.thinking === "search"
        ? "references"
        : "tasks";
}

interface SupplementEntry {
  id: number;
  text: string;
  contexts: ComposerContextReference[];
}

function readInitialPrompt(): string {
  if (typeof window === "undefined") return LITREV_DEFAULT_PROMPT;
  try {
    const stored = window.sessionStorage.getItem(LITREV_PROMPT_STORAGE_KEY)?.trim();
    return stored || LITREV_DEFAULT_PROMPT;
  } catch {
    return LITREV_DEFAULT_PROMPT;
  }
}

function readInitialSourceInput(): string {
  if (typeof window === "undefined") return LITREV_DEFAULT_PROMPT;
  try {
    return window.sessionStorage.getItem(LITREV_SOURCE_INPUT_STORAGE_KEY)?.trim() || readInitialPrompt();
  } catch {
    return readInitialPrompt();
  }
}

function readInitialContexts(): LitrevLaunchContext[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(LITREV_CONTEXT_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is LitrevLaunchContext => (
      item != null
      && (item.kind === "kb" || item.kind === "path")
      && typeof item.id === "string"
      && typeof item.label === "string"
    ));
  } catch {
    return [];
  }
}

function readInitialProjectId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(LITREV_PROJECT_CONTEXT_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

/** Dev shortcuts: `phase=outline|references|task` jump to the matching workflow stage. */
function readInitialPhase(): LitrevPhase {
  if (typeof window === "undefined") return { kind: "setup" };
  try {
    const phase = new URLSearchParams(window.location.search).get("phase");
    if (phase === "outline") return { kind: "wizard", step: 1 };
    if (phase === "references") return { kind: "wizard", step: 2 };
    if (phase === "task") return { kind: "task" };
    if (phase === "thinking") return { kind: "thinking", thinking: "planning", stage: 1 };
    return { kind: "setup" };
  } catch {
    return { kind: "setup" };
  }
}

function thinkingPhaseData(kind: ThinkingKind): LitrevThinkingPhase {
  switch (kind) {
    case "planning":
      return LITREV_PLANNING_PHASE;
    case "outline":
      return LITREV_OUTLINE_PHASE;
    case "search":
      return LITREV_SEARCH_PHASE;
    case "execution":
      return LITREV_EXECUTION_PHASE;
  }
}

function fileNameFromPath(path: string): string {
  return path.split("/").pop() ?? path;
}

export function LiteratureReviewPage() {
  const { t } = useTranslation();
  const { clients } = useApiClients();
  const { state: appState, dispatch } = useAppState();
  const asrRecorder = useAsrRecorder(clients?.asr, { emptyAudioMessage: t("home.asrEmptyAudio") });
  const previewResize = useResizableSidebar({
    storageKey: LITREV_PREVIEW_WIDTH_STORAGE_KEY,
    defaultWidth: 520,
    minWidth: 360,
    maxWidth: 760,
    resizeDirection: -1
  });
  const fileBrowserResize = useResizableSidebar({
    storageKey: LITREV_FILE_BROWSER_WIDTH_STORAGE_KEY,
    defaultWidth: 200,
    minWidth: 160,
    maxWidth: 360
  });
  const [prompt] = useState(readInitialPrompt);
  const [sourceInput] = useState(readInitialSourceInput);
  const [launchContexts] = useState(readInitialContexts);
  const [launchProjectId] = useState(readInitialProjectId);
  const questions = useMemo(() => buildLitrevSetupQuestions(prompt), [prompt]);
  const [phase, setPhase] = useState<LitrevPhase>(readInitialPhase);
  const [questionIndex, setQuestionIndex] = useState(() => {
    const initial = readInitialPhase();
    return initial.kind === "task" || initial.kind === "thinking" ? Number.MAX_SAFE_INTEGER : 0;
  });
  const [todoProgress, setTodoProgress] = useState(() => (
    readInitialPhase().kind === "task" ? 3 : 0
  ));
  const [pendingAnswers, setPendingAnswers] = useState<string[]>(() => (
    questions.map((question) => question.options[0] ?? "")
  ));
  const [questionSupplements, setQuestionSupplements] = useState<Record<number, string>>({});
  const [questionCardStatus, setQuestionCardStatus] = useState<QuestionCardStatus>("preparing");
  const [workflowEnded, setWorkflowEnded] = useState(false);
  const [reachedStages, setReachedStages] = useState<LitrevStageKind[]>(() => [stageKindForPhase(readInitialPhase())]);
  const [preparationDetailsOpen, setPreparationDetailsOpen] = useState(false);
  const [processDetailsOpen, setProcessDetailsOpen] = useState(false);
  const [stageDetailsOpen, setStageDetailsOpen] = useState<Record<LitrevStageKind, boolean>>(() => {
    const current = stageKindForPhase(readInitialPhase());
    return {
      questions: current === "questions",
      keywords: current === "keywords",
      outline: current === "outline",
      references: current === "references",
      tasks: current === "tasks"
    };
  });
  const [answers, setAnswers] = useState<Array<{ question: string; answer: string }>>([]);
  const [keywords, setKeywords] = useState<LitrevKeyword[]>(buildDemoKeywords);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [outline, setOutline] = useState<LitrevOutlineItem[]>(buildDemoOutline);
  const [references, setReferences] = useState<LitrevReference[]>(buildDemoReferences);
  const [referenceTargetKbIds, setReferenceTargetKbIds] = useState<string[]>([]);
  const [knowledgeBases] = useState<KbKnowledgeBase[]>(buildDemoKnowledgeBases);
  const [supplements, setSupplements] = useState<SupplementEntry[]>([]);
  const [composerDraft, setComposerDraft] = useState("");
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
  const composerScopeKey = agentChatScopeKey(appState.agent.currentChatId, appState.agent.newChatRequestId);
  const composerReferences = appState.agent.composerContextReferencesByScope[composerScopeKey] ?? [];
  const [fileContextMenu, setFileContextMenu] = useState<{
    reference: ComposerContextReference;
    x: number;
    y: number;
  } | null>(null);
  const [previewScope, setPreviewScope] = useState<PreviewScope>("task");
  const [knowledgeScope, setKnowledgeScope] = useState<string>(() => (
    launchContexts.find((context) => context.kind === "kb")?.id ?? "all"
  ));
  const [previewPath, setPreviewPath] = useState(LITREV_OUTLINE_ARTIFACT);
  const [openPreviewTabs, setOpenPreviewTabs] = useState<string[]>([
    LITREV_OUTLINE_ARTIFACT,
    LITREV_BODY_ARTIFACT,
    "references/MemGPT.pdf"
  ]);
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const [collapsedPreviewFolders, setCollapsedPreviewFolders] = useState<Record<string, boolean>>({});
  const [workspaceOpen, setWorkspaceOpen] = useState(() => readInitialPhase().kind === "task");
  const dragOutlineState = useRef<{ index: number; startX: number; level: 0 | 1 } | null>(null);
  const [outlineDropTarget, setOutlineDropTarget] = useState<{ index: number; level: 0 | 1 } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previewScopeMenuRef = useRef<HTMLDetailsElement | null>(null);
  const taskFiles = useMemo(() => buildDemoTaskFiles(), []);
  const projectFiles = useMemo(() => (
    buildHomeReferenceItems().map((file) => ({
      path: `project/${file.path}`,
      name: file.path
    }))
  ), []);

  useEffect(() => {
    if (phase.kind !== "task" || todoProgress < LITREV_TODO_ITEMS.length) return;
    const managedFiles = taskFiles
      .filter((file) => file.folder === "references" || file.folder === "outputs")
      .map((file) => {
        const generated = file.folder === "outputs";
        return {
          id: `agent-managed:${file.folder}:${file.name}`,
          path: `${t("kb.files.agentRoot")}/${t(generated ? "kb.files.generatedFolder" : "kb.files.downloadedFolder")}/${file.name}`,
          name: file.name,
          size: "—",
          updated: t("kb.updatedJustNow"),
          source: generated ? "agent-generated" as const : "agent-downloaded" as const
        };
      });
    registerAgentManagedFiles(managedFiles, window.localStorage, window);
  }, [phase.kind, taskFiles, t, todoProgress]);
  const libraryFiles = useMemo(() => buildDemoLibraryFiles(), []);

  const setupDone = questionIndex >= questions.length;
  const activeStage = stageKindForPhase(phase);

  /* ------------------------------ 阶段推进定时器 ------------------------------ */

  useEffect(() => {
    if (phase.kind !== "thinking") return;
    const data = thinkingPhaseData(phase.thinking);
    if (phase.stage >= data.stages.length) {
      switch (phase.thinking) {
        case "planning":
          setPhase({ kind: "wizard", step: 0 });
          break;
        case "outline":
          setPhase({ kind: "wizard", step: 1 });
          break;
        case "search":
          setPhase({ kind: "wizard", step: 2 });
          break;
        case "execution":
          setTodoProgress(0);
          setPhase({ kind: "task" });
          break;
      }
      return;
    }
    const timer = window.setTimeout(() => {
      setPhase((current) => (current.kind === "thinking" ? { ...current, stage: current.stage + 1 } : current));
    }, THINKING_STAGE_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    setReachedStages((stages) => (stages.includes(activeStage) ? stages : [...stages, activeStage]));
    setStageDetailsOpen((state) => {
      const next = { ...state };
      for (const stage of Object.keys(next) as LitrevStageKind[]) next[stage] = stage === activeStage;
      return next;
    });
  }, [activeStage]);

  useEffect(() => {
    if (phase.kind !== "task" || todoProgress >= LITREV_TODO_ITEMS.length) return;
    const timer = window.setTimeout(() => setTodoProgress((value) => value + 1), TODO_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [phase.kind, todoProgress]);

  useEffect(() => {
    if (phase.kind === "task" && todoProgress >= LITREV_TODO_ITEMS.length) {
      setStageDetailsOpen((state) => ({ ...state, tasks: false }));
    }
  }, [phase.kind, todoProgress]);

  useEffect(() => {
    if (phase.kind !== "setup" || setupDone || workflowEnded) return;
    setQuestionCardStatus("preparing");
    const timer = window.setTimeout(() => setQuestionCardStatus("waiting"), 450);
    return () => window.clearTimeout(timer);
  }, [phase.kind, setupDone, workflowEnded]);

  useEffect(() => {
    if (setupDone && phase.kind === "setup" && !workflowEnded) {
      setPhase({ kind: "thinking", thinking: "planning", stage: 0 });
    }
  }, [setupDone, phase.kind, workflowEnded]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [phase, questionCardStatus, supplements, todoProgress]);

  useEffect(() => {
    if (!fileContextMenu) return;
    const close = () => setFileContextMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
    };
  }, [fileContextMenu]);

  /* --------------------------------- 交互处理 --------------------------------- */

  function confirmAnswers() {
    if (questionCardStatus !== "waiting" || pendingAnswers.some((answer) => !answer)) return;
    setAnswers(questions.map((question, index) => ({
      question: question.text,
      answer: pendingAnswers[index] ?? ""
    })));
    setQuestionIndex(questions.length);
  }

  function updateQuestionAnswer(index: number, answer: string) {
    setPendingAnswers((items) => items.map((item, itemIndex) => (
      itemIndex === index ? answer : item
    )));
  }

  function cancelWorkflow() {
    setWorkflowEnded(true);
    setQuestionCardStatus("cancelled");
    setQuestionSupplements({});
  }

  function confirmKeywords() {
    setPhase({ kind: "thinking", thinking: "outline", stage: 0 });
  }

  function confirmOutline() {
    setPhase({ kind: "thinking", thinking: "search", stage: 0 });
  }

  function confirmReferencesAndStart() {
    setPhase({ kind: "thinking", thinking: "execution", stage: 0 });
  }

  function addComposerReferences(references: ComposerContextReference[]) {
    dispatch(agentActions.composerContextReferencesUpdated(
      composerScopeKey,
      mergeComposerContextReferences(composerReferences, references)
    ));
  }

  function removeComposerReference(reference: ComposerContextReference) {
    dispatch(agentActions.composerContextReferencesUpdated(
      composerScopeKey,
      composerReferences.filter((item) => !(item.kind === reference.kind && item.id === reference.id))
    ));
  }

  function fileReference(path: string, name: string): ComposerContextReference {
    return { kind: "path", id: path, label: name };
  }

  function beginFileDrag(event: DragEvent<HTMLElement>, path: string, name: string) {
    writeComposerReferenceDrag(event.dataTransfer, fileReference(path, name));
  }

  function openFileContextMenu(event: MouseEvent<HTMLElement>, path: string, name: string) {
    event.preventDefault();
    setFileContextMenu({
      reference: fileReference(path, name),
      x: Math.min(event.clientX, window.innerWidth - 190),
      y: Math.min(event.clientY, window.innerHeight - 52)
    });
  }

  function handleComposerFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    const references = Array.from(event.target.files ?? []).map((file) => {
      let path = file.name;
      try {
        path = window.memmy?.getPathForFile(file) || file.name;
      } catch {
        path = file.name;
      }
      return fileReference(path, file.name);
    });
    if (references.length) addComposerReferences(references);
    event.target.value = "";
    composerInputRef.current?.focus();
  }

  function pickComposerKnowledgeBase(base: KbKnowledgeBase) {
    addComposerReferences([{ kind: "kb", id: base.id, label: base.name }]);
    setReferencePickerOpen(false);
    composerInputRef.current?.focus();
  }

  function pickComposerReference(item: HomeReferenceItem) {
    addComposerReferences([fileReference(item.path, item.path)]);
    setReferencePickerOpen(false);
    composerInputRef.current?.focus();
  }

  function insertComposerSlash() {
    setReferencePickerOpen(false);
    setComposerDraft((draft) => `${draft}${draft && !/\s$/.test(draft) ? " " : ""}/`);
    window.requestAnimationFrame(() => composerInputRef.current?.focus());
  }

  async function toggleComposerVoiceInput() {
    if (asrRecorder.isRecording) {
      try {
        const transcript = await asrRecorder.finishAndTranscribe();
        setComposerDraft((draft) => mergeVoiceTranscript(draft, transcript.text));
      } catch (error) {
        console.warn("[literature-review] voice transcription failed", error);
      }
      composerInputRef.current?.focus();
      return;
    }
    try {
      await asrRecorder.start();
    } catch (error) {
      console.warn("[literature-review] voice recording failed", error);
    }
  }

  function submitSupplement() {
    const text = composerDraft.trim();
    if (!text && !composerReferences.length) return;
    setSupplements((items) => [...items, {
      id: Date.now(),
      text,
      contexts: composerReferences
    }]);
    setComposerDraft("");
    dispatch(agentActions.composerContextReferencesUpdated(composerScopeKey, []));
    if (workflowEnded) return;
    if (phase.kind === "setup" && questionCardStatus !== "cancelled") {
      setAnswers([]);
      setQuestionIndex(questions.length);
      return;
    }
    if (phase.kind === "wizard") {
      if (phase.step === 0) {
        confirmKeywords();
      } else if (phase.step === 1) {
        confirmOutline();
      } else {
        confirmReferencesAndStart();
      }
    }
  }

  function handleComposerDragOver(event: DragEvent<HTMLElement>) {
    if (!dataTransferHasComposerReference(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleComposerDrop(event: DragEvent<HTMLElement>) {
    const reference = readComposerReferenceDrag(event.dataTransfer);
    if (!reference) return;
    event.preventDefault();
    addComposerReferences([reference]);
  }

  function selectPreviewFile(path: string) {
    setPreviewPath(path);
    setOpenPreviewTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
  }

  function closePreviewTab(path: string) {
    setOpenPreviewTabs((tabs) => {
      if (tabs.length <= 1) return tabs;
      const next = tabs.filter((tab) => tab !== path);
      if (previewPath === path) {
        setPreviewPath(next[next.length - 1] ?? LITREV_OUTLINE_ARTIFACT);
      }
      return next;
    });
  }

  function openArtifact(path: string) {
    setPreviewScope("task");
    selectPreviewFile(path);
  }

  /* --------------------------------- 会话渲染 --------------------------------- */

  function renderThinkingCopy(): ReactNode {
    if (phase.kind !== "thinking") return null;
    return <p className="litrev-stage-thinking-copy">{thinkingPhaseData(phase.thinking).title}</p>;
  }

  function completedStageLabel(stage: LitrevStageKind): string {
    if (stage === "questions") return t("litrev.stageActivity.questions.done");
    if (stage === "keywords") return t("litrev.stageActivity.keywords.done");
    if (stage === "outline") return t("litrev.stageActivity.outline.done");
    if (stage === "references") return t("litrev.stageActivity.references.done");
    return t("litrev.stageActivity.tasks.done");
  }

  function stageOutputFor(stage: Exclude<LitrevStageKind, "tasks">): string {
    if (stage === "questions") return t("litrev.stageOutput.questions");
    if (stage === "keywords") return t("litrev.stageOutput.keywords");
    if (stage === "outline") return t("litrev.stageOutput.outline");
    return t("litrev.stageOutput.references");
  }

  function renderStageOutput(stage: Exclude<LitrevStageKind, "tasks">): ReactNode {
    return <p className="litrev-assistant-copy litrev-stage-output-message">{stageOutputFor(stage)}</p>;
  }

  function currentStageLabel(stage: LitrevStageKind): string {
    if (workflowEnded) return t("litrev.workflow.cancelled");
    if (stage === "questions") {
      return questionCardStatus === "preparing"
        ? t("litrev.stageActivity.questions.generating")
        : t("litrev.stageActivity.questions.waiting");
    }
    if (stage === "tasks") {
      return phase.kind === "thinking"
        ? t("litrev.stageActivity.tasks.generating")
        : t("litrev.stageActivity.tasks.done");
    }
    if (phase.kind === "thinking") {
      return stage === "keywords"
        ? t("litrev.stageActivity.keywords.generating")
        : stage === "outline"
          ? t("litrev.stageActivity.outline.generating")
          : t("litrev.stageActivity.references.generating");
    }
    return stage === "keywords"
      ? t("litrev.stageActivity.keywords.waiting")
      : stage === "outline"
        ? t("litrev.stageActivity.outline.waiting")
        : t("litrev.stageActivity.references.waiting");
  }

  function renderCompletedStageContent(stage: LitrevStageKind): ReactNode {
    if (stage === "questions") return renderRequirementSummary();
    if (stage === "keywords") {
      return (
        <div className="litrev-stage-text-card">
          {keywords.map((keyword) => (
            <div key={keyword.id}><strong>{keyword.text}</strong><small>{t("litrev.keywords.weight")} {keyword.weight}</small></div>
          ))}
        </div>
      );
    }
    if (stage === "outline") {
      return (
        <div className="litrev-stage-text-card litrev-stage-text-card--outline">
          {outline.map((item) => <div key={item.id} data-level={item.level}><strong>{item.text}</strong></div>)}
        </div>
      );
    }
    if (stage === "references") {
      return (
        <div className="litrev-stage-text-card">
          {references.filter((reference) => reference.selected).map((reference) => (
            <div key={reference.id}><strong>{reference.title}</strong><small>{reference.meta}</small></div>
          ))}
        </div>
      );
    }
    return renderTodoList();
  }

  function renderCurrentStageContent(stage: LitrevStageKind): ReactNode {
    if (workflowEnded) return <p className="litrev-cancelled-activity__body">{t("litrev.workflow.cancelledDetail")}</p>;
    if (phase.kind === "thinking") return renderThinkingCopy();
    if (stage === "questions") return null;
    if (phase.kind === "wizard") return null;
    return renderTodoList();
  }

  function renderStageActivity(stage: LitrevStageKind): ReactNode {
    const current = stage === activeStage;
    const open = stageDetailsOpen[stage];
    const running = current && (
      phase.kind === "thinking"
      || (stage === "questions" && questionCardStatus === "preparing")
      || (stage === "tasks" && todoProgress < LITREV_TODO_ITEMS.length)
    );
    const statusText = current ? currentStageLabel(stage) : completedStageLabel(stage);
    const content = current ? renderCurrentStageContent(stage) : renderCompletedStageContent(stage);
    const collapsible = Boolean(content);
    return (
      <div
        key={stage}
        className={`agent-activity-cluster litrev-stage-activity${running ? " agent-activity-cluster--running" : ""}${open ? " agent-activity-cluster--open" : ""}`}
      >
        {collapsible ? (
          <button
            type="button"
            className="agent-activity-cluster__toggle litrev-status-toggle"
            aria-expanded={open}
            onClick={() => setStageDetailsOpen((state) => ({ ...state, [stage]: !state[stage] }))}
          >
            <span>{statusText}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        ) : (
          <div className="litrev-status-toggle litrev-status-toggle--static" aria-live={running ? "polite" : undefined}>
            <span>{statusText}</span>
          </div>
        )}
        {open && content ? (
          <div className="agent-activity-cluster__body litrev-stage-activity__body min-w-0">
            {content}
          </div>
        ) : null}
      </div>
    );
  }

  function renderPreparationSummary(stages: Array<Exclude<LitrevStageKind, "tasks">>): ReactNode {
    return (
      <div className={`agent-activity-cluster litrev-preparation-summary${preparationDetailsOpen ? " agent-activity-cluster--open" : ""}`}>
        <button
          type="button"
          className="agent-activity-cluster__toggle litrev-status-toggle"
          aria-expanded={preparationDetailsOpen}
          onClick={() => setPreparationDetailsOpen((open) => !open)}
        >
          <span>{t("litrev.stageActivity.preparation.done")}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        {preparationDetailsOpen ? (
          <div className="agent-activity-cluster__body litrev-preparation-summary__body">
            {stages.map((stage) => {
              const open = stageDetailsOpen[stage];
              return (
                <Fragment key={stage}>
                  <div className={`litrev-preparation-stage${open ? " litrev-preparation-stage--open" : ""}`}>
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() => setStageDetailsOpen((state) => ({ ...state, [stage]: !state[stage] }))}
                    >
                      <span>{completedStageLabel(stage)}</span>
                      <ChevronDown size={12} aria-hidden="true" />
                    </button>
                    {open ? renderCompletedStageContent(stage) : null}
                  </div>
                  {renderStageOutput(stage)}
                </Fragment>
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  function renderStageActivities(): ReactNode {
    if (activeStage === "tasks") {
      const preparationStages = reachedStages.filter(
        (stage): stage is Exclude<LitrevStageKind, "tasks"> => stage !== "tasks"
      );
      return (
        <>
          {preparationStages.length ? renderPreparationSummary(preparationStages) : null}
          {reachedStages.includes("tasks") ? renderStageActivity("tasks") : null}
        </>
      );
    }
    return reachedStages.map((stage) => (
      <Fragment key={stage}>
        {renderStageActivity(stage)}
        {stage !== activeStage && stage !== "tasks" ? renderStageOutput(stage) : null}
      </Fragment>
    ));
  }

  function renderRequirementSummary(): ReactNode {
    if (!setupDone) return null;
    return (
      <div className="litrev-qa-summary">
        <div>
          <small>{LITREV_TOPIC_QUESTION}</small>
          <strong>{prompt}</strong>
        </div>
        {answers.map((entry) => (
          <div key={entry.question}>
            <small>{entry.question}</small>
            <strong>{entry.answer}</strong>
          </div>
        ))}
      </div>
    );
  }

  function renderLaunchUserMessage(): ReactNode {
    const sourceParts = sourceInput.split(/(\/literature-review\b)/gi);
    return (
      <div className="litrev-user-message">
        <div className="agent-chat-bubble agent-chat-bubble--user litrev-user-bubble">
          {sourceParts.map((part, index) => (
            /^\/literature-review$/i.test(part)
              ? <span key={`${part}:${index}`} className="litrev-user-command">{part}</span>
              : part
          ))}
        </div>
        {launchContexts.length ? (
          <div className="litrev-user-message__contexts">
            {launchContexts.map((context) => (
              <AgentAttachmentCard
                key={`${context.kind}:${context.id}`}
                kind="file"
                name={context.label}
                subline={context.kind === "kb" ? t("home.quick.kind.kb") : t("home.quick.kind.file")}
                align="right"
                leading={context.kind === "kb" ? (
                  <span className="litrev-user-message__kb-icon"><LibraryBig size={16} /></span>
                ) : (
                  <FileTypeIcon name={context.id} surface="card" />
                )}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderConversation(): ReactNode {
    return (
      <div className="litrev-conversation">
        {renderLaunchUserMessage()}
        <p className="litrev-assistant-copy">{LITREV_ASSISTANT_INTRO}</p>
        {supplements.map((entry) => (
          <div key={entry.id} className="litrev-supplement">
            <div className="litrev-user-message">
              {entry.text ? <div className="agent-chat-bubble agent-chat-bubble--user litrev-user-bubble">{entry.text}</div> : null}
              <HomeContextChips chips={entry.contexts} />
            </div>
            <p className="litrev-assistant-copy">{LITREV_SUPPLEMENT_ACK}</p>
          </div>
        ))}
        {renderStageActivities()}
      </div>
    );
  }

  /* --------------------------------- 问答卡片 --------------------------------- */

  function renderQuestionCard(): ReactNode {
    if (
      phase.kind !== "setup"
      || questionCardStatus !== "waiting"
      || workflowEnded
    ) return null;
    return (
      <section className="litrev-question-card" aria-label={t("litrev.question.cardTitle")}>
        <header className="litrev-question-card__head">
          <h2>{t("litrev.question.cardTitle")}</h2>
          <div className="litrev-question-card__meta">
            <span>{t("litrev.question.count", { count: questions.length })}</span>
            <button type="button" aria-label={t("litrev.workflow.close")} onClick={cancelWorkflow}>
              <X size={15} />
            </button>
          </div>
        </header>
        <div className="litrev-question-list">
          {questions.map((question, itemIndex) => {
            const savedAnswer = pendingAnswers[itemIndex] ?? "";
            const supplementDraft = questionSupplements[itemIndex] ?? "";
            const options = savedAnswer && !question.options.includes(savedAnswer)
              ? [...question.options, savedAnswer]
              : question.options;
            return (
              <section
                key={question.id}
                className="litrev-question-item"
              >
                <div className="litrev-question-item__title">
                  <h3>{question.text}</h3>
                </div>
                <div className="litrev-question-options">
                  {options.map((option, optionIndex) => {
                    const selected = savedAnswer === option;
                    return (
                      <button
                        type="button"
                        key={option}
                        className={`litrev-question-option${selected ? " litrev-question-option--selected" : ""}`}
                        onClick={() => updateQuestionAnswer(itemIndex, option)}
                      >
                        <span className="litrev-question-option__number">{optionIndex + 1}</span>
                        <span className="litrev-question-option__label">{option}</span>
                        <span className="litrev-question-option__state">{selected ? <Check size={13} /> : <ChevronRight size={13} />}</span>
                      </button>
                    );
                  })}
                </div>
                <form
                  className="litrev-question-supplement"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const supplement = supplementDraft.trim();
                    if (!supplement) return;
                    updateQuestionAnswer(itemIndex, supplement);
                    setQuestionSupplements((items) => ({ ...items, [itemIndex]: "" }));
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                  <input
                    value={supplementDraft}
                    placeholder={t("litrev.question.supplementPlaceholder")}
                    aria-label={`${question.text}：${t("litrev.question.supplementPlaceholder")}`}
                    onChange={(event) => setQuestionSupplements((items) => ({
                      ...items,
                      [itemIndex]: event.target.value
                    }))}
                  />
                  <button type="submit" aria-label={t("common.confirm")} disabled={!supplementDraft.trim()}>
                    <ChevronRight size={14} />
                  </button>
                </form>
              </section>
            );
          })}
        </div>
        <footer className="litrev-question-card__foot">
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={pendingAnswers.some((answer) => !answer)}
            onClick={confirmAnswers}
          >
            {t("common.confirm")}
          </Button>
        </footer>
      </section>
    );
  }

  /* --------------------------------- 向导卡片 --------------------------------- */

  function renderKeywordStep(): ReactNode {
    return (
      <>
        <p className="litrev-section-hint">{t("litrev.keywords.hint")}</p>
        <div className="litrev-keyword-rows">
          {keywords.map((keyword, index) => (
            <div className="litrev-keyword-row" key={keyword.id}>
              <input
                type="text"
                value={keyword.text}
                aria-label={t("litrev.keywords.itemLabel")}
                onChange={(event) => setKeywords((items) => items.map((item, itemIndex) => (itemIndex === index ? { ...item, text: event.target.value } : item)))}
              />
              <label>{t("litrev.keywords.weight")}</label>
              <input
                type="range"
                min={1}
                max={5}
                value={keyword.weight}
                onChange={(event) => setKeywords((items) => items.map((item, itemIndex) => (itemIndex === index ? { ...item, weight: Number(event.target.value) } : item)))}
              />
              <strong>{keyword.weight}</strong>
              <button
                type="button"
                className="litrev-icon-button"
                aria-label={t("common.remove")}
                onClick={() => setKeywords((items) => items.filter((_, itemIndex) => itemIndex !== index))}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
        <form
          className="litrev-add-row"
          onSubmit={(event) => {
            event.preventDefault();
            const text = keywordDraft.trim();
            if (!text) return;
            setKeywords((items) => [...items, { id: `k-${Date.now()}`, text, weight: 3 }]);
            setKeywordDraft("");
          }}
        >
          <input value={keywordDraft} placeholder={t("litrev.keywords.addPlaceholder")} onChange={(event) => setKeywordDraft(event.target.value)} />
          <Button type="submit" variant="secondary" size="sm" disabled={!keywordDraft.trim()}><Plus size={12} /> {t("litrev.keywords.add")}</Button>
        </form>
      </>
    );
  }

  function renderOutlineStep(): ReactNode {
    const levelAtPointer = (event: DragEvent<HTMLElement>): 0 | 1 => {
      const drag = dragOutlineState.current;
      if (!drag) return 0;
      const horizontalDelta = event.clientX - drag.startX;
      if (horizontalDelta <= -12) return 0;
      if (horizontalDelta >= 12) return 1;
      return drag.level;
    };
    return (
      <>
        <p className="litrev-section-hint">{t("litrev.outline.hint")}</p>
        <div className="litrev-outline-rows">
          {outline.map((item, index) => (
            <div
              key={item.id}
              className={[
                "litrev-outline-row",
                item.level ? "litrev-outline-row--child" : "",
                outlineDropTarget?.index === index ? "litrev-outline-row--drop" : "",
                outlineDropTarget?.index === index && outlineDropTarget.level === 1
                  ? "litrev-outline-row--drop-child"
                  : ""
              ].filter(Boolean).join(" ")}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const level = levelAtPointer(event);
                if (outlineDropTarget?.index !== index || outlineDropTarget.level !== level) {
                  setOutlineDropTarget({ index, level });
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const from = dragOutlineState.current?.index;
                const level = levelAtPointer(event);
                dragOutlineState.current = null;
                setOutlineDropTarget(null);
                if (from == null) return;
                setOutline((items) => moveOutlineItem(items, from, index, level));
              }}
            >
              <button
                type="button"
                className="litrev-outline-row__grip"
                draggable
                aria-label={t("litrev.outline.dragHint")}
                title={t("litrev.outline.dragHint")}
                onDragStart={(event) => {
                  dragOutlineState.current = {
                    index,
                    startX: event.clientX,
                    level: item.level
                  };
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", item.id);
                }}
                onDragEnd={() => {
                  dragOutlineState.current = null;
                  setOutlineDropTarget(null);
                }}
              >
                <GripVertical size={13} />
              </button>
              <input
                value={item.text}
                aria-label={t("litrev.outline.itemLabel")}
                onChange={(event) => setOutline((items) => items.map((entry, entryIndex) => (entryIndex === index ? { ...entry, text: event.target.value } : entry)))}
              />
              <button
                type="button"
                className="litrev-icon-button"
                aria-label={t("common.remove")}
                onClick={() => setOutline((items) => items.filter((_, entryIndex) => entryIndex !== index))}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setOutline((items) => [...items, { id: `o-${Date.now()}`, text: t("litrev.outline.newSection"), level: 0 }])}
        >
          <Plus size={12} /> {t("litrev.outline.addSection")}
        </Button>
      </>
    );
  }

  function renderReferenceStep(): ReactNode {
    return (
      <div className="litrev-ref-list">
        {references.map((reference, index) => (
          <label key={reference.id} className={`litrev-ref-row${reference.selected ? " litrev-ref-row--selected" : ""}`}>
            <input
              type="checkbox"
              checked={reference.selected}
              onChange={(event) => setReferences((items) => items.map((item, itemIndex) => (itemIndex === index ? { ...item, selected: event.target.checked } : item)))}
            />
            <span className={`kb-checkbox${reference.selected ? " kb-checkbox--checked" : ""}`}>{reference.selected ? <Check size={11} /> : null}</span>
            <span className="litrev-ref-row__text">
              <strong>{reference.title}</strong>
              <small>{reference.meta}</small>
            </span>
            <span className={`litrev-ref-row__source${reference.source === "web" ? " litrev-ref-row__source--web" : ""}`}>
              {reference.source === "web" ? t("litrev.refs.fromWeb") : t("litrev.refs.local")}
            </span>
          </label>
        ))}
      </div>
    );
  }

  function renderWizardCard(): ReactNode {
    if (phase.kind !== "wizard" || workflowEnded) return null;
    const stepTitles = [t("litrev.wizard.step.keywords"), t("litrev.wizard.step.outline"), t("litrev.wizard.step.references")] as const;
    return (
      <section className="litrev-wizard-card" aria-label={stepTitles[phase.step]}>
        <header className="litrev-wizard-card__head">
          <strong>{stepTitles[phase.step]}</strong>
          <div className="litrev-wizard-card__head-actions">
            {phase.step === 2 ? (
              <details className="litrev-wizard-card__kb-picker">
                <summary title={t("litrev.refs.addToKbHint")}>
                  <span>
                    {referenceTargetKbIds.length
                      ? t("litrev.refs.selectedKbCount", { count: referenceTargetKbIds.length })
                      : t("litrev.refs.addToKb")}
                  </span>
                  <ChevronDown size={12} aria-hidden="true" />
                </summary>
                <div className="litrev-wizard-card__kb-menu" role="menu" aria-label={t("litrev.refs.targetKb")}>
                  <strong>{t("litrev.refs.targetKb")}</strong>
                  {knowledgeBases.map((base) => {
                    const selected = referenceTargetKbIds.includes(base.id);
                    return (
                      <button
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={selected}
                        key={base.id}
                        onClick={() => setReferenceTargetKbIds((ids) => (
                          ids.includes(base.id)
                            ? ids.filter((id) => id !== base.id)
                            : [...ids, base.id]
                        ))}
                      >
                        <span className={`kb-checkbox${selected ? " kb-checkbox--checked" : ""}`}>
                          {selected ? <Check size={11} /> : null}
                        </span>
                        <span>{base.name}</span>
                      </button>
                    );
                  })}
                </div>
              </details>
            ) : null}
            <span className="litrev-wizard-card__count">{phase.step + 1} / 3</span>
            <button
              type="button"
              className="litrev-wizard-card__close"
              aria-label={t("litrev.workflow.close")}
              onClick={cancelWorkflow}
            >
              <X size={15} />
            </button>
          </div>
        </header>
        <div className="litrev-wizard-card__body">
          {phase.step === 0 ? renderKeywordStep() : phase.step === 1 ? renderOutlineStep() : renderReferenceStep()}
        </div>
        <footer className="litrev-wizard-card__foot">
          <i />
          {phase.step === 2 ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => setReferences((items) => items.map((item) => ({ ...item, selected: true })))}>
                {t("litrev.refs.useDefault")}
              </Button>
              <Button variant="primary" size="sm" onClick={confirmReferencesAndStart}>{t("litrev.refs.confirmStart")}</Button>
            </>
          ) : (
            <Button variant="primary" size="sm" onClick={phase.step === 0 ? confirmKeywords : confirmOutline}>
              {phase.step === 0 ? t("litrev.keywords.confirm") : t("litrev.outline.confirm")}
            </Button>
          )}
        </footer>
      </section>
    );
  }

  /* -------------------------------- 任务执行视图 -------------------------------- */

  function todoOutputForIndex(index: number): string {
    if (index === 0) return t("litrev.todo.output.downloaded");
    if (index === 1) return t("litrev.todo.output.read");
    if (index === 2) return t("litrev.todo.output.drafted");
    if (index === 3) return t("litrev.todo.output.references");
    return t("litrev.todo.output.checked");
  }

  function renderTodoList(): ReactNode {
    const total = LITREV_TODO_ITEMS.length;
    return (
      <div className="litrev-todo__list litrev-stage-text-card">
        {LITREV_TODO_ITEMS.map((item, index) => {
          const done = index < todoProgress;
          const current = index === todoProgress && todoProgress < total;
          return (
            <div key={item} className={`litrev-todo__item${done ? " litrev-todo__item--done" : current ? " litrev-todo__item--current" : ""}`}>
              <span className="litrev-todo__status">
                {done ? <Check size={11} /> : current ? <CircleDashed size={11} className="litrev-spin" /> : null}
              </span>
              <strong>{item}</strong>
              {current ? <small>{t("litrev.todo.running")}</small> : null}
            </div>
          );
        })}
      </div>
    );
  }

  function renderTaskOutputMessages(): ReactNode {
    return LITREV_TODO_ITEMS.slice(0, todoProgress).map((item, index) => (
      <p key={`output:${item}`} className="litrev-assistant-copy litrev-task-output-message">
        {todoOutputForIndex(index)}
      </p>
    ));
  }

  function renderTaskProcess(finished: boolean): ReactNode {
    const processContent = (
      <>
        <p className="litrev-assistant-copy">{LITREV_EXECUTION_INTRO}</p>
        {renderStageActivities()}
        {renderTaskOutputMessages()}
      </>
    );
    if (!finished) return processContent;

    const duration = t("litrev.activity.durationSeconds", {
      seconds: Math.round((LITREV_TODO_ITEMS.length * TODO_STEP_MS) / 1000)
    });
    return (
      <div className={`agent-activity-cluster litrev-task-process${processDetailsOpen ? " agent-activity-cluster--open" : ""}`}>
        <button
          type="button"
          className="agent-activity-cluster__toggle litrev-status-toggle"
          aria-expanded={processDetailsOpen}
          onClick={() => setProcessDetailsOpen((open) => !open)}
        >
          <span>{t("agent.activity.workedFor", { duration })}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        {processDetailsOpen ? (
          <div className="agent-activity-cluster__body litrev-task-process__body">
            {processContent}
          </div>
        ) : null}
      </div>
    );
  }

  function renderTaskConversation(): ReactNode {
    const total = LITREV_TODO_ITEMS.length;
    const finished = todoProgress >= total;
    return (
      <div className="litrev-conversation">
        {renderLaunchUserMessage()}
        {renderTaskProcess(finished)}
        {finished ? (
          <>
            <p className="litrev-assistant-copy">{LITREV_RESULT_LINE}</p>
            <div className="litrev-file-cards">
              {[LITREV_OUTLINE_ARTIFACT, LITREV_BODY_ARTIFACT].map((path) => (
                <button
                  type="button"
                  key={path}
                  className="litrev-file-card"
                  draggable
                  onDragStart={(event) => beginFileDrag(event, path, fileNameFromPath(path))}
                  onContextMenu={(event) => openFileContextMenu(event, path, fileNameFromPath(path))}
                  onClick={() => openArtifact(path)}
                >
                  <FileTypeIcon name={path} surface="card" />
                  <span className="litrev-file-card__text">
                    <strong>{path.split("/").pop()}</strong>
                    <small>Markdown</small>
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : null}
        {supplements.map((entry) => (
          <div key={entry.id} className="litrev-supplement">
            <div className="litrev-user-message">
              {entry.text ? <div className="agent-chat-bubble agent-chat-bubble--user litrev-user-bubble">{entry.text}</div> : null}
              <HomeContextChips chips={entry.contexts} />
            </div>
            <p className="litrev-assistant-copy">{LITREV_SUPPLEMENT_ACK}</p>
          </div>
        ))}
      </div>
    );
  }

  /* --------------------------------- 预览面板 --------------------------------- */

  function renderPreviewPane(): ReactNode {
    const activeKb = knowledgeScope === "all"
      ? null
      : knowledgeBases.find((base) => base.id === knowledgeScope) ?? null;
    const kbFiles = libraryFiles
      .filter((file) => !activeKb || activeKb.fileIds.includes(file.id))
      .map((file) => ({ path: file.path, name: file.name }));
    const previewedContent = litrevPreviewContentFor(previewPath);
    const folders: LitrevPreviewFolder[] = ["uploads", "references", "outputs"];
    const fileName = (path: string) => path.split("/").pop() ?? path;
    const scopeForPath = (path: string): PreviewScope => {
      if (taskFiles.some((file) => file.path === path)) return "task";
      if (projectFiles.some((file) => file.path === path)) return "project";
      return "knowledge";
    };
    const selectFirstKnowledgeFile = (scope: string) => {
      const base = scope === "all" ? null : knowledgeBases.find((item) => item.id === scope) ?? null;
      const first = libraryFiles.find((file) => !base || base.fileIds.includes(file.id));
      if (first) selectPreviewFile(first.path);
    };
    const scopeOptions: Array<{ value: PreviewScope; label: string; icon: ReactNode }> = [
      { value: "task", label: t("litrev.preview.taskFiles"), icon: <Files size={14} /> },
      { value: "knowledge", label: t("litrev.preview.knowledge"), icon: <LibraryBig size={14} /> },
      ...(launchProjectId
        ? [{ value: "project" as const, label: t("litrev.preview.projectSpace"), icon: <Folder size={14} /> }]
        : [])
    ];
    const activeScopeOption = scopeOptions.find((option) => option.value === previewScope) ?? scopeOptions[0]!;
    const selectPreviewScope = (value: PreviewScope) => {
      setPreviewScope(value);
      previewScopeMenuRef.current?.removeAttribute("open");
      if (value === "task") {
        const taskPath = taskFiles.some((file) => file.path === previewPath)
          ? previewPath
          : (openPreviewTabs.find((path) => taskFiles.some((file) => file.path === path)) ?? LITREV_OUTLINE_ARTIFACT);
        setPreviewPath(taskPath);
      } else if (value === "knowledge") {
        selectFirstKnowledgeFile(knowledgeScope);
      } else {
        const first = projectFiles[0];
        if (first) selectPreviewFile(first.path);
      }
    };
    const renderKnowledgeFileTree = (
      files: Array<{ path: string; name: string }>,
      parentPath = ""
    ): ReactNode => {
      const prefix = parentPath ? `${parentPath}/` : "";
      const folderNames = new Set<string>();
      const directFiles: Array<{ path: string; name: string }> = [];

      for (const file of files) {
        if (!file.path.startsWith(prefix)) continue;
        const rest = file.path.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) directFiles.push(file);
        else folderNames.add(rest.slice(0, slash));
      }

      return (
        <>
          {[...folderNames].sort((a, b) => a.localeCompare(b, "zh-CN")).map((folderName) => {
            const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName;
            const collapseKey = `knowledge:${folderPath}`;
            const collapsed = collapsedPreviewFolders[collapseKey] === true;
            return (
              <div key={folderPath} className="litrev-file-folder">
                <button
                  type="button"
                  className="litrev-file-folder__toggle"
                  onClick={() => setCollapsedPreviewFolders((state) => ({ ...state, [collapseKey]: !collapsed }))}
                >
                  {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  <strong>{folderName}</strong>
                </button>
                {!collapsed ? (
                  <div className="litrev-file-folder__children">
                    {renderKnowledgeFileTree(files, folderPath)}
                  </div>
                ) : null}
              </div>
            );
          })}
          {directFiles
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
            .map((file) => (
              <button
                type="button"
                key={file.path}
                className={`litrev-file-item${previewPath === file.path ? " litrev-file-item--active" : ""}`}
                draggable
                onDragStart={(event) => beginFileDrag(event, file.path, file.name)}
                onContextMenu={(event) => openFileContextMenu(event, file.path, file.name)}
                onClick={() => selectPreviewFile(file.path)}
              >
                <FileTypeIcon name={file.name} surface="inline" /> <span>{file.name}</span>
              </button>
            ))}
        </>
      );
    };
    const crumbScope = previewScope === "task"
      ? t("litrev.preview.taskFiles")
      : previewScope === "project"
        ? t("litrev.preview.projectSpace")
        : activeKb?.name ?? t("litrev.preview.allFiles");
    return (
      <aside className="litrev-preview-pane litrev-preview-pane--lifted" style={previewResize.sidebarStyle}>
        <header className="litrev-preview-toolbar">
          <button
            type="button"
            className="litrev-file-browser__toggle"
            aria-label={t("litrev.preview.toggleFiles")}
            aria-expanded={fileTreeOpen}
            onClick={() => setFileTreeOpen((open) => !open)}
          >
            {fileTreeOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
          <div className="litrev-file-tabs" role="tablist" aria-label={t("litrev.preview.openFiles")}>
            {openPreviewTabs.map((path) => {
              const active = previewPath === path;
              return (
                <div key={path} className={`litrev-file-tab${active ? " litrev-file-tab--active" : ""}`} role="presentation">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    title={path}
                    onClick={() => {
                      const nextScope = scopeForPath(path);
                      setPreviewScope(nextScope);
                      if (nextScope === "knowledge") setKnowledgeScope("all");
                      setPreviewPath(path);
                    }}
                  >
                    {fileName(path)}
                  </button>
                  {openPreviewTabs.length > 1 ? (
                    <button
                      type="button"
                      className="litrev-file-tab__close"
                      aria-label={t("common.close")}
                      onClick={(event) => {
                        event.stopPropagation();
                        closePreviewTab(path);
                      }}
                    >
                      <X size={11} />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </header>
        <div className="litrev-preview-body">
          <aside
            className={`litrev-file-browser${fileTreeOpen ? "" : " litrev-file-browser--collapsed"}`}
            style={fileBrowserResize.sidebarStyle}
          >
            {fileTreeOpen ? (
              <>
                <div className="litrev-preview-scope-switcher">
                  <details ref={previewScopeMenuRef} className="litrev-preview-scope-menu">
                    <summary aria-label={t("litrev.preview.scope")}>
                      <span className="litrev-preview-scope-menu__icon" aria-hidden="true">{activeScopeOption.icon}</span>
                      <strong>{activeScopeOption.label}</strong>
                      <ChevronDown size={12} aria-hidden="true" />
                    </summary>
                    <div className="litrev-preview-scope-menu__popover" role="menu">
                      {scopeOptions.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={previewScope === option.value}
                          className={previewScope === option.value ? "litrev-preview-scope-menu__option litrev-preview-scope-menu__option--active" : "litrev-preview-scope-menu__option"}
                          onClick={() => selectPreviewScope(option.value)}
                        >
                          <span aria-hidden="true">{option.icon}</span>
                          <span>{option.label}</span>
                          {previewScope === option.value ? <Check size={14} aria-hidden="true" /> : null}
                        </button>
                      ))}
                    </div>
                  </details>
                </div>
                {previewScope === "knowledge" ? (
                  <div className="litrev-preview-scope">
                    <details className="litrev-preview-scope-menu litrev-preview-scope-menu--knowledge">
                      <summary aria-label={t("litrev.preview.knowledgeScope")}>
                        <strong>{activeKb?.name ?? t("litrev.preview.allFiles")}</strong>
                        <ChevronDown size={12} aria-hidden="true" />
                      </summary>
                      <div className="litrev-preview-scope-menu__popover" role="menu">
                        {[{ id: "all", name: t("litrev.preview.allFiles") }, ...knowledgeBases].map((base) => (
                          <button
                            key={base.id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={knowledgeScope === base.id}
                            className={knowledgeScope === base.id ? "litrev-preview-scope-menu__option litrev-preview-scope-menu__option--active" : "litrev-preview-scope-menu__option"}
                            onClick={(event) => {
                              setKnowledgeScope(base.id);
                              selectFirstKnowledgeFile(base.id);
                              event.currentTarget.closest("details")?.removeAttribute("open");
                            }}
                          >
                            <span>{base.name}</span>
                            {knowledgeScope === base.id ? <Check size={14} aria-hidden="true" /> : null}
                          </button>
                        ))}
                      </div>
                    </details>
                  </div>
                ) : null}
                <nav className="litrev-file-list">
                  {previewScope === "task" ? folders.map((folder) => {
                    const children = taskFiles.filter((file) => file.folder === folder);
                    const collapsed = collapsedPreviewFolders[folder] === true;
                    return (
                      <div key={folder} className="litrev-file-folder">
                        <button
                          type="button"
                          className="litrev-file-folder__toggle"
                          onClick={() => setCollapsedPreviewFolders((state) => ({ ...state, [folder]: !collapsed }))}
                        >
                          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                          <strong>{folder}</strong>
                        </button>
                        {!collapsed ? (
                          <div className="litrev-file-folder__children">
                            {children.map((file) => (
                              <button
                                type="button"
                                key={file.path}
                                className={`litrev-file-item${previewPath === file.path ? " litrev-file-item--active" : ""}`}
                                draggable
                                onDragStart={(event) => beginFileDrag(event, file.path, file.name)}
                                onContextMenu={(event) => openFileContextMenu(event, file.path, file.name)}
                                onClick={() => selectPreviewFile(file.path)}
                              >
                                <FileTypeIcon name={file.name} surface="inline" /> <span>{file.name}</span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  }) : previewScope === "knowledge" ? (
                    renderKnowledgeFileTree(kbFiles)
                  ) : (
                    projectFiles.map((file) => (
                      <button
                        type="button"
                        key={file.path}
                        className={`litrev-file-item${previewPath === file.path ? " litrev-file-item--active" : ""}`}
                        draggable
                        onDragStart={(event) => beginFileDrag(event, file.path, file.name)}
                        onContextMenu={(event) => openFileContextMenu(event, file.path, file.name)}
                        onClick={() => selectPreviewFile(file.path)}
                      >
                        <FileTypeIcon name={file.name} surface="inline" /> <span>{file.name}</span>
                      </button>
                    ))
                  )}
                </nav>
              </>
            ) : null}
          </aside>
          {fileTreeOpen ? (
            <SidebarResizeHandle
              label={t("litrev.preview.resizeFiles")}
              width={fileBrowserResize.width}
              minWidth={fileBrowserResize.minWidth}
              maxWidth={fileBrowserResize.maxWidth}
              isResizing={fileBrowserResize.isResizing}
              onResizeStart={fileBrowserResize.beginResize}
              onResizeBy={fileBrowserResize.resizeBy}
            />
          ) : null}
          <section className="litrev-preview-main">
            <article className="litrev-preview-document">
              <div className="litrev-preview-crumb">
                {crumbScope} › {fileName(previewPath)}
              </div>
              <h2>{previewedContent.title}</h2>
              {previewedContent.sections.map((section) => (
                <section key={section.heading}>
                  <h3>{section.heading}</h3>
                  <p>{section.body}</p>
                </section>
              ))}
            </article>
          </section>
        </div>
      </aside>
    );
  }

  /* ---------------------------------- 组合 ---------------------------------- */

  function renderComposer(placeholderKey: "litrev.composer.setup" | "litrev.composer.task"): ReactNode {
    const canSend = Boolean(composerDraft.trim() || composerReferences.length);
    return (
      <div
        className="litrev-composer"
        onDragOver={handleComposerDragOver}
        onDrop={handleComposerDrop}
      >
        {composerReferences.length ? (
          <div className="composer-context-attachments">
            <HomeContextChips chips={composerReferences} onRemove={removeComposerReference} />
          </div>
        ) : null}
        <textarea
          ref={composerInputRef}
          rows={3}
          value={composerDraft}
          placeholder={t(placeholderKey)}
          onChange={(event) => setComposerDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submitSupplement();
            }
          }}
        />
        <ComposerQuickActionButtons
          onAttach={() => composerFileInputRef.current?.click()}
          onInsertMention={() => setReferencePickerOpen((open) => !open)}
          onInsertSlash={insertComposerSlash}
          referenceMenu={referencePickerOpen ? (
            <ComposerReferencePanel
              open
              onClose={() => setReferencePickerOpen(false)}
              onPickKnowledgeBase={pickComposerKnowledgeBase}
              onPickReference={pickComposerReference}
            />
          ) : null}
        />
        <input
          ref={composerFileInputRef}
          type="file"
          hidden
          multiple
          onChange={handleComposerFilesPicked}
        />
        <div className="litrev-composer__actions">
          <button
            type="button"
            className={`litrev-composer__voice${asrRecorder.isRecording ? " litrev-composer__voice--active" : ""}`}
            aria-label={t("home.voiceInput")}
            title={t("home.voiceInput")}
            disabled={asrRecorder.isTranscribing || asrRecorder.isStarting}
            onClick={() => void toggleComposerVoiceInput()}
          >
            {asrRecorder.isRecording ? <Pause size={15} /> : <Mic size={15} />}
          </button>
          <button
            type="button"
            className={`litrev-composer__send${canSend ? " litrev-composer__send--ready" : ""}`}
            aria-label={t("home.send")}
            disabled={!canSend}
            onClick={submitSupplement}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    );
  }

  function renderWorkspaceToggle(): ReactNode {
    return (
      <button
        type="button"
        className={`litrev-workspace-toggle${workspaceOpen ? " litrev-workspace-toggle--active" : ""}`}
        aria-label={t("litrev.workspace.toggle")}
        title={t("litrev.workspace.toggle")}
        aria-pressed={workspaceOpen}
        onClick={() => setWorkspaceOpen((value) => !value)}
      >
        <PanelRight size={15} />
      </button>
    );
  }

  const isTask = phase.kind === "task";
  const pageTitle = isTask ? t("litrev.title.execution") : t("litrev.title.setup");

  return (
    <AppFrame
      title={t("nav.literatureReview")}
      /* Chat + file pane share one full-height row; skip AppFrame topbar. */
      reserveTopBar={false}
    >
      {!isTask ? (
        <section className="litrev-split">
          {renderWorkspaceToggle()}
          <div className={`litrev-chat-pane${workspaceOpen ? " litrev-chat-pane--with-side" : ""}`}>
            <header className="litrev-chat-pane__topbar">
              <h1 className="agent-conversation-title">{pageTitle}</h1>
            </header>
            <div ref={scrollRef} className="litrev-scroll">
              {renderConversation()}
            </div>
            <div className="litrev-dock">
              {phase.kind === "setup" ? renderQuestionCard() : null}
              {phase.kind === "wizard" ? renderWizardCard() : null}
              {renderComposer("litrev.composer.setup")}
            </div>
          </div>
          {workspaceOpen ? (
            <>
              <SidebarResizeHandle
                label={t("litrev.workspace.resize")}
                width={previewResize.width}
                minWidth={previewResize.minWidth}
                maxWidth={previewResize.maxWidth}
                isResizing={previewResize.isResizing}
                onResizeStart={previewResize.beginResize}
                onResizeBy={previewResize.resizeBy}
              />
              {renderPreviewPane()}
            </>
          ) : null}
        </section>
      ) : (
        <section className="litrev-split">
          {renderWorkspaceToggle()}
          <div className={`litrev-chat-pane${workspaceOpen ? " litrev-chat-pane--with-side" : ""}`}>
            <header className="litrev-chat-pane__topbar">
              <h1 className="agent-conversation-title">{pageTitle}</h1>
            </header>
            <div ref={scrollRef} className="litrev-scroll">
              {renderTaskConversation()}
            </div>
            <div className="litrev-dock">
              {renderComposer("litrev.composer.task")}
            </div>
          </div>
          {workspaceOpen ? (
            <>
              <SidebarResizeHandle
                label={t("litrev.workspace.resize")}
                width={previewResize.width}
                minWidth={previewResize.minWidth}
                maxWidth={previewResize.maxWidth}
                isResizing={previewResize.isResizing}
                onResizeStart={previewResize.beginResize}
                onResizeBy={previewResize.resizeBy}
              />
              {renderPreviewPane()}
            </>
          ) : null}
        </section>
      )}
      {fileContextMenu ? (
        <div
          className="composer-file-context-menu"
          role="menu"
          style={{ left: fileContextMenu.x, top: fileContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              addComposerReferences([fileContextMenu.reference]);
              setFileContextMenu(null);
            }}
          >
            {t("composer.addToChat")}
          </button>
        </div>
      ) : null}
    </AppFrame>
  );
}
