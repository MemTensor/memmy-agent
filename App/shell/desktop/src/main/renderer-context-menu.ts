export interface RendererContextMenuEditFlags {
  canUndo?: boolean;
  canRedo?: boolean;
  canCut?: boolean;
  canCopy?: boolean;
  canPaste?: boolean;
  canDelete?: boolean;
  canSelectAll?: boolean;
}

export interface RendererContextMenuParams {
  isEditable?: boolean;
  selectionText?: string;
  linkURL?: string;
  editFlags?: RendererContextMenuEditFlags;
  maxLabelWidthPx?: number;
}

export type RendererContextMenuRole =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "delete"
  | "selectAll";

export type RendererContextMenuCommand =
  | { kind: "role"; role: RendererContextMenuRole; enabled: boolean }
  | { kind: "separator" }
  | { kind: "openLink"; label: string; url: string }
  | { kind: "copyLink"; label: string; url: string }
  | { kind: "searchSelection"; label: string; url: string; text: string };

const CONTEXT_MENU_MAX_LABEL_WIDTH_PX = 300;
const CONTEXT_MENU_APP_WIDTH_RATIO = 0.25;
const MENU_LABEL_AVERAGE_CHAR_WIDTH_PX = 7;
const SEARCH_SELECTION_LABEL_PREFIX = "Search Google for \"";
const SEARCH_SELECTION_LABEL_SUFFIX = "\"";

export function resolveRendererContextMenuCommands(params: RendererContextMenuParams): RendererContextMenuCommand[] {
  const selectionText = normalizeSelectionText(params.selectionText);
  const linkUrl = normalizeMenuHttpUrl(params.linkURL);
  const commands: RendererContextMenuCommand[] = [];

  if (linkUrl) {
    commands.push(
      { kind: "openLink", label: "Open Link", url: linkUrl },
      { kind: "copyLink", label: "Copy Link", url: linkUrl }
    );
  }

  if (params.isEditable) {
    appendSeparator(commands);
    appendEditableCommands(commands, params.editFlags ?? {}, selectionText);
    return trimMenuSeparators(commands);
  }

  if (selectionText) {
    appendSeparator(commands);
    commands.push(
      { kind: "role", role: "copy", enabled: params.editFlags?.canCopy ?? true },
      {
        kind: "searchSelection",
        label: searchSelectionLabel(selectionText, params.maxLabelWidthPx),
        url: googleSearchUrlForSelection(selectionText),
        text: selectionText
      }
    );
  }

  return trimMenuSeparators(commands);
}

export function googleSearchUrlForSelection(selectionText: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(selectionText)}`;
}

export function resolveRendererContextMenuMaxLabelWidth(appWidth: number): number {
  const fallbackAppWidth = CONTEXT_MENU_MAX_LABEL_WIDTH_PX / CONTEXT_MENU_APP_WIDTH_RATIO;
  const safeAppWidth = Number.isFinite(appWidth) && appWidth > 0 ? appWidth : fallbackAppWidth;
  return Math.floor(Math.min(safeAppWidth * CONTEXT_MENU_APP_WIDTH_RATIO, CONTEXT_MENU_MAX_LABEL_WIDTH_PX));
}

function appendEditableCommands(
  commands: RendererContextMenuCommand[],
  editFlags: RendererContextMenuEditFlags,
  selectionText: string
): void {
  commands.push(
    { kind: "role", role: "undo", enabled: editFlags.canUndo === true },
    { kind: "role", role: "redo", enabled: editFlags.canRedo === true },
    { kind: "separator" },
    { kind: "role", role: "cut", enabled: editFlags.canCut === true },
    { kind: "role", role: "copy", enabled: editFlags.canCopy ?? selectionText.length > 0 },
    { kind: "role", role: "paste", enabled: editFlags.canPaste === true },
    { kind: "role", role: "delete", enabled: editFlags.canDelete === true },
    { kind: "separator" },
    { kind: "role", role: "selectAll", enabled: editFlags.canSelectAll ?? true }
  );
}

function appendSeparator(commands: RendererContextMenuCommand[]): void {
  if (commands.length > 0 && commands.at(-1)?.kind !== "separator") {
    commands.push({ kind: "separator" });
  }
}

function trimMenuSeparators(commands: RendererContextMenuCommand[]): RendererContextMenuCommand[] {
  let start = 0;
  let end = commands.length;
  while (commands[start]?.kind === "separator") {
    start += 1;
  }
  while (commands[end - 1]?.kind === "separator") {
    end -= 1;
  }
  return commands.slice(start, end);
}

function normalizeSelectionText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function searchSelectionLabel(selectionText: string, maxLabelWidthPx = CONTEXT_MENU_MAX_LABEL_WIDTH_PX): string {
  const maxLabelLength = Math.floor(maxLabelWidthPx / MENU_LABEL_AVERAGE_CHAR_WIDTH_PX);
  const fixedLength = SEARCH_SELECTION_LABEL_PREFIX.length + SEARCH_SELECTION_LABEL_SUFFIX.length;
  const previewLength = Math.max(0, maxLabelLength - fixedLength);
  return `${SEARCH_SELECTION_LABEL_PREFIX}${selectionPreview(selectionText, previewLength)}${SEARCH_SELECTION_LABEL_SUFFIX}`;
}

function selectionPreview(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 0) {
    return "";
  }

  if (maxLength <= 3) {
    return ".".repeat(maxLength);
  }

  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function normalizeMenuHttpUrl(value: string | undefined): string | null {
  const rawUrl = (value ?? "").trim();
  if (!rawUrl) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
