/** Onboarding scan animation module. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSourceView } from "@memmy/local-api-contracts";
import { Check, Loader2 } from "lucide-react";
import { Memmy } from "../components/mascot/memmy.js";
import type { AgentSourceScanProgress } from "../state/app-actions.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { AGENT_SOURCE_LOGOS } from "./agent-source-logos.js";
import type { DiscoveredAgent } from "./first-encounter-protocol.js";

export interface OnboardingScanAnimationProps {
  sources: AgentSourceView[];
  agents?: DiscoveredAgent[] | null;
  progress: AgentSourceScanProgress | null;
  isScanning: boolean;
  isPreparingReport?: boolean;
  errorMessage?: string | null;
  onComplete: (agents: DiscoveredAgent[]) => void;
  onSkip?: () => void;
}

const MAX_SCAN_MS = 12_000;
const PENDING_COUNT_CEILING = 48;
const COUNT_TICK_MS = 180;

interface ScanDisplayAgent {
  sourceId: string;
  name: string;
  conversations: number | null;
}

export function OnboardingScanAnimation(props: OnboardingScanAnimationProps) {
  const {
    agents: sampledAgents = null,
    errorMessage = null,
    isPreparingReport = false,
    isScanning,
    onComplete,
    onSkip,
    progress,
    sources
  } = props;
  const { t } = useTranslation();
  const sourceAgents = useMemo(() => buildDiscoveredAgents(sources), [sources]);
  const displayAgents: ScanDisplayAgent[] = sampledAgents ?? sourceAgents;
  const [revealedCount, setRevealedCount] = useState(0);
  const [forceComplete, setForceComplete] = useState(false);
  const [animatedCounts, setAnimatedCounts] = useState<Record<string, number>>({});
  const hasCompleted = useRef(false);
  const hasObservedScanActivity = useRef(false);
  const allRowsRevealed = revealedCount >= displayAgents.length;
  const allDisplayedRowsCompleted = displayAgents.length > 0 &&
    allRowsRevealed &&
    displayAgents.every((agent) => agent.conversations !== null);
  const scanActivityObserved = hasObservedScanActivity.current || isScanning || Boolean(progress) || Boolean(sampledAgents);
  const shouldCompleteScan = forceComplete || allDisplayedRowsCompleted || (scanActivityObserved && !isScanning && allRowsRevealed);

  useEffect(() => {
    const maxTimer = window.setTimeout(() => setForceComplete(true), MAX_SCAN_MS);
    return () => window.clearTimeout(maxTimer);
  }, []);

  useEffect(() => {
    if (revealedCount >= displayAgents.length) {
      return;
    }
    const timer = window.setTimeout(() => setRevealedCount((count) => count + 1), 550);
    return () => window.clearTimeout(timer);
  }, [displayAgents.length, revealedCount]);

  useEffect(() => {
    if (isScanning || progress || sampledAgents) {
      hasObservedScanActivity.current = true;
    }
  }, [isScanning, progress, sampledAgents]);

  useEffect(() => {
    if (isPreparingReport || !shouldCompleteScan || hasCompleted.current) {
      return;
    }

    hasCompleted.current = true;
    onComplete(toCompletedAgents(displayAgents));
  }, [displayAgents, isPreparingReport, onComplete, shouldCompleteScan]);

  useEffect(() => {
    if (revealedCount === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setAnimatedCounts((currentCounts) => nextAnimatedCounts(currentCounts, displayAgents.slice(0, revealedCount), progress));
    }, COUNT_TICK_MS);

    return () => window.clearInterval(timer);
  }, [displayAgents, progress, revealedCount]);

  const phase = shouldCompleteScan ? "ready" : progress?.phase ?? "scan";
  const isPreparingReportVisually = isPreparingReport || allDisplayedRowsCompleted;
  const titleKey = errorMessage ? "onboarding.scan.title.reportError" : isPreparingReportVisually ? "onboarding.scan.title.report" : scanTitleKey(phase);
  const subtitleKey = errorMessage ? "onboarding.scan.subtitle.reportError" : isPreparingReportVisually ? "onboarding.scan.subtitle.report" : scanSubtitleKey(phase);
  const showLoader = !errorMessage && (isPreparingReportVisually || phase !== "ready");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas-oat">
      <div className="w-full max-w-[460px] mx-4">
        <div className="flex items-center gap-3 mb-5">
          <Memmy pose="read" size={64} className="memmy-bob shrink-0 drop-shadow-[0_5px_12px_rgba(34,39,36,0.10)]" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-text-ink flex items-center gap-1.5">
              {t(titleKey)}
              {showLoader && <Loader2 size={15} strokeWidth={2.4} className="ml-1 shrink-0 animate-spin text-status-success" />}
            </h2>
            <p className="text-xs text-text-ink/50 mt-0.5">{t(subtitleKey)}</p>
          </div>
        </div>

        <div className="bg-background-paper rounded-card shadow-[0_2px_12px_rgba(0,0,0,0.06)] p-5">
          <div className="space-y-0 divide-y divide-black/[0.05]">
            {displayAgents.slice(0, revealedCount).map((agent, index) => (
              <ScanAgentRow
                key={agent.sourceId}
                agent={agent}
                index={index}
                displayedCount={displayCountForAgent(agent, animatedCounts)}
                isPending={agent.conversations === null}
              />
            ))}

            {revealedCount === 0 && (
              <div className="py-8 text-center text-xs text-text-ink/35">{t("onboarding.scan.waiting")}</div>
            )}
          </div>
        </div>

        <p className="mt-3 text-center text-[11px] font-normal leading-[1.45] text-text-ink/40 px-1">
          {t("onboarding.scan.privacy")}
        </p>
        {errorMessage && (
          <div className="agent-model-error-notice mt-3" role="alert">
            <div className="agent-model-error-notice__header">
              <p className="agent-model-error-notice__title">{errorMessage}</p>
            </div>
          </div>
        )}
        {errorMessage && onSkip && (
          <button
            type="button"
            onClick={onSkip}
            className="w-full mt-3 py-3.5 text-sm text-white font-normal bg-action-sky rounded-btn hover:bg-action-sky-hover transition-all cursor-pointer shadow-md hover:shadow-lg active:scale-[0.98]"
          >
            {t("onboarding.scan.skipStep")}
          </button>
        )}
      </div>
    </div>
  );
}

export function buildDiscoveredAgents(sources: AgentSourceView[]): ScanDisplayAgent[] {
  return sources
    .filter((source) => source.available && (source.builtin || source.messageCount > 0))
    .map((source) => ({
      sourceId: source.sourceId,
      name: source.displayName,
      conversations: source.messageCount > 0 ? source.messageCount : null
    }));
}

function ScanAgentRow(props: {
  agent: ScanDisplayAgent;
  index: number;
  displayedCount: number;
  isPending: boolean;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="flex items-center gap-3.5 py-3.5 first:pt-0 last:pb-0 animate-in fade-in slide-in-from-bottom-2"
      style={{ animationDuration: "320ms", animationDelay: `${props.index * 40}ms` }}
    >
      <AgentLogo agent={props.agent} />
      <div className="min-w-0 flex-1 text-left">
        <div className="text-sm font-normal leading-[1.25] tracking-[-0.006em] text-text-ink/85">{props.agent.name}</div>
        <div className="mt-0.5 text-xs font-normal tabular-nums text-text-ink/40">
          {t("onboarding.scan.conversationCount", { count: props.displayedCount })}
        </div>
      </div>
      {props.isPending ? (
        <div className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
          <Loader2 size={13} className="animate-spin text-text-ink/25" />
        </div>
      ) : (
        <div className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-action-sky/10">
          <Check size={11} className="text-action-sky" strokeWidth={2.4} />
        </div>
      )}
    </div>
  );
}

function nextAnimatedCounts(
  currentCounts: Record<string, number>,
  agents: ScanDisplayAgent[],
  progress: AgentSourceScanProgress | null
): Record<string, number> {
  const nextCounts = { ...currentCounts };
  for (const [index, agent] of agents.entries()) {
    const current = nextCounts[agent.sourceId] ?? 0;
    const target = targetCountForAgent(agent, index, current, progress);
    nextCounts[agent.sourceId] = stepCountToward(current, target);
  }
  return nextCounts;
}

function targetCountForAgent(
  agent: ScanDisplayAgent,
  index: number,
  current: number,
  progress: AgentSourceScanProgress | null
): number {
  if (agent.conversations !== null) {
    return agent.conversations;
  }

  const progressCount =
    progress && progress.sourceId === agent.sourceId && progress.current > 0
      ? Math.min(PENDING_COUNT_CEILING, progress.current)
      : 0;
  const crawlCount = Math.min(PENDING_COUNT_CEILING, Math.max(1, current + 1 + (index % 3)));
  return Math.max(progressCount, crawlCount);
}

function stepCountToward(current: number, target: number): number {
  if (current === target) {
    return current;
  }
  if (current > target) {
    return target;
  }
  return Math.min(target, current + Math.max(1, Math.ceil((target - current) / 4)));
}

function displayCountForAgent(agent: ScanDisplayAgent, counts: Record<string, number>): number {
  return counts[agent.sourceId] ?? agent.conversations ?? 1;
}

function toCompletedAgents(agents: ScanDisplayAgent[]): DiscoveredAgent[] {
  return agents
    .filter((agent): agent is DiscoveredAgent => agent.conversations !== null)
    .map((agent) => ({
      sourceId: agent.sourceId,
      name: agent.name,
      conversations: agent.conversations
    }));
}

function AgentLogo(props: { agent: ScanDisplayAgent }) {
  const logoUrl = AGENT_SOURCE_LOGOS[props.agent.sourceId];
  const frameClass = "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-canvas-oat/60 border border-border-stone/20";

  if (!logoUrl) {
    return (
      <span className={`${frameClass} text-[11.5px] font-normal text-text-ink/45`}>
        {abbreviateSourceName(props.agent.name)}
      </span>
    );
  }

  return (
    <span className={frameClass}>
      <img src={logoUrl} alt="" aria-hidden="true" className="h-5 w-5 object-contain" />
    </span>
  );
}

function abbreviateSourceName(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length >= 2) {
    return words.slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("");
  }
  return name.slice(0, 2).toUpperCase();
}

function scanTitleKey(phase: string): MessageKey {
  if (phase === "ready" || phase === "done") {
    return "onboarding.scan.title.ready";
  }
  if (phase === "add" || phase === "summarize") {
    return "onboarding.scan.title.analyzing";
  }
  return "onboarding.scan.title.discovering";
}

function scanSubtitleKey(phase: string): MessageKey {
  if (phase === "ready" || phase === "done") {
    return "onboarding.scan.subtitle.ready";
  }
  if (phase === "add" || phase === "summarize") {
    return "onboarding.scan.subtitle.analyzing";
  }
  return "onboarding.scan.subtitle.discovering";
}
