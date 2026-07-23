import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSourceStatus, ScanPermission } from "@memmy/local-api-contracts";
import { ArrowRight, ArrowRightLeft, Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceDisplayName, agentSourceLogoUrl, normalizeAgentSourceId } from "./agent-source-logos.js";

export interface RelayAgentOption {
  sourceId: string;
  displayName?: string;
  available: boolean;
  status: AgentSourceStatus;
}

export interface FirstEncounterRelayChallengeProps {
  agents: RelayAgentOption[];
  onOpenAgent?: (sourceId: string, prompt: string) => Promise<boolean>;
  onCopyPrompt?: (prompt: string) => Promise<void>;
}

export interface FirstEncounterRelayOptInProps {
  onOpenConnections: () => void;
}

const RELAY_AGENT_IDS = new Set(["cursor", "claude_code", "codex", "opencode", "openclaw", "hermes", "workbuddy"]);
type RelayFeedback =
  | { kind: "copied" }
  | { kind: "copy_failed" }
  | { kind: "opened_and_copied"; agent: RelayAgentOption }
  | { kind: "opened_copy_failed"; agent: RelayAgentOption }
  | { kind: "copy_fallback"; agent: RelayAgentOption }
  | { kind: "failed"; agent: RelayAgentOption };

export function FirstEncounterRelayChallenge(props: FirstEncounterRelayChallengeProps) {
  const { t } = useTranslation();
  const [feedback, setFeedback] = useState<RelayFeedback | null>(null);
  const [launchingSourceId, setLaunchingSourceId] = useState<string | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const agents = useMemo(() => relayAgentOptions(props.agents), [props.agents]);

  useEffect(() => () => {
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
  }, []);

  function showTemporaryFeedback(nextFeedback: RelayFeedback) {
    setFeedback(nextFeedback);
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
    }
    feedbackTimerRef.current = window.setTimeout(() => {
      setFeedback(null);
      feedbackTimerRef.current = null;
    }, 2_400);
  }

  async function selectAgent(agent: RelayAgentOption) {
    if (launchingSourceId) {
      return;
    }
    setLaunchingSourceId(agent.sourceId);
    try {
      const prompt = t("onboarding.relay.prompt");
      const outcome = await launchFirstEncounterRelay({
        sourceId: agent.sourceId,
        prompt,
        openAgent: props.onOpenAgent,
        copyPrompt: props.onCopyPrompt
      });
      if (outcome.opened) {
        showTemporaryFeedback({ agent, kind: outcome.copied ? "opened_and_copied" : "opened_copy_failed" });
      } else {
        showTemporaryFeedback({ agent, kind: outcome.copied ? "copy_fallback" : "failed" });
      }
    } catch {
      showTemporaryFeedback({ agent, kind: "failed" });
    } finally {
      setLaunchingSourceId(null);
    }
  }

  async function copyInstruction() {
    try {
      await (props.onCopyPrompt ?? copyRelayPrompt)(t("onboarding.relay.prompt"));
      showTemporaryFeedback({ kind: "copied" });
    } catch {
      showTemporaryFeedback({ kind: "copy_failed" });
    }
  }

  if (agents.length === 0) {
    return null;
  }

  const status = relayFeedbackStatus(feedback, t);

  return (
    <div className="mt-4 rounded-xl border border-action-sky/20 bg-action-sky/6 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-action-sky/12">
          <ArrowRightLeft size={17} className="text-action-sky" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text-ink/85">{t("onboarding.relay.title")}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-text-ink/50">{t("onboarding.relay.body")}</p>
        </div>
        <button
          type="button"
          onClick={() => void copyInstruction()}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border-stone/20 bg-background-paper px-2.5 text-[11px] font-medium text-text-ink/55 transition-colors hover:border-border-stone/35 hover:bg-canvas-oat hover:text-text-ink/80"
        >
          {feedback?.kind === "copied"
            ? <Check size={13} className="text-action-sky" aria-hidden="true" />
            : <Copy size={13} aria-hidden="true" />}
          {feedback?.kind === "copied" ? t("onboarding.relay.copiedPrompt") : t("onboarding.relay.copyPrompt")}
        </button>
      </div>

      <div className="mt-3 grid gap-2 pl-12" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        {agents.map((agent) => {
          const logoUrl = agentSourceLogoUrl(agent.sourceId);
          const agentName = relayAgentName(agent);
          const launching = launchingSourceId === agent.sourceId;
          return (
            <button
              key={agent.sourceId}
              type="button"
              disabled={Boolean(launchingSourceId)}
              onClick={() => void selectAgent(agent)}
              className="inline-flex w-full items-center justify-start gap-2 rounded-lg border border-border-stone/20 bg-background-paper px-3.5 py-2 text-xs font-normal text-text-ink/60 transition-all hover:border-border-stone/35 hover:bg-canvas-oat hover:text-text-ink/80 disabled:cursor-wait disabled:opacity-60"
            >
              {logoUrl ? <img src={logoUrl} alt="" className="h-4 w-4 rounded-sm" /> : null}
              <span className="truncate">{t("onboarding.relay.openAgent", { agent: agentName })}</span>
              {launching
                ? <Loader2 size={13} className="ml-auto shrink-0 animate-spin text-action-sky" aria-hidden="true" />
                : <ExternalLink size={13} className="ml-auto shrink-0 text-text-ink/35" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      {status ? (
        <p
          className={`mt-2 pl-12 text-[11px] ${status.tone === "danger" ? "text-status-danger" : "text-text-ink/50"}`}
          role="status"
          aria-live="polite"
        >
          {status.text}
        </p>
      ) : null}
    </div>
  );
}

export function FirstEncounterRelayOptIn(props: FirstEncounterRelayOptInProps) {
  const { t } = useTranslation();
  return (
    <div className="mt-4 rounded-xl border border-action-sky/20 bg-action-sky/6 px-4 py-3.5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-action-sky/12">
          <ArrowRightLeft size={17} className="text-action-sky" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text-ink/85">{t("onboarding.relay.optInTitle")}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-text-ink/50">{t("onboarding.relay.optInBody")}</p>
        </div>
        <button
          type="button"
          onClick={props.onOpenConnections}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-action-sky px-3 text-[11px] font-semibold text-white transition-colors hover:bg-action-sky-hover"
        >
          {t("onboarding.relay.optInAction")}
          <ArrowRight size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function relayAgentOptions(agents: RelayAgentOption[]): RelayAgentOption[] {
  const seen = new Set<string>();
  return agents.filter((agent) => {
    const sourceId = normalizeAgentSourceId(agent.sourceId);
    if (!agent.available || agent.status === "not_connected" || !RELAY_AGENT_IDS.has(sourceId) || seen.has(sourceId)) {
      return false;
    }
    seen.add(sourceId);
    return true;
  });
}

/** True when at least one supported agent binary/history source was detected on this machine. */
export function hasDetectedRelayAgents(agents: RelayAgentOption[]): boolean {
  return agents.some((agent) => agent.available && RELAY_AGENT_IDS.has(normalizeAgentSourceId(agent.sourceId)));
}

export function firstEncounterFollowUpMode(permission: ScanPermission): "relay" | "connect" | null {
  if (permission === "scan_and_write_skill") {
    return "relay";
  }
  if (permission === "scan_only") {
    return "connect";
  }
  return null;
}

function relayAgentName(agent: RelayAgentOption): string {
  return agent.displayName?.trim() || agentSourceDisplayName(agent.sourceId);
}

function relayFeedbackStatus(
  feedback: RelayFeedback | null,
  t: (key: string, vars?: Record<string, string | number>) => string
): { tone: "info" | "danger"; text: string } | null {
  if (!feedback || feedback.kind === "copied") {
    return null;
  }
  if (feedback.kind === "copy_failed") {
    return { tone: "danger", text: t("onboarding.relay.copyPromptFailed") };
  }
  const agent = relayAgentName(feedback.agent);
  switch (feedback.kind) {
    case "opened_and_copied":
      return { tone: "info", text: t("onboarding.relay.openedCopied", { agent }) };
    case "copy_fallback":
      return { tone: "info", text: t("onboarding.relay.openFallback", { agent }) };
    case "opened_copy_failed":
      return { tone: "danger", text: t("onboarding.relay.openedCopyFailed", { agent }) };
    case "failed":
      return { tone: "danger", text: t("onboarding.relay.openFailed", { agent }) };
  }
}

export interface LaunchFirstEncounterRelayInput {
  sourceId: string;
  prompt: string;
  openAgent?: (sourceId: string, prompt: string) => Promise<boolean>;
  copyPrompt?: (prompt: string) => Promise<void>;
}

export async function launchFirstEncounterRelay(input: LaunchFirstEncounterRelayInput): Promise<{ opened: boolean; copied: boolean }> {
  let copied = false;
  try {
    await (input.copyPrompt ?? copyRelayPrompt)(input.prompt);
    copied = true;
  } catch {
    copied = false;
  }

  let opened = false;
  try {
    opened = await input.openAgent?.(input.sourceId, input.prompt) ?? false;
  } catch {
    opened = false;
  }

  return { opened, copied };
}

async function copyRelayPrompt(prompt: string): Promise<void> {
  if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
    await navigator.clipboard.writeText(prompt);
    return;
  }
  if (typeof document !== "undefined") {
    const textarea = document.createElement("textarea");
    textarea.value = prompt;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (copied) {
      return;
    }
  }
  throw new Error("Clipboard API unavailable");
}
