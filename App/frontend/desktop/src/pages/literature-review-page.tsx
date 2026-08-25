/**
 * Frontend shell for the literature review workflow.
 *
 * The cards and workspace are intentionally interactive, but backend-owned
 * research data starts empty. Nothing on this page simulates search, reading,
 * writing, task progress, or generated artifacts.
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type ReactNode
} from "react";
import {
  Check,
  ChevronRight,
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
import { useApiClients } from "../app/providers.js";
import { Button } from "../components/button.js";
import { FileTypeIcon, FolderTypeIcon } from "../components/file-type-icon.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import {
  composerFolderReferenceFromFiles,
  dataTransferHasComposerReference,
  mergeComposerContextReferences,
  readComposerReferenceDrag
} from "../lib/composer-file-reference.js";
import {
  LITERATURE_SOURCE_ACCEPT,
  assessLiteratureSourceBatch,
  formatLiteratureSourceSize,
  isSupportedLiteratureSourceName
} from "../lib/literature-source-files.js";
import type { ComposerContextReference } from "../state/agent-composer-state.js";
import { AgentAttachmentCard } from "./agent-file-attachment-chip.js";
import { AppFrame } from "./app-frame.js";
import { mergeVoiceTranscript, useAsrRecorder } from "./asr-recorder.js";
import { ComposerQuickActionButtons, HomeContextChips } from "./home-composer-quick-actions.js";
import {
  LITREV_CONTEXT_STORAGE_KEY,
  LITREV_PROJECT_CONTEXT_STORAGE_KEY,
  LITREV_PROMPT_STORAGE_KEY,
  LITREV_SETUP_QUESTIONS,
  LITREV_SOURCE_INPUT_STORAGE_KEY,
  moveOutlineItem,
  type LitrevKeyword,
  type LitrevLaunchContext,
  type LitrevOutlineItem,
  type LitrevQuestionId,
  type LitrevReference
} from "./literature-review-model.js";
import { Mic, Pause } from "./memory/memory-prototype-icons.js";
import { SidebarResizeHandle, useResizableSidebar } from "./sidebar-resize.js";

const LITREV_PREVIEW_WIDTH_STORAGE_KEY = "memmy.literatureReview.previewWidth";
const LITREV_FILE_BROWSER_WIDTH_STORAGE_KEY = "memmy.literatureReview.fileBrowserWidth";

type LitrevStageKind = "questions" | "sources" | "keywords" | "outline" | "references" | "tasks";
type ConfirmableStage = Exclude<LitrevStageKind, "tasks">;

interface LiteratureSourceItem {
  reference: ComposerContextReference;
  fileCount: number | null;
  totalBytes: number | null;
}

interface ConversationEntry {
  id: number;
  text: string;
  contexts: ComposerContextReference[];
  skippedStage?: ConfirmableStage;
}

type SourceUploadNotice = { kind: "unsupported"; count: number };

const STAGE_ORDER: readonly LitrevStageKind[] = [
  "questions",
  "sources",
  "keywords",
  "outline",
  "references",
  "tasks"
];

function readSessionValue(key: string): string {
  if (typeof window === "undefined") return "";
  try {
    return (window.sessionStorage.getItem(key) ?? "").trim();
  } catch {
    return "";
  }
}

function readInitialPrompt(): string {
  return readSessionValue(LITREV_PROMPT_STORAGE_KEY);
}

function readInitialSourceInput(): string {
  return readSessionValue(LITREV_SOURCE_INPUT_STORAGE_KEY)
    || readInitialPrompt()
    || "/literature-review";
}

function readInitialContexts(): LitrevLaunchContext[] {
  if (typeof window === "undefined") return [];
  try {
    const serialized = window.sessionStorage.getItem(LITREV_CONTEXT_STORAGE_KEY) ?? "[]";
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is LitrevLaunchContext => (
      item != null
      && typeof item === "object"
      && "kind" in item
      && item.kind === "path"
      && "id" in item
      && typeof item.id === "string"
      && "label" in item
      && typeof item.label === "string"
    ));
  } catch {
    return [];
  }
}

function readInitialProjectId(): string | null {
  return readSessionValue(LITREV_PROJECT_CONTEXT_STORAGE_KEY) || null;
}

function nextStage(stage: ConfirmableStage): LitrevStageKind {
  const index = STAGE_ORDER.indexOf(stage);
  return STAGE_ORDER[index + 1] ?? "tasks";
}

function stageNameKey(stage: LitrevStageKind): MessageKey {
  if (stage === "questions") return "literatureReview.stage.questions";
  if (stage === "sources") return "literatureReview.stage.sources";
  if (stage === "keywords") return "literatureReview.stage.keywords";
  if (stage === "outline") return "literatureReview.stage.outline";
  if (stage === "references") return "literatureReview.stage.references";
  return "literatureReview.stage.tasks";
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function LiteratureReviewPage() {
  const { clients } = useApiClients();
  const { t } = useTranslation();
  const asrRecorder = useAsrRecorder(clients?.asr, {
    emptyAudioMessage: t("literatureReview.asr.empty")
  });
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
  const [phase, setPhase] = useState<LitrevStageKind>("questions");
  const [completedStages, setCompletedStages] = useState<ConfirmableStage[]>([]);
  const [skippedStages, setSkippedStages] = useState<ConfirmableStage[]>([]);
  const [questionAnswers, setQuestionAnswers] = useState<Record<LitrevQuestionId, string>>({
    field: "",
    time: ""
  });
  const [questionSupplements, setQuestionSupplements] = useState<Record<LitrevQuestionId, string>>({
    field: "",
    time: ""
  });
  const [confirmedAnswers, setConfirmedAnswers] = useState<Record<LitrevQuestionId, string> | null>(null);
  const [sourceItems, setSourceItems] = useState<LiteratureSourceItem[]>(() => (
    launchContexts
      .filter((context) => context.label.endsWith("/") || isSupportedLiteratureSourceName(context.label))
      .map((context) => ({
        reference: { kind: "path", id: context.id, label: context.label },
        fileCount: context.fileCount ?? (context.label.endsWith("/") ? null : 1),
        totalBytes: context.totalBytes ?? null
      }))
  ));
  const [sourceUploadNotice, setSourceUploadNotice] = useState<SourceUploadNotice | null>(null);
  const [keywords, setKeywords] = useState<LitrevKeyword[]>([]);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [keywordDraftWeight, setKeywordDraftWeight] = useState(5);
  const [outline, setOutline] = useState<LitrevOutlineItem[]>([]);
  const [references, setReferences] = useState<LitrevReference[]>([]);
  const [conversationEntries, setConversationEntries] = useState<ConversationEntry[]>([]);
  const [composerDraft, setComposerDraft] = useState("");
  const [composerReferences, setComposerReferences] = useState<ComposerContextReference[]>([]);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [fileTreeOpen, setFileTreeOpen] = useState(true);
  const [outlineDropTarget, setOutlineDropTarget] = useState<{ index: number; level: 0 | 1 } | null>(null);

  const sourceFileInputRef = useRef<HTMLInputElement | null>(null);
  const sourceFolderInputRef = useRef<HTMLInputElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
  const composerFolderInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragOutlineState = useRef<{ index: number; startX: number; level: 0 | 1 } | null>(null);
  const dragOutlinePointerStartX = useRef<number | null>(null);

  const sourceReferences = useMemo(() => sourceItems.map((item) => item.reference), [sourceItems]);
  const sourceTotals = useMemo(() => ({
    fileCount: sourceItems.reduce((count, item) => count + (item.fileCount ?? 0), 0),
    complete: sourceItems.every((item) => item.fileCount != null)
  }), [sourceItems]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [phase, conversationEntries, completedStages, skippedStages]);

  function completeStage(stage: ConfirmableStage) {
    setCompletedStages((stages) => stages.includes(stage) ? stages : [...stages, stage]);
    setPhase(nextStage(stage));
  }

  function skipCurrentCard() {
    if (phase === "tasks") return;
    setSkippedStages((stages) => stages.includes(phase) ? stages : [...stages, phase]);
    setPhase(nextStage(phase));
  }

  function confirmQuestions() {
    if (LITREV_SETUP_QUESTIONS.some((question) => !questionAnswers[question.id].trim())) return;
    setConfirmedAnswers({
      field: questionAnswers.field.trim(),
      time: questionAnswers.time.trim()
    });
    completeStage("questions");
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

  function handleSourceFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    const existingIds = new Set(sourceReferences.map((reference) => reference.id));
    const candidates = Array.from(event.target.files ?? []).filter((file) => {
      const reference = referencesFromFiles([file])[0];
      return !existingIds.has(reference?.id ?? file.name);
    });
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
      }
      setSourceUploadNotice(
        assessment.unsupportedCount
          ? { kind: "unsupported", count: assessment.unsupportedCount }
          : null
      );
    }
    event.target.value = "";
  }

  function addComposerReferences(items: ComposerContextReference[]) {
    setComposerReferences((current) => mergeComposerContextReferences(current, items));
  }

  function handleComposerFilesPicked(event: ChangeEvent<HTMLInputElement>) {
    addComposerReferences(referencesFromFiles(Array.from(event.target.files ?? [])));
    event.target.value = "";
    composerInputRef.current?.focus();
  }

  function handleComposerFolderPicked(event: ChangeEvent<HTMLInputElement>) {
    const reference = folderReferenceFromFiles(Array.from(event.target.files ?? []));
    if (reference) addComposerReferences([reference]);
    event.target.value = "";
    composerInputRef.current?.focus();
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
    const skippedStage = phase === "tasks" ? undefined : phase;
    setConversationEntries((entries) => [...entries, {
      id: Date.now(),
      text,
      contexts: composerReferences,
      skippedStage
    }]);
    setComposerDraft("");
    setComposerReferences([]);
    if (skippedStage) skipCurrentCard();
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
            {launchContexts.map((reference) => {
              const folder = reference.label.endsWith("/");
              return (
                <AgentAttachmentCard
                  key={`${reference.kind}:${reference.id}`}
                  kind="file"
                  name={reference.label}
                  subline={folder ? t("home.quick.kind.folder") : t("home.quick.kind.file")}
                  align="right"
                  leading={folder
                    ? <FolderTypeIcon surface="card" />
                    : <FileTypeIcon name={reference.label} filePath={reference.id} surface="card" />}
                />
              );
            })}
          </div>
        ) : null}
      </div>
    );
  }

  function renderSourceList(removable: boolean): ReactNode {
    return (
      <div className="litrev-source-list">
        {sourceItems.map((item) => {
          const folder = item.reference.label.endsWith("/");
          const detail = folder
            ? item.fileCount == null
              ? t("literatureReview.sources.folderSelected")
              : item.totalBytes == null
                ? t("literatureReview.sources.fileCount", { count: item.fileCount })
                : t("literatureReview.sources.fileCountWithSize", {
                  count: item.fileCount,
                  size: formatLiteratureSourceSize(item.totalBytes)
                })
            : item.totalBytes == null
              ? t("literatureReview.sources.fileSelected")
              : formatLiteratureSourceSize(item.totalBytes);
          return (
            <div className="litrev-source-list__row" key={`${item.reference.kind}:${item.reference.id}`}>
              {folder
                ? <FolderTypeIcon surface="row" />
                : <FileTypeIcon name={item.reference.label} filePath={item.reference.id} surface="row" />}
              <span className="litrev-source-list__name" title={item.reference.label}>
                {item.reference.label}
              </span>
              <small>{detail}</small>
              {removable ? (
                <button
                  type="button"
                  aria-label={t("literatureReview.sources.remove", { name: item.reference.label })}
                  onClick={() => {
                    setSourceItems((items) => items.filter((candidate) => (
                      candidate.reference.kind !== item.reference.kind
                      || candidate.reference.id !== item.reference.id
                    )));
                    setSourceUploadNotice(null);
                  }}
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

  function renderCompletedStage(stage: ConfirmableStage): ReactNode {
    let content: ReactNode;
    if (skippedStages.includes(stage)) {
      content = <p className="litrev-stage-empty">{t("literatureReview.completed.skippedHint")}</p>;
    } else if (stage === "questions") {
      content = confirmedAnswers ? (
        <div className="litrev-qa-summary">
          {prompt ? (
            <div>
              <small>{t("literatureReview.completed.launchRequest")}</small>
              <strong>{prompt}</strong>
            </div>
          ) : null}
          {LITREV_SETUP_QUESTIONS.map((question) => {
            const answer = confirmedAnswers[question.id];
            const option = question.options.find((candidate) => candidate.id === answer);
            return (
              <div key={question.id}>
                <small>{t(question.labelKey)}</small>
                <strong>{option ? t(option.labelKey) : answer}</strong>
              </div>
            );
          })}
        </div>
      ) : <p className="litrev-stage-empty">{t("literatureReview.completed.noScope")}</p>;
    } else if (stage === "sources") {
      content = sourceItems.length
        ? renderSourceList(false)
        : <p className="litrev-stage-empty">{t("literatureReview.completed.noSources")}</p>;
    } else if (stage === "keywords") {
      content = keywords.length ? (
        <div className="litrev-stage-text-card">
          {keywords.filter((keyword) => keyword.selected).map((keyword) => (
            <div key={keyword.id}>
              <strong>{keyword.text}</strong>
              <small>{t("literatureReview.keywords.weightValue", { weight: keyword.weight })}</small>
            </div>
          ))}
        </div>
      ) : <p className="litrev-stage-empty">{t("literatureReview.completed.noKeywords")}</p>;
    } else if (stage === "outline") {
      content = outline.length ? (
        <div className="litrev-stage-text-card litrev-stage-text-card--outline">
          {outline.map((item) => <div key={item.id} data-level={item.level}><strong>{item.text}</strong></div>)}
        </div>
      ) : <p className="litrev-stage-empty">{t("literatureReview.completed.noOutline")}</p>;
    } else {
      content = references.length ? (
        <div className="litrev-stage-text-card">
          {references.filter((reference) => reference.selected).map((reference) => (
            <div key={reference.id}>
              <strong>{reference.title}</strong>
              <small>{reference.meta}</small>
            </div>
          ))}
        </div>
      ) : <p className="litrev-stage-empty">{t("literatureReview.completed.noReferences")}</p>;
    }
    const translatedStageName = t(stageNameKey(stage));
    return (
      <div key={stage} className="agent-activity-cluster agent-activity-cluster--open litrev-stage-activity">
        <div className="litrev-status-toggle litrev-status-toggle--static">
          <span>
            {skippedStages.includes(stage)
              ? t("literatureReview.completed.skipped", { stage: translatedStageName })
              : t("literatureReview.completed.confirmed", { stage: translatedStageName })}
          </span>
        </div>
        <div className="agent-activity-cluster__body litrev-stage-activity__body min-w-0">
          {content}
        </div>
      </div>
    );
  }

  function currentStageStatus(): string {
    if (phase === "questions") return t("literatureReview.status.questions");
    if (phase === "sources") return t("literatureReview.status.sources");
    if (phase === "keywords") return t("literatureReview.status.keywords");
    if (phase === "outline") return t("literatureReview.status.outline");
    if (phase === "references") return t("literatureReview.status.references");
    return t("literatureReview.status.tasks");
  }

  function renderConversation(): ReactNode {
    return (
      <div className="litrev-conversation">
        {renderLaunchUserMessage()}
        {conversationEntries.map((entry) => (
          <div key={entry.id} className="litrev-supplement">
            <div className="litrev-user-message">
              {entry.text ? (
                <div className="agent-chat-bubble agent-chat-bubble--user litrev-user-bubble">
                  {entry.text}
                </div>
              ) : null}
              <HomeContextChips chips={entry.contexts} />
            </div>
          </div>
        ))}
        {STAGE_ORDER.filter((stage): stage is ConfirmableStage => stage !== "tasks")
          .filter((stage) => completedStages.includes(stage) || skippedStages.includes(stage))
          .map(renderCompletedStage)}
        <div className="agent-activity-cluster litrev-stage-activity">
          <div className="litrev-status-toggle litrev-status-toggle--static" aria-live="polite">
            <span>{currentStageStatus()}</span>
          </div>
          {phase === "tasks" ? (
            <div className="agent-activity-cluster__body litrev-stage-activity__body min-w-0">
              <div className="litrev-stage-text-card">
                <div>
                  <strong>{t("literatureReview.execution.emptyTitle")}</strong>
                  <small>{t("literatureReview.execution.emptyBody")}</small>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  function renderQuestionCard(): ReactNode {
    if (phase !== "questions") return null;
    const canConfirm = LITREV_SETUP_QUESTIONS.every((question) => questionAnswers[question.id].trim());
    return (
      <section className="litrev-question-card" aria-label={t("literatureReview.questions.title")}>
        <header className="litrev-question-card__head">
          <h2>{t("literatureReview.questions.title")}</h2>
          <div className="litrev-question-card__meta">
            <span>{t("literatureReview.questions.count", { count: LITREV_SETUP_QUESTIONS.length })}</span>
            <button type="button" aria-label={t("literatureReview.questions.skip")} onClick={skipCurrentCard}>
              <X size={15} />
            </button>
          </div>
        </header>
        <div className="litrev-question-list">
          {LITREV_SETUP_QUESTIONS.map((question) => {
            const selectedAnswer = questionAnswers[question.id];
            const supplement = questionSupplements[question.id];
            const questionLabel = t(question.labelKey);
            const options: Array<{ id: string; label: string }> = question.options.map((option) => ({
              id: option.id,
              label: t(option.labelKey)
            }));
            if (selectedAnswer && !question.options.some((option) => option.id === selectedAnswer)) {
              options.push({ id: selectedAnswer, label: selectedAnswer });
            }
            return (
              <section key={question.id} className="litrev-question-item">
                <div className="litrev-question-item__title">
                  <h3>{questionLabel}</h3>
                </div>
                <div className="litrev-question-options">
                  {options.map((option, optionIndex) => {
                    const selected = selectedAnswer === option.id;
                    return (
                      <button
                        type="button"
                        key={option.id}
                        className={`litrev-question-option${selected ? " litrev-question-option--selected" : ""}`}
                        onClick={() => setQuestionAnswers((answers) => ({ ...answers, [question.id]: option.id }))}
                      >
                        <span className="litrev-question-option__number">{optionIndex + 1}</span>
                        <span className="litrev-question-option__label">{option.label}</span>
                        <span className="litrev-question-option__state">
                          {selected ? <Check size={13} /> : <ChevronRight size={13} />}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <form
                  className="litrev-question-supplement"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const answer = supplement.trim();
                    if (!answer) return;
                    setQuestionAnswers((answers) => ({ ...answers, [question.id]: answer }));
                    setQuestionSupplements((drafts) => ({ ...drafts, [question.id]: "" }));
                  }}
                >
                  <Pencil size={14} aria-hidden="true" />
                  <input
                    value={supplement}
                    placeholder={t("literatureReview.questions.otherDetails")}
                    aria-label={t("literatureReview.questions.otherDetailsFor", { question: questionLabel })}
                    onChange={(event) => setQuestionSupplements((drafts) => ({
                      ...drafts,
                      [question.id]: event.target.value
                    }))}
                  />
                  <button
                    type="submit"
                    aria-label={t("literatureReview.questions.useCustomAnswer", { question: questionLabel })}
                    disabled={!supplement.trim()}
                  >
                    <ChevronRight size={14} />
                  </button>
                </form>
              </section>
            );
          })}
        </div>
        <footer className="litrev-question-card__foot">
          <Button type="button" variant="primary" size="sm" disabled={!canConfirm} onClick={confirmQuestions}>
            {t("literatureReview.questions.confirm")}
          </Button>
        </footer>
      </section>
    );
  }

  function renderSourceCard(): ReactNode {
    if (phase !== "sources") return null;
    return (
      <section className="litrev-wizard-card litrev-source-card" aria-label={t("literatureReview.sources.title")}>
        <header className="litrev-wizard-card__head">
          <strong>{t("literatureReview.sources.title")}</strong>
          <div className="litrev-wizard-card__head-actions">
            {sourceItems.length > 0 && sourceTotals.complete ? (
              <span className="litrev-wizard-card__count">
                {t("literatureReview.sources.included", { count: sourceTotals.fileCount })}
              </span>
            ) : null}
            <button
              type="button"
              className="litrev-wizard-card__close"
              aria-label={t("literatureReview.sources.skip")}
              onClick={skipCurrentCard}
            >
              <X size={15} />
            </button>
          </div>
        </header>
        <div className="litrev-wizard-card__body litrev-source-card__body">
          {sourceItems.length ? (
            <p className="litrev-section-hint">{t("literatureReview.sources.launchHint")}</p>
          ) : null}
          <p className="litrev-source-card__policy">
            {t("literatureReview.sources.policy")}
          </p>
          {sourceItems.length
            ? renderSourceList(true)
            : <div className="litrev-source-card__empty">{t("literatureReview.sources.empty")}</div>}
          {sourceUploadNotice ? (
            <p className="litrev-source-card__notice" role="alert">
              {t("literatureReview.sources.unsupported", { count: sourceUploadNotice.count })}
            </p>
          ) : null}
          <div className="litrev-source-card__actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => sourceFileInputRef.current?.click()}>
              <Plus size={12} /> {t("literatureReview.sources.addFiles")}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => sourceFolderInputRef.current?.click()}>
              <Folder size={13} /> {t("literatureReview.sources.addFolder")}
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
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => sourceItems.length ? completeStage("sources") : skipCurrentCard()}
          >
            {sourceItems.length
              ? t("literatureReview.sources.confirm")
              : t("literatureReview.sources.skipAndContinue")}
          </Button>
        </footer>
      </section>
    );
  }

  function renderKeywordStep(): ReactNode {
    const allSelected = keywords.length > 0 && keywords.every((keyword) => keyword.selected);
    const selectedCount = keywords.filter((keyword) => keyword.selected).length;
    return (
      <>
        <p className="litrev-section-hint">
          {t("literatureReview.keywords.hint")}
        </p>
        {keywords.length ? (
          <>
            <label className="litrev-keyword-select-all">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(event) => setKeywords((items) => items.map((item) => ({ ...item, selected: event.target.checked })))}
              />
              <span className={`litrev-checkbox${allSelected ? " litrev-checkbox--checked" : ""}`}>
                {allSelected ? <Check size={11} /> : null}
              </span>
              <strong>{t("literatureReview.keywords.selectAll")}</strong>
              <small>{selectedCount} / {keywords.length}</small>
            </label>
            <div className="litrev-keyword-rows">
              {keywords.map((keyword, index) => (
                <div className={`litrev-keyword-row${keyword.selected ? "" : " litrev-keyword-row--unselected"}`} key={keyword.id}>
                  <label className="litrev-keyword-row__select">
                    <input
                      type="checkbox"
                      checked={keyword.selected}
                      aria-label={t("literatureReview.keywords.select", { keyword: keyword.text })}
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
                    aria-label={t("literatureReview.keywords.keyword")}
                    onChange={(event) => setKeywords((items) => items.map((item, itemIndex) => (
                      itemIndex === index ? { ...item, text: event.target.value } : item
                    )))}
                  />
                  <span className="litrev-keyword-row__divider" />
                  <label className="litrev-keyword-row__weight">
                    <span>{t("literatureReview.keywords.weight")}</span>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      value={keyword.weight}
                      style={{ "--litrev-weight-progress": `${((keyword.weight - 1) / 9) * 100}%` } as CSSProperties}
                      aria-label={t("literatureReview.keywords.weightFor", { keyword: keyword.text })}
                      onChange={(event) => setKeywords((items) => items.map((item, itemIndex) => (
                        itemIndex === index ? { ...item, weight: Number(event.target.value) } : item
                      )))}
                    />
                    <output>{keyword.weight}</output>
                  </label>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="litrev-source-card__empty">{t("literatureReview.keywords.empty")}</div>
        )}
        <form
          className="litrev-keyword-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            const text = keywordDraft.trim();
            if (!text) return;
            setKeywords((items) => [...items, {
              id: uniqueId("keyword"),
              text,
              weight: keywordDraftWeight,
              selected: true
            }]);
            setKeywordDraft("");
            setKeywordDraftWeight(5);
          }}
        >
          <div className="litrev-keyword-add-row">
            <span className="litrev-checkbox litrev-checkbox--checked"><Check size={11} /></span>
            <div className="litrev-keyword-add-row__field">
              <input
                value={keywordDraft}
                maxLength={100}
                placeholder={t("literatureReview.keywords.placeholder")}
                onChange={(event) => setKeywordDraft(event.target.value)}
              />
              <small>{keywordDraft.length} / 100</small>
            </div>
            <span className="litrev-keyword-row__divider" />
            <label className="litrev-keyword-row__weight">
              <span>{t("literatureReview.keywords.weight")}</span>
              <input
                type="range"
                min={1}
                max={10}
                value={keywordDraftWeight}
                style={{ "--litrev-weight-progress": `${((keywordDraftWeight - 1) / 9) * 100}%` } as CSSProperties}
                aria-label={t("literatureReview.keywords.weightAria")}
                onChange={(event) => setKeywordDraftWeight(Number(event.target.value))}
              />
              <output>{keywordDraftWeight}</output>
            </label>
          </div>
          <Button type="submit" variant="secondary" size="sm" disabled={!keywordDraft.trim()}>
            <Plus size={12} /> {t("literatureReview.keywords.add")}
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
        <p className="litrev-section-hint">
          {t("literatureReview.outline.hint")}
        </p>
        {outline.length ? (
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
                  aria-label={t("literatureReview.outline.drag")}
                  title={t("literatureReview.outline.drag")}
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
                  placeholder={item.level === 0
                    ? t("literatureReview.outline.sectionPlaceholder")
                    : t("literatureReview.outline.subsectionPlaceholder")}
                  aria-label={t("literatureReview.outline.sectionAria")}
                  onChange={(event) => setOutline((items) => items.map((entry, entryIndex) => (
                    entryIndex === index ? { ...entry, text: event.target.value } : entry
                  )))}
                />
                <div className="litrev-outline-row__actions">
                  {item.level === 0 ? (
                    <button
                      type="button"
                      className="litrev-icon-button"
                      aria-label={t("literatureReview.outline.addSubsection")}
                      title={t("literatureReview.outline.addSubsection")}
                      onClick={() => setOutline((items) => {
                        let insertIndex = index + 1;
                        while (items[insertIndex]?.level === 1) insertIndex += 1;
                        return [
                          ...items.slice(0, insertIndex),
                          { id: uniqueId("outline"), text: "", level: 1 },
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
                    aria-label={t("literatureReview.outline.removeSection")}
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
        ) : (
          <div className="litrev-source-card__empty">{t("literatureReview.outline.empty")}</div>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setOutline((items) => [...items, {
            id: uniqueId("outline"),
            text: "",
            level: 0
          }])}
        >
          <Plus size={12} /> {t("literatureReview.outline.addSection")}
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
          <p>{t("literatureReview.references.hint")}</p>
          {references.length ? (
            <strong>
              {t("literatureReview.references.selected", { selected: selectedCount, total: references.length })}
            </strong>
          ) : null}
        </div>
        {references.length ? (
          <div className="litrev-ref-table" role="table" aria-label={t("literatureReview.references.tableAria")}>
            <div className="litrev-ref-table__head" role="row">
              <span aria-hidden="true" />
              <label className="litrev-ref-table__select-all">
                <input
                  type="checkbox"
                  checked={allSelected}
                  aria-label={t("literatureReview.references.selectAll")}
                  onChange={(event) => setReferences((items) => items.map((item) => ({
                    ...item,
                    selected: event.target.checked
                  })))}
                />
                <span className={`litrev-checkbox${allSelected ? " litrev-checkbox--checked" : ""}`}>
                  {allSelected ? <Check size={11} /> : null}
                </span>
              </label>
              <strong>{t("literatureReview.references.reference")}</strong>
              <strong>{t("literatureReview.references.availability")}</strong>
            </div>
            {references.map((reference, index) => (
              <label key={reference.id} className={`litrev-ref-row${reference.selected ? " litrev-ref-row--selected" : ""}`} role="row">
                <span className="litrev-ref-row__index">{index + 1}</span>
                <input
                  type="checkbox"
                  checked={reference.selected}
                  onChange={(event) => setReferences((items) => items.map((item, itemIndex) => (
                    itemIndex === index ? { ...item, selected: event.target.checked } : item
                  )))}
                />
                <span className={`litrev-checkbox${reference.selected ? " litrev-checkbox--checked" : ""}`}>
                  {reference.selected ? <Check size={11} /> : null}
                </span>
                <span className="litrev-ref-row__text">
                  <strong>{reference.title}</strong>
                  <small>{reference.meta}</small>
                </span>
                <span className={`litrev-ref-row__source${reference.source === "web" ? " litrev-ref-row__source--web" : ""}`}>
                  {reference.source === "web"
                    ? t("literatureReview.references.online")
                    : t("literatureReview.references.local")}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className="litrev-source-card__empty">{t("literatureReview.references.empty")}</div>
        )}
      </>
    );
  }

  function renderWizardCard(): ReactNode {
    if (phase !== "keywords" && phase !== "outline" && phase !== "references") return null;
    const wizardStages: readonly ConfirmableStage[] = ["keywords", "outline", "references"];
    const step = wizardStages.indexOf(phase) + 1;
    const hasStageData = phase === "keywords"
      ? keywords.some((keyword) => keyword.selected && keyword.text.trim())
      : phase === "outline"
        ? outline.some((item) => item.text.trim())
        : references.some((reference) => reference.selected);
    const translatedStageName = t(stageNameKey(phase));
    return (
      <section className="litrev-wizard-card" aria-label={translatedStageName}>
        <header className="litrev-wizard-card__head">
          <strong>{translatedStageName}</strong>
          <div className="litrev-wizard-card__head-actions">
            <span className="litrev-wizard-card__count">{step} / {wizardStages.length}</span>
            <button
              type="button"
              className="litrev-wizard-card__close"
              aria-label={t("literatureReview.stage.skip", { stage: translatedStageName })}
              onClick={skipCurrentCard}
            >
              <X size={15} />
            </button>
          </div>
        </header>
        <div className="litrev-wizard-card__body">
          {phase === "keywords"
            ? renderKeywordStep()
            : phase === "outline"
              ? renderOutlineStep()
              : renderReferenceStep()}
        </div>
        <footer className="litrev-wizard-card__foot">
          <i />
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => hasStageData ? completeStage(phase) : skipCurrentCard()}
          >
            {t("common.continue")}
          </Button>
        </footer>
      </section>
    );
  }

  function renderWorkspace(): ReactNode {
    return (
      <aside className="litrev-preview-pane litrev-preview-pane--lifted" style={previewResize.sidebarStyle}>
        <header className="litrev-preview-toolbar">
          <button
            type="button"
            className="litrev-file-browser__toggle"
            aria-label={t("literatureReview.workspace.toggleFileTree")}
            aria-expanded={fileTreeOpen}
            onClick={() => setFileTreeOpen((open) => !open)}
          >
            {fileTreeOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
          <div className="litrev-file-tabs" role="tablist" aria-label={t("literatureReview.workspace.openFiles")} />
        </header>
        <div className="litrev-preview-body">
          <aside
            className={`litrev-file-browser${fileTreeOpen ? "" : " litrev-file-browser--collapsed"}`}
            style={fileBrowserResize.sidebarStyle}
          >
            {fileTreeOpen ? (
              <nav className="litrev-file-list" aria-label={t("literatureReview.workspace.files")}>
                <p className="litrev-stage-empty">{t("literatureReview.workspace.noFiles")}</p>
              </nav>
            ) : null}
          </aside>
          {fileTreeOpen ? (
            <SidebarResizeHandle
              label={t("literatureReview.workspace.resizeFileTree")}
              width={fileBrowserResize.width}
              minWidth={fileBrowserResize.minWidth}
              maxWidth={fileBrowserResize.maxWidth}
              isResizing={fileBrowserResize.isResizing}
              onResizeStart={fileBrowserResize.beginResize}
              onResizeBy={fileBrowserResize.resizeBy}
            />
          ) : null}
          <section className="litrev-preview-main">
            <div className="litrev-preview-empty">
              <Folder size={28} aria-hidden="true" />
              <strong>{t("literatureReview.workspace.emptyTitle")}</strong>
              <small>
                {launchProjectId
                  ? t("literatureReview.workspace.emptyProjectBody")
                  : t("literatureReview.workspace.emptyResearchBody")}
              </small>
            </div>
          </section>
        </div>
      </aside>
    );
  }

  function renderComposer(): ReactNode {
    const canSend = Boolean(composerDraft.trim() || composerReferences.length);
    return (
      <div className="litrev-composer" onDragOver={handleComposerDragOver} onDrop={handleComposerDrop}>
        {composerReferences.length ? (
          <div className="composer-context-attachments">
            <HomeContextChips
              chips={composerReferences}
              onRemove={(reference) => setComposerReferences((items) => items.filter((item) => (
                item.kind !== reference.kind || item.id !== reference.id
              )))}
            />
          </div>
        ) : null}
        <textarea
          ref={composerInputRef}
          rows={3}
          value={composerDraft}
          placeholder={phase === "tasks"
            ? t("literatureReview.composer.taskPlaceholder")
            : t("literatureReview.composer.skipPlaceholder")}
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
        <input ref={composerFileInputRef} type="file" hidden multiple onChange={handleComposerFilesPicked} />
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
            aria-label={t("literatureReview.composer.voice")}
            title={t("literatureReview.composer.voice")}
            disabled={asrRecorder.isTranscribing || asrRecorder.isStarting}
            onClick={() => void toggleComposerVoiceInput()}
          >
            {asrRecorder.isRecording ? <Pause size={15} /> : <Mic size={15} />}
          </button>
          <button
            type="button"
            className={`litrev-composer__send${canSend ? " litrev-composer__send--ready" : ""}`}
            aria-label={t("literatureReview.composer.send")}
            disabled={!canSend}
            onClick={submitConversationMessage}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <AppFrame title={t("literatureReview.title")} reserveTopBar={false}>
      <section className="litrev-split">
        <button
          type="button"
          className={`litrev-workspace-toggle${workspaceOpen ? " litrev-workspace-toggle--active" : ""}`}
          aria-label={t("literatureReview.workspace.toggle")}
          title={t("literatureReview.workspace.toggle")}
          aria-pressed={workspaceOpen}
          onClick={() => setWorkspaceOpen((open) => !open)}
        >
          <PanelRight size={15} />
        </button>
        <div className={`litrev-chat-pane${workspaceOpen ? " litrev-chat-pane--with-side" : ""}`}>
          <header className="litrev-chat-pane__topbar">
            <h1 className="agent-conversation-title">{t("literatureReview.title")}</h1>
          </header>
          <div ref={scrollRef} className="litrev-scroll">
            {renderConversation()}
          </div>
          <div className="litrev-dock">
            {renderQuestionCard()}
            {renderSourceCard()}
            {renderWizardCard()}
            {renderComposer()}
          </div>
        </div>
        {workspaceOpen ? (
          <>
            <SidebarResizeHandle
              label={t("literatureReview.workspace.resize")}
              width={previewResize.width}
              minWidth={previewResize.minWidth}
              maxWidth={previewResize.maxWidth}
              isResizing={previewResize.isResizing}
              onResizeStart={previewResize.beginResize}
              onResizeBy={previewResize.resizeBy}
            />
            {renderWorkspace()}
          </>
        ) : null}
      </section>
    </AppFrame>
  );
}
