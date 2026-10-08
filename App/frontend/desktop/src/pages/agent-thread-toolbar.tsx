import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, Clock5, PanelRight, Search, X } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import type { AgentChatMessage } from "../state/agent-chat-slice.js";
import { collectConversationPrompts } from "./agent-thread-panel-model.js";
import { useThreadSearch } from "./agent-thread-search.js";

const PROMPT_POPOVER_WIDTH = 284;
const PROMPT_POPOVER_MAX_HEIGHT = 260;
const PROMPT_POPOVER_MIN_HEIGHT = 120;
const POPOVER_VIEWPORT_PADDING = 8;
const POPOVER_OFFSET = 4;

type AgentThreadToolbarProps = {
  title: string;
  titleTrailing?: ReactNode;
  messages: AgentChatMessage[];
  panelOpen: boolean;
  onOpenPanel: () => void;
  onJumpToMessage: (messageId: string) => void;
  onSearchNavigate?: () => void;
  getSearchRoot: () => HTMLElement | null;
};

export function AgentThreadToolbar(props: AgentThreadToolbarProps) {
  const { t } = useTranslation();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const [query, setQuery] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activePromptId, setActivePromptId] = useState<string | null>(null);
  const prompts = useMemo(() => collectConversationPrompts(props.messages), [props.messages]);
  const search = useThreadSearch({
    open: searchOpen,
    query,
    getRoot: props.getSearchRoot,
    contentVersion: props.messages,
    onNavigate: props.onSearchNavigate,
  });

  function openSearch() {
    setHistoryOpen(false);
    setSearchOpen(true);
    setSearchFocusRequest((request) => request + 1);
  }

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
    searchInputRef.current?.select();
  }, [searchFocusRequest, searchOpen]);

  function closeSearch() {
    setSearchOpen(false);
    setQuery("");
  }

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        openSearch();
        return;
      }
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (historyOpen) {
        event.preventDefault();
        setHistoryOpen(false);
      } else if (searchOpen) {
        event.preventDefault();
        closeSearch();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [historyOpen, searchOpen]);

  useEffect(() => {
    if (!prompts.length) setHistoryOpen(false);
  }, [prompts.length]);

  const counter = query.trim()
    ? `${search.total ? search.current + 1 : 0}/${search.total}${search.capped ? "+" : ""}`
    : null;

  return (
    <div className="thread-toolbar">
      <h1 className="agent-conversation-title" title={props.title}>
        <span className="agent-conversation-title__text">{props.title}</span>
        {props.titleTrailing}
      </h1>
      <div className="thread-toolbar__actions" data-window-drag-exclusion="thread-toolbar-actions">
        {searchOpen ? (
          <div className="thread-search" role="search">
            <span className="thread-search__icon" aria-hidden="true">
              <Search size={16} />
            </span>
            <input
              ref={searchInputRef}
              className="thread-search__input"
              value={query}
              placeholder={t("home.thread.search.placeholder")}
              aria-label={t("home.thread.search.placeholder")}
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (event.shiftKey) search.previous();
                  else search.next();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeSearch();
                }
              }}
            />
            {counter ? <span className="thread-search__counter" aria-live="polite">{counter}</span> : null}
            <button
              type="button"
              className="thread-search__nav"
              disabled={!search.total}
              aria-label={t("home.thread.search.previous")}
              title={t("home.thread.search.previous")}
              onClick={search.previous}
            >
              <ChevronUp size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="thread-search__nav"
              disabled={!search.total}
              aria-label={t("home.thread.search.next")}
              title={t("home.thread.search.next")}
              onClick={search.next}
            >
              <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="thread-search__close"
              aria-label={t("home.thread.search.close")}
              title={t("home.thread.search.close")}
              onClick={closeSearch}
            >
              <X size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <ToolbarButton label={t("home.thread.search")} onClick={openSearch}>
            <Search size={16} aria-hidden="true" />
          </ToolbarButton>
        )}
        {prompts.length ? (
          <ToolbarButton
            buttonRef={historyButtonRef}
            label={t("home.thread.prompts")}
            active={historyOpen}
            expanded={historyOpen}
            hasPopup="listbox"
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <Clock5 size={16} aria-hidden="true" />
          </ToolbarButton>
        ) : null}
        {!props.panelOpen ? (
          <ToolbarButton label={t("home.threadPanel.open")} onClick={props.onOpenPanel}>
            <PanelRight size={16} aria-hidden="true" />
          </ToolbarButton>
        ) : null}
      </div>
      {historyOpen ? (
        <PromptHistoryPopover
          anchorRef={historyButtonRef}
          prompts={prompts}
          activePromptId={activePromptId}
          onClose={() => setHistoryOpen(false)}
          onSelect={(messageId) => {
            setActivePromptId(messageId);
            setHistoryOpen(false);
            props.onJumpToMessage(messageId);
          }}
        />
      ) : null}
    </div>
  );
}

function ToolbarButton(props: {
  label: string;
  children: ReactNode;
  active?: boolean;
  expanded?: boolean;
  hasPopup?: "listbox" | "menu";
  buttonRef?: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  return (
    <button
      ref={props.buttonRef}
      type="button"
      className={`thread-toolbar__button${props.active ? " thread-toolbar__button--active" : ""}`}
      aria-label={props.label}
      title={props.label}
      aria-expanded={props.expanded}
      aria-haspopup={props.hasPopup}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function PromptHistoryPopover(props: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  prompts: Array<{ messageId: string; text: string }>;
  activePromptId: string | null;
  onClose: () => void;
  onSelect: (messageId: string) => void;
}) {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    function place() {
      const rect = props.anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const maxLeft = window.innerWidth - PROMPT_POPOVER_WIDTH - POPOVER_VIEWPORT_PADDING;
      const top = rect.bottom + POPOVER_OFFSET;
      setPosition({
        top,
        left: Math.max(POPOVER_VIEWPORT_PADDING, Math.min(rect.right - PROMPT_POPOVER_WIDTH, maxLeft)),
        maxHeight: Math.max(PROMPT_POPOVER_MIN_HEIGHT, Math.min(PROMPT_POPOVER_MAX_HEIGHT, window.innerHeight - top - POPOVER_VIEWPORT_PADDING)),
      });
    }
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [props.anchorRef]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !position) return;
    const active = props.activePromptId
      ? [...body.querySelectorAll<HTMLElement>("[data-prompt-message-id]")]
        .find((item) => item.dataset.promptMessageId === props.activePromptId)
      : null;
    body.scrollTop = active
      ? Math.max(0, active.offsetTop - (body.clientHeight - active.offsetHeight) / 2)
      : body.scrollHeight;
  }, [position, props.activePromptId]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target instanceof Node ? event.target : null;
      if (popoverRef.current?.contains(target) || props.anchorRef.current?.contains(target)) return;
      props.onClose();
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [props.anchorRef, props.onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={popoverRef}
      className="thread-prompt-list"
      role="listbox"
      aria-label={t("home.thread.prompts")}
      style={position ? { top: position.top, left: position.left, maxHeight: position.maxHeight } : { visibility: "hidden" }}
    >
      <div className="thread-prompt-list__header">
        {t("home.thread.prompts.header", { count: props.prompts.length })}
      </div>
      <div ref={bodyRef} className="thread-prompt-list__body">
        {props.prompts.map((prompt) => (
          <button
            key={prompt.messageId}
            type="button"
            role="option"
            aria-selected={prompt.messageId === props.activePromptId}
            className={`thread-prompt-list__item${prompt.messageId === props.activePromptId ? " thread-prompt-list__item--active" : ""}`}
            data-prompt-message-id={prompt.messageId}
            title={prompt.text}
            onClick={() => props.onSelect(prompt.messageId)}
          >
            <span className="thread-prompt-list__text">{prompt.text}</span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
