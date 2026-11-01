/**
 * The task input: a contentEditable line that carries referenced sessions as inline chips, the way a chat app
 * shows a mention. A textarea cannot hold a chip and text on one line, so the chips live inside the editor as
 * non-editable nodes and the person types right after them.
 *
 * The browser owns the text nodes; this component only rebuilds them when chips or the value change from
 * outside (a restored draft, a cleared composer), so typing is never rewritten mid-composition.
 */
import { useEffect, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";

export interface InlineChip {
  id: string;
  label: string;
}

export interface ComposerInlineEditorProps {
  value: string;
  chips: InlineChip[];
  placeholder: string;
  className?: string;
  removeChipLabel: string;
  onChange: (value: string, caret: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLDivElement>) => void;
  onRemoveChip: (id: string) => void;
  onCaretChange?: (caret: number) => void;
  editorRef?: RefObject<HTMLDivElement | null>;
}

const CHIP_ATTRIBUTE = "data-mention-chip";
/** Chars shown on a chip. CSS truncation would take the box's baseline away from its text, so it is cut here. */
const CHIP_LABEL_LIMIT = 22;

/** Text of an editor node with the chips removed; block children and `<br>` become newlines. */
export function readEditorPlainText(root: Node): string {
  let text = "";
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (element.hasAttribute(CHIP_ATTRIBUTE)) return;
    if (element.tagName === "BR") {
      text += "\n";
      return;
    }
    const isBlock = element.tagName === "DIV" || element.tagName === "P" || element.tagName === "LI";
    if (isBlock && text && !text.endsWith("\n")) text += "\n";
    for (const child of Array.from(element.childNodes)) visit(child);
  };
  for (const child of Array.from(root.childNodes)) visit(child);
  // `\u00a0` is what a browser leaves for a trailing space; a final newline is filler for an empty block.
  return text.replace(/\u00a0/gu, " ").replace(/\n$/u, "");
}

/** Characters of the person's text before the caret, which the @ menu uses to see what is being typed. */
export function caretTextOffset(root: HTMLElement, range: Range | null): number {
  if (!range || !root.contains(range.endContainer)) return readEditorPlainText(root).length;
  // Counted node by node in document order: chip labels are skipped, and an element caret position counts the
  // text of the children before the offset. This avoids Range#cloneContents, whose text varies by engine.
  let offset = 0;
  let reached = false;
  const countChildren = (node: Node, limit: number | null): void => {
    const children = Array.from(node.childNodes);
    const end = limit === null ? children.length : Math.min(limit, children.length);
    for (let index = 0; index < end && !reached; index += 1) visit(children[index]!);
  };
  const visit = (node: Node): void => {
    if (reached) return;
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node === range.endContainer ? range.endOffset : (node.nodeValue?.length ?? 0);
      if (node === range.endContainer) reached = true;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    if (element.hasAttribute(CHIP_ATTRIBUTE)) return;
    if (element.tagName === "BR") {
      offset += 1;
      return;
    }
    if (node === range.endContainer) {
      countChildren(node, range.endOffset);
      reached = true;
      return;
    }
    countChildren(node, null);
  };
  // Started at the root so a caret position that sits on the editor itself (offset = child index) is counted too.
  if (root === range.endContainer) countChildren(root, range.endOffset);
  else countChildren(root, null);
  return offset;
}

/** The caret sits at the start of the person's text, i.e. directly after the last chip. */
export function caretAtTextStart(root: HTMLElement, range: Range | null): boolean {
  if (!range) return false;
  return caretTextOffset(root, range) === 0;
}

/** Places the caret at the end of the editor, after the chips and the text. */
export function placeCaretAtEnd(root: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** Places the caret `offset` characters into the person's text, past the chips. */
export function placeCaretAtTextOffset(root: HTMLElement, offset: number): void {
  const last = root.lastChild;
  const range = document.createRange();
  if (last && last.nodeType === Node.TEXT_NODE) {
    range.setStart(last, Math.min(offset, last.nodeValue?.length ?? 0));
  } else {
    range.selectNodeContents(root);
  }
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

const CHIP_ICON =
  '<svg class="composer-inline-chip__icon composer-inline-chip__icon--idle" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
const CHIP_REMOVE_ICON =
  '<svg class="composer-inline-chip__icon composer-inline-chip__icon--remove" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

/** The label a chip shows: cut to a readable length without touching CSS overflow. */
export function chipLabelText(label: string): string {
  const chars = Array.from(label);
  return chars.length > CHIP_LABEL_LIMIT ? `${chars.slice(0, CHIP_LABEL_LIMIT).join("")}…` : label;
}

function chipElement(chip: InlineChip, removeLabel: string, onRemove: (id: string) => void): HTMLElement {
  const wrapper = document.createElement("span");
  wrapper.setAttribute(CHIP_ATTRIBUTE, chip.id);
  wrapper.setAttribute("contenteditable", "false");
  wrapper.className = "composer-inline-chip";
  wrapper.title = chip.label;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "composer-inline-chip__leading";
  button.setAttribute("aria-label", `${removeLabel} ${chip.label}`);
  button.title = `${removeLabel} ${chip.label}`;
  // Pressing the chip must not move the caret into a non-editable node.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", () => onRemove(chip.id));
  // Static markup: no text from the page is interpolated here.
  button.innerHTML = CHIP_ICON + CHIP_REMOVE_ICON;
  wrapper.append(button);

  const label = document.createElement("span");
  label.className = "composer-inline-chip__label";
  // Truncated for display only; the title attribute keeps the full name.
  label.textContent = chipLabelText(chip.label);
  wrapper.append(label);
  return wrapper;
}

export function ComposerInlineEditor(props: ComposerInlineEditorProps) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const composing = useRef(false);
  const chipKey = props.chips.map((chip) => chip.id).join("\u0000");
  const chipsRef = useRef(props.chips);
  chipsRef.current = props.chips;

  const root = (): HTMLDivElement | null => props.editorRef?.current ?? localRef.current;

  /** Rebuilds chips and, when the model holds text, a trailing text node. */
  const render = (value: string) => {
    const element = root();
    if (!element) return;
    const nodes: Node[] = props.chips.map((chip) => chipElement(chip, props.removeChipLabel, props.onRemoveChip));
    if (value) nodes.push(document.createTextNode(value));
    element.replaceChildren(...nodes);
  };

  // A chip was added or removed: keep the person typing at the end.
  useLayoutEffect(() => {
    const element = root();
    if (!element) return;
    const focused = document.activeElement === element;
    render(readEditorPlainText(element));
    if (focused) placeCaretAtEnd(element);
  }, [chipKey]);

  // A value written from outside (a restored draft, a cleared composer) replaces the text.
  useEffect(() => {
    const element = root();
    if (!element) return;
    if (readEditorPlainText(element) === props.value) return;
    render(props.value);
  }, [props.value]);

  const emit = (element: HTMLDivElement) => {
    const selection = window.getSelection();
    const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
    props.onChange(readEditorPlainText(element), caretTextOffset(element, range));
  };

  return (
    <div
      ref={(element) => {
        localRef.current = element;
        if (props.editorRef) props.editorRef.current = element;
      }}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={props.placeholder}
      data-placeholder={props.placeholder}
      className={`composer-inline-editor ${props.className ?? ""}`.trim()}
      onInput={(event) => {
        // Mid-composition text is incomplete; the composition end carries the final value.
        if (composing.current) return;
        emit(event.currentTarget);
      }}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        emit(event.currentTarget);
      }}
      onKeyDown={props.onKeyDown}
      onPaste={props.onPaste}
      onKeyUp={(event) => {
        if (!props.onCaretChange) return;
        const selection = window.getSelection();
        const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
        props.onCaretChange(caretTextOffset(event.currentTarget, range));
      }}
      onClick={(event) => {
        if (!props.onCaretChange) return;
        const selection = window.getSelection();
        const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
        props.onCaretChange(caretTextOffset(event.currentTarget, range));
      }}
    />
  );
}
