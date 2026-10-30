import { buildPluginCapabilityLabels } from "./plugin-tool-activity.js";
import { resolveContributionIcon } from "./agent-command-palette.js";
import { SHARED_ROW_MIN_PANE_WIDTH, SHARED_ROW_PRIMARY_RESERVE } from "./sidebar-resize.js";
import type { RecordingPanelSession } from "./interview-recording-panel.js";
import { buildAgentRoutedPluginPrompt, buildLegalDiagnosisContinuation, collectPluginScenarios, pressPinnedPluginCommand, pluginInteractionSignature, reconcileHiddenPluginCalls, PinnedPluginCommandBar, selectConversationPinnedCommands, selectPinnedCommandsForLegalWorkflow, selectOpenPinnedCapabilities } from "./plugin-conversation-controls.js";
import "./conversation-features.css";
import { cloneElement, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ComponentProps } from "react";
import type { InstalledPlugin, PluginArtifactRef, PluginCommandContribution } from "@memmy/local-api-contracts";
import { useApiClients } from "../app/providers.js";
import { normalizePluginConversationId, useOptionalPluginUi, type PluginRecordingMaterial, type PluginUiCall } from "../app/plugin-ui-context.js";
import { useAppState } from "../state/app-state.js";
import { appActions } from "../state/app-actions.js";
import { useTranslation } from "../i18n/use-translation.js";
import { answeredUnresolvedPluginInteraction, pendingPluginInteraction, pluginInteractionCompletedLabel, pluginInteractionWaitingLabel } from "../app/plugin-interaction-waiting-label.js";
import { PluginCapabilityHost, RecordingBarPortalContext, selectVisiblePluginCalls, isActiveLegalWorkflowCard } from "./plugin-capability-host.js";
import { PluginArtifactPreviewPanel } from "./plugin-artifact-preview-panel.js";
import { canUseAccountRecording, useRecordingEntry, RecordingEntryCard, type RecordingArchiveEntry } from "./recording-entry.js";
import { type SlashCommandPaletteItem } from "./agent-command-palette.js";
import type { AgentChatMessage } from "../state/agent-chat-slice.js";

const NO_CALLS: PluginUiCall[] = [];

/** A handed-over interview already has one pending row keyed by its audio path. */
export function recordingArchiveMaterials(entry: RecordingArchiveEntry): PluginRecordingMaterial[] {
  if (!entry.files?.length || (entry.handedOver && entry.id.startsWith("plugin:"))) return [];
  const transcripts = entry.files.filter((file) => file.kind === "file");
  return (transcripts.length ? transcripts : entry.files).map((file) => ({ ...file, collected: entry.collected }));
}

/** A standalone artifact preview covers the chat when both columns cannot fit. */
export function conversationFeaturePanelOverlays(width: number | null | undefined): boolean {
  return width != null && width > 0 && width < SHARED_ROW_PRIMARY_RESERVE + SHARED_ROW_MIN_PANE_WIDTH;
}

export function recordingShortcutOpen(compactOpen: boolean,
  pluginRecording: Pick<RecordingPanelSession, "status"> | null | undefined, pluginRecordingHidden: boolean): boolean {
  // A completed interview may remain in the right panel, but this shortcut
  // has already switched back to controlling the independent recording card.
  return compactOpen || Boolean(pluginRecording && pluginRecording.status !== "done" && !pluginRecordingHidden);
}

function PersistentPluginRecorder(props: {
  owner: string; host: ReactElement<ComponentProps<typeof PluginCapabilityHost>> | null;
  onSession(owner: string, session: RecordingPanelSession | null): void;
}) {
  const publish = useCallback((session: RecordingPanelSession | null) => props.onSession(props.owner, session),
    [props.owner, props.onSession]);
  return props.host ? cloneElement(props.host, { onRecordingSession: publish }) : null;
}

/** Feature integration stays outside the baseline conversation's queue and scroll state. */
export function useConversationFeatures(options: {
  scopeKey: string;
  agentMessages?: readonly AgentChatMessage[];
  sharedRowWidth?: number | null;
  onDraft(text: string): void;
  onStageFiles(files: File[]): Promise<unknown>;
  onOpenArtifact?(artifact: PluginArtifactRef): boolean;
  onSend(text: string): Promise<boolean>;
  onOpenRecording(): void;
}) {
  const { clients } = useApiClients();
  const { state, dispatch } = useAppState();
  const { t, language } = useTranslation();
  const ui = useOptionalPluginUi();
  const currentUi = useRef(ui);
  currentUi.current = ui;
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const scenarios = useMemo(() => collectPluginScenarios(plugins), [plugins]);
  const [error, setError] = useState<{ conversationId: string; message: string } | null>(null);
  const [featurePanelWidth, setFeaturePanelWidth] = useState(560);
  const [preview, setPreview] = useState<PluginArtifactRef | null>(null);
  const invocationFlights = useRef(new Set<string>());
  const [pluginRecordings, setPluginRecordings] = useState(new Map<string, RecordingPanelSession>());
  const [hiddenRecordings, setHiddenRecordings] = useState(new Set<string>());
  const publishRecording = useCallback((owner: string, session: RecordingPanelSession | null) => {
    setPluginRecordings((current) => {
      if (!session && !current.has(owner)) return current;
      const next = new Map(current);
      if (session) next.set(owner, session); else next.delete(owner);
      return next;
    });
  }, []);
  const [recordingBar, setRecordingBar] = useState<HTMLDivElement | null>(null);
  const conversationId = state.agent.currentChatId ?? state.agent.currentSessionKey ?? options.scopeKey;
  const calls = useMemo(() => (ui?.calls ?? NO_CALLS).filter((call) =>
    normalizePluginConversationId(call.conversationId) === normalizePluginConversationId(conversationId)),
  [ui?.calls, conversationId]);
  const completedToolCalls = useMemo(() => new Set((options.agentMessages ?? []).flatMap((message) =>
    (message.toolEvents ?? []).filter((event) => event.phase === "end" || event.phase === "error")
      .flatMap((event) => event.ui_tool_call_id ? [event.ui_tool_call_id] : []))), [options.agentMessages]);
  useEffect(() => {
    if (!ui || !completedToolCalls.size) return;
    const answered = calls.flatMap((call) => call.origin === "agent" && call.agentToolCallId
      && completedToolCalls.has(call.agentToolCallId)
      ? call.events.flatMap((event) => event.type === "interaction"
        ? [`${call.pluginId}:${call.callId}:${event.request.interactionId}`] : []) : []);
    if (!answered.length) return;
    ui.setAnsweredInteractions((current) => {
      const missing = answered.filter((key) => !current.has(key));
      return missing.length ? new Set([...current, ...missing]) : current;
    });
  }, [calls, completedToolCalls, ui?.setAnsweredInteractions]);
  const prepared = useMemo(() => selectVisiblePluginCalls(calls, ui?.answeredInteractions ?? new Set()),
    [calls, ui?.answeredInteractions]);
  const pending = pendingPluginInteraction(prepared.filter((call) => !ui?.dismissedCallIds.has(call.callId)),
    ui?.answeredInteractions ?? new Set());
  const submitted = pending ? null : answeredUnresolvedPluginInteraction(prepared, ui?.answeredInteractions ?? new Set());
  const processInteraction = pending?.call.origin === "agent"
    ? { label: pluginInteractionWaitingLabel(pending, language === "en-US"),
        agentToolCallId: pending.call.agentToolCallId ?? null, awaiting: true }
    : submitted?.call.origin === "agent"
      ? { label: pluginInteractionCompletedLabel(submitted, language === "en-US"),
          agentToolCallId: submitted.call.agentToolCallId ?? null, awaiting: false }
      : null;
  const recordingAuthenticated = canUseAccountRecording(state.bootstrap?.app.userMode, state.account.userId);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (!clients?.plugins) return;
      void clients.plugins.list().then((value) => { if (active) { setPlugins(value); setError(null); } })
        .catch((cause) => { if (active) setError({ conversationId, message: String(cause instanceof Error ? cause.message : cause) }); });
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("memmy:plugins-changed", refresh);
    const timer = setInterval(refresh, 5_000);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", refresh); window.removeEventListener("memmy:plugins-changed", refresh); };
  }, [clients?.plugins, state.account.userId]);

  const archiveRecording = useCallback((entry: RecordingArchiveEntry) => {
    const materials = recordingArchiveMaterials(entry);
    if (!entry.sessionKey || !materials.length) return;
    ui?.addRecordingMaterials("legal-labor", entry.sessionKey, materials);
  }, [ui?.addRecordingMaterials]);
  const recording = useRecordingEntry(clients?.asr,
    clients ? (files) => clients.memmyAgent.uploadAgentMedia(files) : undefined,
    (file, mode) => {
      void latest.current.onStageFiles([file]);
      if (mode === "summarize") latest.current.onDraft(t("recording.summaryPrompt"));
    }, {
      scope: String(state.account.userId ?? "local"),
      ...(state.agent.currentChatId ? { sessionKey: conversationId } : {}),
      onArchived: archiveRecording,
      ...(clients ? { deleteFiles: (paths: string[]) => clients.memmyAgent.deleteRecordingFiles(paths) } : {}),
      onRemoved: (entry) => {
        const paths = new Set([entry.audioPath, ...(entry.files ?? []).map((file) => file.path)]);
        ui?.setRecordingMaterials((current) => new Map([...current].map(([key, files]) =>
          [key, files.filter((file) => !paths.has(file.path))])));
      },
      resolveAudio: async (entry) => {
        if (!entry.audioPath || !clients) return entry.audioUrl ?? null;
        return clients.memmyAgent.resolveRecording(entry.audioPath);
      }
    }, recordingAuthenticated);

  const capabilityLabels = useMemo(() => buildPluginCapabilityLabels(plugins), [plugins]);
  const targets = useMemo(() => plugins.filter((plugin) => plugin.state === "active" && plugin.eligibility?.canUse !== false)
    .flatMap((plugin) => (plugin.manifest.commands ?? [])
      // Older installed packages still map this shortcut to session-start.
      // Never invoke the independent guide until the Host lists that capability.
      .filter((command) => !(plugin.id === "legal-labor" && command.command === "/legal-guide"
        && !plugin.manifest.capabilities.some((capability) => capability.id === "guide-open")))
      .map((command) => ({ plugin,
        command: plugin.id === "legal-labor" && command.command === "/legal-guide"
          ? { ...command, capabilityId: "guide-open" } : command }))), [plugins]);
  const commandItems: SlashCommandPaletteItem[] = targets.map(({ command }) => ({
    command: command.command, title: command.name, description: command.description ?? "",
    icon: command.icon ?? "activity", argHint: command.argHint ?? "", synthetic: true
  }));

  const legalFlowCardOpen = prepared.some((call) => isActiveLegalWorkflowCard(call)
    && !ui?.hiddenCallIds.has(call.callId) && !ui?.dismissedCallIds.has(call.callId));
  const toggleCompactRecording = () => {
    setError(null);
    if (legalFlowCardOpen) return;
    if (!recordingAuthenticated) { dispatch(appActions.navigate("/welcome")); return; }
    const owner = normalizePluginConversationId(conversationId)!;
    const pluginRecorder = pluginRecordings.get(owner);
    if (pluginRecorder && pluginRecorder.status !== "done") {
      setHiddenRecordings((current) => {
        const next = new Set(current);
        if (next.has(owner)) next.delete(owner); else next.add(owner);
        return next;
      });
      return;
    }
    recording.toggleCompact();
  };
  const invoke = async (plugin: InstalledPlugin, command: PluginCommandContribution, args = "") => {
    // This shortcut is a Host recorder, not a material-collect capability call.
    if (plugin.id === "legal-labor" && command.command === "/legal-record") { toggleCompactRecording(); return; }
    if (legalFlowCardOpen && plugin.id === "legal-labor") return;
    if (!clients?.plugins) return;
    setHiddenRecordings((current) => { const next = new Set(current); next.delete(normalizePluginConversationId(conversationId)!); return next; });
    if (command.agentSkillId) { latest.current.onDraft(plugin.manifest.conversation
      ? `$${command.agentSkillId}${args ? ` ${args}` : ""}` : `${command.command} ${args}`); return; }
    setError(null);
    try {
      await pressPinnedPluginCommand({ calls, pluginId: plugin.id, capabilityId: command.capabilityId,
        conversationId, dismissedCallIds: ui?.dismissedCallIds,
        pinnedCapabilities: new Set(targets.filter(({ command }) => command.pinned).map(({ plugin, command }) => `${plugin.id}:${command.capabilityId}`)),
        opening: ui?.openingCommands ?? invocationFlights.current,
        toggleVisibility: (callId) => ui?.setHiddenCallIds((current) => {
          const next = new Set(current);
          if (next.has(callId)) next.delete(callId);
          else { next.add(callId); ui.hiddenInteractionSteps.set(callId, pluginInteractionSignature(calls.find((call) => call.callId === callId))); }
          return next;
        }),
        open: () => clients.plugins.invoke(plugin.id, command.capabilityId, {
          conversationId, input: { command: command.command, arguments: args }, origin: "user"
        })
      });
    } catch (cause) { setError({ conversationId, message: cause instanceof Error ? cause.message : String(cause) }); }
  };
  const runCommand = (text: string): boolean => {
    const [name, ...args] = text.trim().split(/\s+/u);
    const target = targets.find(({ command }) => command.command.toLowerCase() === name?.toLowerCase());
    if (!target || target.command.agentSkillId) return false;
    void invoke(target.plugin, target.command, args.join(" "));
    return true;
  };
  const addArtifact = async (artifact: PluginArtifactRef) => {
    if (!clients?.plugins) return;
    try {
      const blob = await clients.plugins.readArtifact(artifact.downloadUri ?? artifact.uri);
      await latest.current.onStageFiles([new File([blob], artifact.name, { type: artifact.mediaType })]);
    } catch (cause) { setError({ conversationId, message: cause instanceof Error ? cause.message : String(cause) }); }
  };
  useEffect(() => {
    ui?.setHiddenCallIds((current) => reconcileHiddenPluginCalls(current, ui.hiddenInteractionSteps, prepared));
  }, [prepared, ui?.setHiddenCallIds, ui?.hiddenInteractionSteps]);
  const host = (hostCalls: PluginUiCall[], region: "flow" | "pinned" | "panel") => clients?.plugins && ui ?
    <PluginCapabilityHost key={region} region={region} dockInteractions calls={hostCalls} plugins={plugins} client={clients.plugins}
      agentRunActive={state.agent.isSending} asrClient={clients.asr}
      uploadFiles={(files) => clients.memmyAgent.uploadAgentMedia(files)}
      hiddenCallIds={ui.hiddenCallIds} dismissedCallIds={ui.dismissedCallIds}
      answeredInteractions={ui.answeredInteractions}
      onInteractionAnswered={(key) => ui.setAnsweredInteractions((current) => new Set(current).add(key))}
      onCallHidden={(callId) => {
        ui.hiddenInteractionSteps.set(callId, pluginInteractionSignature(ui.calls.find((call) => call.callId === callId)));
        ui.setHiddenCallIds((current) => new Set(current).add(callId));
      }}
      onCallDismissed={(callId) => ui.setDismissedCallIds((current) => new Set(current).add(callId))}
      onRecordingArchived={(entry) => { recording.archive(entry); archiveRecording(entry); }}
      onOpenArtifact={(artifact) => {
        if (options.onOpenArtifact?.(artifact)) { setPreview(null); return; }
        setPreview(artifact);
      }} onAddArtifact={(artifact) => void addArtifact(artifact)}
      onRequestDiagnosis={async (call) => {
        if (normalizePluginConversationId(call.conversationId) !== normalizePluginConversationId(conversationId)) return;
        if (!await latest.current.onSend(buildLegalDiagnosisContinuation(call))) throw new Error(t("home.media.error.sendFailed"));
      }} /> : null;
  const cards = <><div ref={setRecordingBar} />{host(prepared, "flow")}{host(prepared, "pinned")}
    {recording.compactOpen && !legalFlowCardOpen ? <RecordingEntryCard session={recording.session}
      disabled={!clients?.asr} onClose={recording.closeCompact} onOpenList={() => openRecording()} /> : null}
    {error?.conversationId === conversationId ? <div role="alert" className="text-sm text-red-600">{error.message}</div> : null}</>;
  // Microphone owners stay mounted while navigation only moves/hides their control bar.
  const recorderGroups = new Map<string, PluginUiCall[]>();
  for (const call of ui?.calls ?? []) {
    const key = normalizePluginConversationId(call.conversationId) ?? call.conversationId;
    recorderGroups.set(key, [...(recorderGroups.get(key) ?? []), call]);
  }
  const recorders = [...recorderGroups].map(([owner, calls]) => <RecordingBarPortalContext.Provider key={owner}
    value={{ target: recordingBar, hidden: owner !== normalizePluginConversationId(conversationId) }}>
    <PersistentPluginRecorder owner={owner} onSession={publishRecording}
      host={host(selectVisiblePluginCalls(calls, ui?.answeredInteractions ?? new Set()), "panel")} />
  </RecordingBarPortalContext.Provider>);
  const recordingOwner = normalizePluginConversationId(conversationId)!;
  const pluginRecording = pluginRecordings.get(recordingOwner);
  const openRecording = () => {
    setHiddenRecordings((current) => new Set(current).add(recordingOwner));
    options.onOpenRecording();
  };
  const pinnedCapabilities = new Set(targets.filter(({ command }) => command.pinned)
    .map(({ plugin, command }) => `${plugin.id}:${command.capabilityId}`));
  const pinnedTargets = state.agent.currentChatId
    ? selectPinnedCommandsForLegalWorkflow(selectConversationPinnedCommands(targets, calls), legalFlowCardOpen)
    : [];
  const shortcuts = <PinnedPluginCommandBar targets={pinnedTargets} disabled={!clients}
    recordingOpen={recordingShortcutOpen(recording.compactOpen, pluginRecording, hiddenRecordings.has(recordingOwner))}
    active={selectOpenPinnedCapabilities(prepared, ui?.dismissedCallIds, pinnedCapabilities, ui?.hiddenCallIds)}
    onRecordingPress={toggleCompactRecording} onPress={({ plugin, command }) => void invoke(plugin, command)} />;
  const conversationCommand = targets.find(({ plugin, command }) => plugin.manifest.conversation && command.topbar);
  const ConversationIcon = resolveContributionIcon(conversationCommand?.command.icon);
  const conversationShortcut = conversationCommand ? <button type="button" className="thread-toolbar__button"
    aria-label={conversationCommand.command.name} title={conversationCommand.command.name} data-plugin-conversation-toggle
    onClick={() => void invoke(conversationCommand.plugin, conversationCommand.command)}>
    <ConversationIcon size={15} aria-hidden="true" />
  </button> : null;
  const artifactPanel = preview && clients?.plugins ? <PluginArtifactPreviewPanel artifact={preview}
    readArtifact={clients.plugins.readArtifact} onWidthChange={setFeaturePanelWidth}
    sharedRowWidth={options.sharedRowWidth} sharedRowReservedWidth={SHARED_ROW_PRIMARY_RESERVE}
    onClose={() => setPreview(null)} /> : null;
  const content = artifactPanel;
  const sidePanelOverlay = Boolean(content) && conversationFeaturePanelOverlays(options.sharedRowWidth);
  const closeSidePanel = useCallback(() => setPreview(null), []);
  const closePluginRecording = useCallback(() => {
    setHiddenRecordings((current) => new Set(current).add(recordingOwner));
  }, [recordingOwner]);
  // Capture only the current turn's cards for this steering gesture. A later question
  // or a user-owned recorder must never be cancelled by an older acknowledgement.
  const capturePendingInputRelease = (turnId: string) => {
    const captured = calls.filter((call) => {
      if (call.origin !== "agent" || call.turnId !== turnId) return false;
      const interaction = pendingPluginInteraction([call], ui?.answeredInteractions);
      return interaction !== null && interaction.type !== "audio-record";
    });
    return async () => {
      for (const call of captured) {
        const latestCall = currentUi.current?.calls.find((item) => item.callId === call.callId && item.pluginId === call.pluginId);
        if (!latestCall || pluginInteractionSignature(latestCall) !== pluginInteractionSignature(call)
          || !pendingPluginInteraction([latestCall], currentUi.current?.answeredInteractions)) continue;
        if (!clients?.plugins) throw new Error("Plugin client unavailable");
        await clients.plugins.cancel(call.pluginId, call.callId);
        currentUi.current?.interruptPendingInteractions(call.events.flatMap((event) => event.type === "interaction"
          ? [`${call.pluginId}:${call.callId}:${event.request.interactionId}`] : []));
        currentUi.current?.setDismissedCallIds((current) => new Set(current).add(call.callId));
      }
    };
  };
  return { plugins, conversationShortcut, cards, recorders, shortcuts, scenarios, recording, openRecording, closeSidePanel, closePluginRecording,
    pluginRecordingSession: pluginRecording && !hiddenRecordings.has(recordingOwner) ? pluginRecording : null, capabilityLabels,
    processInteraction,
    capturePendingInputRelease,
    pendingKey: pending ? `${pending.call.callId}:${pluginInteractionSignature(pending.call)}` : null,
    waitingLabel: pending ? pluginInteractionWaitingLabel(pending, language === "en-US") : null,
    sidePanel: content ? <div className={`conversation-feature-sidepanel${sidePanelOverlay ? " conversation-feature-sidepanel--overlay" : ""}`}
      style={{ width: sidePanelOverlay ? "100%" : featurePanelWidth }}>{content}</div> : null,
    sidePanelWidth: content ? sidePanelOverlay ? 0 : featurePanelWidth : null,
    agentPrompt: (text: string) => buildAgentRoutedPluginPrompt(text, targets), recordingAuthenticated, runCommand, commandItems,
    waiting: Boolean(pending), pendingAgentTurnId: pending?.call.origin === "agent" ? pending.call.turnId : null,
    signIn: () => dispatch(appActions.navigate("/welcome")) };
}
