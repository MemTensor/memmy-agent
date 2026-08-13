/**
 * Composer quick actions for the new-task screen (design-complete mock).
 *
 * Implements the prototype's composer affordances: attach (+), reference (@)
 * and capability (/) triggers with popovers anchored under each button, plus
 * selected context chips in the composer toolbar.
 */
import {
  useEffect,
  useRef,
  useState,
  type ChangeEventHandler,
  type ClipboardEventHandler,
  type CSSProperties,
  type FormEventHandler,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref
} from "react";
import { AtSign, Plus, SquareSlash } from "lucide-react";
import { FileTypeIcon, FolderTypeIcon } from "../components/file-type-icon.js";
import { Tooltip } from "../components/tooltip.js";
import { useTranslation } from "../i18n/use-translation.js";
import type { ComposerContextReference } from "../state/agent-composer-state.js";
import { AgentAttachmentCard } from "./agent-file-attachment-chip.js";
import { buildHomeReferenceItems, type HomeReferenceItem } from "./literature-review-demo-data.js";

export type ComposerContextChip = ComposerContextReference;

const HOME_REFERENCE_ITEMS: HomeReferenceItem[] = buildHomeReferenceItems();

/** Extracts a trailing `@token` mention query from the composer input, or null. */
export function mentionQueryFromInput(input: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(input);
  return match ? (match[1] ?? "") : null;
}

/** Replaces the trailing `@token` mention in the input after a pick. */
export function stripMentionFromInput(input: string): string {
  return input.replace(/(^|\s)@[^\s@]*$/, "$1");
}

interface ComposerHighlightSegment {
  text: string;
  command: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Splits selected slash commands from surrounding text without changing textarea layout. */
export function composerHighlightSegments(
  input: string,
  highlightedCommands: readonly string[]
): ComposerHighlightSegment[] {
  const commands = [...new Set(highlightedCommands.filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  if (!commands.length || !input) return [{ text: input, command: false }];

  const commandPattern = commands.map(escapeRegExp).join("|");
  const matcher = new RegExp(`(^|\\s)(${commandPattern})(?=\\s|$)`, "gi");
  const segments: ComposerHighlightSegment[] = [];
  let cursor = 0;

  for (const match of input.matchAll(matcher)) {
    const matchIndex = match.index ?? 0;
    const leadingSpace = match[1] ?? "";
    const command = match[2] ?? "";
    const commandStart = matchIndex + leadingSpace.length;
    if (commandStart > cursor) {
      segments.push({ text: input.slice(cursor, commandStart), command: false });
    }
    segments.push({ text: command, command: true });
    cursor = commandStart + command.length;
  }
  if (cursor < input.length) {
    segments.push({ text: input.slice(cursor), command: false });
  }
  return segments.length ? segments : [{ text: input, command: false }];
}

export function removeHighlightedCommandAtCaret(
  input: string,
  highlightedCommands: readonly string[],
  caret: number,
  key: "Backspace" | "Delete"
): { value: string; caret: number } | null {
  const commands = [...new Set(highlightedCommands.filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  if (!commands.length) return null;
  const matcher = new RegExp(
    `(^|\\s)(${commands.map(escapeRegExp).join("|")})(?=\\s|$)`,
    "gi"
  );
  for (const match of input.matchAll(matcher)) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const end = start + (match[2]?.length ?? 0);
    const backspaceMatch = key === "Backspace"
      && (caret === end || (caret === end + 1 && /\s/.test(input[end] ?? "")));
    const deleteMatch = key === "Delete" && caret === start;
    if (!backspaceMatch && !deleteMatch) continue;

    const removeEnd = /\s/.test(input[end] ?? "") ? end + 1 : end;
    const removeStart = removeEnd === end && start > 0 && /\s/.test(input[start - 1] ?? "")
      ? start - 1
      : start;
    return {
      value: `${input.slice(0, removeStart)}${input.slice(removeEnd)}`,
      caret: removeStart
    };
  }
  return null;
}

/** Native textarea with an aligned backdrop that paints selected commands as inline chips. */
export function ComposerHighlightedTextarea(props: {
  value: string;
  className?: string;
  style?: CSSProperties;
  placeholder?: string;
  rows?: number;
  highlightedCommands?: readonly string[];
  textareaRef?: Ref<HTMLTextAreaElement>;
  onChange?: ChangeEventHandler<HTMLTextAreaElement>;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  onInput?: FormEventHandler<HTMLTextAreaElement>;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const segments = composerHighlightSegments(props.value, props.highlightedCommands ?? []);

  function handleKeyDown(event: Parameters<KeyboardEventHandler<HTMLTextAreaElement>>[0]) {
    if (
      (event.key === "Backspace" || event.key === "Delete")
      && event.currentTarget.selectionStart === event.currentTarget.selectionEnd
      && !event.nativeEvent.isComposing
    ) {
      const edit = removeHighlightedCommandAtCaret(
        props.value,
        props.highlightedCommands ?? [],
        event.currentTarget.selectionStart,
        event.key
      );
      if (edit && props.onChange) {
        event.preventDefault();
        const textarea = event.currentTarget;
        const targetProxy = new Proxy(textarea, {
          get(target, property) {
            if (property === "value") return edit.value;
            if (property === "selectionStart" || property === "selectionEnd") return edit.caret;
            const value = Reflect.get(target, property, target);
            return typeof value === "function"
              ? (value as (...args: unknown[]) => unknown).bind(target)
              : value;
          }
        }) as HTMLTextAreaElement;
        props.onChange({
          ...event,
          target: targetProxy,
          currentTarget: targetProxy
        });
        window.requestAnimationFrame(() => {
          textarea.setSelectionRange(edit.caret, edit.caret);
        });
        return;
      }
    }
    props.onKeyDown?.(event);
  }

  return (
    <div className="composer-rich-input composer-rich-input--highlighted">
      <div className="composer-rich-input__backdrop" aria-hidden="true">
        <div style={{ transform: `translateY(${-scrollTop}px)` }}>
          {segments.map((segment, index) => segment.command ? (
            <span key={index} className="composer-slash-chip">{segment.text}</span>
          ) : (
            <span key={index}>{segment.text}</span>
          ))}
          {props.value.endsWith("\n") ? "\n" : null}
        </div>
      </div>
      <textarea
        ref={props.textareaRef}
        value={props.value}
        placeholder={props.placeholder}
        rows={props.rows}
        style={props.style}
        onChange={props.onChange}
        onKeyDown={handleKeyDown}
        onPaste={props.onPaste}
        onInput={props.onInput}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className={`${props.className ?? ""} composer-rich-input__field--highlighted`}
      />
    </div>
  );
}
export function ComposerQuickActionButtons(props: {
  onAttach: () => void;
  onAttachFolder?: () => void;
  onInsertMention: () => void;
  onInsertSlash: () => void;
  /** Anchored directly under the @ button. */
  referenceMenu?: ReactNode;
  /** Anchored directly under the / button. */
  slashMenu?: ReactNode;
}) {
  const { t } = useTranslation();
  const buttonClass = "composer-quick-actions__btn";
  const [attachOpen, setAttachOpen] = useState(false);
  const attachAnchorRef = useRef<HTMLDivElement | null>(null);
  const referenceOpen = Boolean(props.referenceMenu);
  const slashOpen = Boolean(props.slashMenu);

  useEffect(() => {
    if (!attachOpen) return;
    const close = (event: PointerEvent) => {
      if (!attachAnchorRef.current?.contains(event.target as Node)) setAttachOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [attachOpen]);

  return (
    <div className="composer-quick-actions" data-composer-quick-actions-root>
      <div ref={attachAnchorRef} className="composer-quick-actions__anchor">
        <Tooltip content={t("home.quick.attachHint")}>
          <button
            type="button"
            aria-label={t("home.quick.attach")}
            aria-expanded={props.onAttachFolder ? attachOpen : undefined}
            className={`${buttonClass}${attachOpen ? " composer-quick-actions__btn--active" : ""}`}
            onClick={() => {
              if (props.onAttachFolder) setAttachOpen((open) => !open);
              else props.onAttach();
            }}
          >
            <Plus size={15} />
          </button>
        </Tooltip>
        {attachOpen && props.onAttachFolder ? (
          <div className="composer-quick-actions__popover composer-quick-actions__popover--attach" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setAttachOpen(false);
                props.onAttach();
              }}
            >
              {t("home.quick.uploadFile")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setAttachOpen(false);
                props.onAttachFolder?.();
              }}
            >
              {t("home.quick.uploadFolder")}
            </button>
          </div>
        ) : null}
      </div>
      <div className="composer-quick-actions__anchor">
        <Tooltip content={t("home.quick.referenceHint")}>
          <button
            type="button"
            aria-label={t("home.quick.reference")}
            aria-expanded={referenceOpen}
            className={`${buttonClass}${referenceOpen ? " composer-quick-actions__btn--active" : ""}`}
            onClick={props.onInsertMention}
          >
            <AtSign size={15} />
          </button>
        </Tooltip>
        {referenceOpen ? (
          <div className="composer-quick-actions__popover composer-quick-actions__popover--reference" data-composer-quick-popover="reference">
            {props.referenceMenu}
          </div>
        ) : null}
      </div>
      <div className="composer-quick-actions__anchor">
        <Tooltip content={t("home.quick.capabilityHint")}>
          <button
            type="button"
            aria-label={t("home.quick.capability")}
            aria-expanded={slashOpen}
            className={`${buttonClass}${slashOpen ? " composer-quick-actions__btn--active" : ""}`}
            onClick={props.onInsertSlash}
          >
            <SquareSlash size={15} />
          </button>
        </Tooltip>
        {slashOpen ? (
          <div className="composer-quick-actions__popover composer-quick-actions__popover--slash" data-composer-quick-popover="slash">
            {props.slashMenu}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Reference panel anchored under the `@` button when mention/reference is active.
 * Searchable list of local files and folders.
 */
export function ComposerReferencePanel(props: {
  open: boolean;
  /** Query synced from a trailing `@token` in the composer, if any. */
  externalQuery?: string | null;
  onClose: () => void;
  onPickReference: (item: HomeReferenceItem) => void;
}) {
  const { t } = useTranslation();
  const [localQuery, setLocalQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const wasOpenRef = useRef(false);
  const query = localQuery.trim().toLowerCase();
  const items = HOME_REFERENCE_ITEMS.filter((item) => !query || item.path.toLowerCase().includes(query));

  useEffect(() => {
    if (props.open && !wasOpenRef.current) {
      setLocalQuery(props.externalQuery ?? "");
      queueMicrotask(() => searchInputRef.current?.focus());
    }
    wasOpenRef.current = props.open;
  }, [props.open, props.externalQuery]);

  useEffect(() => {
    if (!props.open || props.externalQuery == null) return;
    setLocalQuery(props.externalQuery);
  }, [props.externalQuery, props.open]);

  useEffect(() => {
    if (!props.open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (rootRef.current?.contains(target as Node)) return;
      if (target?.closest("[data-composer-quick-actions-root]")) return;
      props.onClose();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [props.onClose, props.open]);

  if (!props.open) return null;

  return (
    <div ref={rootRef} className="home-reference-panel" role="listbox" aria-label={t("home.quick.reference")}>
      <header className="home-reference-panel__head">
        <strong>{t("home.quick.reference")}</strong>
        <label className="home-reference-panel__search">
          <input
            ref={searchInputRef}
            value={localQuery}
            placeholder={t("home.quick.referenceSearch")}
            aria-label={t("home.quick.referenceSearch")}
            onChange={(event) => setLocalQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                props.onClose();
              }
            }}
          />
        </label>
      </header>
      <div className="home-reference-panel__list">
        <div className="home-reference-panel__heading">{t("home.quick.localSection")}</div>
        {items.map((item) => (
          <button
            type="button"
            key={item.path}
            className="home-reference-panel__item"
            role="option"
            onClick={() => props.onPickReference(item)}
          >
            {item.kind === "folder"
              ? <FolderTypeIcon surface="row" />
              : <FileTypeIcon name={item.path} surface="row" />}
            <span className="home-reference-panel__text">
              <strong>{item.path}</strong>
              <small>{item.meta}</small>
            </span>
            <code>{t(item.kind === "folder" ? "home.quick.kind.folder" : "home.quick.kind.file")}</code>
          </button>
        ))}
        {!items.length ? (
          <div className="home-reference-panel__empty">{t("home.quick.noMatches")}</div>
        ) : null}
      </div>
    </div>
  );
}

export function HomeContextChips(props: {
  chips: ComposerContextChip[];
  onRemove?: (chip: ComposerContextChip) => void;
}) {
  const { t } = useTranslation();
  if (!props.chips.length) return null;
  return (
    <div className="home-context-chips">
      {props.chips.map((chip) => {
        const folder = chip.kind === "path" && chip.label.endsWith("/");
        const kindLabel = folder
          ? t("home.quick.kind.folder")
          : t("home.quick.kind.file");
        return (
          <AgentAttachmentCard
            key={`${chip.kind}:${chip.id}`}
            kind="file"
            name={chip.label}
            subline={kindLabel}
            title={chip.label}
            removable={Boolean(props.onRemove)}
            removeLabel={props.onRemove ? t("common.remove") : undefined}
            onRemove={props.onRemove ? () => props.onRemove?.(chip) : undefined}
            leading={(
              folder ? (
                <FolderTypeIcon surface="card" />
              ) : (
                <FileTypeIcon name={chip.label} surface="card" />
              )
            )}
          />
        );
      })}
    </div>
  );
}

