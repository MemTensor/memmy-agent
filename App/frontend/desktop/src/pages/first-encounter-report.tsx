import { useEffect, useLayoutEffect, useRef, useState, type UIEvent } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { Memmy } from "../components/mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";
import { AgentMessageContent } from "./agent-message-content.js";
import type { FirstEncounterReportPayload } from "./first-encounter-protocol.js";
import {
  FirstEncounterRelayChallenge,
  FirstEncounterRelayOptIn,
  type RelayAgentOption
} from "./first-encounter-relay-challenge.js";

export interface FirstEncounterReportProps {
  payload: FirstEncounterReportPayload;
  isStreaming: boolean;
  simulateStreaming: boolean;
  followUpMode: "relay" | "connect" | null;
  agents: RelayAgentOption[];
  onOpenAgent?: (sourceId: string, prompt: string) => Promise<boolean>;
  onVerifyMemory?: (sourceId: string, startedAt: string) => Promise<boolean>;
  onRelayLifecycle?: (event: "relay_clicked" | "memory_verified", sourceId: string, action: string) => void;
  onContinue: () => void;
}

const PUNCTUATION = new Set(["。", "！", "？", "，", "、", "；", "：", ".", "!", "?", ",", ";", ":", "\n"]);
const MARKDOWN_BLOCK_CHARS = new Set(["#", "-", "*", "|", "`", ">", "\n"]);
const REPORT_CONTENT_BOTTOM_EPSILON_PX = 4;
const REPORT_USER_SCROLL_INTENT_MS = 600;

function isReportContentAtBottom(element: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">): boolean {
  return element.scrollTop + element.clientHeight >= element.scrollHeight - REPORT_CONTENT_BOTTOM_EPSILON_PX;
}

export function FirstEncounterReport(props: FirstEncounterReportProps) {
  const { t } = useTranslation();
  const [displayedText, setDisplayedText] = useState("");
  const [showFollowUps, setShowFollowUps] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollReportRef = useRef(true);
  const isProgrammaticReportScrollRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  const report = props.payload.body;
  const contentIsStreaming = props.isStreaming || (props.simulateStreaming && !showFollowUps);

  useEffect(() => {
    if (props.isStreaming) {
      setDisplayedText(report);
      setShowFollowUps(false);
      return;
    }

    if (!props.simulateStreaming) {
      setDisplayedText(report);
      setShowFollowUps(true);
      return;
    }

    if (!report) {
      return;
    }

    let index = 0;
    let timer: number | undefined;
    setDisplayedText("");
    setShowFollowUps(false);

    const tick = () => {
      if (index >= report.length) {
        timer = window.setTimeout(() => setShowFollowUps(true), 300);
        return;
      }

      const char = report[index] ?? "";
      index = Math.min(index + (MARKDOWN_BLOCK_CHARS.has(char) ? 1 : 2), report.length);
      setDisplayedText(report.slice(0, index));
      timer = window.setTimeout(tick, PUNCTUATION.has(char) ? 120 : 28);
    };

    tick();
    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [props.isStreaming, props.simulateStreaming, report]);

  useLayoutEffect(() => {
    if (shouldAutoScrollReportRef.current) {
      scrollReportToBottom(showFollowUps ? "smooth" : "auto");
    }
  }, [displayedText, showFollowUps]);

  function scrollReportToBottom(behavior: ScrollBehavior = "auto") {
    const target = scrollRef.current;
    if (!target) {
      return;
    }

    isProgrammaticReportScrollRef.current = true;
    target.scrollTo({ top: target.scrollHeight, behavior });
    window.setTimeout(() => {
      isProgrammaticReportScrollRef.current = false;
    }, 120);
  }

  function markReportUserScrollIntent() {
    userScrollIntentUntilRef.current = Date.now() + REPORT_USER_SCROLL_INTENT_MS;
  }

  function handleReportScroll(event: UIEvent<HTMLDivElement>) {
    if (isProgrammaticReportScrollRef.current) {
      return;
    }
    if (isReportContentAtBottom(event.currentTarget)) {
      shouldAutoScrollReportRef.current = true;
      return;
    }
    if (Date.now() > userScrollIntentUntilRef.current) {
      return;
    }
    shouldAutoScrollReportRef.current = false;
  }

  return (
    // Outer scrolls on small screens; inner min-h-screen + items-center centers when content fits.
    // Use min-h-screen (not min-h-full): prebuilt utilities omit min-h-full.
    <div className="fixed inset-0 z-50 overflow-y-auto bg-canvas-oat">
      <div className="flex min-h-screen items-center justify-center px-6 py-8">
        <div
          className="flex flex-col"
          style={{ width: "min(calc(100vw - 48px), clamp(600px, 64vw, 760px))" }}
        >
          <div className="mb-4 flex shrink-0 justify-end">
            <div className="agent-user-turn flex min-w-0 max-w-[75%] justify-end">
              <div className="agent-chat-bubble-frame agent-chat-bubble-frame--user max-w-full min-w-0">
                <div className="agent-chat-bubble agent-chat-bubble--user max-w-full min-w-0 overflow-hidden px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {props.payload.reportPrompt}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3">
            <div className="mt-1 shrink-0">
              <Memmy pose="celebrate" size={56} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex flex-col rounded-card bg-background-paper p-6 shadow-[0_2px_12px_rgba(0,0,0,0.06)]">
                <div className="mb-3 flex shrink-0 items-center gap-1.5">
                  <Sparkles size={14} className="text-action-sky" />
                  <h2 className="text-sm font-bold text-text-ink">{t("onboarding.report.title")}</h2>
                </div>
                <div
                  ref={scrollRef}
                  className="min-h-[120px] overflow-y-auto pr-1 text-sm leading-[1.8] whitespace-pre-line text-text-ink/80"
                  style={{ maxHeight: "min(42vh, 360px)" }}
                  onScroll={handleReportScroll}
                  onWheel={markReportUserScrollIntent}
                  onTouchMove={markReportUserScrollIntent}
                >
                  <AgentMessageContent content={displayedText} isStreaming={contentIsStreaming} />
                </div>

                {showFollowUps && props.followUpMode === "relay" && (
                  <div className="mt-5 shrink-0 animate-in fade-in slide-in-from-bottom-3" style={{ animationDuration: "500ms" }}>
                    <FirstEncounterRelayChallenge
                      agents={props.agents}
                      prompt={props.payload.relayPrompt}
                      onOpenAgent={props.onOpenAgent}
                      onVerifyMemory={props.onVerifyMemory}
                      onLifecycle={props.onRelayLifecycle}
                    />
                  </div>
                )}

                {showFollowUps && props.followUpMode === "connect" && (
                  <div className="mt-5 shrink-0 animate-in fade-in slide-in-from-bottom-3" style={{ animationDuration: "500ms" }}>
                    {/* scan_only: keep the value card, omit the connect button — this screen cannot install Agents. */}
                    <FirstEncounterRelayOptIn />
                  </div>
                )}
              </div>

              {showFollowUps && (
                <div className="mt-4 flex shrink-0 items-center justify-between px-1 animate-in fade-in" style={{ animationDuration: "600ms" }}>
                  <p className="text-xs leading-relaxed text-text-ink/40">{t("onboarding.report.disclaimer")}</p>
                  <button
                    type="button"
                    onClick={props.onContinue}
                    className="ml-4 inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-btn bg-action-sky px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-action-sky-hover"
                  >
                    {t("onboarding.report.continue")}
                    <ArrowRight size={13} aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
