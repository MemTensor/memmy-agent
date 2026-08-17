/**
 * Literature review agent workflow (design-complete mock).
 *
 * Implements the interaction prototype end to end: requirement clarification
 * cards -> keyword / outline / reference wizard cards with agent thinking and
 * search progress in between -> autonomous to-do execution with the file
 * preview workspace on the right. All content comes from
 * `literature-review-demo-data.ts`; no backend calls are made.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Folder,
  GripVertical,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Pencil,
  Plus,
  Send,
  Trash2,
  X
} from "lucide-react";
import { FileTypeIcon, FolderTypeIcon } from "../components/file-type-icon.js";
import { useApiClients } from "../app/providers.js";
import { AppFrame } from "./app-frame.js";
import { AgentAttachmentCard } from "./agent-file-attachment-chip.js";
import { SidebarResizeHandle, useResizableSidebar } from "./sidebar-resize.js";
import { Button } from "../components/button.js";
import { useTranslation } from "../i18n/use-translation.js";
import {
  composerFolderReferenceFromFiles,
  dataTransferHasComposerReference,
  mergeComposerContextReferences,
  readComposerReferenceDrag,
  writeComposerReferenceDrag
} from "../lib/composer-file-reference.js";
import {
  LITERATURE_SOURCE_ACCEPT,
  assessLiteratureSourceBatch,
  formatLiteratureSourceSize,
  isSupportedLiteratureSourceName
} from "../lib/literature-source-files.js";
import { agentActions } from "../state/app-actions.js";
import { agentChatScopeKey, type ComposerContextReference } from "../state/agent-composer-state.js";
import { useAppState } from "../state/app-state.js";
import { ComposerQuickActionButtons, HomeContextChips } from "./home-composer-quick-actions.js";
import { mergeVoiceTranscript, useAsrRecorder } from "./asr-recorder.js";
import { Mic, Pause } from "./memory/memory-prototype-icons.js";
import {
  LITREV_ASSISTANT_INTRO,
  LITREV_CONTEXT_STORAGE_KEY,
  LITREV_DEFAULT_PROMPT,
  LITREV_DOCX_ARTIFACT,
  LITREV_EXECUTION_PHASE,
  LITREV_EXECUTION_INTRO,
  LITREV_LATEX_ARTIFACT,
  LITREV_OUTLINE_PHASE,
  LITREV_PDF_ARTIFACT,
  LITREV_PLANNING_PHASE,
  LITREV_PROJECT_CONTEXT_STORAGE_KEY,
  LITREV_PROMPT_STORAGE_KEY,
  LITREV_SOURCE_INPUT_STORAGE_KEY,
  LITREV_RESULT_LINE,
  LITREV_SEARCH_PHASE,
  LITREV_MESSAGE_ACK,
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
type LitrevStageKind = "questions" | "sources" | "keywords" | "outline" | "references" | "tasks";
type QuestionCardStatus = "preparing" | "waiting";

type LitrevPhase =
  | { kind: "setup" }
  | { kind: "sources" }
  | { kind: "thinking"; thinking: ThinkingKind; stage: number }
  | { kind: "wizard"; step: 0 | 1 | 2 }
  | { kind: "task" };

interface LiteratureSourceItem {
  reference: ComposerContextReference;
  fileCount: number | null;
  totalBytes: number;
}

type SourceUploadNotice = { kind: "unsupported"; count: number };

function stageKindForPhase(phase: LitrevPhase): LitrevStageKind {
  if (phase.kind === "setup") return "questions";
  if (phase.kind === "sources") return "sources";
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

interface ConversationEntry {
  id: number;
  text: string;
  contexts: ComposerContextReference[];
  skippedStage?: Exclude<LitrevStageKind, "tasks">;
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
      && item.kind === "path"
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
    return initial.kind === "setup" ? 0 : Number.MAX_SAFE_INTEGER;
  });
  const [todoProgress, setTodoProgress] = useState(() => (
    readInitialPhase().kind === "task" ? 3 : 0
  ));
  const [pendingAnswers, setPendingAnswers] = useState<string[]>(() => (
    questions.map((question) => question.options[0] ?? "")
  ));
  const [questionSupplements, setQuestionSupplements] = useState<Record<number, string>>({});
  const [questionCardStatus, setQuestionCardStatus] = useState<QuestionCardStatus>("preparing");
  const [skippedStages, setSkippedStages] = useState<LitrevStageKind[]>([]);
  const [reachedStages, setReachedStages] = useState<LitrevStageKind[]>(() => [stageKindForPhase(readInitialPhase())]);
  const [preparationDetailsOpen, setPreparationDetailsOpen] = useState(false);
  const [processDetailsOpen, setProcessDetailsOpen] = useState(false);
  const [stageDetailsOpen, setStageDetailsOpen] = useState<Record<LitrevStageKind, boolean>>(() => {
    const current = stageKindForPhase(readInitialPhase());
    return {
      questions: current === "questions",
      sources: current === "sources",
      keywords: current === "keywords",
      outline: current === "outline",
      references: current === "references",
      tasks: current === "tasks"
    };
  });
  const [answers, setAnswers] = useState<Array<{ question: string; answer: string }>>([]);
  const [sourceItems, setSourceItems] = useState<LiteratureSourceItem[]>(() => (
    launchContexts
      .filter((context) => context.label.endsWith("/") || isSupportedLiteratureSourceName(context.label))
      .map((context) => ({
        reference: { kind: "path", id: context.id, label: context.label },
        fileCount: context.fileCount ?? (context.label.endsWith("/") ? null : 1),
        totalBytes: context.totalBytes ?? 0
      }))
  ));
  const [sourceUploadNotice, setSourceUploadNotice] = useState<SourceUploadNotice | null>(null);
  const sourceReferences = useMemo(() => sourceItems.map((item) => item.reference), [sourceItems]);
  const sourceTotals = useMemo(() => ({
    fileCount: sourceItems.reduce((count, item) => count + (item.fileCount ?? 0), 0),
    complete: sourceItems.every((item) => item.fileCount != null)
  }), [sourceItems]);
  const [keywords, setKeywords] = useState<LitrevKeyword[]>(buildDemoKeywords);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [keywordDraftWeight, setKeywordDraftWeight] = useState(6);
  const [outline, setOutline] = useState<LitrevOutlineItem[]>(buildDemoOutline);
  const [references, setReferences] = useState<LitrevReference[]>(buildDemoReferences);
  const [conversationEntries, setConversationEntries] = useState<ConversationEntry[]>([]);
  const [composerDraft, setComposerDraft] = useState("");
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
  const composerFolderInputRef = useRef<HTMLInputElement | null>(null);
  const sourceFileInputRef = useRef<HTMLInputElement | null>(null);
  const sourceFolderInputRef = useRef<HTMLInputElement | null>(null);
  const composerScopeKey = agentChatScopeKey(appState.agent.currentChatId, appState.agent.newChatRequestId);
  const composerReferences = appState.agent.composerContextReferencesByScope[composerScopeKey] ?? [];
  const [fileContextMenu, setFileContextMenu] = useState<{
    reference: ComposerContextReference;
    x: number;
    y: number;
  } | null>(null);
  const taskFiles = useMemo(() => buildDemoTaskFiles(), []);
  const projectSourceFiles = useMemo(() => (
    buildHomeReferenceItems().filter((file) => file.kind === "file").map((file) => ({
      path: `project/${file.path}`,
      name: file.path
    }))
  ), []);
  const generatedFiles = phase.kind === "task" ? taskFiles : [];
  const projectFiles = useMemo(() => (
    launchProjectId
      ? [
        ...projectSourceFiles,
        ...generatedFiles.map((file) => ({
          path: `project/${file.path}`,
          name: file.name,
          folder: file.folder
        }))
      ]
      : []
  ), [generatedFiles, launchProjectId, projectSourceFiles]);
  const workspaceFiles = launchProjectId ? projectFiles : generatedFiles;
  const initialPreviewPath = workspaceFiles[0]?.path ?? null;
  const [previewPath, setPreviewPath] = useState<string | null>(initialPreviewPath);
  const [openPreviewTabs, setOpenPreviewTabs] = useState<string[]>(initialPreviewPath ? [initialPreviewPath] : []);
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const [collapsedPreviewFolders, setCollapsedPreviewFolders] = useState<Record<string, boolean>>({});
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const dragOutlineState = useRef<{ index: number; startX: number; level: 0 | 1 } | null>(null);
  const dragOutlinePointerStartX = useRef<number | null>(null);
  const [outlineDropTarget, setOutlineDropTarget] = useState<{ index: number; level: 0 | 1 } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
    if (phase.kind !== "setup" || setupDone) return;
    setQuestionCardStatus("preparing");
    const timer = window.setTimeout(() => setQuestionCardStatus("waiting"), 450);
    return () => window.clearTimeout(timer);
  }, [phase.kind, setupDone]);

  useEffect(() => {
    if (setupDone && phase.kind === "setup") {
      setPhase({ kind: "sources" });
    }
  }, [setupDone, phase.kind]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [phase, questionCardStatus, conversationEntries, todoProgress]);

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

  function confirmSources() {
    setPhase({ kind: "thinking", thinking: "planning", stage: 0 });
  }

  function addSourceItems(items: LiteratureSourceItem[]) {
    setSourceItems((current) => {
      const next = [...current];
      for (const item of items) {
        if (!next.some((existing) => (
          existing.reference.kind === item.reference.kind
          && existing.reference.id === item.reference.id
        ))) {
          next.push(item);
        }
      }
      return next;
    });
  }

  function removeSourceReference(reference: ComposerContextReference) {
    setSourceItems((current) => current.filter((item) => (
      item.reference.kind !== reference.kind || item.reference.id !== reference.id
    )));
    setSourceUploadNotice(null);
  }

  function updateQuestionAnswer(index: number, answer: string) {
    setPendingAnswers((items) => items.map((item, itemIndex) => (
      itemIndex === index ? answer : item
    )));
  }

  function skipCurrentCard() {
    const skippedStage = stageKindForPhase(phase);
    setSkippedStages((stages) => (stages.includes(skippedStage) ? stages : [...stages, skippedStage]));
    if (phase.kind === "setup") {
      setAnswers([]);
      setQuestionSupplements({});
      setQuestionIndex(questions.length);
      return;
    }
    if (phase.kind === "sources") {
      confirmSources();
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

  function referencesFromFiles(files: File[]): ComposerContextReference[] {
    return files.map((file) => {
      let path = file.name;
      try {
        path = window.memmy?.getPathForFile(file) || file.name;
      } catch {
        path = file.name;
      }
      return fileReference(path, file.name);
    });
  }

  function folderReferenceFromFiles(files: File[]): ComposerContextReference | null {
    return composerFolderReferenceFromFiles(files, (file) => {
      try {
        return window.memmy?.getPathForFile(file) || file.name;
      } catch {
        return file.name;
      }
    });
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
    const references = referencesFromFiles(Array.from(event.target.files ?? []));
    if (references.length) addComposerReferences(references);
    event.target.value = "";
    composerInputRef.current?.focus();
  }

  function handleComposerFolderPicked(event: ChangeEvent<HTMLInputElement>) {
    const reference = folderReferenceFromFiles(Array.from(event.target.files ?? []));
    if (reference) addComposerReferences([reference]);
    event.target.value = "";
    composerInputRef.current?.focus();
  }

  function handleSourceFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    const existingIds = new Set(sourceReferences.map((reference) => reference.id));
    const candidates = Array.from(event.target.files ?? []).filter((file) => (
      !existingIds.has(referencesFromFiles([file])[0]?.id ?? file.name)
    ));
    const assessment = assessLiteratureSourceBatch(candidates);
    addSourceItems(assessment.accepted.map((file) => ({
      reference: referencesFromFiles([file])[0] ?? fileReference(file.name, file.name),
      fileCount: 1,
      totalBytes: file.size
    })));
    setSourceUploadNotice(
      assessment.unsupportedCount
        ? { kind: "unsupported", count: assessment.unsupportedCount }
        : null
    );
    event.target.value = "";
  }

  function handleSourceFolderPicked(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    const reference = folderReferenceFromFiles(files);
    const alreadyAdded = reference && sourceReferences.some((item) => item.id === reference.id);
    if (reference && !alreadyAdded) {
      const assessment = assessLiteratureSourceBatch(files);
      if (assessment.accepted.length) {
        addSourceItems([{
          reference,
          fileCount: assessment.accepted.length,
          totalBytes: assessment.accepted.reduce((total, file) => total + file.size, 0)
        }]);
        setSourceUploadNotice(
          assessment.unsupportedCount
            ? { kind: "unsupported", count: assessment.unsupportedCount }
            : null
        );
      } else if (assessment.unsupportedCount) {
        setSourceUploadNotice({ kind: "unsupported", count: assessment.unsupportedCount });
      }
    }
    event.target.value = "";
  }

  function insertComposerSlash() {
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

  function submitConversationMessage() {
    const text = composerDraft.trim();
    if (!text && !composerReferences.length) return;
    const skippedStage: Exclude<LitrevStageKind, "tasks"> | undefined = (
      phase.kind === "sources"
      || phase.kind === "wizard"
      || (phase.kind === "setup" && questionCardStatus === "waiting")
    )
      ? stageKindForPhase(phase) as Exclude<LitrevStageKind, "tasks">
      : undefined;
    setConversationEntries((items) => [...items, {
      id: Date.now(),
      text,
      contexts: composerReferences,
      skippedStage
    }]);
    setComposerDraft("");
    dispatch(agentActions.composerContextReferencesUpdated(composerScopeKey, []));
    if (skippedStage) skipCurrentCard();
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
      const next = tabs.filter((tab) => tab !== path);
      if (previewPath === path) {
        setPreviewPath(next[next.length - 1] ?? null);
      }
      return next;
    });
  }

  function openArtifact(path: string) {
    selectPreviewFile(launchProjectId ? `project/${path}` : path);
    setWorkspaceOpen(true);
  }

  /* --------------------------------- 会话渲染 --------------------------------- */

  function renderThinkingCopy(): ReactNode {
    if (phase.kind !== "thinking") return null;
    return <p className="litrev-stage-thinking-copy">{thinkingPhaseData(phase.thinking).title}</p>;
  }

  function completedStageLabel(stage: LitrevStageKind): string {
    if (skippedStages.includes(stage)) {
      return t("litrev.stageActivity.skipped", { stage: stageDisplayName(stage) });
    }
    if (stage === "questions") return t("litrev.stageActivity.questions.done");
    if (stage === "sources") return t("litrev.stageActivity.sources.done");
    if (stage === "keywords") return t("litrev.stageActivity.keywords.done");
    if (stage === "outline") return t("litrev.stageActivity.outline.done");
    if (stage === "references") return t("litrev.stageActivity.references.done");
    return t("litrev.stageActivity.tasks.done");
  }

  function stageDisplayName(stage: LitrevStageKind): string {
    if (stage === "questions") return t("litrev.question.cardTitle");
    if (stage === "sources") return t("litrev.sources.title");
    if (stage === "keywords") return t("litrev.wizard.step.keywords");
    if (stage === "outline") return t("litrev.wizard.step.outline");
    if (stage === "references") return t("litrev.wizard.step.references");
    return t("litrev.preview.files");
  }

  function renderCancelledStageNotice(stage: Exclude<LitrevStageKind, "tasks">): ReactNode {
    const title = t("litrev.workflow.skippedTitle", { stage: stageDisplayName(stage) });
    return <p className="litrev-cancelled-stage-notice">{title}</p>;
  }

  function stageOutputFor(stage: Exclude<LitrevStageKind, "tasks">): string {
    if (stage === "questions") return t("litrev.stageOutput.questions");
    if (stage === "sources") return t("litrev.stageOutput.sources");
    if (stage === "keywords") return t("litrev.stageOutput.keywords");
    if (stage === "outline") return t("litrev.stageOutput.outline");
    return t("litrev.stageOutput.references");
  }

  function renderStageOutput(stage: Exclude<LitrevStageKind, "tasks">): ReactNode {
    return <p className="litrev-assistant-copy litrev-stage-output-message">{stageOutputFor(stage)}</p>;
  }

  function currentStageLabel(stage: LitrevStageKind): string {
    if (stage === "questions") {
      return questionCardStatus === "preparing"
        ? t("litrev.stageActivity.questions.generating")
        : t("litrev.stageActivity.questions.waiting");
    }
    if (stage === "sources") return t("litrev.stageActivity.sources.waiting");
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
    if (skippedStages.includes(stage) && stage !== "tasks") return renderCancelledStageNotice(stage);
    if (stage === "questions") return renderRequirementSummary();
    if (stage === "sources") {
      return sourceItems.length
        ? renderSourceList(false)
        : <p className="litrev-stage-empty">{t("litrev.sources.none")}</p>;
    }
    if (stage === "keywords") {
      return (
        <div className="litrev-stage-text-card">
          {keywords.filter((keyword) => keyword.selected).map((keyword) => (
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
    if (phase.kind === "thinking") return renderThinkingCopy();
    if (stage === "questions" || stage === "sources") return null;
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
              if (skippedStages.includes(stage)) {
                const entry = conversationEntries.find((item) => item.skippedStage === stage);
                return (
                  <Fragment key={stage}>
                    {renderCancelledStageNotice(stage)}
                    {entry ? renderConversationEntry(entry) : null}
                  </Fragment>
                );
              }
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
    return reachedStages.map((stage) => {
      if (skippedStages.includes(stage) && stage !== activeStage && stage !== "tasks") {
        const entry = conversationEntries.find((item) => item.skippedStage === stage);
        return (
          <Fragment key={stage}>
            {renderCancelledStageNotice(stage)}
            {entry ? renderConversationEntry(entry) : null}
          </Fragment>
        );
      }
      return (
        <Fragment key={stage}>
          {renderStageActivity(stage)}
          {stage !== activeStage && stage !== "tasks" ? renderStageOutput(stage) : null}
        </Fragment>
      );
    });
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
            {launchContexts.map((reference) => (
              <AgentAttachmentCard
                key={`${reference.kind}:${reference.id}`}
                kind="file"
                name={reference.label}
                subline={reference.label.endsWith("/") ? t("home.quick.kind.folder") : t("home.quick.kind.file")}
                align="right"
                leading={reference.label.endsWith("/")
                  ? <FolderTypeIcon surface="card" />
                  : <FileTypeIcon name={reference.id} surface="card" />}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  function renderConversationEntry(entry: ConversationEntry): ReactNode {
    return (
      <div key={entry.id} className="litrev-supplement">
        <div className="litrev-user-message">
          {entry.text ? <div className="agent-chat-bubble agent-chat-bubble--user litrev-user-bubble">{entry.text}</div> : null}
          <HomeContextChips chips={entry.contexts} />
        </div>
        <p className="litrev-assistant-copy">{LITREV_MESSAGE_ACK}</p>
      </div>
    );
  }

  function renderConversation(): ReactNode {
    return (
      <div className="litrev-conversation">
        {renderLaunchUserMessage()}
        <p className="litrev-assistant-copy">{LITREV_ASSISTANT_INTRO}</p>
        {conversationEntries.filter((entry) => !entry.skippedStage).map(renderConversationEntry)}
        {renderStageActivities()}
      </div>
    );
  }

  /* --------------------------------- 问答卡片 --------------------------------- */

  function renderQuestionCard(): ReactNode {
    if (
      phase.kind !== "setup"
      || questionCardStatus !== "waiting"
    ) return null;
    return (
      <section className="litrev-question-card" aria-label={t("litrev.question.cardTitle")}>
        <header className="litrev-question-card__head">
          <h2>{t("litrev.question.cardTitle")}</h2>
          <div className="litrev-question-card__meta">
            <span>{t("litrev.question.count", { count: questions.length })}</span>
            <button type="button" aria-label={t("litrev.workflow.close")} onClick={skipCurrentCard}>
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

  function renderSourceCard(): ReactNode {
    if (phase.kind !== "sources") return null;
    return (
      <section className="litrev-wizard-card litrev-source-card" aria-label={t("litrev.sources.title")}>
        <header className="litrev-wizard-card__head">
          <strong>{t("litrev.sources.title")}</strong>
          <div className="litrev-wizard-card__head-actions">
            {sourceItems.length && sourceTotals.complete ? (
              <span className="litrev-wizard-card__count">
                {t("litrev.sources.count", {
                  count: sourceTotals.fileCount
                })}
              </span>
            ) : null}
            <button
              type="button"
              className="litrev-wizard-card__close"
              aria-label={t("litrev.workflow.close")}
              onClick={skipCurrentCard}
            >
              <X size={15} />
            </button>
          </div>
        </header>
        <div className="litrev-wizard-card__body litrev-source-card__body">
          {sourceItems.length ? (
            <p className="litrev-section-hint">{t("litrev.sources.existingHint")}</p>
          ) : null}
          <p className="litrev-source-card__policy">
            {t("litrev.sources.policy")}
          </p>
          {sourceItems.length ? (
            renderSourceList(true)
          ) : (
            <div className="litrev-source-card__empty">{t("litrev.sources.empty")}</div>
          )}
          {sourceUploadNotice ? (
            <p className="litrev-source-card__notice" role="alert">
              {t("litrev.sources.unsupported", { count: sourceUploadNotice.count })}
            </p>
          ) : null}
          <div className="litrev-source-card__actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => sourceFileInputRef.current?.click()}>
              <Plus size={12} /> {t("litrev.sources.addFiles")}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => sourceFolderInputRef.current?.click()}>
              <Folder size={13} /> {t("litrev.sources.addFolder")}
            </Button>
          </div>
          <input
            ref={sourceFileInputRef}
            type="file"
            hidden
            multiple
            accept={LITERATURE_SOURCE_ACCEPT}
            onChange={handleSourceFilesPicked}
          />
          <input
            ref={(node) => {
              sourceFolderInputRef.current = node;
              node?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            hidden
            multiple
            accept={LITERATURE_SOURCE_ACCEPT}
            onChange={handleSourceFolderPicked}
          />
        </div>
        <footer className="litrev-wizard-card__foot">
          <i />
          <Button type="button" variant="primary" size="sm" onClick={confirmSources}>
            {t(sourceItems.length ? "litrev.sources.confirm" : "litrev.sources.skip")}
          </Button>
        </footer>
      </section>
    );
  }

  function renderSourceList(removable: boolean): ReactNode {
    return (
      <div className="litrev-source-list">
        {sourceItems.map((item) => {
          const { reference } = item;
          const folder = reference.label.endsWith("/");
          return (
            <div className="litrev-source-list__row" key={`${reference.kind}:${reference.id}`}>
              {folder
                ? <FolderTypeIcon surface="row" />
                : <FileTypeIcon name={reference.label} filePath={reference.id} surface="row" />}
              <span className="litrev-source-list__name" title={reference.id}>{reference.label}</span>
              <small>
                {folder
                  ? item.fileCount == null
                    ? t("litrev.sources.folderSelected")
                    : t("litrev.sources.folderMeta", {
                      count: item.fileCount,
                      size: formatLiteratureSourceSize(item.totalBytes)
                    })
                  : formatLiteratureSourceSize(item.totalBytes)}
              </small>
              {removable ? (
                <button
                  type="button"
                  aria-label={`${t("common.remove")}: ${reference.label}`}
                  onClick={() => removeSourceReference(reference)}
                >
                  <X size={13} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  /* --------------------------------- 向导卡片 --------------------------------- */

  function renderKeywordStep(): ReactNode {
    const allKeywordsSelected = keywords.length > 0 && keywords.every((keyword) => keyword.selected);
    const selectedKeywordCount = keywords.filter((keyword) => keyword.selected).length;
    return (
      <>
        <p className="litrev-section-hint">{t("litrev.keywords.hint")}</p>
        <label className="litrev-keyword-select-all">
          <input
            type="checkbox"
            checked={allKeywordsSelected}
            onChange={(event) => setKeywords((items) => items.map((item) => ({ ...item, selected: event.target.checked })))}
          />
          <span className={`litrev-checkbox${allKeywordsSelected ? " litrev-checkbox--checked" : ""}`}>
            {allKeywordsSelected ? <Check size={11} /> : null}
          </span>
          <strong>{t("litrev.keywords.selectAll")}</strong>
          <small>{selectedKeywordCount} / {keywords.length}</small>
        </label>
        <div className="litrev-keyword-rows">
          {keywords.map((keyword, index) => (
            <div className={`litrev-keyword-row${keyword.selected ? "" : " litrev-keyword-row--unselected"}`} key={keyword.id}>
              <label className="litrev-keyword-row__select">
                <input
                  type="checkbox"
                  checked={keyword.selected}
                  aria-label={`${t("litrev.keywords.itemLabel")}: ${keyword.text}`}
                  onChange={(event) => setKeywords((items) => items.map((item, itemIndex) => (
                    itemIndex === index ? { ...item, selected: event.target.checked } : item
                  )))}
                />
                <span className={`litrev-checkbox${keyword.selected ? " litrev-checkbox--checked" : ""}`}>
                  {keyword.selected ? <Check size={11} /> : null}
                </span>
              </label>
              <input
                type="text"
                value={keyword.text}
                maxLength={100}
                aria-label={t("litrev.keywords.itemLabel")}
                onChange={(event) => setKeywords((items) => items.map((item, itemIndex) => (itemIndex === index ? { ...item, text: event.target.value } : item)))}
              />
              <span className="litrev-keyword-row__divider" />
              <label className="litrev-keyword-row__weight">
                <span>{t("litrev.keywords.weight")}</span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={keyword.weight}
                  style={{ "--litrev-weight-progress": `${((keyword.weight - 1) / 9) * 100}%` } as CSSProperties}
                  aria-label={`${t("litrev.keywords.weight")}: ${keyword.text}`}
                  onChange={(event) => setKeywords((items) => items.map((item, itemIndex) => (itemIndex === index ? { ...item, weight: Number(event.target.value) } : item)))}
                />
                <output>{keyword.weight}</output>
              </label>
            </div>
          ))}
        </div>
        <form
          className="litrev-keyword-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            const text = keywordDraft.trim();
            if (!text) return;
            setKeywords((items) => [...items, { id: `k-${Date.now()}`, text, weight: keywordDraftWeight, selected: true }]);
            setKeywordDraft("");
            setKeywordDraftWeight(6);
          }}
        >
          <div className="litrev-keyword-add-row">
            <span className="litrev-checkbox litrev-checkbox--checked"><Check size={11} /></span>
            <div className="litrev-keyword-add-row__field">
              <input
                value={keywordDraft}
                maxLength={100}
                placeholder={t("litrev.keywords.addPlaceholder")}
                onChange={(event) => setKeywordDraft(event.target.value)}
              />
              <small>{keywordDraft.length} / 100</small>
            </div>
            <span className="litrev-keyword-row__divider" />
            <label className="litrev-keyword-row__weight">
              <span>{t("litrev.keywords.weight")}</span>
              <input
                type="range"
                min={1}
                max={10}
                value={keywordDraftWeight}
                style={{ "--litrev-weight-progress": `${((keywordDraftWeight - 1) / 9) * 100}%` } as CSSProperties}
                aria-label={t("litrev.keywords.weight")}
                onChange={(event) => setKeywordDraftWeight(Number(event.target.value))}
              />
              <output>{keywordDraftWeight}</output>
            </label>
          </div>
          <Button type="submit" variant="secondary" size="sm" disabled={!keywordDraft.trim()}>
            <Plus size={12} /> {t("litrev.keywords.add")}
          </Button>
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
                dragOutlinePointerStartX.current = null;
                setOutlineDropTarget(null);
                if (from == null) return;
                setOutline((items) => moveOutlineItem(items, from, index, level));
              }}
            >
              <span className="litrev-outline-row__marker" aria-hidden="true" />
              <button
                type="button"
                className="litrev-outline-row__grip"
                draggable
                aria-label={t("litrev.outline.dragHint")}
                title={t("litrev.outline.dragHint")}
                onMouseDown={(event) => {
                  dragOutlinePointerStartX.current = event.clientX;
                }}
                onDragStart={(event) => {
                  dragOutlineState.current = {
                    index,
                    startX: dragOutlinePointerStartX.current ?? event.clientX,
                    level: item.level
                  };
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", item.id);
                }}
                onDragEnd={() => {
                  dragOutlineState.current = null;
                  dragOutlinePointerStartX.current = null;
                  setOutlineDropTarget(null);
                }}
              >
                <GripVertical size={13} />
              </button>
              <input
                value={item.text}
                maxLength={2000}
                aria-label={t("litrev.outline.itemLabel")}
                onChange={(event) => setOutline((items) => items.map((entry, entryIndex) => (entryIndex === index ? { ...entry, text: event.target.value } : entry)))}
              />
              <div className="litrev-outline-row__actions">
                {item.level === 0 ? (
                  <button
                    type="button"
                    className="litrev-icon-button"
                    aria-label={t("litrev.outline.addSubsection")}
                    title={t("litrev.outline.addSubsection")}
                    onClick={() => setOutline((items) => {
                      let insertIndex = index + 1;
                      while (items[insertIndex]?.level === 1) insertIndex += 1;
                      return [
                        ...items.slice(0, insertIndex),
                        { id: `o-${Date.now()}`, text: t("litrev.outline.newSubsection"), level: 1 },
                        ...items.slice(insertIndex)
                      ];
                    })}
                  >
                    <Plus size={13} />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="litrev-icon-button"
                  aria-label={t("common.remove")}
                  onClick={() => setOutline((items) => {
                    if (item.level === 1) return items.filter((_, entryIndex) => entryIndex !== index);
                    let blockEnd = index + 1;
                    while (items[blockEnd]?.level === 1) blockEnd += 1;
                    return [...items.slice(0, index), ...items.slice(blockEnd)];
                  })}
                >
                  <Trash2 size={13} />
                </button>
              </div>
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
    const selectedCount = references.filter((reference) => reference.selected).length;
    const allSelected = references.length > 0 && selectedCount === references.length;
    return (
      <>
        <div className="litrev-ref-summary">
          <p>{t("litrev.refs.note")}</p>
          <strong>{t("litrev.refs.selected", { selected: selectedCount, total: references.length })}</strong>
        </div>
        <div className="litrev-ref-table" role="table" aria-label={t("litrev.wizard.step.references")}>
          <div className="litrev-ref-table__head" role="row">
            <span aria-hidden="true" />
            <label className="litrev-ref-table__select-all">
              <input
                type="checkbox"
                checked={allSelected}
                aria-label={t("litrev.refs.selectAll")}
                onChange={(event) => setReferences((items) => items.map((item) => ({ ...item, selected: event.target.checked })))}
              />
              <span className={`litrev-checkbox${allSelected ? " litrev-checkbox--checked" : ""}`}>
                {allSelected ? <Check size={11} /> : null}
              </span>
            </label>
            <strong>{t("litrev.refs.referenceColumn")}</strong>
            <strong>{t("litrev.refs.statusColumn")}</strong>
          </div>
          {references.map((reference, index) => {
            const abstractOnly = /仅摘要|abstract/i.test(reference.meta);
            return (
              <label key={reference.id} className={`litrev-ref-row${reference.selected ? " litrev-ref-row--selected" : ""}`} role="row">
                <span className="litrev-ref-row__index">{index + 1}</span>
                <input
                  type="checkbox"
                  checked={reference.selected}
                  onChange={(event) => setReferences((items) => items.map((item, itemIndex) => (itemIndex === index ? { ...item, selected: event.target.checked } : item)))}
                />
                <span className={`litrev-checkbox${reference.selected ? " litrev-checkbox--checked" : ""}`}>{reference.selected ? <Check size={11} /> : null}</span>
                <span className="litrev-ref-row__text">
                  <strong>{reference.title}</strong>
                  <small>{reference.meta}</small>
                </span>
                <span className={`litrev-ref-row__source${reference.source === "web" ? " litrev-ref-row__source--web" : ""}`}>
                  {abstractOnly
                    ? t("litrev.refs.abstractOnly")
                    : reference.source === "web"
                      ? t("litrev.refs.fromWeb")
                      : t("litrev.refs.local")}
                </span>
              </label>
            );
          })}
        </div>
      </>
    );
  }

  function renderWizardCard(): ReactNode {
    if (phase.kind !== "wizard") return null;
    const stepTitles = [t("litrev.wizard.step.keywords"), t("litrev.wizard.step.outline"), t("litrev.wizard.step.references")] as const;
    return (
      <section className="litrev-wizard-card" aria-label={stepTitles[phase.step]}>
        <header className="litrev-wizard-card__head">
          <strong>{stepTitles[phase.step]}</strong>
          <div className="litrev-wizard-card__head-actions">
            <span className="litrev-wizard-card__count">{phase.step + 1} / 3</span>
            <button
              type="button"
              className="litrev-wizard-card__close"
              aria-label={t("litrev.workflow.close")}
              onClick={skipCurrentCard}
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
            <Button variant="primary" size="sm" onClick={confirmReferencesAndStart}>{t("litrev.refs.confirmStart")}</Button>
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

  function renderTaskResult(): ReactNode {
    return (
      <>
        <p className="litrev-assistant-copy">{LITREV_RESULT_LINE}</p>
        <div className="litrev-file-cards">
          {[LITREV_LATEX_ARTIFACT, LITREV_PDF_ARTIFACT, LITREV_DOCX_ARTIFACT].map((path) => (
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
                <small>{path.endsWith(".tex") ? "LaTeX" : path.endsWith(".pdf") ? "PDF" : "DOCX"}</small>
              </span>
            </button>
          ))}
        </div>
      </>
    );
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
        {finished ? renderTaskResult() : null}
        {conversationEntries.filter((entry) => !entry.skippedStage).map(renderConversationEntry)}
      </div>
    );
  }

  /* --------------------------------- 预览面板 --------------------------------- */

  function renderPreviewPane(): ReactNode {
    const previewedContent = previewPath ? litrevPreviewContentFor(previewPath) : null;
    const folders: LitrevPreviewFolder[] = ["downloads", "outputs"];
    const fileName = (path: string) => path.split("/").pop() ?? path;
    const workspaceRootLabel = launchProjectId
      ? t("litrev.preview.currentProject")
      : t("litrev.preview.taskFolder");
    const renderFileButton = (file: { path: string; name: string }) => (
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
    );
    return (
      <aside className="litrev-preview-pane litrev-preview-pane--lifted" style={previewResize.sidebarStyle}>
        <header className="litrev-preview-toolbar">
          {workspaceFiles.length ? (
            <button
              type="button"
              className="litrev-file-browser__toggle"
              aria-label={t("litrev.preview.toggleFiles")}
              aria-expanded={fileTreeOpen}
              onClick={() => setFileTreeOpen((open) => !open)}
            >
              {fileTreeOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>
          ) : null}
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
                    onClick={() => setPreviewPath(path)}
                  >
                    {fileName(path)}
                  </button>
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
                </div>
              );
            })}
          </div>
        </header>
        <div className="litrev-preview-body">
          <aside
            className={`litrev-file-browser${fileTreeOpen && workspaceFiles.length ? "" : " litrev-file-browser--collapsed"}`}
            style={fileBrowserResize.sidebarStyle}
          >
            {fileTreeOpen && workspaceFiles.length ? (
              <nav className="litrev-file-list">
                {launchProjectId
                  ? workspaceFiles.map(renderFileButton)
                  : folders.map((folder) => {
                    const children = taskFiles.filter((file) => file.folder === folder);
                    if (!children.length) return null;
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
                            {children.map(renderFileButton)}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
              </nav>
            ) : null}
          </aside>
          {fileTreeOpen && workspaceFiles.length ? (
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
            {previewPath && previewedContent ? (
              <article className="litrev-preview-document">
                <div className="litrev-preview-crumb">
                  {workspaceRootLabel} › {fileName(previewPath)}
                </div>
                <h2>{previewedContent.title}</h2>
                {previewedContent.sections.map((section) => (
                  <section key={section.heading}>
                    <h3>{section.heading}</h3>
                    <p>{section.body}</p>
                  </section>
                ))}
              </article>
            ) : (
              <div className="litrev-preview-empty">
                <Folder size={28} aria-hidden="true" />
                <strong>{t(launchProjectId ? "litrev.preview.projectEmpty" : "litrev.preview.taskEmpty")}</strong>
                <small>{t(launchProjectId ? "litrev.preview.projectEmptyDetail" : "litrev.preview.taskEmptyDetail")}</small>
              </div>
            )}
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
              submitConversationMessage();
            }
          }}
        />
        <ComposerQuickActionButtons
          onAttach={() => composerFileInputRef.current?.click()}
          onAttachFolder={() => composerFolderInputRef.current?.click()}
          onInsertSlash={insertComposerSlash}
        />
        <input
          ref={composerFileInputRef}
          type="file"
          hidden
          multiple
          onChange={handleComposerFilesPicked}
        />
        <input
          ref={(node) => {
            composerFolderInputRef.current = node;
            node?.setAttribute("webkitdirectory", "");
          }}
          type="file"
          hidden
          multiple
          onChange={handleComposerFolderPicked}
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
            onClick={submitConversationMessage}
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
              {phase.kind === "sources" ? renderSourceCard() : null}
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
