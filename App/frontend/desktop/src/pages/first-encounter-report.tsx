import { useEffect, useLayoutEffect, useRef, useState, type UIEvent } from "react";
import { MessageCircle, Sparkles } from "lucide-react";
import { Memmy } from "../components/mascot/memmy.js";
import { useTranslation } from "../i18n/use-translation.js";
import { AgentMessageContent } from "./agent-message-content.js";
import type { FirstEncounterReportPayload, FirstEncounterTaskAction } from "./first-encounter-protocol.js";

export interface FirstEncounterReportProps {
  payload: FirstEncounterReportPayload;
  isStreaming: boolean;
  simulateStreaming: boolean;
  onTaskClick: (action: FirstEncounterTaskAction) => void;
  onStartConversation: () => void;
  onSkip: () => void;
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
  const [showActions, setShowActions] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollReportRef = useRef(true);
  const isProgrammaticReportScrollRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  const report = props.payload.body;
  const emptyHistory = props.payload.emptyHistory;
  const primaryAction = props.payload.actions[0] ?? null;
  const secondaryActions = props.payload.actions.slice(1, 3);
  const mainAction = emptyHistory ? {
    buttonLabel: t("onboarding.report.firstConversation"),
    description: t("onboarding.report.firstConversationDescription"),
    onClick: props.onStartConversation
  } : primaryAction ? {
    buttonLabel: primaryAction.buttonLabel,
    description: primaryAction.description,
    onClick: () => props.onTaskClick(primaryAction)
  } : null;
  const contentIsStreaming = props.isStreaming || (props.simulateStreaming && !showActions);

  useEffect(() => {
    if (props.isStreaming) {
      setDisplayedText(report);
      setShowActions(false);
      return;
    }

    if (!props.simulateStreaming) {
      setDisplayedText(report);
      setShowActions(true);
      return;
    }

    if (!report) {
      return;
    }

    let index = 0;
    let timer: number | undefined;
    setDisplayedText("");
    setShowActions(false);

    const tick = () => {
      if (index >= report.length) {
        timer = window.setTimeout(() => setShowActions(true), 300);
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
  }, [primaryAction, props.isStreaming, props.simulateStreaming, report]);

  useLayoutEffect(() => {
    if (shouldAutoScrollReportRef.current) {
      scrollReportToBottom(showActions ? "smooth" : "auto");
    }
  }, [displayedText, showActions]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas-oat overflow-hidden">
      <div
        className="my-8 flex max-h-[calc(100vh-64px)] flex-col"
        style={{ width: "min(calc(100vw - 48px), clamp(600px, 64vw, 760px))" }}
      >
        <div className="mb-6 flex shrink-0 items-center gap-3">
          <Memmy pose="celebrate" size={64} />
          <div>
            <div className="flex items-center gap-2">
              <Sparkles size={16} className="text-action-sky" />
              <h2 className="text-base font-bold text-text-ink">{t("onboarding.report.title")}</h2>
            </div>
            <p className="text-xs text-text-ink/50 mt-0.5">{t("onboarding.report.subtitle")}</p>
          </div>
        </div>

        <div className="bg-background-paper rounded-card shadow-[0_2px_12px_rgba(0,0,0,0.06)] p-6 mb-4 flex min-h-0 flex-col">
          <div
            ref={scrollRef}
            className="text-sm text-text-ink/80 leading-[1.8] whitespace-pre-line min-h-[120px] overflow-y-auto pr-1"
            style={{ maxHeight: "min(42vh, 360px)" }}
            onScroll={handleReportScroll}
            onWheel={markReportUserScrollIntent}
            onTouchMove={markReportUserScrollIntent}
          >
            <AgentMessageContent content={displayedText} isStreaming={contentIsStreaming} />
          </div>

          {showActions && mainAction && (
            <div className="mt-5 shrink-0 animate-in fade-in slide-in-from-bottom-3" style={{ animationDuration: "500ms" }}>
              <ReportPrimaryAction {...mainAction} />
              {!emptyHistory && secondaryActions.length > 0 && (
                <div className="mt-4">
                  <span className="text-[11px] text-text-ink/35 font-normal">{t("onboarding.report.alternatives")}</span>
                  <div className="flex flex-wrap gap-2 mt-1.5">
                    {secondaryActions.map((secondaryAction) => (
                      <button
                        key={secondaryAction.suggestedPrompt}
                        type="button"
                        onClick={() => props.onTaskClick(secondaryAction)}
                        className="px-3.5 py-2 text-xs font-normal text-text-ink/55 bg-canvas-oat/60 border border-border-stone/20 rounded-lg hover:bg-canvas-oat hover:text-text-ink/75 hover:border-border-stone/35 transition-all cursor-pointer"
                      >
                        <span className="whitespace-normal text-center">{secondaryAction.buttonLabel}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {showActions && !emptyHistory && (
          <div className="flex shrink-0 items-center justify-between px-1 animate-in fade-in" style={{ animationDuration: "600ms" }}>
            <p className="text-xs text-text-ink/40 leading-relaxed">{t("onboarding.report.disclaimer")}</p>
            <button
              type="button"
              onClick={props.onSkip}
              className="text-xs font-normal text-text-ink/45 hover:text-action-sky transition-colors cursor-pointer shrink-0 ml-4"
            >
              {t("onboarding.report.skip")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReportPrimaryAction(props: { buttonLabel: string; description: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="w-full flex items-center gap-3 px-4 py-3.5 bg-action-sky/6 border border-action-sky/20 rounded-xl hover:bg-action-sky/10 transition-all cursor-pointer group"
    >
      <div className="w-9 h-9 rounded-lg bg-action-sky/12 flex items-center justify-center shrink-0 group-hover:bg-action-sky/20 transition-colors">
        <MessageCircle size={17} className="text-action-sky" />
      </div>
      <div className="flex-1 min-w-0 text-left">
        <div className="text-sm font-semibold text-text-ink/85">{props.buttonLabel}</div>
        <div className="text-xs text-text-ink/45 mt-0.5">{props.description}</div>
      </div>
    </button>
  );
}
