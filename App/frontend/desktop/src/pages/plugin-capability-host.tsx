import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ChangeEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent
} from "react";
import {
  AlertCircle,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  Download,
  FileOutput,
  HelpCircle,
  ListChecks,
  LoaderCircle,
  MessageSquarePlus,
  Mic,
  Paperclip,
  X
} from "lucide-react";
import type {
  CapabilityEvent,
  InstalledPlugin,
  PluginArtifactRef,
  PluginInteractionRequest,
  PluginInvocationOrigin
} from "@memmy/local-api-contracts";
import type { AsrClient } from "../api/asr-client.js";
import type { UploadAgentMediaInput, UploadedAgentMedia } from "../api/memmy-agent-client.js";
import type { PluginsClient } from "../api/plugins-client.js";
import { asrRecordingTimeRemainingMs, useAsrRecorder } from "./asr-recorder.js";
import { usePluginChatFeedback, type PluginChatFeedback, type PluginUiCall } from "../app/plugin-ui-context.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { classifyAgentAttachmentFile } from "../lib/agent-attachment.js";
import { mergeLiveLines, type AsrLiveLine } from "../lib/asr-live-transcription.js";
import { pushWaveformLevel } from "../lib/audio-pcm-tap.js";
import { persistRecording } from "../lib/recording-deliverables.js";
import {
  formatClock,
  type RecordingPanelSession,
  type RecordingPanelTranscript
} from "./interview-recording-panel.js";
import { materializePluginUploadFile } from "../lib/plugin-upload-file.js";
import { startBrowserDownload } from "./agent-message-content.js";

const TASK_STATUS_KEYS = {
  pending: "plugin.ui.task.pending",
  running: "plugin.ui.task.running",
  completed: "plugin.ui.task.completed",
  failed: "plugin.ui.task.failed"
} as const;

interface PluginCapabilityHostProps {
  calls: PluginUiCall[];
  plugins: InstalledPlugin[];
  client: (Pick<PluginsClient, "getUi" | "cancel" | "respond"> & Partial<Pick<PluginsClient, "readArtifact">>) | null;
  uploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
  /** Backs `audio-record` interactions; the Host transcribes so plugins never receive raw audio. */
  asrClient?: AsrClient;
  onAddArtifact?: (artifact: PluginArtifactRef) => void;
  onOpenArtifact?: (artifact: PluginArtifactRef) => void;
  /**
   * Which region this host is filling.
   *
   * A card the user raised themselves belongs next to the control that raised
   * it, above the composer, where it stays reachable. A card the model asked
   * for belongs in the transcript at the point of the turn that asked. Both
   * regions mount a host; each renders only the calls that belong to it.
   */
  region?: PluginCardRegion;
  /** Opens the side panel that a recording interaction transcribes into. */
  onRecordingSession?: (session: RecordingPanelSession | null) => void;
  /**
   * Calls the page has already closed, which must not come back as an error.
   *
   * A pinned button toggles: the second press cancels the call, and a cancelled
   * call ends with the plugin reporting that cancellation. Left alone that
   * report would take the place of the card the user just dismissed, so the
   * page names the calls it closed and the host drops them instead.
   */
  dismissedCallIds?: ReadonlySet<string>;
  /**
   * Moves the conversation when a gesture runs past the end of a card.
   *
   * The region is capped in height and scrolls on its own, but it is a sibling
   * of the transcript, not a child of it, so the browser has no scroll ancestor
   * to chain to: a wheel gesture that reaches the bottom of a card would stop
   * dead and read as the conversation being stuck. The page owns the scroller,
   * so it is handed the leftover delta.
   */
  onRegionWheelOverflow?: (deltaY: number) => void;
  /**
   * Reports that the user closed a card, so the page that owns the layout knows.
   *
   * A card can be the reason its region is on screen — the recorder brings the
   * column with it — so the region cannot outlive the card. The page owns that
   * decision, which means it has to hear about the close.
   */
  onCallDismissed?: (callId: string) => void;
  /**
   * Interactions already answered, shared across the regions.
   *
   * A call can move between regions as it progresses — the recorder is answered
   * in the side column and its upload step then appears over the composer — and
   * an answered interaction must not render again in the region it moved to.
   * The answer is a fact about the call, so the page keeps it and every host
   * reads the same set.
   */
  answeredInteractions?: ReadonlySet<string>;
  /** Records an answered interaction for every region rendering this call. */
  onInteractionAnswered?: (key: string) => void;
}

/**
 * Where a plugin card is rendered.
 *
 * `panel` is the column beside the conversation: the interview recorder lives
 * there, directly above the transcript it is producing. A recording runs for an
 * hour while the chat keeps moving, so the recorder needs a place of its own
 * rather than a bar parked over the conversation.
 */
export type PluginCardRegion = "flow" | "pinned" | "panel";

export interface PluginRendererInteractionState {
  interactionId: string;
  status: "stale";
  error: {
    code: "stale_card";
    message: string;
    latestContentHash: string;
  };
}

export function PluginCapabilityHost(props: PluginCapabilityHostProps) {
  const { t } = useTranslation();
  const [localAnsweredInteractions, setLocalAnsweredInteractions] = useState<Set<string>>(() => new Set());
  const [dismissedCalls, setDismissedCalls] = useState<Set<string>>(() => new Set());
  // The page owns this set once there is more than one region, because a call
  // can move between them mid-flight and the region it lands in has to know
  // what was already answered. Standing alone, the host keeps its own.
  const answeredInteractions = props.answeredInteractions ?? localAnsweredInteractions;
  const reportAnswered = props.onInteractionAnswered;
  const rememberAnswered = useCallback((key: string) => {
    setLocalAnsweredInteractions((current) => new Set(current).add(key));
    reportAnswered?.(key);
  }, [reportAnswered]);
  // Read through a ref so the wheel listener is not rebuilt on every render:
  // a pinned card re-renders on every timer tick while it is recording.
  const wheelOverflowRef = useRef(props.onRegionWheelOverflow);
  wheelOverflowRef.current = props.onRegionWheelOverflow;
  const forwardWheelOverflow = useCallback((event: ReactWheelEvent<HTMLElement>) => {
    const handler = wheelOverflowRef.current;
    if (!handler) return;
    // Only the part of the gesture the card could not use travels on, so the
    // transcript picks up exactly where the card left off.
    const element = event.currentTarget;
    const atTop = element.scrollTop <= 0;
    const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
    if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) handler(event.deltaY);
  }, []);
  const plugins = useMemo(() => new Map(props.plugins.map((plugin) => [plugin.id, plugin])), [props.plugins]);
  const interactionStates = useMemo(() => resolveRendererInteractionStates(props.calls), [props.calls]);
  const region = props.region ?? "flow";
  const calls = useMemo(
    () => selectRegionPluginCalls(
      occludeUserRaisedCalls(
        selectCurrentPluginCalls(
          selectVisiblePluginCalls(props.calls, answeredInteractions)
            .filter((call) => !dismissedCalls.has(`${call.pluginId}:${call.callId}`))
            .filter((call) => !props.dismissedCallIds?.has(call.callId))
        )
      ),
      region
    ),
    [answeredInteractions, dismissedCalls, props.calls, props.dismissedCallIds, region]
  );
  const orderedCalls = useMemo(() => orderPluginCallsForDisplay(calls), [calls]);
  if (calls.length === 0) return null;

  return (
    <section
      className={region === "pinned" ? "space-y-3 plugin-capability-region plugin-capability-region--pinned" : "space-y-3 plugin-capability-region"}
      aria-label={t("plugin.ui.regionLabel")}
      onWheel={region === "pinned" ? forwardWheelOverflow : undefined}
    >
      {orderedCalls.map((call) => {
        const plugin = plugins.get(call.pluginId);
        const renderer = plugin?.manifest.ui?.renderer;
        const usesRenderer = Boolean(
          renderer
          && (!renderer.capabilities || renderer.capabilities.includes(call.capabilityId))
          && call.events.some((event) => event.type === "interaction" && event.request.type === "custom")
          && !call.events.some((event) => event.type === "result" || event.type === "error")
          && props.client
        );
        const respond = async (interactionId: string, response: unknown) => {
          if (!props.client) return Promise.reject(new Error("Plugin client unavailable"));
          await props.client.respond(call.pluginId, call.callId, interactionId, response);
          // A refresh is an intermediate action in a multi-step card. Keep the
          // renderer mounted until its next authoritative interaction arrives.
          if (asRecord(response).action === "refresh") return;
          rememberAnswered(interactionKey(call, interactionId));
        };
        const cancel = () => {
          if (!props.client) return Promise.reject(new Error("Plugin client unavailable"));
          return props.client.cancel(call.pluginId, call.callId);
        };
        // Closing a card the user raised themselves is not an answer. The call
        // is cancelled so the plugin stops waiting, and the card is dropped
        // locally so a cancellation error does not take its place — the user
        // asked for it to go away, not to be told it went away.
        const dismiss = async () => {
          setDismissedCalls((current) => new Set(current).add(`${call.pluginId}:${call.callId}`));
          props.onCallDismissed?.(call.callId);
          await cancel().catch(() => undefined);
        };
        const dismissable = call.origin === "user"
          && call.events.some((event) => event.type === "interaction")
          && !call.events.some((event) => event.type === "result" || event.type === "error");
        const cards = (
          <GenericPluginCards
            events={call.events}
            conversationId={call.conversationId}
            pluginId={call.pluginId}
            origin={call.origin}
            onRespond={respond}
            onCancel={cancel}
            onUploadFiles={props.uploadFiles}
            onDismiss={dismissable ? () => void dismiss() : undefined}
            onRecordingSession={props.onRecordingSession}
            asrClient={props.asrClient}
            onAddArtifact={props.onAddArtifact}
            onOpenArtifact={props.onOpenArtifact}
            onReadArtifact={props.client?.readArtifact}
          />
        );
        // The recording bar is a single line with its own controls and close
        // button, so wrapping it in card chrome would double the height of the
        // one card that has to stay out of the way for hours.
        if (isBarePresentation(call)) return <div key={call.callId}>{cards}</div>;
        return (
          <div key={call.callId} className="rounded-card border border-border-stone/30 bg-background-paper p-3 shadow-sm">
            <div className="mb-2 flex items-start justify-between gap-2">
              <p className="text-xs font-medium text-text-ink/55">
                {plugin?.manifest.name ?? call.pluginId}
              </p>
              {dismissable ? (
                <button
                  type="button"
                  aria-label={t("plugin.ui.dismissCard")}
                  title={t("plugin.ui.dismissCard")}
                  className="-mr-1 -mt-1 rounded px-1 text-xs text-text-ink/45 hover:text-text-ink/80"
                  onClick={() => void dismiss()}
                >
                  ✕
                </button>
              ) : null}
            </div>
            {usesRenderer && renderer ? (
              <SandboxedPluginRenderer
                call={call}
                interactionStates={interactionStates.get(call.pluginId + ":" + call.callId) ?? []}
                height={renderer.height ?? 320}
                client={props.client!}
                onRespond={respond}
                onUploadFiles={plugin?.approvedPermissions.some((permission) => permission.type === "host-service" && permission.services.includes("file-input")) ? props.uploadFiles : undefined}
                fallback={cards}
              />
            ) : (
              cards
            )}
          </div>
        );
      })}
    </section>
  );
}

function GenericPluginCards(props: {
  conversationId?: string;
  pluginId?: string;
  origin?: PluginInvocationOrigin;
  events: CapabilityEvent[];
  onRespond(interactionId: string, response: unknown): Promise<void>;
  onCancel(): Promise<void>;
  onUploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
  onDismiss?: () => void;
  onRecordingSession?: (session: RecordingPanelSession | null) => void;
  asrClient?: AsrClient;
  onAddArtifact?: (artifact: PluginArtifactRef) => void;
  onOpenArtifact?: (artifact: PluginArtifactRef) => void;
  onReadArtifact?: PluginsClient["readArtifact"];
}) {
  const terminal = props.events.some((event) => event.type === "result" || event.type === "error");
  const artifactEvents = props.events.filter((event): event is Extract<CapabilityEvent, { type: "artifact" }> => event.type === "artifact");
  // Setup files (templates, checklists) and deliverables are both files, but
  // they answer different questions — "what do I take with me" and "what did
  // this produce" — so they are listed apart and named differently. A single
  // list called 交付文件 made a card full of blank templates read as a finished
  // engagement.
  const setupEvents = artifactEvents.filter((event) => event.artifact.role === "setup");
  const deliverableEvents = artifactEvents.filter((event) => event.artifact.role !== "setup");
  return (
    <div className="space-y-2">
      {props.events.filter((event) => event.type !== "artifact").map((event) => {
        if (event.type === "progress") return terminal ? null : <ProgressCard key="progress" event={event} canCancel={Boolean(event.cancellable)} onCancel={props.onCancel} />;
        if (event.type === "task-list") return terminal ? null : <TaskCard key="tasks" event={event} />;
        if (event.type === "interaction") {
          return terminal ? null : <InteractionCard key={`interaction:${event.request.interactionId}`} request={event.request} conversationId={props.conversationId} pluginId={props.pluginId} onRespond={props.onRespond} onUploadFiles={props.onUploadFiles} onDismiss={props.onDismiss} onRecordingSession={props.onRecordingSession} asrClient={props.asrClient} />;
        }
        if (event.type === "error") {
          return props.origin === "user" && isCancellation(event.code) ? null : <ErrorCard key="error" event={event} />;
        }
        return null;
      })}
      {setupEvents.length > 0 ? (
        <ArtifactGroup
          events={setupEvents}
          labelKey="plugin.ui.setupCollection"
          onAddToChat={props.onAddArtifact}
          onOpen={props.onOpenArtifact}
          onRead={props.onReadArtifact}
        />
      ) : null}
      {deliverableEvents.length > 1 ? (
        <ArtifactCollection
          events={deliverableEvents}
          onAddToChat={props.onAddArtifact}
          onOpen={props.onOpenArtifact}
          onRead={props.onReadArtifact}
        />
      ) : deliverableEvents[0] ? (
        <ArtifactCard event={deliverableEvents[0]} onAddToChat={props.onAddArtifact} onOpen={props.onOpenArtifact} onRead={props.onReadArtifact} />
      ) : null}
    </div>
  );
}

function ProgressCard(props: {
  event: Extract<CapabilityEvent, { type: "progress" }>;
  canCancel: boolean;
  onCancel(): Promise<void>;
}) {
  const { t } = useTranslation();
  const [cancelState, setCancelState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const value = props.event.total ? Math.min(100, Math.round((props.event.current / props.event.total) * 100)) : undefined;
  const completed = value === 100;
  const cancel = async () => {
    setCancelState("pending");
    try {
      await props.onCancel();
      setCancelState("done");
    } catch {
      setCancelState("error");
    }
  };
  return (
    <div className="rounded-card bg-canvas-oat/50 px-3 py-2.5" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm text-text-ink/75">
        {completed
          ? <Check size={15} className="text-status-success" aria-hidden="true" />
          : <LoaderCircle size={15} className="animate-spin text-action-sky" aria-hidden="true" />}
        <span>{props.event.message || t("plugin.ui.progress")}</span>
        {value !== undefined ? <span className="ml-auto text-xs text-text-ink/45">{value}%</span> : null}
        {props.canCancel && cancelState !== "done" ? (
          <button type="button" disabled={cancelState === "pending"} className="ml-1 text-xs text-text-ink/55 hover:text-status-error disabled:opacity-50" onClick={() => void cancel()}>
            {t("plugin.ui.cancel")}
          </button>
        ) : null}
        {cancelState === "done" ? <span className="ml-1 text-xs text-text-ink/45">{t("plugin.ui.cancelled")}</span> : null}
      </div>
      {value !== undefined ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border-stone/30" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
          <div className="h-full rounded-full bg-action-sky transition-[width]" style={{ width: `${value}%` }} />
        </div>
      ) : null}
      {cancelState === "error" ? <p className="mt-1 text-xs text-status-error" role="alert">{t("plugin.ui.cancelFailed")}</p> : null}
    </div>
  );
}

function TaskCard(props: { event: Extract<CapabilityEvent, { type: "task-list" }> }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-card border border-border-stone/30 px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text-ink/75">
        <ListChecks size={15} className="text-action-sky" aria-hidden="true" />
        {t("plugin.ui.tasks")}
      </div>
      <ul className="space-y-1.5">
        {props.event.tasks.map((task) => {
          const Icon = task.status === "completed" ? Check : task.status === "failed" ? X : task.status === "running" ? CircleDot : Circle;
          return (
            <li key={task.id} className="flex items-center gap-2 text-sm text-text-ink/65">
              <Icon size={14} className={task.status === "failed" ? "text-status-error" : task.status === "completed" ? "text-status-success" : "text-action-sky"} aria-hidden="true" />
              <span className="min-w-0 flex-1 break-words">{task.title}</span>
              <span className="text-[11px] text-text-ink/40">{t(TASK_STATUS_KEYS[task.status])}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function InteractionCard(props: {
  conversationId?: string;
  pluginId?: string;
  request: PluginInteractionRequest;
  onRespond(interactionId: string, response: unknown): Promise<void>;
  onUploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
  onDismiss?: () => void;
  onRecordingSession?: (session: RecordingPanelSession | null) => void;
  asrClient?: AsrClient;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState<unknown[]>([]);
  const [status, setStatus] = useState<"idle" | "submitting" | "answered" | "error">("idle");
  const payload = asRecord(props.request.payload);
  const title = firstString(payload, ["title", "question", "prompt", "message"])
    ?? (props.request.type === "approval" ? t("plugin.ui.approval") : t("plugin.ui.question"));
  const description = firstString(payload, ["description", "detail", "hint"]);
  const options = readOptions(payload.options);
  const questions = readQuestions(payload.questions);
  const multiple = payload.multiple === true;
  const allowText = questions.length === 0 && (options.length === 0 || payload.allowText === true);
  const disabled = status === "submitting" || status === "answered";

  const submit = async (response: unknown) => {
    setStatus("submitting");
    try {
      await props.onRespond(props.request.interactionId, response);
      setStatus("answered");
    } catch {
      setStatus("error");
    }
  };
  const submitText = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) void submit(value.trim());
  };

  if (props.request.type === "file-input") {
    return <FileInputCard conversationId={props.conversationId} pluginId={props.pluginId} request={props.request} title={title} description={description} disabled={disabled} status={status} onStatus={setStatus} onRespond={props.onRespond} onUploadFiles={props.onUploadFiles} />;
  }

  if (props.request.type === "audio-record") {
    return (
      <AudioRecordCard
        request={props.request}
        title={title}
        description={description}
        status={status}
        onStatus={setStatus}
        onRespond={props.onRespond}
        onDismiss={props.onDismiss}
        onRecordingSession={props.onRecordingSession}
        asrClient={props.asrClient}
        uploadFiles={props.onUploadFiles}
      />
    );
  }

  return (
    <div className="rounded-card border border-action-sky/25 bg-action-sky/8 px-3 py-3">
      <div className="flex items-start gap-2">
        <HelpCircle size={16} className="mt-0.5 shrink-0 text-action-sky" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-ink/80">{title}</p>
          {description ? <p className="mt-1 text-xs leading-relaxed text-text-ink/50">{description}</p> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {questions.length > 0 ? (
              <QuestionFields questions={questions} disabled={disabled} onSubmit={(answers) => void submit({ answers })} />
            ) : null}
            {props.request.type === "approval" ? (
              <>
                <ResponseButton disabled={disabled} onClick={() => void submit(true)}>{t("plugin.ui.approve")}</ResponseButton>
                <ResponseButton disabled={disabled} onClick={() => void submit(false)} secondary>{t("plugin.ui.reject")}</ResponseButton>
                {payload.allowModify === true ? <ResponseButton disabled={disabled} onClick={() => void submit("modify")} secondary>{t("plugin.ui.modify")}</ResponseButton> : null}
              </>
            ) : options.length > 0 ? (
              <>
                {options.map((option, index) => multiple ? (
                  <label key={`${index}:${option.label}`} className="inline-flex cursor-pointer items-center gap-1.5 rounded-btn border border-border-stone/40 bg-background-paper px-3 py-1.5 text-xs text-text-ink/65">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={selected.includes(option.value)}
                      onChange={(event) => setSelected((current) => event.target.checked ? [...current, option.value] : current.filter((item) => item !== option.value))}
                    />
                    {option.label}
                  </label>
                ) : (
                  <ResponseButton key={`${index}:${option.label}`} disabled={disabled} onClick={() => void submit(option.value)}>{option.label}</ResponseButton>
                ))}
                {multiple ? <ResponseButton disabled={disabled || selected.length === 0} onClick={() => void submit(selected)}>{t("plugin.ui.submit")}</ResponseButton> : null}
              </>
            ) : null}
            {allowText ? (
              <form className="flex w-full gap-2" onSubmit={submitText}>
                <input
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  disabled={disabled}
                  aria-label={title}
                  placeholder={t("plugin.ui.responsePlaceholder")}
                  className="min-w-0 flex-1 rounded-input border border-border-stone/50 bg-background-paper px-3 py-1.5 text-sm text-text-ink outline-none focus:border-action-sky disabled:opacity-60"
                />
                <ResponseButton disabled={disabled || !value.trim()}>{t("plugin.ui.submit")}</ResponseButton>
              </form>
            ) : null}
          </div>
          {status === "answered" ? <p className="mt-2 text-xs text-status-success" role="status">{t("plugin.ui.answered")}</p> : null}
          {status === "error" ? <p className="mt-2 text-xs text-status-error" role="alert">{t("plugin.ui.responseFailed")}</p> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Records microphone audio and hands the plugin the transcript.
 *
 * The audio never reaches the plugin: the Host transcribes it and responds with
 * text only, so a plugin needs no microphone or raw-audio access. Speaker
 * separation is requested through the payload and applied upstream, which is why
 * the card exposes no speaker controls.
 *
 * The card itself is one line: an interview runs for hours, and a card that
 * tall would push the conversation off screen for the whole session. The
 * transcript goes to the side panel instead, which the card drives through
 * `onRecordingSession`.
 */
function AudioRecordCard(props: {
  request: PluginInteractionRequest;
  title: string;
  description: string | null;
  status: "idle" | "submitting" | "answered" | "error";
  onStatus(value: "idle" | "submitting" | "answered" | "error"): void;
  onRespond(interactionId: string, response: unknown): Promise<void>;
  onDismiss?: () => void;
  onRecordingSession?: (session: RecordingPanelSession | null) => void;
  asrClient?: AsrClient;
  uploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
}) {
  const { t } = useTranslation();
  const payload = asRecord(props.request.payload);
  const diarization = payload.diarization === true;
  const allowSkip = payload.allowSkip === true;
  const [elapsedMs, setElapsedMs] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [lines, setLines] = useState<AsrLiveLine[]>([]);
  const [transcript, setTranscript] = useState<RecordingPanelTranscript | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  // Live transcription (streaming, or its segmented-HTTP fallback) can fail
  // without the recording itself failing — the diarized pass at the end still
  // has its own shot. Silently dropping that failure left the card looking
  // idle with no lines and no explanation; this is the only place its message
  // reaches the user.
  const [liveError, setLiveError] = useState<string | null>(null);
  const recorder = useAsrRecorder(props.asrClient, {
    live: {
      onLine: (line) => setLines((current) => mergeLiveLines(current, line)),
      onLevel: (level) => setLevels((current) => pushWaveformLevel(current, level, WAVEFORM_BARS)),
      onError: (liveErr) => setLiveError((current) => current ?? liveErr.message)
    }
  });
  const answered = props.status === "answered";
  const busy = props.status === "submitting" || recorder.isTranscribing;

  const remainingMs = asrRecordingTimeRemainingMs(elapsedMs);

  useEffect(() => {
    if (recorder.status !== "recording") return;
    const timer = window.setInterval(() => setElapsedMs((current) => current + 1_000), 1_000);
    return () => window.clearInterval(timer);
  }, [recorder.status]);

  // An object URL outlives the render that made it, so it is revoked when the
  // card goes away rather than left for the tab to collect.
  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const finish = async () => {
    props.onStatus("submitting");
    try {
      const result = await recorder.finishAndTranscribe({ diarization });
      setAudioUrl(URL.createObjectURL(result.recording));
      setTranscript({ text: result.text, segments: result.segments ?? [] });
      // The recording and its transcript are deliverables in their own right,
      // so both are persisted and handed back as files. The plugin still never
      // receives audio bytes, only a Host-owned path.
      const files = await persistRecording(result, t, props.uploadFiles);
      await props.onRespond(props.request.interactionId, {
        text: result.text,
        segments: result.segments ?? [],
        durationMs: result.durationMs ?? elapsedMs,
        transcribedAt: result.transcribedAt,
        ...files
      });
      props.onStatus("answered");
    } catch {
      props.onStatus("error");
    }
  };
  // A whole recording travels as one payload, so it has a hard ceiling. Stop at
  // it and transcribe what was captured rather than losing the interview.
  useEffect(() => {
    if (recorder.status !== "recording" || remainingMs > 0) return;
    void finish();
  }, [recorder.status, remainingMs]);

  const skip = async () => {
    recorder.cancel();
    props.onStatus("submitting");
    try {
      await props.onRespond(props.request.interactionId, { text: "", segments: [], durationMs: 0 });
      props.onStatus("answered");
    } catch {
      props.onStatus("error");
    }
  };

  const start = () => {
    setElapsedMs(0);
    setLines([]);
    setLevels([]);
    setTranscript(null);
    setLiveError(null);
    void recorder.start().catch(() => undefined);
  };

  // The panel mirrors the card, so it is published from the card's own state
  // rather than kept in a second copy that could drift.
  const panelStatus: RecordingPanelSession["status"] = recorder.status === "paused"
    ? "paused"
    : recorder.isTranscribing
      ? "transcribing"
      : recorder.isRecording
        ? "recording"
        : "done";
  const panelOpen = recorder.isRecording || recorder.isTranscribing || transcript !== null;
  const publish = props.onRecordingSession;
  // A finished transcript is the recording's deliverable and the design keeps
  // it on screen next to the upload card that follows, so it outlives this
  // card. Read through a ref because the unmount below sees only the first
  // render's closure.
  const finishedRef = useRef(false);
  finishedRef.current = transcript !== null;
  useEffect(() => {
    if (!publish) return;
    if (!panelOpen) {
      publish(null);
      return;
    }
    publish({
      title: props.title,
      status: panelStatus,
      elapsedMs,
      lines,
      transcript,
      audioUrl,
      onPause: () => recorder.pause(),
      onResume: () => recorder.resume(),
      onFinish: () => void finish(),
      onClose: () => publish(null)
    });
  }, [publish, panelOpen, panelStatus, elapsedMs, lines, transcript, audioUrl, props.title]);
  useEffect(() => () => {
    // Retracting a half-finished recording is right — there is nothing to show
    // and the microphone should not be left open. A finished one stays until
    // the user closes the pane.
    if (finishedRef.current) return;
    publish?.(null);
  }, [publish]);

  const error = !props.asrClient
    ? t("plugin.ui.audio.unavailable")
    : recorder.error && !answered
      ? recorder.error.message
      : liveError && !answered
        ? liveError
        : props.status === "error"
          ? t("plugin.ui.responseFailed")
          : null;

  return (
    <div className={`recording-bar${recorder.isRecording ? " recording-bar--live" : ""}`}>
      <span className="recording-bar__icon" aria-hidden="true"><Mic size={14} /></span>
      <p className="recording-bar__title">
        {recorder.isRecording
          ? (recorder.status === "paused" ? t("plugin.ui.audio.paused") : t("plugin.ui.audio.recording"))
          : props.title}
      </p>
      <span className="recording-bar__clock" role="timer" aria-label={t("plugin.ui.audio.elapsed")}>
        {formatClock(elapsedMs)}
      </span>
      <Waveform levels={levels} active={recorder.status === "recording"} />
      <div className="recording-bar__actions">
        {recorder.isRecording ? (
          <>
            <button
              type="button"
              className="recording-bar__button"
              disabled={busy || answered}
              onClick={() => (recorder.status === "paused" ? recorder.resume() : recorder.pause())}
            >
              {recorder.status === "paused" ? t("plugin.ui.audio.resume") : t("plugin.ui.audio.pause")}
            </button>
            <button type="button" className="recording-bar__button recording-bar__button--primary" disabled={busy || answered} onClick={() => void finish()}>
              {t("plugin.ui.audio.stop")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="recording-bar__button recording-bar__button--primary"
            disabled={busy || answered || recorder.isStarting || !props.asrClient}
            onClick={start}
          >
            {t("plugin.ui.audio.start")}
          </button>
        )}
        {allowSkip && !recorder.isRecording && !answered ? (
          <button type="button" className="recording-bar__button" disabled={busy} onClick={() => void skip()}>
            {t("plugin.ui.skip")}
          </button>
        ) : null}
        {props.onDismiss ? (
          <button
            type="button"
            className="recording-bar__close"
            aria-label={t("plugin.ui.dismissCard")}
            title={t("plugin.ui.dismissCard")}
            onClick={() => {
              recorder.cancel();
              props.onDismiss?.();
            }}
          >
            ✕
          </button>
        ) : null}
      </div>
      {recorder.isRecording && remainingMs <= REMAINING_WARNING_MS ? (
        <span className="recording-bar__note recording-bar__note--warning" role="status">
          {t("plugin.ui.audio.remaining", { time: formatClock(remainingMs) })}
        </span>
      ) : null}
      {recorder.isTranscribing ? <span className="recording-bar__note" role="status">{t("plugin.ui.audio.transcribing")}</span> : null}
      {answered ? <span className="recording-bar__note recording-bar__note--done" role="status">{t("plugin.ui.answered")}</span> : null}
      {error ? <span className="recording-bar__note recording-bar__note--warning" role="alert">{error}</span> : null}
    </div>
  );
}

/** Point at which the recording card starts counting down to the hard stop. */
const REMAINING_WARNING_MS = 5 * 60 * 1_000;

/** How many bars the recording waveform shows. */
const WAVEFORM_BARS = 48;

/** Live loudness readout for the recording bar. */
function Waveform(props: { levels: number[]; active: boolean }) {
  // Padded to full width so the bars stay put as readings arrive instead of
  // the whole waveform sliding across the bar.
  const padded = [
    ...new Array(Math.max(0, WAVEFORM_BARS - props.levels.length)).fill(0),
    ...props.levels
  ];
  return (
    <div className={`recording-waveform${props.active ? " recording-waveform--active" : ""}`} aria-hidden="true">
      {padded.map((level, index) => (
        <span key={index} className="recording-waveform__bar" style={{ height: `${Math.round(8 + level * 92)}%` }} />
      ))}
    </div>
  );
}

function FileInputCard(props: {
  conversationId?: string;
  pluginId?: string;
  request: PluginInteractionRequest;
  title: string;
  description: string | null;
  disabled: boolean;
  status: "idle" | "submitting" | "answered" | "error";
  onStatus(value: "idle" | "submitting" | "answered" | "error"): void;
  onRespond(interactionId: string, response: unknown): Promise<void>;
  onUploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
}) {
  const { t } = useTranslation();
  const payload = asRecord(props.request.payload);
  const [files, setFiles] = useState<File[]>([]);
  const pendingFeedback = useRef<PluginChatFeedback | null>(null);
  const fileDraftKey = JSON.stringify([props.pluginId, props.conversationId, payload.taskId, payload.cardType, payload.targetPaperId]);
  const fileDrafts = usePluginChatFeedback(payload.chatFeedback === true ? props.conversationId : undefined, (feedback) => {
    if (props.status === "answered") return false;
    pendingFeedback.current = feedback;
    if (!props.disabled) void releaseForChat();
    return true;
  });
  useEffect(() => { const draft = fileDrafts?.get(fileDraftKey); if (draft) setFiles(draft); }, [fileDraftKey, fileDrafts]);
  useEffect(() => { if (!props.disabled && pendingFeedback.current) void releaseForChat(); }, [props.disabled]);
  async function releaseForChat() {
    const feedback = pendingFeedback.current;
    if (!feedback || props.disabled) return;
    pendingFeedback.current = null;
    fileDrafts?.set(fileDraftKey, files);
    props.onStatus("submitting");
    try {
      await props.onRespond(props.request.interactionId, { action: "chat-feedback", ...feedback, files: [], values: { selectedFileNames: files.map((file) => file.name) } });
      props.onStatus("answered");
    } catch { props.onStatus("error"); }
  }

  const [validationError, setValidationError] = useState<string | null>(null);
  const accept = readStrings(payload.accept).join(",");
  const fileRules = readFileRules(payload.fileRules);
  const maxFiles = positiveInteger(payload.maxFiles) ?? (payload.multiple === true ? null : 1);
  const minFiles = positiveInteger(payload.minFiles) ?? 0;
  const maxBytes = positiveInteger(payload.maxBytes);
  const fileStates = files.map((file) => classifyPluginInputFile(file, accept, maxBytes, fileRules, t));
  const readyFiles = fileStates.filter((item) => item.status === "ready").map((item) => item.file);
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    // Picking again adds to the selection instead of replacing it. A lawyer
    // assembling a case pulls together a transcript, a workbook and a handful
    // of scans; replacing meant each new file pushed the last one out, so the
    // only way to send several was to hand over a whole folder. A single-file
    // card keeps replacing, where the second pick is a new choice.
    const picked = Array.from(event.target.files ?? []);
    const next = payload.multiple === true ? appendUniqueFiles(files, picked) : picked;
    event.target.value = "";
    setFiles(next);
    if (fileDrafts?.has(fileDraftKey)) fileDrafts.set(fileDraftKey, next);
    const nextReady = next.filter((file) => classifyPluginInputFile(file, accept, maxBytes, fileRules, t).status === "ready");
    setValidationError(validateReadyFileCount(nextReady, maxFiles, t));
  };
  const remove = (index: number) => {
    const next = files.filter((_file, candidateIndex) => candidateIndex !== index);
    setFiles(next);
    if (fileDrafts?.has(fileDraftKey)) {
      if (next.length) fileDrafts.set(fileDraftKey, next);
      else fileDrafts.delete(fileDraftKey);
    }
    const nextReady = next.filter((file) => classifyPluginInputFile(file, accept, maxBytes, fileRules, t).status === "ready");
    setValidationError(validateReadyFileCount(nextReady, maxFiles, t));
  };
  const upload = async () => {
    const error = validateReadyFileCount(readyFiles, maxFiles, t);
    if (error || !props.onUploadFiles) {
      setValidationError(error ?? t("plugin.ui.responseFailed"));
      return;
    }
    props.onStatus("submitting");
    try {
      const uploaded = await props.onUploadFiles(readyFiles.map((file) => {
        const classification = classifyAgentAttachmentFile(file, { allowAudio: true })!;
        return { blob: file, name: file.name, kind: classification.kind, mime: classification.mime };
      }));
      const feedback = pendingFeedback.current;
      if (feedback) {
        pendingFeedback.current = null;
        fileDrafts?.set(fileDraftKey, files);
        await props.onRespond(props.request.interactionId, { action: "chat-feedback", ...feedback, files: [],
          values: { selectedFileNames: files.map((file) => file.name), stagedFiles: uploaded } });
      } else {
        await props.onRespond(props.request.interactionId, { files: uploaded });
        fileDrafts?.delete(fileDraftKey);
      }
      props.onStatus("answered");
    } catch {
      props.onStatus("error");
    }
  };
  const skip = async () => {
    props.onStatus("submitting");
    try {
      await props.onRespond(props.request.interactionId, { files: [] });
      props.onStatus("answered");
    } catch {
      props.onStatus("error");
    }
  };
  return (
    <div className="rounded-card border border-action-sky/25 bg-action-sky/8 px-3 py-3">
      <div className="flex items-start gap-2">
        <Paperclip size={16} className="mt-0.5 shrink-0 text-action-sky" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-sm font-medium text-text-ink/80">{props.title}</p>
            {files.length ? (
              <span className="shrink-0 text-xs text-text-ink/40">{t("plugin.ui.fileCount", { count: files.length })}</span>
            ) : null}
          </div>
          {props.description ? <p className="mt-1 whitespace-pre-line text-xs text-text-ink/50">{props.description}</p> : null}
          <div className="mt-2 flex items-center gap-2">
            <label className="cursor-pointer rounded-btn border border-border-stone/40 bg-background-paper px-3 py-1.5 text-xs text-text-ink/65">
              {t("plugin.ui.chooseFiles")}
              <input className="sr-only" type="file" accept={accept || undefined} multiple={payload.multiple === true} disabled={props.disabled} onChange={choose} />
            </label>
            {payload.allowDirectory === true ? (
              <label className="cursor-pointer rounded-btn border border-border-stone/40 bg-background-paper px-3 py-1.5 text-xs text-text-ink/65">
                {t("plugin.ui.chooseFolder")}
                {/*
                  webkitdirectory is not in the React typings but is what every
                  Chromium build implements, and the desktop shell is Chromium.
                */}
                <input
                  className="sr-only"
                  type="file"
                  multiple
                  disabled={props.disabled}
                  onChange={choose}
                  {...{ webkitdirectory: "" } as Record<string, string>}
                />
              </label>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-xs text-text-ink/45">
              {files.length ? t("plugin.ui.filesReadySummary", { ready: readyFiles.length, blocked: files.length - readyFiles.length }) : t("plugin.ui.noFiles")}
            </span>
            {minFiles === 0 && files.length === 0 ? <ResponseButton disabled={props.disabled} secondary onClick={() => void skip()}>{t("plugin.ui.skip")}</ResponseButton> : null}
            <ResponseButton disabled={props.disabled || readyFiles.length === 0 || Boolean(validationError) || !props.onUploadFiles} onClick={() => void upload()}>
              {firstString(payload, ["submitLabel"]) ?? t("plugin.ui.upload")}
            </ResponseButton>
          </div>
          {accept ? <p className="mt-2 text-xs text-text-ink/35">{t("plugin.ui.acceptedFormats", { formats: summarizeAcceptedFormats(accept, t) })}</p> : null}
          {fileStates.length ? (
            <ul className="mt-2 space-y-1.5" aria-label={t("plugin.ui.selectedFiles")}>
              {fileStates.map((item, index) => (
                <li key={`${item.file.name}:${item.file.size}:${index}`} className={`flex items-start gap-2 rounded-btn border px-2.5 py-2 text-xs ${item.status === "blocked" ? "border-status-error/20 bg-status-error-soft text-text-ink/55" : "border-border-stone/30 bg-background-paper text-text-ink/65"}`}>
                  {item.status === "blocked" ? <AlertCircle size={14} className="mt-0.5 shrink-0 text-status-error" aria-hidden="true" /> : <Check size={14} className="mt-0.5 shrink-0 text-status-success" aria-hidden="true" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.file.name}</span>
                    <span className={item.status === "blocked" ? "text-status-error" : "text-text-ink/40"} role={item.status === "blocked" ? "alert" : undefined}>
                      {item.message ?? t("plugin.ui.fileReady")}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={props.disabled}
                    aria-label={t("plugin.ui.removeFile", { name: item.file.name })}
                    className="rounded-btn p-1 text-text-ink/35 transition-colors hover:bg-canvas-oat hover:text-text-ink/65 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => remove(index)}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {validationError ? <p className="mt-2 text-xs text-status-error" role="alert">{validationError}</p> : null}
          {props.status === "answered" ? <p className="mt-2 text-xs text-status-success" role="status">{t("plugin.ui.answered")}</p> : null}
          {props.status === "error" ? <p className="mt-2 text-xs text-status-error" role="alert">{t("plugin.ui.responseFailed")}</p> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * One form for a card that asks several things at once.
 *
 * A plugin that needs twenty blanks filled has no way to ask for them one at a
 * time without twenty consecutive cards, so `payload.questions` collects them
 * into a single form answered as `{ answers: { [id]: value } }`.
 *
 * A blank is left out of the answers entirely rather than sent as an empty
 * string: skipping a question and answering it with nothing are different
 * statements, and the plugin marks the skipped ones as unverified.
 */
function QuestionFields(props: {
  questions: PluginQuestionField[];
  disabled: boolean;
  onSubmit: (answers: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const filled = props.questions.filter((question) => (answers[question.id] ?? "").trim());
  const incomplete = props.questions.some((question) => question.required && !(answers[question.id] ?? "").trim());
  const set = (id: string, value: string) => setAnswers((current) => ({ ...current, [id]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmit(Object.fromEntries(filled.map((question) => [question.id, answers[question.id]!.trim()])));
  };

  return (
    <form className="flex w-full flex-col gap-2" onSubmit={submit}>
      <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
        {props.questions.map((question) => (
          <label key={question.id} className="flex flex-col gap-1">
            {/*
              The badge, not a lone asterisk, is what tells the two kinds apart:
              a required field blocks submit, an optional one does not, and the
              difference used to be a single character at the end of a long
              sentence that the reader scrolled past.
            */}
            <span className="flex items-baseline gap-2 text-xs text-text-ink/65">
              <span className="min-w-0 flex-1">{question.label}</span>
              <span
                className={question.required ? "shrink-0 font-medium text-status-error" : "shrink-0 text-text-ink/40"}
              >
                {question.required ? t("plugin.ui.fieldRequired") : t("plugin.ui.fieldOptional")}
              </span>
            </span>
            {question.options.length > 0 ? (
              <select
                value={answers[question.id] ?? ""}
                onChange={(event) => set(question.id, event.target.value)}
                disabled={props.disabled}
                className="rounded-input border border-border-stone/50 bg-background-paper px-3 py-1.5 text-sm text-text-ink outline-none focus:border-action-sky disabled:opacity-60"
              >
                <option value="">{question.required ? t("plugin.ui.requiredPlaceholder") : t("plugin.ui.optionalPlaceholder")}</option>
                {question.options.map((option, index) => (
                  <option key={`${index}:${option}`} value={option}>{option}</option>
                ))}
              </select>
            ) : (
              <input
                value={answers[question.id] ?? ""}
                onChange={(event) => set(question.id, event.target.value)}
                disabled={props.disabled}
                placeholder={question.required ? t("plugin.ui.requiredPlaceholder") : t("plugin.ui.optionalPlaceholder")}
                className="rounded-input border border-border-stone/50 bg-background-paper px-3 py-1.5 text-sm text-text-ink outline-none focus:border-action-sky disabled:opacity-60"
              />
            )}
          </label>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs text-text-ink/40">
          {t("plugin.ui.answerCount", { filled: filled.length, total: props.questions.length })}
        </span>
        <ResponseButton disabled={props.disabled || incomplete}>{t("plugin.ui.submit")}</ResponseButton>
      </div>
    </form>
  );
}

function ResponseButton(props: { children: string; disabled: boolean; onClick?: () => void; secondary?: boolean }) {
  return (
    <button
      type="submit"
      disabled={props.disabled}
      onClick={props.onClick}
      className={`rounded-btn border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${props.secondary ? "border-border-stone/40 bg-background-paper text-text-ink/60 hover:bg-canvas-oat" : "border-action-sky/30 bg-action-sky/10 text-action-sky hover:bg-action-sky/15"}`}
    >
      {props.children}
    </button>
  );
}

function ArtifactCard(props: {
  event: Extract<CapabilityEvent, { type: "artifact" }>;
  onAddToChat?: (artifact: PluginArtifactRef) => void;
  onOpen?: (artifact: PluginArtifactRef) => void;
  onRead?: PluginsClient["readArtifact"];
}) {
  const { t } = useTranslation();
  const artifact = props.event.artifact;
  const downloadUri = artifact.downloadUri ?? artifact.uri;
  const [downloadState, setDownloadState] = useState<"idle" | "pending" | "error">("idle");
  const download = async () => {
    if (!props.onRead) {
      const safeUri = resolveSafeArtifactUri(downloadUri);
      if (safeUri) startBrowserDownload(safeUri, artifact.name);
      return;
    }
    setDownloadState("pending");
    try {
      const blob = await props.onRead(downloadUri);
      const objectUrl = URL.createObjectURL(blob);
      startBrowserDownload(objectUrl, artifact.name);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setDownloadState("idle");
    } catch {
      setDownloadState("error");
    }
  };
  return (
    <div className="flex items-center gap-3 rounded-card border border-border-stone/30 px-3 py-2.5">
      <FileOutput size={18} className="shrink-0 text-action-sky" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text-ink/75">{props.event.artifact.name}</p>
        <p className="truncate text-[11px] text-text-ink/40">{props.event.artifact.mediaType}</p>
      </div>
      {props.onOpen ? (
        <button type="button" className="inline-flex items-center gap-1 text-xs text-action-sky hover:underline" onClick={() => props.onOpen?.(artifact)}>
          {t("plugin.ui.open")}<FileOutput size={12} aria-hidden="true" />
        </button>
      ) : null}
      <button type="button" disabled={downloadState === "pending"} className="inline-flex items-center gap-1 text-xs text-action-sky hover:underline disabled:opacity-50" onClick={() => void download()}>
          {t("plugin.ui.download")}<Download size={12} aria-hidden="true" />
      </button>
      {props.onAddToChat ? (
        <button type="button" className="inline-flex items-center gap-1 text-xs text-action-sky hover:underline" onClick={() => props.onAddToChat?.(props.event.artifact)}>
          {t("plugin.ui.addToChat")}<MessageSquarePlus size={12} aria-hidden="true" />
        </button>
      ) : null}
      {downloadState === "error" ? <span className="text-xs text-status-error" role="alert">{t("plugin.ui.downloadFailed")}</span> : null}
    </div>
  );
}

/**
 * Lists one group of files, named for what they are.
 *
 * Two files go straight on screen: a card that hides the two things it was
 * opened to hand over is a card that made the user click twice for nothing.
 * Past that the rows collapse behind a count, because the card is not the
 * place to read a long file list — the preview panel is.
 *
 * @param props Files, the label naming the group, and the row actions.
 * @returns The group as one block.
 */
function ArtifactGroup(props: {
  events: Array<Extract<CapabilityEvent, { type: "artifact" }>>;
  labelKey: MessageKey;
  onAddToChat?: (artifact: PluginArtifactRef) => void;
  onOpen?: (artifact: PluginArtifactRef) => void;
  onRead?: PluginsClient["readArtifact"];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const rows = props.events.length <= 2 || expanded
    ? props.events.map((event) => (
      <ArtifactCard
        key={`artifact:${event.artifact.id}`}
        event={event}
        onAddToChat={props.onAddToChat}
        onOpen={props.onOpen}
        onRead={props.onRead}
      />
    ))
    : null;
  return (
    <>
      {props.events.length > 2 ? (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-card border border-border-stone/30 bg-canvas-oat/30 px-3 py-2 text-left text-xs text-text-ink/60 transition-colors hover:bg-canvas-oat/60"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <FileOutput size={15} className="shrink-0 text-action-sky" aria-hidden="true" />
          <span className="font-medium">{t(props.labelKey, { count: props.events.length })}</span>
          <span className="ml-auto text-text-ink/40">{expanded ? t("plugin.ui.collapse") : t("plugin.ui.expand")}</span>
          <ChevronRight size={14} className={`text-text-ink/40 transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />
        </button>
      ) : null}
      {rows}
    </>
  );
}

function ArtifactCollection(props: {
  events: Array<Extract<CapabilityEvent, { type: "artifact" }>>;
  onAddToChat?: (artifact: PluginArtifactRef) => void;
  onOpen?: (artifact: PluginArtifactRef) => void;
  onRead?: PluginsClient["readArtifact"];
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="overflow-hidden rounded-card border border-border-stone/30">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-text-ink/70 transition-colors hover:bg-canvas-oat/40"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <FileOutput size={17} className="shrink-0 text-action-sky" aria-hidden="true" />
        <span className="font-medium">{t("plugin.ui.artifactCollection", { count: props.events.length })}</span>
        <span className="ml-auto text-xs text-text-ink/40">{expanded ? t("plugin.ui.collapse") : t("plugin.ui.expand")}</span>
        <ChevronRight size={15} className={`text-text-ink/40 transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />
      </button>
      {expanded ? (
        <div className="max-h-72 space-y-1.5 overflow-y-auto border-t border-border-stone/30 p-2">
          {props.events.map((event) => (
            <ArtifactCard
              key={`artifact:${event.artifact.id}`}
              event={event}
              onAddToChat={props.onAddToChat}
              onOpen={props.onOpen}
              onRead={props.onRead}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function interactionKey(call: Pick<PluginUiCall, "pluginId" | "callId">, interactionId: string): string {
  return `${call.pluginId}:${call.callId}:${interactionId}`;
}

/**
 * Reduces the calls of one capability to the ones worth a card.
 *
 * The conversation is not a log of everything the plugin did — it is where the
 * work is happening. So for each capability only two things survive: the run
 * that is still going, and the most recent run that produced something. An
 * earlier attempt that failed, a run the user started again, a cancelled one:
 * those are history, and rendering each as its own card buries the one card the
 * user is supposed to act on.
 *
 * A newer live run supersedes an older one for the same reason the plugin can
 * only serve one at a time — only the newest is still answering.
 *
 * @param calls Calls the region is considering, oldest first.
 * @returns The calls that deserve a card, oldest first.
 */
export function selectCurrentPluginCalls(calls: readonly PluginUiCall[]): PluginUiCall[] {
  const isLive = (call: PluginUiCall) => !call.events.some((event) => event.type === "result" || event.type === "error");
  const groups = new Map<string, { live?: PluginUiCall; finished?: PluginUiCall }>();
  const order: string[] = [];
  for (const call of calls) {
    const key = `${call.pluginId}:${call.capabilityId}`;
    let group = groups.get(key);
    if (!group) {
      group = {};
      groups.set(key, group);
      order.push(key);
    }
    if (isLive(call)) group.live = call;
    else group.finished = call;
  }
  return order
    .flatMap((key) => {
      const group = groups.get(key)!;
      if (group.live) return [group.live];
      if (group.finished?.events.some((event) => event.type === "artifact")) return [group.finished];
      return [];
    })
    .sort((left, right) => calls.indexOf(left) - calls.indexOf(right));
}

/** Keeps history in the event store while limiting the conversation to actionable UI. */
export function selectVisiblePluginCalls(calls: PluginUiCall[], answered: ReadonlySet<string> = new Set()): PluginUiCall[] {
  const prepared = calls.map((call) => ({
    ...call,
    events: call.events.filter((event) => (
      event.type !== "interaction" || !answered.has(interactionKey(call, event.request.interactionId))
    ))
  }));
  const latest = prepared[prepared.length - 1];
  const latestActive = latest && !latest.events.some((event) => event.type === "result" || event.type === "error")
    ? latest.callId
    : undefined;
  return prepared.filter((call, index) => {
    const artifactEvents = call.events.filter((event): event is Extract<CapabilityEvent, { type: "artifact" }> => event.type === "artifact");
    // A call that only handed over setup files (templates, checklists) carries
    // no real deliverable. Keeping it on screen after it terminates adds a card
    // the user cannot act on. Deliverable artifacts — the workbook, the report
    // — still stay because those are what the engagement produced.
    const hasDeliverableArtifact = artifactEvents.some((event) => event.artifact.role !== "setup");
    const hasArtifact = artifactEvents.length > 0;
    const hasError = call.events.some((event) => event.type === "error");
    const terminal = call.events.some((event) => event.type === "result" || event.type === "error");
    const recoveredByLaterRetry = hasError && prepared.slice(index + 1).some((candidate) => (
      candidate.pluginId === call.pluginId
      && candidate.capabilityId === call.capabilityId
      && candidate.conversationId === call.conversationId
      && candidate.events.some((event) => event.type === "result")
    ));
    if (hasDeliverableArtifact) return true;
    // A setup-only call that finished (result or dismissed) is history:
    // the templates were handed over and the card has nothing left to offer.
    if (hasArtifact && terminal) return false;
    if (hasArtifact && !terminal) return true;
    if (hasError) return !recoveredByLaterRetry;
    if (!terminal && call.events.some((event) => event.type === "interaction")) return true;
    return call.callId === latestActive && call.events.some((event) => event.type !== "result");
  });
}

/**
 * Hides user-raised cards while the Agent is waiting on one of its own.
 *
 * User-raised cards are pinned entry points the user opens whenever it suits
 * them, so they can already be on screen when the model asks its own question.
 * Two live cards competing for the same answer is ambiguous, and the Agent's is
 * the one blocking progress, so it wins. Nothing is cancelled — the hidden card
 * comes back once the Agent's interaction is answered.
 *
 * @param calls Visible calls.
 * @returns Calls with occluded ones removed.
 */
export function occludeUserRaisedCalls(calls: PluginUiCall[]): PluginUiCall[] {
  const agentIsWaiting = calls.some((call) => (
    call.origin === "agent"
    && call.events.some((event) => event.type === "interaction")
    && !call.events.some((event) => event.type === "result" || event.type === "error")
  ));
  if (!agentIsWaiting) return calls;
  // The recorder is never occluded: hiding it unmounts the card that owns the
  // microphone, and a recording in progress cannot be taken again. It is also
  // not competing for the same answer — one takes a recording, the other a
  // reply — so leaving it up costs the Agent's card nothing.
  return calls.filter((call) => (
    call.origin !== "user"
    || isBarePresentation(call)
    || !call.events.some((event) => event.type === "interaction")
  ));
}

/**
 * Reports whether a call renders its own chrome and should not be boxed.
 *
 * @param call The call being rendered.
 * @returns True when the call's only live event is a recording interaction.
 */
export function isBarePresentation(call: PluginUiCall): boolean {
  const live = call.events.filter((event) => event.type !== "artifact");
  return live.length > 0
    && live.every((event) => event.type === "interaction" && event.request.type === "audio-record");
}

/**
 * Splits calls between the side panel, the pinned region and the transcript.
 *
 * A call the user raised stays beside the conversation for as long as it is
 * live; a call the model raised belongs in the transcript. Once a user-raised
 * call has delivered its result it moves to the transcript too, so the pinned
 * region holds only what is still actionable and the deliverables stay in the
 * history.
 *
 * The interview recorder is the exception. It draws its own bar, stays open for
 * as long as the interview lasts, and its transcript grows in the column beside
 * it, so it belongs in that column rather than over the conversation.
 *
 * @param calls Visible calls.
 * @param region The region being rendered.
 * @returns The calls that belong to that region.
 */
export function selectRegionPluginCalls(calls: PluginUiCall[], region: PluginCardRegion): PluginUiCall[] {
  const isLiveUserCall = (call: PluginUiCall) => (
    call.origin === "user"
    && !call.events.some((event) => event.type === "result" || event.type === "error")
  );
  return calls.filter((call) => {
    const live = isLiveUserCall(call);
    if (region === "panel") return live && isBarePresentation(call);
    if (region === "pinned") return live && !isBarePresentation(call);
    return !live;
  });
}

/** Keep active work closest to the current Agent turn and completed deliveries at the bottom. */
export function orderPluginCallsForDisplay(calls: PluginUiCall[]): PluginUiCall[] {
  const isCompletedDelivery = (call: PluginUiCall) => (
    call.events.some((event) => event.type === "artifact")
    && call.events.some((event) => event.type === "result" || event.type === "error")
  );
  return [
    ...calls.filter((call) => !isCompletedDelivery(call)),
    ...calls.filter(isCompletedDelivery)
  ];
}

function ErrorCard(props: { event: Extract<CapabilityEvent, { type: "error" }> }) {
  return (
    <div className="flex items-start gap-2 rounded-card border border-status-error/20 bg-status-error-soft px-3 py-2.5 text-sm text-status-error" role="alert">
      <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{props.event.message}</span>
    </div>
  );
}

function SandboxedPluginRenderer(props: {
  call: PluginUiCall;
  interactionStates: PluginRendererInteractionState[];
  height: number;
  client: Pick<PluginsClient, "getUi">;
  onRespond(interactionId: string, response: unknown): Promise<void>;
  fallback: ReactNode;
  onUploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
}) {
  const { t } = useTranslation();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const answered = useRef(new Set<string>());
  const uploading = useRef(new Set<string>());
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [rendererHeight, setRendererHeight] = useState(() => Math.min(props.height, 320));
  const document = useMemo(() => html === null ? "" : buildRendererDocument(html), [html]);
  const queuedChat = useRef<PluginChatFeedback | null>(null);
  const latestInteraction = [...props.call.events].reverse().find((event) => event.type === "interaction");
  const feedbackEnabled = latestInteraction?.type === "interaction" && asRecord(latestInteraction.request.payload).chatFeedback === true
    && !props.call.events.some((event) => event.type === "result" || event.type === "error");
  usePluginChatFeedback(feedbackEnabled ? props.call.conversationId : undefined, (feedback) => {
    if (latestInteraction?.type !== "interaction" || answered.current.has(latestInteraction.request.interactionId)) return false;
    queuedChat.current = feedback;
    iframeRef.current?.contentWindow?.postMessage({ type: "memmy.plugin.chat-feedback", version: 1,
      interactionId: latestInteraction.request.interactionId, ...feedback }, "*");
    return true;
  });

  const rendererMessage = useMemo(() => ({
    type: "memmy.plugin.render",
    version: 1,
    pluginId: props.call.pluginId,
    capabilityId: props.call.capabilityId,
    callId: props.call.callId,
    events: props.call.events,
    interactionStates: props.interactionStates
  }), [props.call, props.interactionStates]);

  useEffect(() => {
    let active = true;
    void props.client.getUi(props.call.pluginId, "renderer").then((content) => {
      if (active) setHtml(content);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => { active = false; };
  }, [props.call.pluginId, props.client]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(rendererMessage, "*");
    if (queuedChat.current && latestInteraction?.type === "interaction") iframeRef.current?.contentWindow?.postMessage({
      type: "memmy.plugin.chat-feedback", version: 1, interactionId: latestInteraction.request.interactionId, ...queuedChat.current
    }, "*");
  }, [rendererMessage]);

  useEffect(() => {
    setRendererHeight(Math.min(props.height, 320));
  }, [props.call.callId, props.height]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = asRecord(event.data);
      if (message.type === "memmy.plugin.resize" && message.version === 1) {
        const requestedHeight = typeof message.height === "number" ? message.height : Number.NaN;
        if (Number.isFinite(requestedHeight)) {
          setRendererHeight(Math.min(props.height, Math.max(180, Math.ceil(requestedHeight))));
        }
        return;
      }
      if (message.type === "memmy.plugin.upload-files" && message.version === 1) {
        const interactionId = message.interactionId;
        const requestId = message.requestId;
        const latest = [...props.call.events].reverse().find((item) => item.type === "interaction");
        if (typeof interactionId !== "string" || typeof requestId !== "string" || requestId.length > 128
          || latest?.type !== "interaction" || latest.request.interactionId !== interactionId
          || latest.request.type !== "custom" || answered.current.has(interactionId) || uploading.current.has(interactionId)
          || props.call.events.some((item) => item.type === "result" || item.type === "error")) return;
        const reply = (result: Record<string, unknown>) => iframeRef.current?.contentWindow?.postMessage({
          type: "memmy.plugin.upload-result", version: 1, interactionId, requestId, ...result
        }, "*");
        const rules = asRecord(asRecord(latest.request.payload).fileUpload);
        const files = Array.isArray(message.files) ? message.files : [];
        const maxFiles = Math.min(10, positiveInteger(rules.maxFiles) ?? 1);
        const maxBytes = Math.min(50 * 1024 * 1024, positiveInteger(rules.maxBytes) ?? 50 * 1024 * 1024);
        const accept = readStrings(rules.accept).join(",");
        if (!props.onUploadFiles || !accept || files.length === 0 || files.length > maxFiles
          || files.some((file) => !(file instanceof File) || classifyPluginInputFile(file, accept, maxBytes, [], t).status !== "ready")
          || props.interactionStates.some((state) => state.interactionId === interactionId)) {
          reply({ ok: false, error: { message: t("plugin.ui.uploadInvalid") } });
          return;
        }
        uploading.current.add(interactionId);
        const uploadFiles = props.onUploadFiles;
        void Promise.all(files.map(async (file: File) => {
          const classification = classifyAgentAttachmentFile(file, { allowAudio: true })!;
          return { blob: await materializePluginUploadFile(file), name: file.name, kind: classification.kind, mime: classification.mime };
        })).then(uploadFiles).then(
          (uploaded) => reply({ ok: true, files: uploaded }),
          () => reply({ ok: false, error: { message: t("plugin.ui.uploadFailed") } })
        ).finally(() => uploading.current.delete(interactionId));
        return;
      }
      if (message.type !== "memmy.plugin.interaction-response" || message.version !== 1 || typeof message.interactionId !== "string") return;
      const interactionId = message.interactionId;
      const declared = props.call.events.some((item) => item.type === "interaction" && item.request.interactionId === interactionId);
      if (!declared || answered.current.has(interactionId)) return;
      const response = asRecord(message.response);
      const stale = props.interactionStates.find((item) => item.interactionId === interactionId);
      if (stale && response.action === "submit") {
        iframeRef.current?.contentWindow?.postMessage({
          type: "memmy.plugin.response-result",
          version: 1,
          interactionId,
          ok: false,
          error: stale.error
        }, "*");
        return;
      }
      answered.current.add(interactionId);
      if (response.action === "chat-feedback") queuedChat.current = null;
      void props.onRespond(interactionId, message.response).then(
        () => iframeRef.current?.contentWindow?.postMessage({ type: "memmy.plugin.response-result", version: 1, interactionId, ok: true }, "*"),
        () => {
          answered.current.delete(interactionId);
          iframeRef.current?.contentWindow?.postMessage({ type: "memmy.plugin.response-result", version: 1, interactionId, ok: false }, "*");
        }
      );
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [props.call.events, props.height, props.interactionStates, props.onRespond, props.onUploadFiles, t]);

  if (failed) return props.fallback;
  if (html === null) return <p className="py-3 text-center text-xs text-text-ink/40" role="status">{t("plugin.ui.rendererLoading")}</p>;
  return (
    <iframe
      ref={iframeRef}
      title={`${props.call.pluginId} ${t("plugin.ui.renderer")}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={document}
      className="w-full rounded-card border-0 bg-transparent"
      style={{ height: rendererHeight }}
      onLoad={() => {
        iframeRef.current?.contentWindow?.postMessage(rendererMessage, "*");
        if (queuedChat.current && latestInteraction?.type === "interaction") iframeRef.current?.contentWindow?.postMessage({
          type: "memmy.plugin.chat-feedback", version: 1, interactionId: latestInteraction.request.interactionId, ...queuedChat.current
        }, "*");
      }}
    />
  );
}

export function buildRendererDocument(html: string): string {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; navigate-to 'none'";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${meta}`);
  if (/<html(?:\s[^>]*)?>/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, (root) => `${root}<head>${meta}</head>`);
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

export function resolveRendererInteractionStates(
  calls: PluginUiCall[]
): Map<string, PluginRendererInteractionState[]> {
  const latest = new Map<string, { contentHash: string }>();
  for (const call of calls) {
    for (const event of call.events) {
      if (event.type !== "result") continue;
      const output = asRecord(event.output);
      const taskId = typeof output.taskId === "string" ? output.taskId : null;
      if (!taskId || !Array.isArray(output.artifacts)) continue;
      for (const value of output.artifacts) {
        const artifact = asRecord(value);
        if (typeof artifact.kind !== "string" || typeof artifact.contentHash !== "string" || artifact.stale === true) continue;
        latest.set(call.pluginId + ":" + taskId + ":" + artifact.kind, {
          contentHash: artifact.contentHash
        });
      }
    }
  }

  const states = new Map<string, PluginRendererInteractionState[]>();
  for (const call of calls) {
    const callStates: PluginRendererInteractionState[] = [];
    for (const event of call.events) {
      if (event.type !== "interaction") continue;
      const payload = asRecord(event.request.payload);
      const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
      const baseArtifact = asRecord(payload.baseArtifact);
      if (!taskId || typeof baseArtifact.kind !== "string" || typeof baseArtifact.contentHash !== "string") continue;
      const current = latest.get(call.pluginId + ":" + taskId + ":" + baseArtifact.kind);
      let latestContentHash = current?.contentHash;
      let stale = Boolean(current && current.contentHash !== baseArtifact.contentHash);
      if (Array.isArray(payload.artifactSnapshot)) {
        for (const value of payload.artifactSnapshot) {
          const dependency = asRecord(value);
          if (typeof dependency.kind !== "string" || typeof dependency.contentHash !== "string") continue;
          // Older plugin builds used a sentinel for absent optional inputs.
          // It is not an artifact version and must not be compared with a
          // historical artifact observed earlier in the conversation.
          if (dependency.contentHash === "__missing__") continue;
          const latestDependency = latest.get(call.pluginId + ":" + taskId + ":" + dependency.kind);
          if (latestDependency && latestDependency.contentHash !== dependency.contentHash) {
            stale = true;
            latestContentHash = latestDependency.contentHash;
            break;
          }
        }
      }
      if (!stale || !latestContentHash) continue;
      callStates.push({
        interactionId: event.request.interactionId,
        status: "stale",
        error: {
          code: "stale_card",
          message: "This card targets an older artifact version. Load the latest version before submitting.",
          latestContentHash
        }
      });
    }
    if (callStates.length) states.set(call.pluginId + ":" + call.callId, callStates);
  }
  return states;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readOptions(value: unknown): Array<{ label: string; value: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [{ label: item.trim(), value: item }];
    const option = asRecord(item);
    const label = firstString(option, ["label", "name", "title"]);
    return label ? [{ label, value: "value" in option ? option.value : label }] : [];
  });
}

/**
 * Whether an error is the call ending because it was cancelled.
 *
 * A card the user raised is cancelled by the user closing it, so the plugin's
 * report of that cancellation says nothing they do not already know — they
 * asked for the card to go away, not to be told it went away. Whatever the call
 * had already delivered stays on screen; only this notice is dropped.
 */
export function isCancellation(code: string): boolean {
  return code === "cancelled"
    || code === "interaction_cancelled"
    || code === "plugin_call_cancelled"
    // What the runtime reports when `cancel` was called on a live call, which
    // is exactly how a second press on a pinned button closes its card.
    || code === "plugin_cancelled";
}

export interface PluginQuestionField {
  id: string;
  label: string;
  /** Answers are strings on the wire, so option values are read as their labels. */
  options: string[];
  required: boolean;
}

/**
 * Reads the fields of a multi-question card.
 *
 * An entry without an id has nowhere to put its answer and one without a label
 * asks the user nothing, so both are dropped rather than rendered blank.
 */
export function readQuestions(value: unknown): PluginQuestionField[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const question = asRecord(item);
    const id = firstString(question, ["id", "key", "name"]);
    const label = firstString(question, ["label", "question", "prompt", "title"]);
    if (!id || !label || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      label,
      options: readOptions(question.options).map((option) => option.label),
      required: question.required === true
    }];
  });
}

function readStrings(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

interface PluginFileRule {
  extensions: string[];
  disposition: "blocked";
  code: string | null;
  message: string;
}

function readFileRules(value: unknown): PluginFileRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const rule = asRecord(raw);
    const extensions = readStrings(rule.extensions).map((item) => item.toLowerCase());
    const message = firstString(rule, ["message"]);
    if (rule.disposition !== "blocked" || !extensions.length || !message) return [];
    return [{ extensions, disposition: "blocked" as const, code: firstString(rule, ["code"]), message }];
  });
}

function classifyPluginInputFile(
  file: File,
  accept: string,
  maxBytes: number | null,
  rules: PluginFileRule[],
  t: ReturnType<typeof useTranslation>["t"]
): { file: File; status: "ready" | "blocked"; code: string | null; message: string | null } {
  const name = file.name.toLowerCase();
  const rule = rules.find((item) => item.extensions.some((extension) => name.endsWith(extension)));
  if (rule) return { file, status: "blocked", code: rule.code, message: rule.message };
  if (!matchesAccept(file, accept) || !classifyAgentAttachmentFile(file, { allowAudio: true })) {
    return { file, status: "blocked", code: "file_unsupported", message: t("plugin.ui.fileUnsupported") };
  }
  if (maxBytes && file.size > maxBytes) {
    return { file, status: "blocked", code: "file_too_large", message: t("plugin.ui.fileTooLarge") };
  }
  return { file, status: "ready", code: null, message: null };
}

function validateReadyFileCount(files: File[], maxFiles: number | null, t: ReturnType<typeof useTranslation>["t"]): string | null {
  if (maxFiles && files.length > maxFiles) return t("plugin.ui.fileCountExceeded");
  return null;
}

function appendUniqueFiles(existing: File[], selected: File[]): File[] {
  const files = [...existing];
  for (const file of selected) {
    if (!files.some((candidate) => (
      candidate.name === file.name
      && candidate.size === file.size
      && candidate.lastModified === file.lastModified
      && candidate.type === file.type
      && candidate.webkitRelativePath === file.webkitRelativePath
    ))) files.push(file);
  }
  return files;
}

/**
 * Extension families the accept hint is summarized into, in reading order.
 *
 * Format names that are trademarks read the same in every language and stay
 * literal; the two that describe a kind of file rather than a format are
 * translated.
 */
const ACCEPT_FAMILIES: ReadonlyArray<{ label: string | MessageKey; translate?: true; extensions: readonly string[] }> = [
  { label: "PDF", extensions: [".pdf"] },
  { label: "Word", extensions: [".doc", ".docx"] },
  { label: "Excel", extensions: [".xls", ".xlsx", ".xlsm", ".csv"] },
  { label: "PPT", extensions: [".ppt", ".pptx"] },
  { label: "TXT/MD", extensions: [".txt", ".md"] },
  { label: "plugin.ui.format.image", translate: true, extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic"] },
  { label: "plugin.ui.format.media", translate: true, extensions: [".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".amr", ".mp4", ".mov", ".webm"] }
];

/**
 * Summarizes an accept list into the file kinds a person recognises.
 *
 * A raw extension list is long enough to be unreadable, and the user only
 * needs to know whether what they have in hand will be taken.
 *
 * @param accept The card's accept list.
 * @param t The translator, for the families named by kind rather than format.
 * @returns A joined summary, listing unrecognised extensions as themselves.
 */
export function summarizeAcceptedFormats(accept: string, t: ReturnType<typeof useTranslation>["t"]): string {
  const entries = accept.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const labels = ACCEPT_FAMILIES
    .filter((family) => family.extensions.some((extension) => entries.includes(extension)))
    .map((family) => (family.translate ? t(family.label as MessageKey) : family.label));
  const unmatched = entries.filter((entry) => (
    entry.startsWith(".") && !ACCEPT_FAMILIES.some((family) => family.extensions.includes(entry))
  ));
  return [...labels, ...unmatched].join(t("plugin.ui.format.separator"));
}

function matchesAccept(file: File, accept: string): boolean {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  return accept.split(",").some((raw) => {
    const rule = raw.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith(".")) return name.endsWith(rule);
    if (rule.endsWith("/*")) return mime.startsWith(rule.slice(0, -1));
    return mime === rule;
  });
}

export function resolveSafeArtifactUri(raw: string): string | null {
  try {
    const url = new URL(raw, typeof window === "undefined" ? "http://localhost" : window.location.origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
