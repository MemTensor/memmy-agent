import { useLayoutEffect, useRef, useState, type ChangeEventHandler, type ClipboardEventHandler, type CSSProperties, type FormEventHandler, type KeyboardEventHandler, type Ref } from "react";
import "./composer-highlighted-textarea.css";

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
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const field = fieldRef.current;
    const backdrop = backdropRef.current;
    if (!field || !backdrop) return;
    const sync = () => {
      const computed = window.getComputedStyle(field);
      for (const property of ["font-family", "font-size", "font-weight", "font-style", "line-height", "letter-spacing", "padding-top", "padding-right", "padding-bottom", "padding-left", "text-align", "word-break", "overflow-wrap", "tab-size"]) {
        backdrop.style.setProperty(property, computed.getPropertyValue(property));
      }
      backdrop.style.width = field.clientWidth + "px";
      backdrop.style.height = field.clientHeight + "px";
    };
    sync();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(sync) : null;
    observer?.observe(field);
    window.addEventListener("resize", sync);
    return () => { observer?.disconnect(); window.removeEventListener("resize", sync); };
  }, [props.value, props.className, props.style]);
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
      <div ref={backdropRef} className="composer-rich-input__backdrop" aria-hidden="true">
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
        ref={(element) => {
          fieldRef.current = element;
          if (typeof props.textareaRef === "function") props.textareaRef(element);
          else if (props.textareaRef) props.textareaRef.current = element;
        }}
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
