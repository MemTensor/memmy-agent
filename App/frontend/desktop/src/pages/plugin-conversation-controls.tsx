import { Mic } from "lucide-react";
import type { ReactNode } from "react";
import type { InstalledPlugin, PluginCommandContribution, PluginScenarioContribution, PluginArtifactRef } from "@memmy/local-api-contracts";
import { normalizePluginConversationId, type PluginUiCall, type PluginRecordingMaterial } from "../app/plugin-ui-context.js";
import { pinnedCapabilityKey } from "./plugin-capability-host.js";
import { resolveContributionIcon } from "./agent-command-palette.js";
import { normalizeThreadPath, type ThreadArtifact } from "./agent-thread-panel-model.js";
import type { RecordingArchiveEntry } from "./recording-entry.js";
import { buildLegalDiagnosisContinuationPrompt } from "../lib/legal-diagnosis-continuation.js";
import { messageCatalogs, resolveLanguage } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";



export interface PluginCommandTarget {
  plugin: InstalledPlugin;
  command: PluginCommandContribution;
}


export function collectPluginCommandTargets(plugins: InstalledPlugin[], reserved: Iterable<string> = []): PluginCommandTarget[] {
  const seen = new Set([...reserved].map((command) => command.toLowerCase()));
  return plugins.filter((plugin) => plugin.state === "active").flatMap((plugin) => (
    (plugin.manifest.commands ?? []).flatMap((command) => {
      if (seen.has(command.command)) return [];
      seen.add(command.command);
      return [{ plugin, command }];
    })
  ));
}


/**
 * Selects the commands a plugin asked to pin above the composer.
 *
 * Pinned commands are the ones the user reaches repeatedly and out of order,
 * where hunting for a slash command each time is the wrong interaction. They
 * are a shortcut for the same invocation, not a separate path, so they are
 * drawn from the same targets the slash commands resolve against.
 *
 * @param targets Available plugin commands.
 * @returns Targets whose command declares itself pinned.
 */
export function selectPinnedPluginCommands(targets: PluginCommandTarget[]): PluginCommandTarget[] {
  return targets.filter((target) => target.command.pinned === true);
}


/**
 * Selects the commands the slash palette should list.
 *
 * @param targets Available plugin commands.
 * @returns Targets that have no pinned button standing in for them.
 */
export function selectSlashPluginCommands(targets: PluginCommandTarget[]): PluginCommandTarget[] {
  return targets.filter((target) => target.command.pinned !== true);
}


/** A scenario card together with the plugin that contributed it. */
export interface PluginScenarioTarget extends PluginScenarioContribution {
  pluginId: string;
}


/**
 * Collects the scenario entry cards contributed by enabled plugins.
 *
 * Only active plugins contribute: a disabled plugin cannot serve the work its
 * card would start, so offering it would dead-end.
 *
 * @param plugins Installed plugins.
 * @returns Scenario cards to offer on the empty home screen.
 */
export function collectPluginScenarios(plugins: InstalledPlugin[]): PluginScenarioTarget[] {
  return plugins
    .filter((plugin) => plugin.state === "active")
    .flatMap((plugin) => (plugin.manifest.scenarios ?? []).map((scenario) => ({ ...scenario, pluginId: plugin.id })));
}


/**
 * Fixed buttons above the composer for the commands a plugin pinned.
 *
 * Renders nothing when no plugin pinned anything, so the composer keeps its
 * usual layout for everyone else.
 */
export function PinnedPluginCommandBar(props: {
  targets: PluginCommandTarget[];
  disabled: boolean;
  recordingOpen: boolean;
  onRecordingPress(): void;
  /** Buttons whose card is on screen, as `pluginId:capabilityId`. */
  active: ReadonlySet<string>;
  /** Pressing a button opens its card, or closes the one it already opened. */
  onPress(target: PluginCommandTarget): void;
}) {
  if (props.targets.length === 0) return null;
  return (
    <div className="pinned-command-bar">
      {props.targets.map((target) => {
        const Icon = target.plugin.id === "legal-labor" && target.command.topbar === true ? Mic : resolveContributionIcon(target.command.icon);
        // The composer recording entry controls its compact card independently
        // of the top-bar page and pending material collection calls.
        const recording = target.command.topbar === true;
        const open = recording ? props.recordingOpen : props.active.has(`${target.plugin.id}:${target.command.capabilityId}`);
        return (
          <button
            key={`${target.plugin.id}:${target.command.command}`}
            type="button"
            disabled={props.disabled}
            title={target.command.description}
            className="pinned-command-chip"
            // These buttons stay on screen while their card is open, so without
            // this the card and the button that raised it look unrelated.
            data-open={open ? "true" : undefined}
            aria-pressed={open}
            onClick={() => recording ? props.onRecordingPress() : props.onPress(target)}
          >
            <Icon size={13} aria-hidden="true" />
            {target.command.name}
          </button>
        );
      })}
    </div>
  );
}


/** Legal shortcuts belong only to conversations that actually invoked the plugin. */
export function selectConversationPinnedCommands(targets: PluginCommandTarget[], calls: readonly PluginUiCall[]): PluginCommandTarget[] {
  const invoked = new Set(calls.map((call) => call.pluginId));
  return selectPinnedPluginCommands(targets).filter((target) =>
    target.plugin.id !== "legal-labor" || invoked.has(target.plugin.id));
}


/** Legal workflow cards own the composer until the user handles that step. */
export function selectPinnedCommandsForLegalWorkflow(targets: PluginCommandTarget[], workflowCardOpen: boolean): PluginCommandTarget[] {
  return workflowCardOpen ? targets.filter((target) => target.plugin.id !== "legal-labor") : targets;
}


/**
 * Which pinned buttons currently have a card on screen.
 *
 * A pinned call is either the user's own or a skill invocation of a capability
 * represented by a pinned command. It holds the screen until it finishes or is
 * closed, so its button is highlighted for exactly that long.
 */
export function selectOpenPinnedCapabilities(
  calls: readonly PluginUiCall[],
  dismissedCallIds?: ReadonlySet<string>,
  pinnedCapabilities: ReadonlySet<string> = new Set(),
  hiddenCallIds?: ReadonlySet<string>
): Set<string> {
  const open = new Set<string>();
  for (const call of calls) {
    if (call.origin !== "user" && !pinnedCapabilities.has(pinnedCapabilityKey(call))) continue;
    // Hidden cards keep their calls alive but no longer highlight the button.
    if (dismissedCallIds?.has(call.callId) || hiddenCallIds?.has(call.callId)) continue;
    if (call.events.some((event) => event.type === "result" || event.type === "error")) continue;
    open.add(pinnedCapabilityKey(call));
  }
  return open;
}


/** Finds a pending call to hide or show, including one already hidden. */
export function selectPinnedToggleCall(
  calls: readonly PluginUiCall[],
  pluginId: string,
  capabilityId: string,
  dismissedCallIds?: ReadonlySet<string>,
  pinnedCapabilities: ReadonlySet<string> = new Set()
): string | null {
  const prioritized = [...calls.filter((call) => call.origin !== "agent"), ...calls.filter((call) => call.origin === "agent")];
  for (let index = prioritized.length - 1; index >= 0; index -= 1) {
    const call = prioritized[index]!;
    if (pinnedCapabilityKey(call) !== `${pluginId}:${capabilityId}`) continue;
    if (call.origin !== "user" && !pinnedCapabilities.has(pinnedCapabilityKey(call))) continue;
    // Explicitly cancelled calls cannot be restored; hidden calls can.
    if (dismissedCallIds?.has(call.callId)) continue;
    if (call.events.some((event) => event.type === "result" || event.type === "error")) continue;
    return call.callId;
  }
  return null;
}


/** A visibility gesture never answers, cancels, or restarts a pending call. */
export async function pressPinnedPluginCommand(options: {
  calls: readonly PluginUiCall[];
  pluginId: string;
  capabilityId: string;
  dismissedCallIds?: ReadonlySet<string>;
  pinnedCapabilities: ReadonlySet<string>;
  toggleVisibility(callId: string): void;
  open(): Promise<unknown>;
  opening?: Set<string>;
  conversationId?: string;
}): Promise<void> {
  const callId = selectPinnedToggleCall(options.calls, options.pluginId, options.capabilityId,
    options.dismissedCallIds, options.pinnedCapabilities);
  if (callId) options.toggleVisibility(callId);
  else {
    const key = JSON.stringify([options.conversationId ?? null, options.pluginId, options.capabilityId]);
    if (options.opening?.has(key)) return;
    options.opening?.add(key);
    try { await options.open(); } finally { options.opening?.delete(key); }
  }
}


/** Closing one step must never hide the next request in the same call. */
export function pluginInteractionSignature(call: PluginUiCall | undefined): string {
  return call?.events.filter((event) => event.type === "interaction")
    .map((event) => event.type === "interaction" ? event.request.interactionId : "").join("\n") ?? "";
}


export function unresolvedAgentInteractionKeys(calls: readonly PluginUiCall[]): string[] {
  return calls.filter((call) => call.origin === "agent"
    && !call.events.some((event) => event.type === "result" || event.type === "error"))
    .flatMap((call) => call.events.flatMap((event) => event.type === "interaction"
      ? [`${call.pluginId}:${call.callId}:${event.request.interactionId}`] : []));
}


export function reconcileHiddenPluginCalls(hidden: Set<string>, hiddenSteps: ReadonlyMap<string, string>, calls: readonly PluginUiCall[]): Set<string> {
  const next = new Set(hidden);
  for (const id of hidden) {
    const call = calls.find((candidate) => candidate.callId === id);
    if (call?.events.some((event) => event.type === "interaction")
      && hiddenSteps.get(id) !== pluginInteractionSignature(call)) next.delete(id);
  }
  return next.size === hidden.size ? hidden : next;
}


export function buildLegalDiagnosisContinuation(call: PluginUiCall, language = "zh-CN"): string {
  const result = call.events.find((event) => event.type === "result");
  const output = result?.type === "result" && result.output && typeof result.output === "object"
    ? result.output as Record<string, unknown> : {};
  if (typeof output.sessionId !== "string" || !output.sessionId.trim()) {
    throw new Error(messageCatalogs[resolveLanguage(language)]["home.legalDiagnosis.sessionMissing"]);
  }
  return buildLegalDiagnosisContinuationPrompt(output.sessionId);
}


export function parsePluginCommandInvocation(input: string, targets: PluginCommandTarget[]): {
  plugin: InstalledPlugin;
  contribution: PluginCommandContribution;
  arguments: string;
} | null {
  const trimmed = input.trim();
  const token = trimmed.split(/\s/, 1)[0]?.toLowerCase();
  const target = targets.find((item) => item.command.command === token);
  return target ? { plugin: target.plugin, contribution: target.command, arguments: trimmed.slice(target.command.command.length).trim() } : null;
}


/** Converts an Agent-routed plugin command into an explicit Skill invocation. */
export function buildAgentRoutedPluginPrompt(input: string, targets: PluginCommandTarget[]): string | null {
  const invocation = parsePluginCommandInvocation(input, targets);
  const skillId = invocation?.contribution.agentSkillId;
  if (!invocation || !skillId) return null;
  return `$${skillId}${invocation.arguments ? ` ${invocation.arguments}` : ""}`;
}


/**
 * The files a finished recording contributes to the diagnosis materials card.
 *
 * Only the transcript goes in: the diagnosis reads text, and the audio stays
 * in the recording archive for playback.
 */
export function selectRecordingMaterialFiles(entry: RecordingArchiveEntry): PluginRecordingMaterial[] {
  // A handed-over recording is already on the upload card as its own row.
  if (entry.handedOver) return [];
  return (entry.files ?? [])
    .filter((file) => file.kind !== "audio")
    .map((file) => ({ ...file, collected: entry.collected === true }));
}


/**
 * The recording and transcript files a conversation hands over with its report.
 *
 * Oldest first, each recording's audio before its transcript, matching the
 * order the interviews happened in.
 */
export function selectRecordingDeliveryFiles(recordings: readonly RecordingArchiveEntry[], conversationId: string | null): PluginArtifactRef[] {
  const normalized = normalizePluginConversationId(conversationId);
  if (!normalized) return [];
  return recordings
    .filter((entry) => entry.status !== "transcribing" && entry.status !== "failed"
      && normalizePluginConversationId(entry.sessionKey) === normalized)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    .flatMap((entry) => (entry.files ?? []).map((file) => ({
      id: `recording:${file.path}`, name: file.name, mediaType: file.mime, uri: file.url, path: file.path
    })));
}


/** Agent-owned plugin files enter Artifacts only after the Agent sends them in a message. */
export function selectPluginThreadArtifacts(
  calls: readonly PluginUiCall[],
  recordingFiles: readonly PluginArtifactRef[] = []
): ThreadArtifact[] {
  const artifacts = new Map<string, ThreadArtifact>();
  const names = new Set<string>();
  const add = (artifact: PluginArtifactRef) => {
    if (artifact.role === "setup") return;
    const path = artifact.path?.trim() || undefined;
    const url = artifact.uri?.trim() || undefined;
    const key = normalizeThreadPath(path ?? url ?? "");
    if (!key || artifacts.has(key)) return;
    artifacts.set(key, { key, name: artifact.name, ...(path ? { path } : {}), ...(url ? { url } : {}) });
    names.add(artifact.name);
  };
  for (const call of calls) {
    if (call.origin === "agent") continue;
    for (const event of call.events) if (event.type === "artifact") add(event.artifact);
  }
  // The recorder archive remains available independently of Agent delivery.
  for (const artifact of recordingFiles) if (!names.has(artifact.name)) add(artifact);
  return [...artifacts.values()];
}


/** Keeps the global plugin event stream scoped to the conversation on screen. */
export function selectPluginCallsForConversation(
  calls: readonly PluginUiCall[],
  currentChatId: string | null,
  currentSessionKey: string | null,
  draftScopeKey: string
): PluginUiCall[] {
  // Once a chat exists its public id is authoritative.  The session key is an
  // alternate spelling of that same id for Agent-originated events; accepting
  // an old session key during navigation can briefly render another chat's
  // pending card.
  const activeConversationId = currentChatId ?? currentSessionKey ?? draftScopeKey;
  const normalizedActiveId = normalizePluginConversationId(activeConversationId);
  if (!normalizedActiveId) return [];
  return calls.filter((call) => normalizePluginConversationId(call.conversationId) === normalizedActiveId);
}
