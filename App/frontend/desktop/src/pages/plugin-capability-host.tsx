import "./plugin-interaction-frame.css";
import { createPortal } from "react-dom";
import { Button } from "../components/button.js";
import { FileTypeIcon } from "../components/file-type-icon.js";
import { AgentAttachmentCard } from "./agent-file-attachment-chip.js";
import type { RecordingArchiveEntry } from "./recording-entry.js";
import {
  createContext,
  useContext,
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
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileOutput,
  FileText,
  Folder,
  Plus,
  Upload,
  HelpCircle,
  LoaderCircle,
  MessageSquarePlus,
  Mic,
  Paperclip,
  PenLine,
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
import { asrRecordingTimeRemainingMs, isLiveAsrTimeout, useAsrRecorder } from "./asr-recorder.js";
import { normalizePluginConversationId, usePluginChatFeedback, usePluginQuestionDrafts, useRecordLegalQuestionAnswer, usePluginRecordingMaterials, usePluginTranscriptions, type PluginChatFeedback, type PluginRecordingMaterial, type PluginUiCall } from "../app/plugin-ui-context.js";
import { handOverRecording } from "../lib/recording-handover.js";
import { PLUGIN_TRANSCRIPTION_ATTEMPTS, type PluginRecordingTranscript, type PluginTranscriptionJob, type PluginTranscriptionState } from "../lib/plugin-transcription-jobs.js";
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
import { RecordingWaveform, WAVE_BARS } from "./recording-waveform.js";
const REVIEW_PLUGIN_ID = "literature-review";
import { themeLiteratureReviewCard } from "./literature-review-card-theme.js";
import { ReviewSourceCard } from "./literature-review-source-card.js";
import "./agent-confirmation-dock.css";
import "./agent-question-card.css";

/** Moving only the bar leaves its microphone owner mounted in the side pane. */
export const RecordingBarPortalContext = createContext<{ target: HTMLElement | null; hidden: boolean } | null>(null);

/** The PoC's model-requested cards take precedence over fixed shortcuts. */
export function isLegalFlowInteraction(call: PluginUiCall): boolean {
  return call.pluginId === "legal-labor"
    && !call.events.some((event) => event.type === "result" || event.type === "error")
    && ((call.capabilityId === "session-start" && guidanceQuestion(call.events) !== undefined)
      || call.events.some((event) => event.type === "interaction" && (
      event.request.type === "file-input"
      || (event.request.type === "question" && readQuestions(asRecord(event.request.payload).questions).length > 0)
    )));
}

/** Any live legal workflow card takes priority over the optional reference guide. */
export function isActiveLegalWorkflowCard(call: PluginUiCall): boolean {
  return call.pluginId === "legal-labor"
    && call.capabilityId !== "guide-open"
    && !call.events.some((event) => event.type === "result" || event.type === "error")
    && call.events.some((event) => event.type === "interaction");
}


const TASK_STATUS_KEYS = {
  pending: "plugin.ui.task.pending",
  running: "plugin.ui.task.running",
  completed: "plugin.ui.task.completed",
  failed: "plugin.ui.task.failed"
} as const;

interface PluginCapabilityHostProps {
  /** The owning Agent turn has ended; do not keep an agent-owned progress row spinning. */
  agentRunActive?: boolean;
  /** Chat surfaces keep all pending confirmations in the composer dock. Standalone plugin pages stay inline. */
  dockInteractions?: boolean;
  calls: PluginUiCall[];
  plugins: InstalledPlugin[];
  client: (Pick<PluginsClient, "getUi" | "cancel" | "respond"> & Partial<Pick<PluginsClient, "readArtifact">>) | null;
  uploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
  /** Backs `audio-record` interactions; the Host transcribes so plugins never receive raw audio. */
  asrClient?: AsrClient;
  onAddArtifact?: (artifact: PluginArtifactRef) => void;
  onOpenArtifact?: (artifact: PluginArtifactRef) => void;
  /** Starts an explicitly requested report after user-raised material collection completes. */
  onRequestDiagnosis?: (call: PluginUiCall) => Promise<void>;
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
  onRecordingArchived?: (entry: RecordingArchiveEntry) => void;
  /** Explicitly cancelled calls, whose cancellation reports stay dismissed. */
  dismissedCallIds?: ReadonlySet<string>;
  /** Hidden pending calls stay mounted so inputs and recordings survive. */
  hiddenCallIds?: ReadonlySet<string>;
  /** A pinned card's close control only hides it. */
  onCallHidden?: (callId: string) => void;
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
 * `panel` keeps the interview microphone owner mounted independently of the
 * cards in the dock. Its bar is portalled above the composer and its transcript
 * is mirrored into the side pane, so hiding a fixed card cannot stop recording.
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
  const recordLegalQuestionAnswer = useRecordLegalQuestionAnswer();
  const [localAnsweredInteractions, setLocalAnsweredInteractions] = useState<Set<string>>(() => new Set());
  const [dismissedCalls, setDismissedCalls] = useState<Set<string>>(() => new Set());
  const diagnosisRequested = useRef(new Set<string>());
  const responseFlights = useRef(new Map<string, Promise<void>>());
  const [diagnosisRetries, setDiagnosisRetries] = useState(new Map<string, PluginUiCall>());
  const retryFlights = useRef(new Set<string>());
  const [retryingDiagnosis, setRetryingDiagnosis] = useState(new Set<string>());
  const [pendingDiagnoses, setPendingDiagnoses] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    for (const call of props.calls) {
      if (!pendingDiagnoses.has(call.callId)) continue;
      const terminal = call.events.find((event) => event.type === "result" || event.type === "error");
      if (!terminal) continue;
      setPendingDiagnoses((current) => { const next = new Set(current); next.delete(call.callId); return next; });
      if (terminal.type === "result" && !diagnosisRequested.current.has(call.callId)) {
        diagnosisRequested.current.add(call.callId);
        void props.onRequestDiagnosis?.(call).catch(() => {
          setDiagnosisRetries((current) => new Map(current).set(call.callId, call));
        });
      }
    }
  }, [props.calls, props.onRequestDiagnosis, pendingDiagnoses]);

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
    const element = event.currentTarget;
    // A card with its own scrolling list — the question card, the upload card —
    // owns the wheel while the pointer is anywhere over it. Reaching the end of
    // the list does not hand the rest of the gesture to the conversation: the
    // user is reading the card, and the chat moving underneath it loses their
    // place. Over the card's header or footer the wheel drives that list, so
    // the whole card scrolls as one thing.
    const scroller = cardScroller(event.target, element);
    if (scroller) {
      if (!(event.target instanceof Node && scroller.contains(event.target))) scroller.scrollTop += event.deltaY;
      return;
    }
    // Only the part of the gesture the card could not use travels on, so the
    // transcript picks up exactly where the card left off.
    const atTop = element.scrollTop <= 0;
    const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
    if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) handler(event.deltaY);
  }, []);
  const plugins = useMemo(() => new Map(props.plugins.map((plugin) => [plugin.id, plugin])), [props.plugins]);
  // A capability can be raised by the Agent through a skill and still have a
  // persistent button above the composer. The command contribution is the
  // source of truth for that relationship; keeping it here avoids a second
  // transcript card for the same interaction.
  const pinnedCapabilities = useMemo(() => new Set(
    props.plugins.flatMap((plugin) => (plugin.manifest.commands ?? [])
      .filter((command) => command.pinned === true)
      .map((command) => `${plugin.id}:${command.capabilityId}`))
  ), [props.plugins]);
  const interactionStates = useMemo(() => resolveRendererInteractionStates(props.calls), [props.calls]);
  const region = props.region ?? "flow";
  const calls = useMemo(
    () => selectRegionPluginCalls(
      occludeUserRaisedCalls(
        selectCurrentPluginCalls(
          selectVisiblePluginCalls(props.calls, answeredInteractions)
            .filter((call) => !dismissedCalls.has(`${call.pluginId}:${call.callId}`))
            .filter((call) => !props.dismissedCallIds?.has(call.callId))
        ), pinnedCapabilities
      ),
      region,
      pinnedCapabilities,
      props.dockInteractions
    ),
    [answeredInteractions, dismissedCalls, pinnedCapabilities, props.calls, props.dismissedCallIds, props.dockInteractions, region]
  );
  const orderedCalls = useMemo(() => orderPluginCallsForDisplay(deduplicateLegalInteractions(calls)), [calls]);
  const displayCalls = orderedCalls.filter((call) => {
    // Agent calls already return their error to the expandable tool result.
    // Do not duplicate it as a persistent block beside the composer.
    if (call.origin === "agent" && call.events.some((event) => event.type === "error")) return false;
    if (props.dockInteractions && call.pluginId === REVIEW_PLUGIN_ID && isStatusOnlyPresentation(call)) return false;
    // Agent-owned Office progress already has a tool row in the conversation.
    if (region === "flow" && call.pluginId === "office" && call.origin === "agent" && isStatusOnlyPresentation(call)) return false;
    // Agent-owned legal progress appears on its tool row. User-started jobs
    // keep this standalone status because they have no Agent tool row.
    if (props.dockInteractions && region === "flow" && call.pluginId === "legal-labor"
      && call.origin === "agent" && isStatusOnlyPresentation(call)) return false;
    if (region === "flow" && props.agentRunActive === false && call.pluginId === "legal-labor"
      && call.origin === "agent" && isStatusOnlyPresentation(call)) return false;
    // Agent-owned files are candidates until the Agent sends them through the
    // ordinary message tool. Do not leave an empty plugin result shell here.
    if (region === "flow" && call.origin === "agent"
      && call.events.some((event) => event.type === "artifact" && event.artifact.role !== "setup")
      && call.events.some((event) => event.type === "result")
      && call.events.every((event) => ["artifact", "result", "progress", "task-list"].includes(event.type))) return false;
    return true;
  });
  const currentRetries = [...diagnosisRetries.values()].filter((retry) => props.calls.some((call) => call.callId === retry.callId));
  if (displayCalls.length === 0 && currentRetries.length === 0) return null;

  return (
    <section
      className={region === "pinned" ? "space-y-3 plugin-capability-region plugin-capability-region--pinned" : "space-y-3 plugin-capability-region"}
      aria-label={t("plugin.ui.regionLabel")}
      style={currentRetries.length === 0 && calls.length > 0 && calls.every((call) => props.hiddenCallIds?.has(call.callId)
        && !call.events.some((event) => event.type === "result" || event.type === "error")) ? { display: "none" } : undefined}
      onWheel={region === "pinned" ? forwardWheelOverflow : undefined}
    >
      {currentRetries.map((call) => <article key={`retry:${call.callId}`} className="diagnostic-upload-card">
        <div className="diagnostic-upload-card__body"><p className="diagnostic-upload-card__description" role="status">{t("plugin.ui.diagnosisSaved")}</p></div>
        <footer className="diagnostic-upload-card__footer"><p role="alert">{t("plugin.ui.responseFailed")}</p>
          <button type="button" className="diagnostic-upload-card__action diagnostic-upload-card__action--primary"
            disabled={retryingDiagnosis.has(call.callId)} onClick={() => {
              if (retryFlights.current.has(call.callId) || !props.onRequestDiagnosis) return;
              retryFlights.current.add(call.callId);
              setRetryingDiagnosis((current) => new Set(current).add(call.callId));
              void props.onRequestDiagnosis(call).then(() => {
                setDiagnosisRetries((current) => { const next = new Map(current); next.delete(call.callId); return next; });
              }).catch(() => undefined).finally(() => {
                retryFlights.current.delete(call.callId);
                setRetryingDiagnosis((current) => { const next = new Set(current); next.delete(call.callId); return next; });
              });
            }}>{t("plugin.ui.generateDiagnosis")}</button>
        </footer>
      </article>)}
      {displayCalls.map((call) => {
        // The review process owns status; keep actionable cards and artifacts here.
        const plugin = plugins.get(call.pluginId);
        const renderer = plugin?.manifest.ui?.renderer;
        const reviewCard = call.pluginId === REVIEW_PLUGIN_ID;
        const reviewDelivery = reviewCard && call.events.some((event) => event.type === "artifact" && event.artifact.role !== "setup");
        const usesRenderer = Boolean(
          renderer
          && (!renderer.capabilities || renderer.capabilities.includes(call.capabilityId))
          && call.events.some((event) => event.type === "interaction" && event.request.type === "custom")
          && !call.events.some((event) => event.type === "result" || event.type === "error")
          && props.client
        );
        const respond = async (interactionId: string, response: unknown) => {
          if (!props.client) return Promise.reject(new Error("Plugin client unavailable"));
          const peers = matchingLegalInteractionCalls(call, selectVisiblePluginCalls(props.calls, answeredInteractions));
          const targets = peers.length ? peers : [call];
          await Promise.all(targets.map(async (target) => {
            const request = target === call ? null : [...target.events].reverse().find((event) => event.type === "interaction");
            const targetId = request?.type === "interaction" ? request.request.interactionId : interactionId;
            const key = interactionKey(target, targetId);
            if (answeredInteractions.has(key)) return;
            const existing = responseFlights.current.get(key);
            if (existing) return existing;
            const flight = props.client!.respond(target.pluginId, target.callId, targetId, response).then(() => {
              if (asRecord(response).action !== "refresh") {
                const answeredRequest = target.events.find((event) => event.type === "interaction" && event.request.interactionId === targetId);
                if (answeredRequest?.type === "interaction") recordLegalQuestionAnswer?.(target, answeredRequest.request, response);
                rememberAnswered(key);
              }
            });
            responseFlights.current.set(key, flight);
            try { await flight; } finally { responseFlights.current.delete(key); }
          }));
        };
        const cancel = () => {
          if (!props.client) return Promise.reject(new Error("Plugin client unavailable"));
          return props.client.cancel(call.pluginId, call.callId);
        };
        const autoPinned = pinnedCapabilities.has(pinnedCapabilityKey(call));
        // Pinned cards can reopen the same interaction. Other dismissals
        // explicitly retire the call and hide its cancellation report.
        const dismiss = async () => {
          if (call.pluginId === "legal-labor" && call.capabilityId === "guide-open") {
            const event = [...call.events].reverse().find((item) => item.type === "interaction");
            if (event?.type === "interaction") await respond(event.request.interactionId, { action: "close" });
            setDismissedCalls((current) => new Set(current).add(`${call.pluginId}:${call.callId}`));
            props.onCallDismissed?.(call.callId);
            return;
          }
          if (isLegalFlowInteraction(call)) {
            const event = [...call.events].reverse().find((item) => item.type === "interaction");
            if (event?.type === "interaction") await respond(event.request.interactionId,
              call.capabilityId === "session-start" && guidanceQuestion(call.events)
                ? { action: "cancel" }
                : event.request.type === "file-input" ? { action: "skip", files: [] } : { action: "skip", answers: {} });
            return;
          }
          if (autoPinned && props.onCallHidden) {
            const peers = matchingLegalInteractionCalls(call, selectVisiblePluginCalls(props.calls, answeredInteractions));
            for (const peer of peers.length ? peers : [call]) props.onCallHidden(peer.callId);
            return;
          }
          setDismissedCalls((current) => new Set(current).add(`${call.pluginId}:${call.callId}`));
          props.onCallDismissed?.(call.callId);
          await cancel().catch(() => undefined);
        };
        const hidden = props.hiddenCallIds?.has(call.callId)
          && !call.events.some((event) => event.type === "result" || event.type === "error");
        const dismissable = (isLegalFlowInteraction(call) || call.origin === "user" || (region === "pinned" && autoPinned))
          && call.events.some((event) => event.type === "interaction")
          && !call.events.some((event) => event.type === "result" || event.type === "error");
        const cards = (
          <GenericPluginCards
            events={call.events}
            conversationId={call.conversationId}
            pluginId={call.pluginId}
            origin={call.origin}
            guidance={call.pluginId === "legal-labor" && ["session-start", "guide-open"].includes(call.capabilityId)}
            guidanceReadOnly={call.pluginId === "legal-labor" && call.capabilityId === "guide-open"}
            diagnosticUpload={call.pluginId === "legal-labor" && ["session-start", "material-collect"].includes(call.capabilityId)}
            hideDeliverables={call.origin === "agent" || call.pluginId === "legal-labor"}
            onGenerateDiagnosis={call.origin === "user" && props.onRequestDiagnosis
              ? () => setPendingDiagnoses((current) => new Set(current).add(call.callId)) : undefined}
            onRespond={respond}
            onCancel={cancel}
            onUploadFiles={props.uploadFiles}
            onDismiss={dismissable ? dismiss : undefined}
            onRecordingSession={props.onRecordingSession} onRecordingArchived={props.onRecordingArchived}
            asrClient={props.asrClient}
            onAddArtifact={props.onAddArtifact}
            onOpenArtifact={props.onOpenArtifact}
            onReadArtifact={props.client?.readArtifact}
          />
        );
        // The recording bar is a single line with its own controls and close
        // button, so wrapping it in card chrome would double the height of the
        // one card that has to stay out of the way for hours.
        // Progress and task-list events are status updates, not user-facing
        // cards. Keep them in the chat flow as text so a job cannot take over
        // the conversation with a second progress panel.
        if (isBarePresentation(call) || isStatusOnlyPresentation(call)
          || (call.pluginId === "legal-labor" && call.events.some((event) => event.type === "error")
            && !call.events.some((event) => event.type === "interaction"))
          || (reviewDelivery && !usesRenderer && (!call.events.some((event) => event.type === "interaction")
            || call.events.some((event) => event.type === "result" || event.type === "error")))
          || isLegalFlowInteraction(call)
          || (call.pluginId === "legal-labor" && ((["session-start", "guide-open"].includes(call.capabilityId) && guidanceQuestion(call.events))
            || (["session-start", "material-collect"].includes(call.capabilityId)
              && call.events.some((event) => event.type === "interaction" && event.request.type === "file-input"))))) return <div key={call.callId} hidden={hidden}>{cards}</div>;
        return (
          <div key={call.callId} hidden={hidden} className={reviewCard ? `review-interaction-shell${usesRenderer ? "" : " review-interaction-shell--native"}` : "rounded-card border border-border-stone/30 bg-background-paper p-3 shadow-sm"}>
            {!reviewCard && <div className="mb-2 flex items-start justify-between gap-2">
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
            </div>}
            {usesRenderer && renderer ? (
              <SandboxedPluginRenderer
                call={call}
                interactionStates={interactionStates.get(call.pluginId + ":" + call.callId) ?? []}
                height={renderer.height ?? 320}
                docked={region === "pinned"}
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
  guidance?: boolean;
  guidanceReadOnly?: boolean;
  diagnosticUpload?: boolean;
  /** Agent-owned file candidates are attached by the main message flow. */
  hideDeliverables?: boolean;
  onGenerateDiagnosis?: () => void;
  events: CapabilityEvent[];
  onRespond(interactionId: string, response: unknown): Promise<void>;
  onCancel(): Promise<void>;
  onUploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
  onDismiss?: () => void | Promise<void>;
  onRecordingSession?: (session: RecordingPanelSession | null) => void;
  onRecordingArchived?: (entry: RecordingArchiveEntry) => void;
  asrClient?: AsrClient;
  onAddArtifact?: (artifact: PluginArtifactRef) => void;
  onOpenArtifact?: (artifact: PluginArtifactRef) => void;
  onReadArtifact?: PluginsClient["readArtifact"];
}) {
  const { t } = useTranslation();
  const terminal = props.events.some((event) => event.type === "result" || event.type === "error");
  const artifactEvents = props.events.filter((event): event is Extract<CapabilityEvent, { type: "artifact" }> => event.type === "artifact");
  // Setup files (templates, checklists) and deliverables are both files, but
  // they answer different questions — "what do I take with me" and "what did
  // this produce" — so they are listed apart and named differently. A single
  // list called 交付文件 made a card full of blank templates read as a finished
  // engagement.
  const setupEvents = props.guidance || props.pluginId !== "legal-labor"
    ? artifactEvents.filter((event) => event.artifact.role === "setup") : [];
  const deliverableEvents = props.hideDeliverables ? [] : artifactEvents.filter((event) => event.artifact.role !== "setup");
  // Template events remain in the call's history after the guide is answered.
  // A bare audio step belongs to the recorder, where those files are unrelated.
  const liveEvents = props.events.filter((event) => event.type !== "artifact");
  const legalProgress = props.pluginId === "legal-labor" && !terminal
    ? liveEvents.find((event): event is Extract<CapabilityEvent, { type: "progress" }> => event.type === "progress") : undefined;
  const legalTasks = props.pluginId === "legal-labor" && !terminal
    ? liveEvents.find((event): event is Extract<CapabilityEvent, { type: "task-list" }> => event.type === "task-list") : undefined;
  const recordingOnly = !terminal && liveEvents.length > 0
    && liveEvents.every((event) => event.type === "interaction" && event.request.type === "audio-record");
  const uploadInteraction = props.diagnosticUpload && !terminal
    ? props.events.find((event) => event.type === "interaction" && event.request.type === "file-input") : undefined;
  if (uploadInteraction?.type === "interaction") return <InteractionCard
    request={uploadInteraction.request} conversationId={props.conversationId} pluginId={props.pluginId}
    diagnosticUpload onGenerateDiagnosis={props.onGenerateDiagnosis} onDismiss={props.onDismiss} onOpenArtifact={props.onOpenArtifact}
    onRespond={props.onRespond} onUploadFiles={props.onUploadFiles} />;
  const guide = props.guidance && !terminal ? guidanceQuestion(props.events) : undefined;
  if (guide && setupEvents.length > 0) return <DiagnosticGuidanceCard
    request={guide} templates={setupEvents} readOnly={props.guidanceReadOnly} onRespond={props.onRespond}
    onClose={props.onDismiss} onRead={props.onReadArtifact} />;
  return (
    <div className="space-y-2">
      {legalProgress || legalTasks ? <LegalProcessStatus progress={legalProgress} tasks={legalTasks} onCancel={props.onCancel} /> : null}
      {props.events.filter((event) => event.type !== "artifact").map((event) => {
        if (event.type === "progress") return terminal || props.pluginId === "legal-labor" ? null : <ProgressText key="progress" event={event} canCancel={Boolean(event.cancellable)} onCancel={props.onCancel} />;
        if (event.type === "task-list") return terminal || props.pluginId === "legal-labor" ? null : <TaskText key="tasks" event={event} />;
        if (event.type === "interaction") {
          return terminal ? null : <InteractionCard key={`interaction:${event.request.interactionId}`} request={event.request} conversationId={props.conversationId} pluginId={props.pluginId} onRespond={props.onRespond} onUploadFiles={props.onUploadFiles} onDismiss={props.onDismiss} onRecordingSession={props.onRecordingSession} onRecordingArchived={props.onRecordingArchived} asrClient={props.asrClient} />;
        }
        if (event.type === "error") {
          return props.origin === "user" && isCancellation(event.code) ? null
            : props.pluginId === "legal-labor" ? <LegalProcessOutcome key="error" event={event} />
              : <ErrorCard key="error" event={event} />;
        }
        return null;
      })}
      {props.pluginId !== "legal-labor" && setupEvents.length > 0 && !recordingOnly ? (
        <ArtifactGroup
          events={setupEvents}
          labelKey="plugin.ui.setupCollection"
          onAddToChat={props.onAddArtifact}
          onOpen={props.onOpenArtifact}
          onRead={props.onReadArtifact}
        />
      ) : null}
      {props.pluginId === REVIEW_PLUGIN_ID && deliverableEvents.length > 0 ? (
        <div className="agent-delivered-files">{deliverableEvents.map((event) => <ArtifactCard key={event.artifact.id} event={event} onAddToChat={props.onAddArtifact} onOpen={props.onOpenArtifact} onRead={props.onReadArtifact} presentation="chat" />)}</div>
      ) : deliverableEvents.length > 1 ? (
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

/** The model's guide has choices; the pinned reference guide only offers downloads. */
function guidanceQuestion(events: CapabilityEvent[]): PluginInteractionRequest | undefined {
  const event = events.find((candidate) => {
    if (candidate.type !== "interaction" || candidate.request.type !== "question") return false;
    const payload = asRecord(candidate.request.payload);
    if (payload.readOnly === true) return true;
    const options = readOptions(payload.options);
    return options.some((option) => option.value === "record") && options.some((option) => option.value === "upload");
  });
  return event?.type === "interaction" ? event.request : undefined;
}

export function DiagnosticGuidanceCard(props: {
  request: PluginInteractionRequest;
  readOnly?: boolean;
  templates: Array<Extract<CapabilityEvent, { type: "artifact" }>>;
  onRespond(interactionId: string, response: unknown): Promise<void>;
  onClose?: () => void | Promise<void>;
  onRead?: PluginsClient["readArtifact"];
}) {
  const { t } = useTranslation();
  const payload = asRecord(props.request.payload);
  const readOnly = props.readOnly === true || payload.readOnly === true;
  const title = firstString(payload, ["title"]) ?? t("plugin.ui.question");
  const description = firstString(payload, ["description", "detail", "hint"]) ?? "";
  const options = readOnly ? [] : readOptions(payload.options);
  const [status, setStatus] = useState<"idle" | "submitting" | "answered" | "error">("idle");
  const submitting = useRef(false);
  const submit = async (value: unknown) => {
    if (submitting.current) return;
    submitting.current = true;
    setStatus("submitting");
    try { await props.onRespond(props.request.interactionId, value); setStatus("answered"); }
    catch { submitting.current = false; setStatus("error"); }
  };
  return <article className="diagnostic-guidance-card" aria-label={title}>
    <header className="diagnostic-guidance-card__header">
      <h3>{title}</h3>
      {props.onClose ? <button type="button" className="diagnostic-guidance-card__close" aria-label={t("plugin.ui.dismissCard")}
        title={t("plugin.ui.dismissCard")} disabled={status === "submitting"} onClick={() => { if (!submitting.current) void props.onClose?.(); }}><X size={15} /></button> : null}
    </header>
    <div className="diagnostic-guidance-card__templates">
      {props.templates.map((event) => {
        const prefix = `《${event.artifact.name}》：`;
        const detail = description.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length) ?? "";
        return <ArtifactCard key={event.artifact.id} event={event} onRead={props.onRead} guidanceDescription={detail} />;
      })}
    </div>
    {!readOnly ? <footer className="diagnostic-guidance-card__footer">
      {options.map((option) => <Button key={String(option.value)} type="button" size="sm" className="diagnostic-guidance-card__action"
        variant={option.value === "record" ? "primary" : "secondary"}
        disabled={status === "submitting" || status === "answered"} onClick={() => void submit(option.value)}>
        {option.value === "record" ? <Mic size={13} aria-hidden="true" /> : <Upload size={13} aria-hidden="true" />}{option.label}
      </Button>)}
      {status === "error" ? <p className="diagnostic-guidance-card__error" role="alert">{t("plugin.ui.responseFailed")}</p> : null}
    </footer> : null}
  </article>;
}

/** Legal jobs expose one current action; their task list is optional detail of that action. */
function LegalProcessStatus(props: {
  progress?: Extract<CapabilityEvent, { type: "progress" }>;
  tasks?: Extract<CapabilityEvent, { type: "task-list" }>;
  onCancel(): Promise<void>;
}) {
  const { t } = useTranslation();
  const [cancelState, setCancelState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const progress = props.progress;
  const tasks = props.tasks?.tasks ?? [];
  const activeTask = tasks.find((task) => task.status === "running") ?? tasks.find((task) => task.status === "pending");
  const label = progress?.message?.trim() || activeTask?.title || t("plugin.ui.progress");
  const percentage = progress?.total && progress.total > 1
    ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : null;
  // Some capabilities report current === total before writing their final file.
  // Treat the text as complete only when the plugin explicitly says so.
  const completed = progress ? progress.total !== undefined && progress.current >= progress.total
    && /\u5b8c\u6210|\u5df2\u751f\u6210|complete|finished/iu.test(label)
    : tasks.length > 0 && tasks.every((task) => task.status === "completed");
  const heading = <>
    {completed ? <Check size={14} className="legal-process-status__complete" aria-hidden="true" />
      : <LoaderCircle size={14} className="legal-process-status__spinner" aria-hidden="true" />}
    <span className="legal-process-status__label">{label}</span>
    {percentage !== null && percentage > 0 && percentage < 100
      ? <span className="legal-process-status__percent">{percentage}%</span> : null}
  </>;
  const cancel = async () => {
    setCancelState("pending");
    try { await props.onCancel(); setCancelState("done"); }
    catch { setCancelState("error"); }
  };
  return <div className="legal-process-status" role="status" aria-live="polite">
    <div className="legal-process-status__row">
      {tasks.length > 0 ? <details className="agent-activity-tool-batch legal-process-status__details">
        <summary className="agent-activity-tool-batch__summary legal-process-status__summary">
          {heading}<ChevronRight size={14} className="agent-activity-tool-batch__chevron" aria-hidden="true" />
        </summary>
        <div className="agent-activity-tool-batch__body legal-process-status__tasks">
          {tasks.map((task) => <div key={task.id} className={`legal-process-status__task legal-process-status__task--${task.status}`}>
            <span className="legal-process-status__task-marker" aria-hidden="true">{task.status === "completed" ? "✓" : "·"}</span>
            <span>{task.title}</span><span className="legal-process-status__task-state">{t(TASK_STATUS_KEYS[task.status])}</span>
          </div>)}
        </div>
      </details> : <div className="legal-process-status__summary">{heading}</div>}
      {progress?.cancellable && cancelState !== "done" ? <button type="button" className="legal-process-status__cancel"
        disabled={cancelState === "pending"} onClick={() => void cancel()}>{t("plugin.ui.cancel")}</button> : null}
      {cancelState === "done" ? <span className="legal-process-status__cancelled">{t("plugin.ui.cancelled")}</span> : null}
    </div>
    {cancelState === "error" ? <span className="legal-process-status__cancel-error" role="alert">{t("plugin.ui.cancelFailed")}</span> : null}
  </div>;
}

function LegalProcessOutcome(props: { event: Extract<CapabilityEvent, { type: "error" }> }) {
  const { t } = useTranslation();
  const cancelled = isCancellation(props.event.code);
  return <div className={`legal-process-outcome${cancelled ? " legal-process-outcome--cancelled" : ""}`}
    role={cancelled ? "status" : "alert"}>
    <AlertCircle size={14} aria-hidden="true" />
    <span>{cancelled ? t("plugin.ui.cancelled") : props.event.message}</span>
  </div>;
}

function ProgressText(props: {
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
    <div className="plugin-status-text" role="status" aria-live="polite">
      <div className="flex min-w-0 items-center gap-2">
        <span className={completed ? "text-status-success" : "text-action-sky"} aria-hidden="true">{completed ? "✓" : "·"}</span>
        <span className="min-w-0 break-words">{props.event.message || t("plugin.ui.progress")}</span>
        {value !== undefined ? <span className="shrink-0 text-xs text-text-ink/45">（{value}%）</span> : null}
        {props.canCancel && cancelState !== "done" ? (
          <button type="button" disabled={cancelState === "pending"} className="ml-auto shrink-0 text-xs text-text-ink/55 hover:text-status-error disabled:opacity-50" onClick={() => void cancel()}>
            {t("plugin.ui.cancel")}
          </button>
        ) : null}
        {cancelState === "done" ? <span className="ml-auto shrink-0 text-xs text-text-ink/45">{t("plugin.ui.cancelled")}</span> : null}
      </div>
      {cancelState === "error" ? <span className="mt-1 block text-xs text-status-error" role="alert">{t("plugin.ui.cancelFailed")}</span> : null}
    </div>
  );
}

function TaskText(props: { event: Extract<CapabilityEvent, { type: "task-list" }> }) {
  const { t } = useTranslation();
  return (
    <div className="plugin-status-text" role="status" aria-live="polite">
      <span className="sr-only">{t("plugin.ui.tasks")}: </span>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {props.event.tasks.map((task) => {
          return (
            <span key={task.id} className={`inline-flex items-center gap-1 text-sm text-text-ink/65 ${task.status === "completed" ? "review-task-completed" : ""}`}>
              {task.status === "running" ? <span aria-hidden="true" className="review-task-spinner" /> : null}
              {task.title}（{t(TASK_STATUS_KEYS[task.status])}）
            </span>
          );
        })}
      </div>
    </div>
  );
}

function InteractionCard(props: {
  conversationId?: string;
  pluginId?: string;
  request: PluginInteractionRequest;
  diagnosticUpload?: boolean;
  onOpenArtifact?: (artifact: PluginArtifactRef) => void;
  onGenerateDiagnosis?: () => void;
  onRespond(interactionId: string, response: unknown): Promise<void>;
  onUploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
  onDismiss?: () => void | Promise<void>;
  onRecordingSession?: (session: RecordingPanelSession | null) => void;
  onRecordingArchived?: (entry: RecordingArchiveEntry) => void;
  asrClient?: AsrClient;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState<unknown[]>([]);
  const [status, setStatus] = useState<"idle" | "submitting" | "answered" | "error">("idle");
  const payload = asRecord(props.request.payload);
  const title = firstString(payload, ["title", "question", "prompt", "message"])
    ?? (props.request.type === "approval" ? t("plugin.ui.approval") : t("plugin.ui.question"));
  const description = props.pluginId === REVIEW_PLUGIN_ID ? null : firstString(payload, ["description", "detail", "hint"]);
  const options = readOptions(payload.options);
  const questions = readQuestions(payload.questions);
  const multiple = payload.multiple === true;
  const allowText = questions.length === 0 && (options.length === 0 || payload.allowText === true);
  const disabled = status === "submitting" || status === "answered";
  const submitting = useRef(false);

  const submit = async (response: unknown) => {
    if (submitting.current) return;
    submitting.current = true;
    setStatus("submitting");
    try {
      await props.onRespond(props.request.interactionId, response);
      setStatus("answered");
    } catch {
      submitting.current = false;
      setStatus("error");
    }
  };
  const submitText = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) void submit(value.trim());
  };

  if (props.request.type === "file-input") {
    return <FileInputCard onOpenArtifact={props.onOpenArtifact} diagnosticUpload={props.diagnosticUpload} onGenerateDiagnosis={props.onGenerateDiagnosis} onClose={props.onDismiss} conversationId={props.conversationId} pluginId={props.pluginId} request={props.request} title={title} description={description} disabled={disabled} status={status} onStatus={setStatus} onRespond={props.onRespond} onUploadFiles={props.onUploadFiles} />;
  }

  if (props.request.type === "audio-record") {
    return (
      <AudioRecordCard
        conversationId={props.conversationId}
        request={props.request}
        title={props.pluginId === "legal-labor" ? t("recording.page.title") : title}
        interview={props.pluginId === "legal-labor"}
        description={description}
        status={status}
        onStatus={setStatus}
        onRespond={props.onRespond}
        onDismiss={props.onDismiss}
        onRecordingSession={props.onRecordingSession} onRecordingArchived={props.onRecordingArchived}
        asrClient={props.asrClient}
        uploadFiles={props.onUploadFiles}
      />
    );
  }

  if (props.pluginId === "legal-labor" && questions.length > 0) return <QuestionFields
    legal draftKey={JSON.stringify([props.pluginId, props.conversationId, props.request.interactionId])} title={title} description={description} questions={questions} disabled={disabled}
    error={status === "error" ? t("plugin.ui.responseFailed") : null}
    onSubmit={(answers) => void submit({ answers })}
    onClose={(answers) => void submit({ action: "skip", answers })} />;

  return (
    <div className={props.pluginId === REVIEW_PLUGIN_ID ? "review-native-card" : "rounded-card border border-action-sky/25 bg-action-sky/8 px-3 py-3"}>
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
  conversationId?: string;
  request: PluginInteractionRequest;
  title: string;
  interview?: boolean;
  description: string | null;
  status: "idle" | "submitting" | "answered" | "error";
  onStatus(value: "idle" | "submitting" | "answered" | "error"): void;
  onRespond(interactionId: string, response: unknown): Promise<void>;
  onDismiss?: () => void | Promise<void>;
  onRecordingSession?: (session: RecordingPanelSession | null) => void;
  onRecordingArchived?: (entry: RecordingArchiveEntry) => void;
  asrClient?: AsrClient;
  uploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
}) {
  const { t } = useTranslation();
  const payload = asRecord(props.request.payload);
  const portal = useContext(RecordingBarPortalContext);
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
      onLevel: (level) => setLevels((current) => pushWaveformLevel(current, level, WAVE_BARS)),
      onError: (liveErr) => setLiveError((current) => current ?? (isLiveAsrTimeout(liveErr) ? t("plugin.ui.audio.liveTimeout") : liveErr.message))
    }
  });
  const answered = props.status === "answered";
  const submitting = useRef(false);
  const starting = useRef(false);
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
    if (audioUrl?.startsWith("blob:")) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const transcriptionJobs = usePluginTranscriptions();
  const finish = async () => {
    if (submitting.current || busy || answered) return;
    submitting.current = true;
    props.onStatus("submitting");
    const sessionKey = props.conversationId
      ? (props.conversationId.startsWith("websocket:") ? props.conversationId : `websocket:${props.conversationId}`)
      : undefined;
    // An interview is handed over the moment it stops. Transcribing half an
    // hour of audio takes minutes, and the upload card that follows must be
    // usable straight away; the transcription carries on at page level and
    // the upload card waits for it when the user submits.
    if (props.interview && props.asrClient && props.uploadFiles && transcriptionJobs && props.conversationId) {
      try {
        const stopped = await recorder.stop();
        const durationMs = stopped.durationMs ?? elapsedMs;
        const blobUrl = URL.createObjectURL(stopped.recording);
        setAudioUrl(blobUrl);
        const { audio, job, transcriptName } = await handOverRecording({
          stopped, asrClient: props.asrClient, uploadFiles: props.uploadFiles,
          startTranscription: transcriptionJobs.startTranscription, t, diarization
        });
        // The row stands for the transcript — that is what the interview adds to
        // the diagnosis — and it is named for the file ASR is still writing.
        // The plugin already receives the recording on the response below, so
        // the row is staged as collected: only its text still has to travel.
        const pendingRow: PluginRecordingMaterial = {
          kind: "file", path: audio.path, url: audio.url, name: transcriptName, mime: "text/plain", bytes: 0,
          collected: true, pending: true, pendingAudio: audio
        };
        transcriptionJobs.addRecordingMaterials("legal-labor", props.conversationId, [pendingRow]);
        finishedRef.current = true;
        const panel = (status: RecordingPanelSession["status"], text: RecordingPanelTranscript | null) => props.onRecordingSession?.({
          title: props.title, status, elapsedMs: durationMs, lines, transcript: text, audioUrl: audio.url,
          onPause: () => undefined, onResume: () => undefined, onFinish: () => undefined,
          onClose: () => props.onRecordingSession?.(null)
        });
        panel("transcribing", null);
        // Archived before the card can disappear, so the interview is in the
        // recording list even while its transcript is still being produced;
        // the list follows the job until the finished entry replaces this one.
        const pendingEntry: RecordingArchiveEntry = {
          id: `plugin:${audio.path}`, title: props.title, recordedAt: new Date().toISOString(), durationMs,
          speakerCount: 0, transcript: { text: "", segments: [] }, audioUrl: audio.url, audioPath: audio.path,
          status: "transcribing", ...(sessionKey ? { sessionKey } : {}), collected: true, handedOver: true, files: []
        };
        props.onRecordingArchived?.(pendingEntry);
        await props.onRespond(props.request.interactionId, {
          text: "", segments: [], durationMs, audio, transcriptPending: true
        });
        props.onStatus("answered");
        // This card is gone by now; the closures below still reach the page.
        void job.wait().then((result) => {
          if (!result) return;
          const transcriptText = { text: result.text, segments: result.segments };
          panel("done", transcriptText);
          props.onRecordingArchived?.({
            ...pendingEntry, recordedAt: result.transcribedAt,
            speakerCount: new Set(result.segments.map((segment) => segment.speakerId ?? 0)).size || 1,
            transcript: transcriptText, status: "ready",
            files: [audio, result.transcriptFile].filter((file): file is UploadedAgentMedia => file !== undefined)
          });
        });
      } catch {
        submitting.current = false;
        props.onStatus("error");
      }
      return;
    }
    try {
      const result = await recorder.finishAndTranscribe({ diarization });
      const blobUrl = URL.createObjectURL(result.recording);
      setAudioUrl(blobUrl);
      setTranscript({ text: result.text, segments: result.segments ?? [] });
      // The recording and its transcript are deliverables in their own right,
      // so both are persisted and handed back as files. The plugin still never
      // receives audio bytes, only a Host-owned path.
      const files = await persistRecording(result, t, props.uploadFiles);
      if (files.audio) setAudioUrl(files.audio.url);
      const archived: RecordingArchiveEntry = {
        id: `plugin:${files.audio?.path ?? props.request.interactionId}`, title: props.title,
        recordedAt: result.transcribedAt, durationMs: result.durationMs ?? elapsedMs,
        speakerCount: new Set((result.segments ?? []).map((segment) => segment.speakerId ?? 0)).size || 1,
        transcript: { text: result.text, segments: result.segments ?? [] },
        audioUrl: files.audio?.url ?? blobUrl, status: "ready",
        ...(files.audio ? { audioPath: files.audio.path } : {}),
        ...(props.conversationId ? { sessionKey: props.conversationId.startsWith("websocket:")
          ? props.conversationId : `websocket:${props.conversationId}` } : {}),
        files: [files.audio, files.transcript].filter((file): file is UploadedAgentMedia => file !== undefined)
      };
      props.onRecordingArchived?.(archived);
      // Responding may immediately unmount this card. Publish the durable URL
      // synchronously instead of waiting for a React effect that might never run.
      finishedRef.current = true;
      props.onRecordingSession?.({
        title: props.title, status: "done", elapsedMs: result.durationMs ?? elapsedMs,
        lines, transcript: { text: result.text, segments: result.segments ?? [] },
        audioUrl: files.audio?.url ?? blobUrl,
        onPause: () => undefined, onResume: () => undefined, onFinish: () => undefined,
        onClose: () => props.onRecordingSession?.(null)
      });
      await props.onRespond(props.request.interactionId, {
        text: result.text,
        segments: result.segments ?? [],
        durationMs: result.durationMs ?? elapsedMs,
        transcribedAt: result.transcribedAt,
        ...files
      });
      props.onRecordingArchived?.({ ...archived, collected: true });
      props.onStatus("answered");
    } catch {
      submitting.current = false;
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
    if (submitting.current || busy || answered) return;
    submitting.current = true;
    recorder.cancel();
    props.onStatus("submitting");
    try {
      await props.onRespond(props.request.interactionId, { text: "", segments: [], durationMs: 0 });
      props.onStatus("answered");
    } catch {
      submitting.current = false;
      props.onStatus("error");
    }
  };

  const start = () => {
    if (starting.current || submitting.current || busy || answered || recorder.isRecording || recorder.isStarting) return;
    starting.current = true;
    setElapsedMs(0);
    setLines([]);
    setLevels([]);
    setTranscript(null);
    setLiveError(null);
    finishedRef.current = false;
    void recorder.start().catch(() => undefined).finally(() => { starting.current = false; });
  };

  // The panel mirrors the card, so it is published from the card's own state
  // rather than kept in a second copy that could drift.
  const panelStatus: RecordingPanelSession["status"] = recorder.status === "paused"
    ? "paused"
    : recorder.isTranscribing
      ? "transcribing"
      : recorder.isRecording
        ? "recording"
        : recorder.isStarting ? "starting" : transcript ? "done" : "idle";
  const publish = props.onRecordingSession;
  // A finished transcript is the recording's deliverable and the design keeps
  // it on screen next to the upload card that follows, so it outlives this
  // card. Read through a ref because the unmount below sees only the first
  // render's closure.
  const finishedRef = useRef(false);
  // Sticky: a handed-over interview finishes before its transcript exists.
  if (transcript !== null) finishedRef.current = true;
  useEffect(() => {
    if (!publish) return;
    publish({
      title: props.title,
      status: panelStatus,
      elapsedMs,
      lines,
      transcript,
      audioUrl,
      onStart: start,
      onPause: () => recorder.pause(),
      onResume: () => recorder.resume(),
      onFinish: () => void finish(),
      onClose: () => publish(null)
    });
  }, [publish, panelStatus, elapsedMs, lines, transcript, audioUrl, props.title]);
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

  const bar = (
    <div className={`recording-bar${props.interview ? " recording-bar--interview" : ""}${recorder.isRecording ? " recording-bar--live" : ""}`}>
      <span className="recording-bar__icon" aria-hidden="true"><Mic size={props.interview ? 18 : 14} /></span>
      <p className="recording-bar__title">
        {recorder.isRecording
          ? (recorder.status === "paused" ? t("plugin.ui.audio.paused") : t("plugin.ui.audio.recording"))
          : props.title}
      </p>
      <span className="recording-bar__clock" role="timer" aria-label={t("plugin.ui.audio.elapsed")}>
        {formatClock(elapsedMs)}
      </span>
      <RecordingWaveform levels={levels} active={recorder.status === "recording"}
        idle={!recorder.isRecording && !recorder.isTranscribing && !answered && elapsedMs === 0} />
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
            // Explicit dismissal unmounts this card and the recorder cleans
            // up then. A visibility-only close keeps the recorder running.
            onClick={props.onDismiss}
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
  return portal ? (portal.target ? createPortal(<div hidden={portal.hidden}>{bar}</div>, portal.target) : null) : bar;
}

/** Point at which the recording card starts counting down to the hard stop. */
const REMAINING_WARNING_MS = 5 * 60 * 1_000;

function formatUploadFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Only responses that carry a handed-over recording's text grow the extra field. */
function transcriptField(transcripts: Record<string, unknown>): { transcripts?: Record<string, unknown> } {
  return Object.keys(transcripts).length ? { transcripts } : {};
}

/** Keeps recording files out of the material list while still handing them to the final delivery. */
function recordingDeliverableField(files: UploadedAgentMedia[]): { recordingDeliverables?: UploadedAgentMedia[] } {
  return files.length ? { recordingDeliverables: files } : {};
}

/**
 * How a staged recording's transcription is doing, under its file name.
 *
 * Failure only shows once the automatic retries are spent. The retry action
 * stays available while a submission waits for the recording's text.
 */
function StagedTranscriptionStatus(props: { state?: PluginTranscriptionState; job?: PluginTranscriptionJob }) {
  const { t } = useTranslation();
  const state = props.state;
  if (!state || state.status === "ready") return null;
  if (state.status === "transcribing") {
    return <p className="diagnostic-upload-card__transcription" role="status">
      {state.attempt > 1 ? t("plugin.ui.audio.retryingRow", { attempt: state.attempt - 1 }) : t("plugin.ui.audio.transcribingRow")}
    </p>;
  }
  if (state.status === "skipped") return <p className="diagnostic-upload-card__transcription">{t("plugin.ui.audio.skippedRow")}</p>;
  return <div className="diagnostic-upload-card__transcription diagnostic-upload-card__transcription--failed" role="alert">
    <span>{t("plugin.ui.audio.transcriptionFailedRow", { attempts: PLUGIN_TRANSCRIPTION_ATTEMPTS })}</span>
    <button type="button" onClick={() => props.job?.retry()}>{t("plugin.ui.audio.retryTranscription")}</button>
  </div>;
}

export function FileInputCard(props: {
  conversationId?: string;
  pluginId?: string;
  request: PluginInteractionRequest;
  diagnosticUpload?: boolean;
  onOpenArtifact?: (artifact: PluginArtifactRef) => void;
  onGenerateDiagnosis?: () => void;
  onClose?: () => void | Promise<void>;
  title: string;
  description: string | null;
  disabled: boolean;
  status: "idle" | "submitting" | "answered" | "error";
  onStatus(value: "idle" | "submitting" | "answered" | "error"): void;
  onRespond(interactionId: string, response: unknown): Promise<void>;
  onUploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
}) {
  const { t, language } = useTranslation();
  const payload = asRecord(props.request.payload);
  const recordingMaterials = usePluginRecordingMaterials(props.diagnosticUpload ? props.pluginId : undefined, props.conversationId);
  const stagedFiles = recordingMaterials.files;

  const reviewImport = props.pluginId === "literature-review" && payload.cardType === "source-import";
  const [files, setFiles] = useState<File[]>([]);
  const [skippedFromFolder, setSkippedFromFolder] = useState(0);
  const localPreviewUrls = useRef<string[]>([]);
  useEffect(() => () => { for (const uri of localPreviewUrls.current) URL.revokeObjectURL(uri); }, []);
  const openSelected = (file: File) => {
    const uri = URL.createObjectURL(file);
    localPreviewUrls.current.push(uri);
    props.onOpenArtifact?.({ id: uri, uri, name: file.name, mediaType: file.type || "application/octet-stream" });
  };
  const submitting = useRef(false);
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
    if (!feedback || props.disabled || submitting.current) return;
    submitting.current = true;
    pendingFeedback.current = null;
    fileDrafts?.set(fileDraftKey, files);
    props.onStatus("submitting");
    try {
      await props.onRespond(props.request.interactionId, { action: "chat-feedback", ...feedback, files: [], values: { selectedFileNames: files.map((file) => file.name) } });
      props.onStatus("answered");
    } catch { submitting.current = false; props.onStatus("error"); }
  }

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const transcriptionJobs = usePluginTranscriptions();
  const [waitingForTranscripts, setWaitingForTranscripts] = useState(false);
  useEffect(() => {
    // Older sessions may already contain both the pending audio-path row and
    // the completed transcript-path row. The pending row owns the handover;
    // once ready it displays the transcript file's metadata itself.
    const redundant = new Set(stagedFiles.flatMap((file) => {
      if (!file.pending) return [];
      const state = transcriptionJobs?.transcriptions.get(file.path);
      return state?.status === "ready" && state.transcript.transcriptFile?.path
        ? [state.transcript.transcriptFile.path] : [];
    }));
    if (!redundant.size || !stagedFiles.some((file) => !file.pending && redundant.has(file.path))) return;
    recordingMaterials.update(stagedFiles.filter((file) => file.pending || !redundant.has(file.path)));
  }, [stagedFiles, transcriptionJobs?.transcriptions, recordingMaterials.update]);
  /**
   * Resolves the staged recordings into what the plugin receives.
   *
   * A recording that is still being transcribed is listed and submittable, so
   * the user is never held at this card. What is sent still has to be the
   * transcript, not a gap where the interview should be — so submitting waits
   * here for any transcription in flight, and the card carries on by itself
   * once it lands. The plugin already holds a collected recording, so only its
   * text travels; one it has not seen goes as the transcript file.
   */
  const collectStaged = async (keepPending = false) => {
    const transcripts: Record<string, { text: string; segments: PluginRecordingTranscript["segments"] }> = {};
    const recordingDeliverables: UploadedAgentMedia[] = [];
    const jobs = stagedFiles.map((file) => transcriptionJobs?.transcriptionJob(file.path));
    if (jobs.some((job) => job && job.state.status !== "ready")) setWaitingForTranscripts(true);
    try {
      const results = await Promise.all(jobs.map((job) => job?.wait()));
      const files: UploadedAgentMedia[] = [];
      const retained: PluginRecordingMaterial[] = [];
      stagedFiles.forEach((file, index) => {
        const { collected, pending: _pending, pendingAudio, ...media } = file;
        if (!file.pending) {
          if (!collected) files.push(media);
          return;
        }
        const result = results[index];
        if (result) {
          if (pendingAudio) recordingDeliverables.push(pendingAudio);
          if (result.transcriptFile) recordingDeliverables.push(result.transcriptFile);
          // A recording the plugin already holds gets its text attached to that
          // material, keyed by the recording's path. One it never saw arrives
          // as the transcript file instead. Sending both would put the same
          // interview into the session twice.
          if (collected) transcripts[file.path] = { text: result.text, segments: result.segments };
          else if (result.transcriptFile) files.push(result.transcriptFile);
          return;
        }
        // No transcript. Closing the card is not a decision about the
        // recording, so the row stays for the next round rather than being
        // resolved by a submission the user never made.
        if (keepPending) { retained.push(file); return; }
        // The user chose to go on without the text: hand the audio over so the
        // plugin can read it itself. A recording the plugin already holds
        // needs nothing, which is the case once its text has been delivered.
        if (!collected && file.pendingAudio) files.push(file.pendingAudio);
      });
      return { transcripts, files, recordingDeliverables, retained };
    } finally {
      setWaitingForTranscripts(false);
    }
  };
  const close = async () => {
    if (submitting.current || props.disabled) return;
    submitting.current = true;
    props.onStatus("submitting");
    fileDrafts?.set(fileDraftKey, files);
    try {
      // Closing skips this collection round; selected files stay in the draft.
      // A recording still being transcribed keeps its row, so its text travels
      // with the next card instead of being lost with this one.
      const staged = await collectStaged(true);
      await props.onRespond(props.request.interactionId, {
        action: "skip",
        files: staged.files,
        ...transcriptField(staged.transcripts),
        ...recordingDeliverableField(staged.recordingDeliverables)
      });
      recordingMaterials.update(staged.retained);
      props.onStatus("answered");
      props.onGenerateDiagnosis?.();
    } catch { submitting.current = false; props.onStatus("error"); }
  };
  const [validationError, setValidationError] = useState<string | null>(null);
  const accept = readStrings(payload.accept).join(",");
  const fileRules = readFileRules(payload.fileRules);
  const maxFiles = positiveInteger(payload.maxFiles) ?? (payload.multiple === true ? null : 1);
  const minFiles = positiveInteger(payload.minFiles) ?? 0;
  const maxBytes = positiveInteger(payload.maxBytes);
  const fileStates = files.map((file) => classifyPluginInputFile(file, accept, maxBytes, fileRules, t));
  const readyFiles = fileStates.filter((item) => item.status === "ready").map((item) => item.file);
  const addFiles = (picked: File[]) => {
    if (submitting.current || props.disabled) return;
    // Picking again adds to the selection instead of replacing it. A lawyer
    // assembling a case pulls together a transcript, a workbook and a handful
    // of scans; replacing meant each new file pushed the last one out, so the
    // only way to send several was to hand over a whole folder. A single-file
    // card keeps replacing, where the second pick is a new choice.
    const next = payload.multiple === true ? appendUniqueFiles(files, picked) : picked;
    setFiles(next);
    if (fileDrafts?.has(fileDraftKey)) fileDrafts.set(fileDraftKey, next);
    const nextReady = next.filter((file) => classifyPluginInputFile(file, accept, maxBytes, fileRules, t).status === "ready");
    setValidationError(validateReadyFileCount([...nextReady, ...stagedFiles], maxFiles, minFiles, t));
  };
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    setSkippedFromFolder(0);
    addFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };
  const chooseReviewFolder = (picked: File[]) => {
    const supported = picked.filter((file) => classifyPluginInputFile(file, accept, maxBytes, fileRules, t).status === "ready");
    const available = maxFiles ? Math.max(0, maxFiles - readyFiles.length) : supported.length;
    const accepted = supported.slice(0, available);
    setSkippedFromFolder(picked.length - accepted.length);
    if (accepted.length) addFiles(accepted);
  };
  const remove = (index: number) => {
    if (submitting.current || props.disabled) return;
    const next = files.filter((_file, candidateIndex) => candidateIndex !== index);
    setFiles(next);
    if (fileDrafts?.has(fileDraftKey)) {
      if (next.length) fileDrafts.set(fileDraftKey, next);
      else fileDrafts.delete(fileDraftKey);
    }
    const nextReady = next.filter((file) => classifyPluginInputFile(file, accept, maxBytes, fileRules, t).status === "ready");
    setValidationError(validateReadyFileCount([...nextReady, ...stagedFiles], maxFiles, minFiles, t));
  };
  const upload = async () => {
    if (submitting.current || props.disabled) return;
    const error = validateReadyFileCount([...readyFiles, ...stagedFiles], maxFiles, minFiles, t);
    if (error || !props.onUploadFiles) {
      setValidationError(error ?? t("plugin.ui.responseFailed"));
      return;
    }
    submitting.current = true;
    props.onStatus("submitting");
    try {
      const uploaded = readyFiles.length ? await props.onUploadFiles(readyFiles.map((file) => {
        const classification = classifyAgentAttachmentFile(file, { allowAudio: true })!;
        return { blob: file, name: file.name, kind: classification.kind, mime: classification.mime };
      })) : [];
      const staged = await collectStaged();
      const submitted = [...staged.files, ...uploaded];
      const feedback = pendingFeedback.current;
      if (feedback) {
        pendingFeedback.current = null;
        fileDrafts?.set(fileDraftKey, files);
        await props.onRespond(props.request.interactionId, { action: "chat-feedback", ...feedback, files: [],
          values: { selectedFileNames: files.map((file) => file.name), stagedFiles: submitted },
          ...transcriptField(staged.transcripts), ...recordingDeliverableField(staged.recordingDeliverables) });
      } else {
        await props.onRespond(props.request.interactionId, {
          files: submitted,
          ...transcriptField(staged.transcripts),
          ...recordingDeliverableField(staged.recordingDeliverables)
        });
        recordingMaterials.update(staged.retained);
        fileDrafts?.delete(fileDraftKey);
      }
      props.onStatus("answered");
      if (!feedback) props.onGenerateDiagnosis?.();
    } catch {
      submitting.current = false;
      props.onStatus("error");
    }
  };
  const skip = async () => {
    if (submitting.current || props.disabled) return;
    submitting.current = true;
    props.onStatus("submitting");
    try {
      await props.onRespond(props.request.interactionId, { files: [] });
      props.onStatus("answered");
    } catch {
      submitting.current = false;
      props.onStatus("error");
    }
  };
  if (props.diagnosticUpload) return <article className="diagnostic-upload-card" aria-label={props.title}>
    <header className="diagnostic-upload-card__header">
      <h3>{props.title}</h3>
      {files.length + stagedFiles.length > 0 ? <span className="diagnostic-upload-card__count">{t("plugin.ui.fileCount", { count: files.length + stagedFiles.length })}</span> : null}
      {props.onClose ? <button type="button" className="diagnostic-upload-card__close" aria-label={t("plugin.ui.dismissCard")}
        disabled={props.disabled} onClick={() => { void close(); }}><X size={18} /></button> : null}
    </header>
    <div className={`diagnostic-upload-card__body${dragging ? " diagnostic-upload-card__body--dragging" : ""}`}
      onDragOver={(event) => { if (!props.disabled) { event.preventDefault(); event.stopPropagation(); setDragging(true); } }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); event.stopPropagation(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }}>
      {fileStates.length || stagedFiles.length ? <ul className="diagnostic-upload-card__files" aria-label={t("plugin.ui.selectedFiles")}>
        {stagedFiles.map((file) => {
          const transcriptionState = transcriptionJobs?.transcriptions.get(file.path);
          const transcriptFile = transcriptionState?.status === "ready" ? transcriptionState.transcript.transcriptFile : undefined;
          const displayFile = transcriptFile ?? file;
          const canOpen = Boolean(props.onOpenArtifact) && (!file.pending || Boolean(transcriptFile));
          return <li key={file.path} className="diagnostic-upload-card__file">
            <span className="diagnostic-upload-card__file-icon"><FileTypeIcon name={displayFile.name} mime={displayFile.mime} surface="row" /></span>
            <div className="diagnostic-upload-card__file-info"><button type="button" disabled={!canOpen} title={displayFile.name} onClick={() => props.onOpenArtifact?.({ id: displayFile.path, path: displayFile.path, uri: displayFile.path, name: displayFile.name, mediaType: displayFile.mime })}>{displayFile.name}</button>
              <StagedTranscriptionStatus state={transcriptionState} job={transcriptionJobs?.transcriptionJob(file.path)} /></div>
            <span className="diagnostic-upload-card__file-size">{formatUploadFileSize(displayFile.bytes)}</span>
            <button type="button" className="diagnostic-upload-card__remove" disabled={props.disabled}
              aria-label={t("plugin.ui.removeFile", { name: displayFile.name })}
              onClick={() => recordingMaterials.update(stagedFiles.filter((item) => item.path !== file.path))}><X size={17} /></button>
          </li>;
        })}
        {fileStates.map((item, index) => {
          return <li key={`${item.file.name}:${item.file.size}:${index}`} className="diagnostic-upload-card__file">
            <span className="diagnostic-upload-card__file-icon"><FileTypeIcon name={item.file.name} mime={item.file.type} surface="row" /></span>
            <div className="diagnostic-upload-card__file-info">
              <button type="button" disabled={!props.onOpenArtifact} title={item.file.webkitRelativePath || item.file.name} onClick={() => openSelected(item.file)}>{item.file.webkitRelativePath || item.file.name}</button>
              {item.status === "blocked" ? <p className="diagnostic-upload-card__error" role="alert">{item.message}</p> : null}
            </div>
            <span className="diagnostic-upload-card__file-size">{formatUploadFileSize(item.file.size)}</span>
            <button type="button" className="diagnostic-upload-card__remove" disabled={props.disabled}
              aria-label={t("plugin.ui.removeFile", { name: item.file.name })} onClick={() => remove(index)}><X size={17} /></button>
          </li>;
        })}
      </ul> : <button type="button" className="diagnostic-upload-card__dropzone" disabled={props.disabled} onClick={() => fileInputRef.current?.click()}><Upload size={20} aria-hidden="true" /><span>{t("plugin.ui.dropFiles")}</span></button>}
      <div className="diagnostic-upload-card__pickers">
        <label className="diagnostic-upload-card__picker"><Plus size={16} aria-hidden="true" />{t("plugin.ui.uploadFiles")}
          <input ref={fileInputRef} className="sr-only" type="file" aria-label={t("plugin.ui.uploadFiles")} accept={accept || undefined}
            multiple={payload.multiple === true} disabled={props.disabled} onChange={choose} />
        </label>
        {payload.allowDirectory === true ? <label className="diagnostic-upload-card__picker"><Folder size={16} aria-hidden="true" />{t("plugin.ui.chooseFolder")}
          <input className="sr-only" type="file" aria-label={t("plugin.ui.chooseFolder")} multiple disabled={props.disabled}
            onChange={choose} {...{ webkitdirectory: "" } as Record<string, string>} />
        </label> : null}
      </div>
      {validationError ? <p className="diagnostic-upload-card__error" role="alert">{validationError}</p> : null}
      {props.status === "error" ? <p className="diagnostic-upload-card__error" role="alert">{t("plugin.ui.responseFailed")}</p> : null}
      {props.status === "answered" ? <p role="status">{t("plugin.ui.answered")}</p> : null}
      {waitingForTranscripts ? <p className="diagnostic-upload-card__waiting" role="status">{t("plugin.ui.audio.waitingForTranscription")}</p> : null}
    </div>
    <footer className="diagnostic-upload-card__footer">
      {accept ? <p>{t("plugin.ui.acceptedFormats", { formats: summarizeAcceptedFormats(accept, t) })}</p> : null}
      <Button type="button" variant="primary" size="sm"
        disabled={props.disabled || readyFiles.length + stagedFiles.length === 0 || Boolean(validationError) || !props.onUploadFiles}
        onClick={() => void upload()}>{t("plugin.ui.generateDiagnosis")}</Button>
    </footer>
  </article>;
  if (props.pluginId === REVIEW_PLUGIN_ID && payload.cardType === "source-import" && !payload.targetPaperId) return <ReviewSourceCard
    files={fileStates.map((item) => ({ file: item.file, blocked: item.status === "blocked" ? item.message : null }))}
    accept={accept} maxFiles={maxFiles} validationError={validationError}
    skippedFromFolder={skippedFromFolder} status={props.status} disabled={props.disabled}
    canUpload={Boolean(props.onUploadFiles) && readyFiles.length > 0} english={language === "en-US"}
    onFilesPicked={(picked) => { setSkippedFromFolder(0); addFiles(picked); }} onFolderPicked={chooseReviewFolder}
    onRemove={remove} onConfirm={() => { void upload(); }} onSkip={() => { void skip(); }} />;
  if (props.pluginId === REVIEW_PLUGIN_ID) return <article className="review-native-card review-source-card">
    <header className="review-card-header"><h3>{props.title}</h3>{files.length > 0 && <span>{t("plugin.ui.fileCount", { count: files.length })}</span>}</header>
    <div className="review-card-body">
      <p className="review-card-hint">{t("plugin.ui.uploadFullTextHint")}</p>
      <div className="review-source-picker">
        <Paperclip size={22} strokeWidth={1.5} aria-hidden="true" />
        <div><p>{files.length ? t("plugin.ui.filesReadySummary", { ready: readyFiles.length, blocked: files.length - readyFiles.length }) : t("plugin.ui.noFiles")}</p>
          {accept && <p className="review-card-hint">{t("plugin.ui.acceptedFormats", { formats: summarizeAcceptedFormats(accept, t) })}</p>}</div>
        <div className="review-source-picker__actions">
          <label className="review-secondary-button">{t("plugin.ui.chooseFiles")}<input className="sr-only" type="file" accept={accept || undefined} multiple={payload.multiple === true} disabled={props.disabled} onChange={choose} /></label>
          {payload.allowDirectory === true && <label className="review-secondary-button">{t("plugin.ui.chooseFolder")}<input className="sr-only" type="file" multiple disabled={props.disabled} onChange={choose} {...{ webkitdirectory: "" } as Record<string, string>} /></label>}
        </div>
      </div>
      {fileStates.length > 0 && <ul className="review-source-files" aria-label={t("plugin.ui.selectedFiles")}>{fileStates.map((item, index) => <li key={`${item.file.name}:${item.file.size}:${index}`}>
        {item.status === "blocked" ? <AlertCircle size={16} className="text-status-error" aria-hidden="true" /> : <FileTypeIcon name={item.file.name} surface="row" />}
        <div><p title={item.file.name}>{item.file.name}</p><span className={item.status === "blocked" ? "text-status-error" : "review-card-hint"} role={item.status === "blocked" ? "alert" : undefined}>{item.message ?? t("plugin.ui.fileReady")}</span></div>
        <button type="button" disabled={props.disabled} aria-label={t("plugin.ui.removeFile", { name: item.file.name })} onClick={() => remove(index)}><X size={14} aria-hidden="true" /></button>
      </li>)}</ul>}
      {validationError && <p className="text-xs text-status-error" role="alert">{validationError}</p>}
      {props.status === "answered" && <p className="text-xs text-status-success" role="status">{t("plugin.ui.answered")}</p>}
      {props.status === "error" && <p className="text-xs text-status-error" role="alert">{t("plugin.ui.responseFailed")}</p>}
    </div>
    <footer className="review-card-footer">
      {minFiles === 0 && files.length === 0 && <ResponseButton disabled={props.disabled} secondary onClick={() => void skip()}>{t("plugin.ui.skip")}</ResponseButton>}
      <ResponseButton disabled={props.disabled || readyFiles.length === 0 || Boolean(validationError) || !props.onUploadFiles} onClick={() => void upload()}>{firstString(payload, ["submitLabel"]) ?? t("plugin.ui.upload")}</ResponseButton>
    </footer>
  </article>;
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
  legal?: boolean;
  draftKey?: string;
  title?: string;
  description?: string | null;
  error?: string | null;
  onClose?: (answers: Record<string, string>) => void;
  questions: PluginQuestionField[];
  disabled: boolean;
  onSubmit: (answers: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  const drafts = usePluginQuestionDrafts();
  const [answers, setAnswers] = useState<Record<string, string | null>>(() => (props.draftKey ? drafts?.get(props.draftKey) : undefined) ?? {});
  const [activeIndex, setActiveIndex] = useState(0);
  const filled = props.questions.filter((question) => typeof answers[question.id] === "string" && answers[question.id]!.trim());
  const incomplete = props.questions.some((question) => question.required && answers[question.id] !== null && !(answers[question.id] ?? "").trim());
  const activeQuestion = props.questions[Math.min(activeIndex, props.questions.length - 1)];
  const set = (id: string, value: string | null) => setAnswers((current) => {
    const next = { ...current, [id]: value };
    if (props.draftKey) drafts?.set(props.draftKey, next);
    return next;
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmit(Object.fromEntries(filled.map((question) => [question.id, answers[question.id]!.trim()])));
  };

  if (props.legal && activeQuestion) {
    const lastQuestion = activeIndex === props.questions.length - 1;
    const value = answers[activeQuestion.id] ?? "";
    const selectedOption = activeQuestion.options.includes(value);
    const answerSnapshot = (draft: Record<string, string | null>) => Object.fromEntries(props.questions.flatMap((question) => {
      const answer = draft[question.id];
      return typeof answer === "string" && answer.trim() ? [[question.id, answer.trim()]] : [];
    }));
    const advanceOrSubmit = (draft: Record<string, string | null>) => {
      if (!lastQuestion) { setActiveIndex((index) => index + 1); return; }
      const pendingIndex = props.questions.findIndex((question) => draft[question.id] === undefined
        || (question.required && draft[question.id] !== null && !draft[question.id]?.trim()));
      if (pendingIndex >= 0) setActiveIndex(pendingIndex);
      else props.onSubmit(answerSnapshot(draft));
    };
    const skipCurrent = () => {
      if (props.disabled) return;
      const next = { ...answers, [activeQuestion.id]: null };
      setAnswers(next);
      if (props.draftKey) drafts?.set(props.draftKey, next);
      advanceOrSubmit(next);
    };
    const continueOrSubmit = (event: FormEvent) => {
      event.preventDefault();
      if (props.disabled || (activeQuestion.required && !value.trim() && answers[activeQuestion.id] !== null)) return;
      const next = value.trim() ? answers : { ...answers, [activeQuestion.id]: null };
      if (next !== answers) {
        setAnswers(next);
        if (props.draftKey) drafts?.set(props.draftKey, next);
      }
      advanceOrSubmit(next);
    };
    return <form className="agent-confirmation-card agent-question-card legal-question-card" aria-label={props.title} onSubmit={continueOrSubmit}>
      <header className="agent-confirmation-card__header agent-question-card__header legal-question-card__header">
        <h3 className="agent-question-card__prompt">{activeQuestion.label}</h3>
        <div className="agent-question-card__header-actions">
          <nav className="agent-question-card__pagination" aria-label={t("home.question.count", { count: props.questions.length })}>
            <button type="button" disabled={activeIndex === 0 || props.disabled} aria-label={t("home.question.previous")}
              onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}><ChevronLeft size={16} aria-hidden="true" /></button>
            <span aria-live="polite">{activeIndex + 1}/{props.questions.length}</span>
            <button type="button" disabled={lastQuestion || props.disabled} aria-label={t("home.question.next")}
              onClick={() => setActiveIndex((index) => Math.min(props.questions.length - 1, index + 1))}><ChevronRight size={16} aria-hidden="true" /></button>
          </nav>
          <button type="button" className="agent-question-card__close" disabled={props.disabled}
            aria-label={t("plugin.ui.dismissCard")} onClick={() => props.onClose?.(answerSnapshot(answers))}><X size={18} aria-hidden="true" /></button>
        </div>
      </header>
      <div className="agent-confirmation-card__body agent-question-card__body legal-question-card__list"
        role="group" aria-label={activeQuestion.label} key={activeQuestion.id}>
        {props.description ? <p className="legal-question-card__hint">{props.description}</p> : null}
        <div className="agent-question-card__options">
          {activeQuestion.options.map((option, index) => {
            const selected = value === option;
            return <button type="button" key={option} disabled={props.disabled} aria-pressed={selected}
              className={`agent-question-card__option${selected ? " agent-question-card__option--selected" : ""}`}
              onClick={() => set(activeQuestion.id, option)}>
              <span className="agent-question-card__choice" aria-hidden="true">{index + 1}</span>
              <span className="agent-question-card__option-copy"><span>{option}</span></span>
              {selected ? <Check size={15} aria-hidden="true" /> : <ArrowRight size={17} className="agent-question-card__option-arrow" aria-hidden="true" />}
            </button>;
          })}
          <div className="agent-question-card__other">
            <span className="agent-question-card__other-icon" aria-hidden="true"><PenLine size={14} /></span>
            <input aria-label={activeQuestion.label} disabled={props.disabled} value={selectedOption ? "" : value}
              onChange={(event) => set(activeQuestion.id, event.target.value)}
              placeholder={activeQuestion.options.length ? t("home.question.other") : t(activeQuestion.required ? "plugin.ui.requiredPlaceholder" : "plugin.ui.optionalPlaceholder")} />
          </div>
        </div>
      </div>
      <footer className="agent-confirmation-card__footer agent-question-card__footer legal-question-card__footer">
        <span className="agent-question-card__selection">{props.error ? <span className="agent-question-card__error" role="alert">{props.error}</span> : null}</span>
        <button type="button" className="agent-question-card__skip" disabled={props.disabled}
          onClick={skipCurrent}>{t("plugin.ui.skip")}</button>
        <button type="submit" className="agent-question-card__continue"
          disabled={props.disabled || (activeQuestion.required && !value.trim() && answers[activeQuestion.id] !== null)}>
          {t(lastQuestion ? "home.question.confirm" : "home.question.next")}
        </button>
      </footer>
    </form>;
  }

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
  presentation?: "chat";
  guidanceDescription?: string;
}) {
  const { t } = useTranslation();
  const artifact = props.event.artifact;
  const downloadUri = artifact.downloadUri ?? artifact.uri;
  const [downloadState, setDownloadState] = useState<"idle" | "pending" | "error">("idle");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const downloading = useRef(false);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", onKeyDown); };
  }, [menu]);
  const download = async () => {
    if (downloading.current) return;
    if (!props.onRead) {
      const safeUri = resolveSafeArtifactUri(downloadUri);
      if (safeUri) startBrowserDownload(safeUri, artifact.name);
      return;
    }
    downloading.current = true;
    setDownloadState("pending");
    try {
      const blob = await props.onRead(downloadUri);
      const objectUrl = URL.createObjectURL(blob);
      startBrowserDownload(objectUrl, artifact.name);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      setDownloadState("idle");
    } catch {
      setDownloadState("error");
    } finally {
      downloading.current = false;
    }
  };
  if (props.guidanceDescription !== undefined) {
    const extension = artifact.name.match(/\.[^.]+$/)?.[0] ?? "";
    const name = extension ? artifact.name.slice(0, -extension.length) : artifact.name;
    return <button type="button" className="diagnostic-guidance-card__template" disabled={downloadState === "pending"} onClick={() => void download()} aria-label={`${t("plugin.ui.download")} ${artifact.name}`}>
      <span className="diagnostic-guidance-card__file-icon"><FileTypeIcon name={artifact.name} mime={artifact.mediaType} surface="card" /></span>
      <div className="diagnostic-guidance-card__file-info">
        <p className="diagnostic-guidance-card__file-name">{name}<span>{extension}</span></p>
        {props.guidanceDescription ? <p className="diagnostic-guidance-card__description">{props.guidanceDescription}</p> : null}
      </div>
      <span className="diagnostic-guidance-card__download">
        <Download size={16} strokeWidth={1.5} aria-hidden="true" />{t("plugin.ui.download")}
      </span>
      {downloadState === "error" ? <p className="diagnostic-guidance-card__error" role="alert">{t("plugin.ui.downloadFailed")}</p> : null}
    </button>;
  }
  if (props.presentation === "chat") return <span className="agent-delivered-file">
    <AgentAttachmentCard kind="file" name={artifact.name} mime={artifact.mediaType}
      title={artifact.name} onClick={() => { if (props.onOpen) props.onOpen(artifact); else void download(); }}
      onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}
      onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom });
      } }} />
    {menu && createPortal(<div role="menu" aria-label={t("agent.attachment.menu")}
      className="agent-image-context-menu agent-file-context-menu"
      style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 180)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 140)) }}
      onPointerDown={(event) => event.stopPropagation()}>
      {props.onOpen ? <button type="button" role="menuitem" className="agent-image-context-menu__item"
        onClick={() => { setMenu(null); props.onOpen?.(artifact); }}>{t("plugin.ui.open")}</button> : null}
      <button type="button" role="menuitem" className="agent-image-context-menu__item"
        onClick={() => { setMenu(null); void download(); }}>{t("plugin.ui.download")}</button>
      {props.onAddToChat ? <button type="button" role="menuitem" className="agent-image-context-menu__item"
        onClick={() => { setMenu(null); props.onAddToChat?.(artifact); }}>{t("plugin.ui.addToChat")}</button> : null}
    </div>, document.body)}
    {downloadState === "error" ? <span className="text-xs text-status-error" role="alert">{t("plugin.ui.downloadFailed")}</span> : null}
  </span>;
  return (
    <div className="plugin-artifact-row flex items-center gap-3 rounded-card border border-border-stone/30 px-3 py-2.5">
      <FileTypeIcon name={artifact.name} mime={artifact.mediaType} surface="row" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text-ink/75">{props.event.artifact.name}</p>
        <p className="truncate text-[11px] text-text-ink/40">{artifact.name.match(/\.([^.]*)$/)?.[1]?.toUpperCase() ?? t("plugin.ui.artifactCollection", { count: 1 })}</p>
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

function legalInteractionKey(call: PluginUiCall): string | null {
  if (!call.conversationId || call.pluginId !== "legal-labor" || !["session-start", "material-collect"].includes(call.capabilityId)
    || call.events.some((event) => event.type === "result" || event.type === "error")) return null;
  const event = [...call.events].reverse().find((item) => item.type === "interaction");
  if (event?.type !== "interaction") return null;
  const kind = event.request.type;
  const phase = kind === "file-input" ? "upload" : kind === "audio-record" ? "recording" : null;
  return phase ? JSON.stringify([call.pluginId, call.conversationId.replace(/^websocket:/, ""), phase]) : null;
}

function matchingLegalInteractionCalls(call: PluginUiCall, calls: readonly PluginUiCall[]): PluginUiCall[] {
  const key = legalInteractionKey(call);
  return key ? calls.filter((candidate) => legalInteractionKey(candidate) === key) : [];
}

/** One visible step answers both a manual opener and the Agent waiting on it. */
function deduplicateLegalInteractions(calls: PluginUiCall[]): PluginUiCall[] {
  const chosen = new Map<string, PluginUiCall>();
  for (const call of calls) {
    const key = legalInteractionKey(call) ?? call.callId;
    const previous = chosen.get(key);
    if (!previous || call.origin === "agent" || previous.origin !== "agent") chosen.set(key, call);
  }
  return calls.filter((call) => [...chosen.values()].includes(call));
}

/** Keeps delivered files across calls while collapsing superseded interaction cards. */
export function selectCurrentPluginCalls(calls: readonly PluginUiCall[]): PluginUiCall[] {
  const isLive = (call: PluginUiCall) => !call.events.some((event) => event.type === "result" || event.type === "error");
  const deliveryKey = (call: PluginUiCall, artifact: PluginArtifactRef) => JSON.stringify([
    normalizePluginConversationId(call.conversationId) ?? call.conversationId,
    call.pluginId,
    artifact.path ? ["path", artifact.path] : ["id", artifact.id]
  ]);
  // Host download URLs and artifact IDs can change when a file is delivered
  // again. Its workspace path identifies that file without merging same-named
  // files from different tasks. Artifacts without a path retain their own IDs.
  const latestDeliveries = new Map<string, CapabilityEvent>();
  for (const call of calls) {
    for (const event of call.events) {
      if (event.type === "artifact" && event.artifact.role !== "setup") {
        latestDeliveries.set(deliveryKey(call, event.artifact), event);
      }
    }
  }
  const currentCalls = calls.map((call) => ({
    ...call,
    events: call.events.filter((event) => event.type !== "artifact" || event.artifact.role === "setup"
      || latestDeliveries.get(deliveryKey(call, event.artifact)) === event)
  }));
  const selected = new Set(currentCalls.filter((call) => call.events.some((event) => (
    event.type === "artifact" && event.artifact.role !== "setup"
  ))));
  const groups = new Map<string, { live: PluginUiCall[]; finished?: PluginUiCall }>();
  for (const call of currentCalls) {
    const key = `${normalizePluginConversationId(call.conversationId) ?? call.conversationId}:${call.pluginId}:${call.capabilityId}:${isBarePresentation(call) ? "recorder" : "card"}`;
    let group = groups.get(key);
    if (!group) {
      group = { live: [] };
      groups.set(key, group);
    }
    if (isLive(call)) group.live.push(call);
    else group.finished = call;
  }
  for (const group of groups.values()) {
    if (group.live.length) {
      // A second invocation cannot hide a tool that still needs an answer.
      const waiting = group.live.filter((call) => call.events.some((event) => event.type === "interaction"));
      for (const call of waiting.length ? deduplicateLegalInteractions(waiting) : group.live.slice(-1)) selected.add(call);
    } else if (group.finished?.events.some((event) => event.type === "artifact")) {
      selected.add(group.finished);
    } else if (group.finished && [REVIEW_PLUGIN_ID, "legal-labor"].includes(group.finished.pluginId)
      && group.finished.events.some((event) => event.type === "error" && !isCancellation(event.code))) {
      selected.add(group.finished);
    }
  }
  return currentCalls.filter((call) => selected.has(call));
}

/** Keeps history in the event store while limiting the conversation to actionable UI. */
export function selectVisiblePluginCalls(calls: PluginUiCall[], answered: ReadonlySet<string> = new Set()): PluginUiCall[] {
  const prepared = calls.map((call) => {
    // Legal collection asks sequentially: guide -> recorder -> upload. A new
    // request supersedes the previous card even before its reply is acknowledged.
    const sequential = call.pluginId === "legal-labor" && ["session-start", "material-collect"].includes(call.capabilityId);
    const latestInteraction = [...call.events].reverse().find((event) => event.type === "interaction");
    return {
      ...call,
      events: call.events.filter((event) => event.type !== "interaction" || (
        (!sequential || event === latestInteraction)
        && !answered.has(interactionKey(call, event.request.interactionId))
      ))
    };
  });
  const latest = prepared[prepared.length - 1];
  const latestActive = latest && !latest.events.some((event) => event.type === "result" || event.type === "error")
    ? latest.callId
    : undefined;
  return prepared.filter((call, index) => {
    const artifactEvents = call.events.filter((event): event is Extract<CapabilityEvent, { type: "artifact" }> => event.type === "artifact");
    // A call that only handed over setup files (templates, checklists) carries
    // no real deliverable. Keeping it on screen after it terminates adds a card
    // the user cannot act on. File events remain available to the Agent, but
    // only a message/media attachment makes one a conversation deliverable.
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
    // A completed legal file-only call has no user-facing card of its own.
    if (hasDeliverableArtifact) {
      return !(call.pluginId === "legal-labor" && terminal && !hasError
        && !artifactEvents.some((event) => event.artifact.role === "setup")
        && !call.events.some((event) => event.type === "interaction"));
    }
    // A setup-only call that finished (result or dismissed) is history:
    // the templates were handed over and the card has nothing left to offer.
    if (hasArtifact && terminal && !hasError) return false;
    if (hasArtifact && !terminal) return call.pluginId !== "legal-labor"
      || call.events.some((event) => event.type === "interaction");
    if (hasError) return !recoveredByLaterRetry;
    if (!terminal && call.events.some((event) => event.type === "interaction")) return true;
    return call.callId === latestActive && call.events.some((event) => event.type !== "result");
  });
}

/**
 * Hides incidental user-raised cards while the Agent is waiting on its own.
 *
 * Explicit pinned commands remain available independently of the Agent's
 * question. Other competing cards return after that question is answered;
 * hiding them never cancels their calls.
 *
 * @param calls Visible calls.
 * @returns Calls with occluded ones removed.
 */
export function occludeUserRaisedCalls(calls: PluginUiCall[], pinnedCapabilities: ReadonlySet<string> = new Set()): PluginUiCall[] {
  const legalWorkflowCardOpen = calls.some(isActiveLegalWorkflowCard);
  const visibleCalls = legalWorkflowCardOpen
    ? calls.filter((call) => !(call.pluginId === "legal-labor" && call.capabilityId === "guide-open"))
    : calls;
  const agentIsWaiting = visibleCalls.some((call) => (
    call.origin === "agent"
    && call.events.some((event) => event.type === "interaction")
    && !call.events.some((event) => event.type === "result" || event.type === "error")
  ));
  if (!agentIsWaiting) return visibleCalls;
  // The recorder is never occluded: hiding it unmounts the card that owns the
  // microphone, and a recording in progress cannot be taken again. It is also
  // not competing for the same answer — one takes a recording, the other a
  // reply — so leaving it up costs the Agent's card nothing.
  return visibleCalls.filter((call) => (
    call.origin !== "user"
    || pinnedCapabilities.has(`${call.pluginId}:${call.capabilityId}`)
    || isBarePresentation(call)
    || !call.events.some((event) => event.type === "interaction")
  ));
}

/**
 * Finds the scrolling list of the card under the pointer, if it has one.
 *
 * @param target The element the wheel gesture started on.
 * @param region The pinned region; only its cards are searched.
 * @returns The card's scroll container, or null when the card does not scroll.
 */
function cardScroller(target: EventTarget | null, region: HTMLElement): HTMLElement | null {
  const scrolls = (node: Element): node is HTMLElement => {
    if (!(node instanceof HTMLElement) || node.scrollHeight <= node.clientHeight) return false;
    const overflowY = window.getComputedStyle(node).overflowY;
    return overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
  };
  let card: Element | null = null;
  for (let node = target instanceof Element ? target : null; node && node !== region; node = node.parentElement) {
    if (scrolls(node)) return node;
    card = node;
  }
  // Over the header or footer: the list is elsewhere in the same card.
  return card ? [...card.querySelectorAll("*")].find(scrolls) ?? null : null;
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
 * Progress is part of the transcript flow. It only needs a small text status
 * line, so it must not inherit the generic plugin card chrome.
 */
export function isStatusOnlyPresentation(call: PluginUiCall): boolean {
  if (call.events.some((event) => event.type === "artifact" || event.type === "interaction" || event.type === "result" || event.type === "error")) {
    return false;
  }
  return call.events.length > 0 && call.events.every((event) => event.type === "progress" || event.type === "task-list");
}

/**
 * Splits calls between the side panel, the pinned region and the transcript.
 *
 * A call the user raised stays beside the conversation for as long as it is
 * live. A model-raised call whose capability has a pinned command follows the
 * same route, so a skill invocation cannot create a duplicate transcript card.
 * Once a call has delivered its result it moves to the transcript too, so the
 * pinned region holds only what is still actionable and deliverables stay in
 * the history.
 *
 * The interview recorder is the exception. It draws its own bar, stays open for
 * as long as the interview lasts, and its transcript grows in the column beside
 * it, so it belongs in that column rather than over the conversation.
 *
 * @param calls Visible calls.
 * @param region The region being rendered.
 * @param pinnedCapabilities Capability keys represented by a pinned command.
 * @returns The calls that belong to that region.
 */
/** Pinned commands retain their own capability identity. */
export function pinnedCapabilityKey(call: PluginUiCall): string {
  return `${call.pluginId}:${call.capabilityId}`;
}

export function selectRegionPluginCalls(
  calls: PluginUiCall[],
  region: PluginCardRegion,
  pinnedCapabilities: ReadonlySet<string> = new Set(),
  dockInteractions = false
): PluginUiCall[] {
  const isLiveUserCall = (call: PluginUiCall) => (
    (call.origin === "user" || pinnedCapabilities.has(pinnedCapabilityKey(call)))
    && !call.events.some((event) => event.type === "result" || event.type === "error")
  );
  return calls.filter((call) => {
    const live = isLiveUserCall(call);
    // The model starts this recorder inside session-start, which has no
    // pinned command. Its audio owner still belongs in the recording panel.
    if (call.pluginId === "legal-labor" && isBarePresentation(call)) return region === "panel";
    const pendingConfirmation = dockInteractions && !isBarePresentation(call)
      && !call.events.some((event) => event.type === "result" || event.type === "error")
      && call.events.some((event) => event.type === "interaction");
    if (pendingConfirmation) return region === "pinned";
    if (isLegalFlowInteraction(call)) return region === "pinned";
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
    <div className="plugin-error-card flex items-start gap-2 rounded-card border border-status-error/20 bg-status-error-soft px-3 py-2.5 text-sm text-status-error" role="alert">
      <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{props.event.message}</span>
    </div>
  );
}

/** Review cards render their own structured data; Agent prose is not card copy. */
export function reviewPresentationEvents(events: CapabilityEvent[]): CapabilityEvent[] {
  return events.map((event) => {
    if (event.type !== "interaction") return event;
    const payload = { ...asRecord(event.request.payload) };
    delete payload.description;
    delete payload.detail;
    delete payload.hint;
    return { ...event, request: { ...event.request, payload } };
  });
}

function SandboxedPluginRenderer(props: {
  call: PluginUiCall;
  interactionStates: PluginRendererInteractionState[];
  height: number;
  docked?: boolean;
  client: Pick<PluginsClient, "getUi">;
  onRespond(interactionId: string, response: unknown): Promise<void>;
  fallback: ReactNode;
  onUploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
}) {
  const { t } = useTranslation();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const reviewScopeCollapsed = useRef(false);
  const answered = useRef(new Set<string>());
  const uploading = useRef(new Set<string>());
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(() => typeof window === "undefined" ? 900 : window.innerHeight);
  const heightLimit = props.docked && props.call.pluginId === REVIEW_PLUGIN_ID ? Math.min(props.height, Math.max(220, viewportHeight - 310)) : props.height;
  useEffect(() => {
    const resize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const [rendererHeight, setRendererHeight] = useState(() => Math.min(props.height, 320));
  const document = useMemo(() => html === null ? "" : buildRendererDocument(props.call.pluginId === REVIEW_PLUGIN_ID ? themeLiteratureReviewCard(html) : html), [html, props.call.pluginId]);
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
    events: props.call.pluginId === REVIEW_PLUGIN_ID ? reviewPresentationEvents(props.call.events) : props.call.events,
    interactionStates: props.interactionStates,
    presentation: { maxHeight: heightLimit }
  }), [props.call, props.interactionStates, heightLimit]);

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

  useEffect(() => { reviewScopeCollapsed.current = false; }, [props.call.callId]);
  useEffect(() => { setRendererHeight((current) => Math.min(current, heightLimit)); }, [heightLimit]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = asRecord(event.data);
      if (message.type === "memmy.plugin.resize" && message.version === 1) {
        const requestedHeight = typeof message.height === "number" ? message.height : Number.NaN;
        if (Number.isFinite(requestedHeight)) {
          const reviewScope = props.call.pluginId === REVIEW_PLUGIN_ID && props.call.events.some((item) =>
            item.type === "interaction" && asRecord(item.request.payload).cardType === "review-spec");
          if (reviewScope && typeof message.collapsed === "boolean") reviewScopeCollapsed.current = message.collapsed;
          else if (reviewScope && reviewScopeCollapsed.current) return;
          setRendererHeight(Math.min(heightLimit, Math.max(reviewScopeCollapsed.current ? 48 : 180, Math.ceil(requestedHeight))));
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
  }, [props.call.events, heightLimit, props.interactionStates, props.onRespond, props.onUploadFiles, t]);

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

function validateReadyFileCount(files: readonly unknown[], maxFiles: number | null, minFiles: number, t: ReturnType<typeof useTranslation>["t"]): string | null {
  if (files.length < minFiles) return t("plugin.ui.fileCountBelowMinimum", { count: minFiles });
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
