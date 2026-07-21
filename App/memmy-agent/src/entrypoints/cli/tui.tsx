import { Box, Text, render, useApp, useCursor, useInput, useStdout } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import { AgentLoop } from "../../core/agent-runtime/loop.js";
import { Config } from "../../config/schema.js";
import { getConfigPath, getWorkspacePath } from "../../config/paths.js";
import { withProgressCapabilities } from "../../utils/progress-events.js";
import { VERSION } from "../../version.js";
import { resolveComposerCursorPosition, type ComposerLayout } from "./tui-cursor.js";

type TuiMessageRole = "assistant" | "progress" | "system" | "user";

type TuiMessage = {
  id: number;
  role: TuiMessageRole;
  text: string;
};

type TuiCleanup = () => Promise<void>;

type TuiProps = {
  config: Config;
  registerCleanup: (cleanup: TuiCleanup) => void;
  sessionId: string;
  toolsets: ToolsetSummary[];
  version: string;
};

type ToolsetSummary = {
  name: string;
  tools: string[];
};

type TerminalSize = {
  columns: number;
  rows: number;
};

const PROMPT = "❯";
const MAX_MESSAGES = 24;
const MAX_TOOLSET_ROWS = 5;
const THINK_FRAMES = ["planning", "working", "calling tools", "reading", "writing"];
const PALETTE = {
  accent: "#F59E6B",
  assistant: "#8BA1F3",
  danger: "#F87B8E",
  ink: "#EAF6F3",
  lemon: "#FDF2B8",
  line: "#6EA098",
  lineDim: "#36514D",
  muted: "#9BB6B0",
  primary: "#5CBFAE",
  primaryStrong: "#3AA893",
  success: "#2DC999",
};

const WORDMARK_ROWS = [
  "███╗   ███╗ ███████╗ ███╗   ███╗ ███╗   ███╗ ██╗   ██╗",
  "████╗ ████║ ██╔════╝ ████╗ ████║ ████╗ ████║ ╚██╗ ██╔╝",
  "██╔████╔██║ █████╗   ██╔████╔██║ ██╔████╔██║  ╚████╔╝",
  "██║╚██╔╝██║ ██╔══╝   ██║╚██╔╝██║ ██║╚██╔╝██║   ╚██╔╝",
  "██║ ╚═╝ ██║ ███████╗ ██║ ╚═╝ ██║ ██║ ╚═╝ ██║    ██║",
  "╚═╝     ╚═╝ ╚══════╝ ╚═╝     ╚═╝ ╚═╝     ╚═╝    ╚═╝",
];

const AGENT_ROWS = [
  " █████╗   ██████╗  ███████╗ ███╗   ██╗ █████████╗",
  "██╔══██╗ ██╔════╝  ██╔════╝ ████╗  ██║ ╚══██╔══╝",
  "███████║ ██║  ███╗ █████╗   ██╔██╗ ██║    ██║",
  "██╔══██║ ██║   ██║ ██╔══╝   ██║╚██╗██║    ██║",
  "██║  ██║ ╚██████╔╝ ███████╗ ██║ ╚████║    ██║",
  "╚═╝  ╚═╝  ╚═════╝  ╚══════╝ ╚═╝  ╚═══╝    ╚═╝",
];

const TITLE_ROW_COLORS = ["#A8E7DC", "#86D8CA", "#67C7B7", "#67C7B7", "#49AA9B", "#2F7C73"] as const;

type MascotTone = "dark" | "none" | "rice0" | "rice1" | "rice2" | "spoon0" | "spoon1" | "spoon2";
type MascotPixelSegment = readonly [MascotTone, MascotTone, string];

// Half-block raster sampled from App/frontend/desktop/src/assets/mascot/memmy-rice.png.
const MASCOT_PIXEL_ROWS: ReadonlyArray<ReadonlyArray<MascotPixelSegment>> = [
  [["none", "none", "                       "], ["rice0", "none", "▄▄▄▄▄▄"]],
  [["none", "none", "                    "], ["rice0", "rice0", "▀▀▀▀▀▀▀▀▀▀▀▀▀"]],
  [["none", "none", "                "], ["none", "rice0", " "], ["rice0", "rice0", "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀"], ["rice1", "rice0", "▀"], ["none", "rice1", " "]],
  [["none", "none", "               "], ["none", "rice0", " "], ["rice0", "rice0", "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀"], ["rice1", "rice1", "▀▀"], ["none", "rice1", " "], ["none", "none", "     "], ["spoon0", "none", "▄"], ["spoon1", "none", "▄▄"]],
  [["none", "none", "              "], ["none", "rice1", " "], ["rice0", "rice0", "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀"], ["rice1", "rice1", "▀▀"], ["rice2", "rice1", "▀"], ["none", "none", "  "], ["spoon1", "none", "▄"], ["spoon1", "spoon1", "▀▀▀▀"], ["spoon0", "spoon0", "▀"], ["spoon1", "none", "▄"]],
  [["none", "none", "             "], ["none", "spoon1", " "], ["rice1", "rice1", "▀"], ["rice0", "rice0", "▀▀▀▀▀▀▀▀▀▀▀▀▀▀"], ["rice0", "rice0", "▀▀▀▀▀▀▀▀▀"], ["rice1", "rice1", "▀▀"], ["spoon1", "spoon1", "▀▀▀▀▀▀▀▀▀"], ["none", "none", " "]],
  [["none", "none", "          "], ["none", "spoon2", " "], ["spoon1", "spoon1", "▀▀"], ["spoon1", "rice2", "▀"], ["rice0", "rice0", "▀▀▀▀▀▀▀"], ["dark", "rice0", "●"], ["rice0", "rice0", "▀▀▀▀▀▀▀"], ["dark", "rice0", "●"], ["rice0", "rice0", "▀▀▀▀▀▀"], ["rice1", "rice1", "▀▀▀▀"], ["rice2", "rice2", "▀"], ["spoon2", "spoon1", "▀"], ["spoon1", "spoon1", "▀▀▀▀"], ["spoon1", "none", "▀▀"]],
  [["none", "none", "         "], ["none", "spoon1", " "], ["spoon1", "spoon1", "▀▀▀"], ["rice1", "rice2", "▀"], ["rice0", "rice0", "▀▀▀▀▀▀▀▀▀▀▀"], ["dark", "rice0", "⌣"], ["rice0", "rice0", "▀▀▀▀▀▀▀▀▀"], ["rice0", "rice1", "▀"], ["rice1", "rice1", "▀▀▀▀"], ["spoon1", "spoon1", "▀▀▀"], ["spoon1", "spoon2", "▀"], ["spoon1", "none", "▀"]],
  [["none", "none", "         "], ["spoon1", "spoon1", "▀▀▀▀▀"], ["rice1", "rice2", "▀"], ["rice0", "rice1", "▀▀"], ["rice0", "rice0", "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀"], ["rice0", "rice1", "▀▀"], ["rice1", "rice1", "▀▀▀▀"], ["rice1", "rice2", "▀"], ["spoon1", "spoon1", "▀▀▀▀"]],
  [["none", "none", "         "], ["spoon1", "none", "▀"], ["spoon1", "spoon1", "▀▀▀▀▀▀"], ["rice1", "spoon1", "▀▀"], ["rice1", "rice1", "▀"], ["rice0", "rice1", "▀▀▀▀▀▀"], ["rice0", "rice0", "▀▀"], ["rice0", "rice1", "▀▀▀"], ["rice1", "rice1", "▀▀▀▀▀"], ["rice1", "spoon1", "▀▀"], ["spoon1", "spoon1", "▀▀▀▀"], ["spoon1", "none", "▀"]],
  [["none", "none", "          "], ["spoon1", "none", "▀"], ["spoon1", "spoon1", "▀▀"], ["spoon0", "spoon1", "▀"], ["spoon1", "spoon1", "▀▀▀▀▀▀"], ["rice2", "spoon1", "▀"], ["rice1", "spoon1", "▀▀▀▀▀▀▀▀▀"], ["rice2", "spoon2", "▀"], ["rice2", "spoon1", "▀"], ["spoon1", "spoon1", "▀▀▀▀▀▀"], ["spoon1", "spoon2", "▀"], ["spoon1", "none", "▀"]],
  [["none", "none", "            "], ["spoon1", "none", "▀▀"], ["spoon1", "spoon2", "▀"], ["spoon1", "spoon1", "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀"], ["spoon1", "spoon2", "▀"], ["spoon1", "none", "▀"], ["spoon2", "none", "▀"]],
  [["none", "none", "                "], ["spoon2", "none", "▀▀"], ["spoon1", "none", "▀"], ["spoon1", "spoon1", "▀"], ["spoon1", "spoon2", "▀"], ["spoon1", "spoon1", "▀"], ["spoon1", "spoon2", "▀▀▀"], ["spoon1", "spoon1", "▀"], ["spoon1", "spoon2", "▀▀▀▀▀"], ["spoon1", "spoon1", "▀"], ["spoon2", "none", "▀▀"]],
];

const WORDMARK_WIDTH = Math.max(...WORDMARK_ROWS.map((row) => row.length), ...AGENT_ROWS.map((row) => row.length));
const MASCOT_RENDER_ROWS = MASCOT_PIXEL_ROWS;
const MASCOT_WIDTH = Math.max(...MASCOT_RENDER_ROWS.map((row) => row.reduce((sum, [, , text]) => sum + text.length, 0)));
const HERO_LOGO_TITLE_GAP = 5;

const MASCOT_TONE_COLOR: Record<Exclude<MascotTone, "none">, string> = {
  dark: "#17201E",
  rice0: "#FFFDF7",
  rice1: "#F5EDE0",
  rice2: "#DACDBD",
  spoon0: "#F0B86C",
  spoon1: "#D18B3E",
  spoon2: "#8E5E2C",
};

function toneColor(tone: MascotTone): string | undefined {
  return tone === "none" ? undefined : MASCOT_TONE_COLOR[tone];
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m${rest}s` : `${rest}s`;
}

function displayModelName(model: string): string {
  return model.split("/").pop() || model;
}

function modelLabel(config: Config): string {
  const resolved = config.resolvePreset();
  const preset = config.agents.defaults.modelPreset;
  return preset ? `${displayModelName(resolved.model)} @${preset}` : displayModelName(resolved.model);
}

const TOOLSET_ORDER = ["web", "exec", "file", "runtime", "image", "goal", "cron", "mcp", "other"] as const;

const TOOLSET_BY_TOOL_NAME: Record<string, string> = {
  apply_patch: "file",
  complete_goal: "goal",
  cron: "cron",
  edit_file: "file",
  exec: "exec",
  find_files: "file",
  generate_image: "image",
  grep: "file",
  list_dir: "file",
  list_exec_sessions: "exec",
  long_task: "goal",
  message: "runtime",
  my: "runtime",
  read_file: "file",
  spawn: "runtime",
  web_fetch: "web",
  web_search: "web",
  write_file: "file",
  write_stdin: "exec",
};

function toolsetRank(name: string): number {
  if (name.startsWith("mcp:")) return TOOLSET_ORDER.indexOf("mcp");
  const rank = TOOLSET_ORDER.indexOf(name as (typeof TOOLSET_ORDER)[number]);
  return rank >= 0 ? rank : TOOLSET_ORDER.length;
}

function addToolset(groups: Map<string, string[]>, name: string, tools: string[]): void {
  if (!tools.length) return;
  const current = groups.get(name) ?? [];
  const seen = new Set(current);
  for (const tool of tools) {
    if (seen.has(tool)) continue;
    current.push(tool);
    seen.add(tool);
  }
  groups.set(name, current);
}

function mcpConfiguredToolNames(server: { enabledTools?: string[] }): string[] {
  const enabled = server.enabledTools ?? [];
  return enabled.length && !enabled.includes("*") ? enabled : ["configured"];
}

function summarizeToolsets(config: Config, toolNames: string[]): ToolsetSummary[] {
  const groups = new Map<string, string[]>();
  for (const toolName of toolNames) {
    const groupName = toolName.startsWith("mcp_") ? "mcp" : (TOOLSET_BY_TOOL_NAME[toolName] ?? "other");
    addToolset(groups, groupName, [toolName]);
  }

  for (const [serverName, server] of Object.entries(config.tools.mcpServers)) {
    if (!server.command && !server.url) continue;
    addToolset(groups, `mcp:${serverName}`, mcpConfiguredToolNames(server));
  }

  return [...groups.entries()]
    .map(([name, tools]) => ({ name, tools }))
    .sort((a, b) => toolsetRank(a.name) - toolsetRank(b.name) || a.name.localeCompare(b.name));
}

function readToolsets(config: Config): ToolsetSummary[] {
  const loop = AgentLoop.fromConfig(config);
  return summarizeToolsets(config, loop.toolNames);
}

function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: stdout.columns || process.stdout.columns || 100,
    rows: stdout.rows || process.stdout.rows || 30,
  }));

  useEffect(() => {
    const update = () => {
      setSize({
        columns: stdout.columns || process.stdout.columns || 100,
        rows: stdout.rows || process.stdout.rows || 30,
      });
    };
    update();
    stdout.on("resize", update);
    return () => {
      stdout.off("resize", update);
    };
  }, [stdout]);

  return size;
}

function onceCleanup(fn: TuiCleanup): TuiCleanup {
  let promise: Promise<void> | null = null;
  return () => {
    promise ??= fn();
    return promise;
  };
}

async function settleWithTimeout(promises: Array<Promise<unknown>>, timeoutMs: number): Promise<void> {
  await Promise.race([
    Promise.allSettled(promises),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function messageFrameWidth(columns: number): number {
  return Math.max(36, Math.min(columns - 4, 96));
}

function splitMessageLines(text: string, width: number): string[] {
  const contentWidth = Math.max(12, width - 4);
  const sourceLines = (text || " ").split(/\r?\n/);
  const lines: string[] = [];

  for (const sourceLine of sourceLines) {
    if (!sourceLine) {
      lines.push(" ");
      continue;
    }

    let line = "";
    let lineWidth = 0;
    for (const char of sourceLine) {
      const charWidth = Math.max(1, stringWidth(char));
      if (line && lineWidth + charWidth > contentWidth) {
        lines.push(line);
        line = "";
        lineWidth = 0;
      }
      line += char;
      lineWidth += charWidth;
    }
    lines.push(line || " ");
  }

  return lines;
}

function MessageFrameTop({ title, width }: { title: string; width: number }) {
  const titleText = ` ${title} `;
  const rightWidth = Math.max(2, width - stringWidth(titleText) - 3);

  return (
    <Box>
      <Text color={PALETTE.line}>╭─</Text>
      <Text color={PALETTE.primary} bold>
        {titleText}
      </Text>
      <Text color={PALETTE.line}>{repeated("─", rightWidth)}╮</Text>
    </Box>
  );
}

function MessageFrameRow({ line, width }: { line: string; width: number }) {
  const contentWidth = Math.max(0, width - 4);
  const safeLine = truncateEnd(line, contentWidth);

  return (
    <Box>
      <Text color={PALETTE.line}>│ </Text>
      <Text color={PALETTE.ink}>{safeLine}</Text>
    </Box>
  );
}

function MessageFrameBottom({ width }: { width: number }) {
  return <Text color={PALETTE.line}>╰{repeated("─", Math.max(0, width - 2))}╯</Text>;
}

function AssistantMessageBlock({ columns, message }: { columns: number; message: TuiMessage }) {
  const width = Math.max(36, columns - 2);
  const lines = splitMessageLines(message.text, width);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <MessageFrameTop title="🍚 Memmy" width={width} />
      {lines.map((line, index) => (
        <MessageFrameRow key={index} line={line} width={width} />
      ))}
      <MessageFrameBottom width={width} />
    </Box>
  );
}

function UserMessageBlock({ columns, message }: { columns: number; message: TuiMessage }) {
  const width = messageFrameWidth(columns);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={PALETTE.line}>{repeated("─", width)}</Text>
      <Box>
        <Text color={PALETTE.primary} bold>
          ●{" "}
        </Text>
        <Text color={PALETTE.ink} bold wrap="wrap">
          {message.text || " "}
        </Text>
      </Box>
      <Text color={PALETTE.line}>{repeated("─", width)}</Text>
    </Box>
  );
}

function MessageBlock({ columns, message }: { columns: number; message: TuiMessage }) {
  if (message.role === "assistant") return <AssistantMessageBlock columns={columns} message={message} />;
  if (message.role === "user") return <UserMessageBlock columns={columns} message={message} />;

  const palette: Record<Exclude<TuiMessageRole, "assistant" | "user">, { color: string; label: string }> = {
    progress: { color: PALETTE.primary, label: "tool" },
    system: { color: PALETTE.accent, label: "status" },
  };
  const style = palette[message.role];

  return (
    <Box flexDirection="column" marginBottom={1} paddingLeft={1}>
      <Text color={style.color} bold={message.role === "system"}>
        {style.label}
      </Text>
      <Box paddingLeft={2}>
        <Text color={message.role === "progress" ? PALETTE.muted : PALETTE.ink} wrap="wrap">
          {message.text || " "}
        </Text>
      </Box>
    </Box>
  );
}

function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={10}>
        <Text color={PALETTE.muted}>{label}</Text>
      </Box>
      <Box flexShrink={1}>
        <Text color={PALETTE.ink} wrap="truncate-middle">
          {value}
        </Text>
      </Box>
    </Box>
  );
}

function truncateEnd(text: string, maxWidth: number): string {
  const width = Math.max(0, Math.floor(maxWidth));
  if (stringWidth(text) <= width) return text;
  if (width <= 0) return "";
  if (width <= 3) return ".".repeat(width);

  let result = "";
  for (const char of text) {
    const next = result + char;
    if (stringWidth(next) > width - 3) break;
    result = next;
  }

  return `${result}...`;
}

function ToolLine({ detail, detailWidth, name }: { detail: string; detailWidth: number; name: string }) {
  const safeDetailWidth = Math.max(1, detailWidth);

  return (
    <Box>
      <Box width={14}>
        <Text color={PALETTE.accent}>{name}</Text>
      </Box>
      <Box width={safeDetailWidth}>
        <Text color={PALETTE.ink}>{truncateEnd(detail, safeDetailWidth)}</Text>
      </Box>
    </Box>
  );
}

function repeated(char: string, count: number): string {
  return count > 0 ? char.repeat(count) : "";
}

function TitledFrameTop({ title, width }: { title: string; width: number }) {
  const innerWidth = Math.max(2, width - 2);
  const titleText = ` ${title} `;
  const safeTitle = titleText.length > innerWidth ? titleText.slice(0, innerWidth) : titleText;
  const sideWidth = Math.max(0, innerWidth - safeTitle.length);
  const leftWidth = Math.floor(sideWidth / 2);
  const rightWidth = sideWidth - leftWidth;

  return (
    <Box marginTop={1}>
      <Text color={PALETTE.line}>╭{repeated("─", leftWidth)}</Text>
      <Text color={PALETTE.lemon} bold>
        {safeTitle}
      </Text>
      <Text color={PALETTE.line}>{repeated("─", rightWidth)}╮</Text>
    </Box>
  );
}

function TitledFrameBottom({ width }: { width: number }) {
  return (
    <Text color={PALETTE.line}>
      ╰{repeated("─", Math.max(0, width - 2))}╯
    </Text>
  );
}

function TitledFrameRow({ children, width }: { children?: React.ReactNode; width: number }) {
  return (
    <Box>
      <Text color={PALETTE.line}>│</Text>
      <Box paddingX={1} width={Math.max(2, width - 2)}>
        {children ?? <Text> </Text>}
      </Box>
      <Text color={PALETTE.line}>│</Text>
    </Box>
  );
}

let graphemeSegmenter: Intl.Segmenter | null = null;

function graphemeStops(value: string): number[] {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const stops = [0];
  for (const { index, segment } of graphemeSegmenter.segment(value)) {
    const end = index + segment.length;
    if (end > 0) stops.push(end);
  }
  if (stops.at(-1) !== value.length) stops.push(value.length);
  return stops;
}

function snapCursor(value: string, cursor: number): number {
  const position = Math.max(0, Math.min(cursor, value.length));
  let snapped = 0;
  for (const stop of graphemeStops(value)) {
    if (stop > position) break;
    snapped = stop;
  }
  return snapped;
}

function previousCursor(value: string, cursor: number): number {
  const position = snapCursor(value, cursor);
  let previous = 0;
  for (const stop of graphemeStops(value)) {
    if (stop >= position) return previous;
    previous = stop;
  }
  return previous;
}

function nextCursor(value: string, cursor: number): number {
  const position = snapCursor(value, cursor);
  for (const stop of graphemeStops(value)) {
    if (stop > position) return stop;
  }
  return value.length;
}

function wordLeft(value: string, cursor: number): number {
  let index = previousCursor(value, cursor);
  while (index > 0 && /\s/.test(value[index] ?? "")) index = previousCursor(value, index);
  while (index > 0 && !/\s/.test(value[previousCursor(value, index)] ?? "")) index = previousCursor(value, index);
  return index;
}

function wordRight(value: string, cursor: number): number {
  let index = snapCursor(value, cursor);
  while (index < value.length && !/\s/.test(value[index] ?? "")) index = nextCursor(value, index);
  while (index < value.length && /\s/.test(value[index] ?? "")) index = nextCursor(value, index);
  return index;
}

type ModifierKey = { ctrl: boolean; meta: boolean; super?: boolean };

const isMac = process.platform === "darwin";

function isActionMod(key: ModifierKey): boolean {
  return isMac ? key.meta || key.super === true : key.ctrl;
}

function isMacActionFallback(key: ModifierKey, input: string, target: "a" | "e" | "u" | "k" | "w"): boolean {
  return isMac && key.ctrl && !key.meta && key.super !== true && input.toLowerCase() === target;
}

function absolutePosition(node: any): { x: number; y: number } | null {
  let current = node;
  let x = 0;
  let y = 0;

  while (current?.parentNode) {
    if (!current.yogaNode) return null;
    x += current.yogaNode.getComputedLeft();
    y += current.yogaNode.getComputedTop();
    current = current.parentNode;
  }

  return { x, y };
}

function renderedTextLayout(node: any): ComposerLayout | null {
  const base = absolutePosition(node);
  if (!base) return null;
  const firstTextNode = node?.childNodes?.find((child: any) => child?.yogaNode);
  let root = node;
  while (root?.parentNode) root = root.parentNode;
  const outputHeight = root?.yogaNode?.getComputedHeight?.();
  if (!Number.isFinite(outputHeight)) return null;

  return {
    outputHeight,
    x: base.x + (firstTextNode?.yogaNode?.getComputedLeft?.() ?? 0),
    y: base.y + (firstTextNode?.yogaNode?.getComputedTop?.() ?? 0),
  };
}

function ComposerInput({
  active,
  columns,
  cursor,
  placeholder,
  rows,
  value,
}: {
  active: boolean;
  columns: number;
  cursor: number;
  placeholder: string;
  rows: number;
  value: string;
}) {
  const rowRef = useRef<any>(null);
  const { setCursorPosition } = useCursor();
  const prompt = ` ${PROMPT} `;
  const safeCursor = snapCursor(value, cursor);
  const beforeCursor = value.slice(0, safeCursor);
  const afterCursor = value.slice(safeCursor);
  const [layout, setLayout] = useState<ComposerLayout | undefined>(undefined);
  const rowWidth = Math.max(1, columns - (layout?.x ?? 0));
  const cursorCells = stringWidth(prompt + beforeCursor);
  const cursorPosition = layout
    ? resolveComposerCursorPosition({ cursorCells, layout, rowWidth, terminalRows: rows })
    : undefined;

  setCursorPosition(active ? cursorPosition : undefined);

  useEffect(() => {
    const nextLayout = renderedTextLayout(rowRef.current);
    if (!nextLayout) return;
    setLayout((previous) =>
      previous?.x === nextLayout.x &&
      previous.y === nextLayout.y &&
      previous.outputHeight === nextLayout.outputHeight
        ? previous
        : nextLayout,
    );
  });

  return (
    <Box ref={rowRef}>
      <Text color={active ? PALETTE.ink : PALETTE.muted} bold>
        {prompt}
      </Text>
      {value ? (
        <>
          <Text color={PALETTE.ink}>{beforeCursor}</Text>
          <Text color={PALETTE.ink}>{afterCursor || " "}</Text>
        </>
      ) : (
        <Text color={PALETTE.muted}>{placeholder}</Text>
      )}
    </Box>
  );
}

function TitleLine({ line, rowIndex }: { line: string; rowIndex: number }) {
  return (
    <Text color={TITLE_ROW_COLORS[rowIndex]} bold>
      {line}
    </Text>
  );
}

function BigTitle() {
  return (
    <Box flexDirection="column">
      {WORDMARK_ROWS.map((line, index) => (
        <TitleLine key={line} line={line} rowIndex={index} />
      ))}
      <Box height={1} />
      {AGENT_ROWS.map((line, index) => (
        <TitleLine key={line} line={line} rowIndex={index} />
      ))}
    </Box>
  );
}

function MascotLogo() {
  return (
    <Box flexDirection="column">
      {MASCOT_RENDER_ROWS.map((row, rowIndex) => (
        <Box key={rowIndex}>
          {row.map(([foreground, background, text], spanIndex) => (
            <Text
              key={`${rowIndex}-${spanIndex}`}
              backgroundColor={toneColor(background)}
              bold={foreground === "dark"}
              color={toneColor(foreground)}
            >
              {text}
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function Hero({ columns }: { columns: number }) {
  const horizontal = columns >= MASCOT_WIDTH + WORDMARK_WIDTH + HERO_LOGO_TITLE_GAP + 4;

  return (
    <Box
      alignItems={horizontal ? "center" : "flex-start"}
      flexDirection={horizontal ? "row" : "column"}
      marginBottom={1}
      marginTop={1}
    >
      <MascotLogo />
      <Box flexDirection="column" marginLeft={horizontal ? HERO_LOGO_TITLE_GAP : 0} marginTop={horizontal ? 0 : 1}>
        <BigTitle />
      </Box>
    </Box>
  );
}

function formatToolsetTools(tools: string[]): string {
  return tools.join(", ");
}

function formatCompactToolsets(toolsets: ToolsetSummary[]): string {
  const visible = toolsets.slice(0, MAX_TOOLSET_ROWS).map((toolset) => toolset.name);
  const hidden = toolsets.length - visible.length;
  return hidden > 0 ? `${visible.join(", ")} (+${hidden} more)` : visible.join(", ");
}

function Banner({
  columns,
  config,
  toolsets,
  version,
}: {
  columns: number;
  config: Config;
  toolsets: ToolsetSummary[];
  version: string;
}) {
  const visibleToolsets = toolsets.slice(0, MAX_TOOLSET_ROWS);
  const hiddenToolsetCount = toolsets.length - visibleToolsets.length;
  const workspace = getWorkspacePath(config.agents.defaults.workspace);
  const compact = columns < 96;
  const contentDirection: "column" | "row" = compact ? "column" : "row";
  const panelWidth = Math.max(42, columns - 2);
  const wideContentWidth = Math.max(1, panelWidth - 4);
  const workspaceColumnWidth = 42;
  const toolColumnGap = 3;
  const toolColumnWidth = Math.max(16, wideContentWidth - workspaceColumnWidth - toolColumnGap);
  const toolDetailWidth = Math.max(1, toolColumnWidth - 14);
  const title = `Memmy Agent v${version}`;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Hero columns={columns} />

      <Box flexDirection="column">
        <TitledFrameTop title={title} width={panelWidth} />
        {compact ? (
          <>
            <TitledFrameRow width={panelWidth}>
              <MetaLine label="workspace" value={workspace} />
            </TitledFrameRow>
            <TitledFrameRow width={panelWidth}>
              <MetaLine label="config" value={getConfigPath()} />
            </TitledFrameRow>
            <TitledFrameRow width={panelWidth}>
              <MetaLine label="model" value={modelLabel(config)} />
            </TitledFrameRow>
            <TitledFrameRow width={panelWidth}>
              <MetaLine label="tools" value={formatCompactToolsets(toolsets)} />
            </TitledFrameRow>
          </>
        ) : (
          <>
            <TitledFrameRow width={panelWidth}>
              <Box flexDirection={contentDirection}>
                <Box width={workspaceColumnWidth}>
                  <Text color={PALETTE.primary} bold>
                    workspace
                  </Text>
                </Box>
                <Box paddingLeft={toolColumnGap} width={toolColumnWidth + toolColumnGap}>
                  <Text color={PALETTE.primary} bold>
                    available tools
                  </Text>
                </Box>
              </Box>
            </TitledFrameRow>
            <TitledFrameRow width={panelWidth}>
              <Box flexDirection={contentDirection}>
                <Box width={workspaceColumnWidth}>
                  <MetaLine label="root" value={workspace} />
                </Box>
                <Box paddingLeft={toolColumnGap} width={toolColumnWidth + toolColumnGap}>
                  {visibleToolsets[0] ? (
                    <ToolLine
                      detail={formatToolsetTools(visibleToolsets[0].tools)}
                      detailWidth={toolDetailWidth}
                      name={visibleToolsets[0].name}
                    />
                  ) : null}
                </Box>
              </Box>
            </TitledFrameRow>
            <TitledFrameRow width={panelWidth}>
              <Box flexDirection={contentDirection}>
                <Box width={workspaceColumnWidth}>
                  <MetaLine label="config" value={getConfigPath()} />
                </Box>
                <Box paddingLeft={toolColumnGap} width={toolColumnWidth + toolColumnGap}>
                  {visibleToolsets[1] ? (
                    <ToolLine
                      detail={formatToolsetTools(visibleToolsets[1].tools)}
                      detailWidth={toolDetailWidth}
                      name={visibleToolsets[1].name}
                    />
                  ) : null}
                </Box>
              </Box>
            </TitledFrameRow>
            <TitledFrameRow width={panelWidth}>
              <Box flexDirection={contentDirection}>
                <Box width={workspaceColumnWidth}>
                  <MetaLine label="model" value={modelLabel(config)} />
                </Box>
                <Box paddingLeft={toolColumnGap} width={toolColumnWidth + toolColumnGap}>
                  {visibleToolsets[2] ? (
                    <ToolLine
                      detail={formatToolsetTools(visibleToolsets[2].tools)}
                      detailWidth={toolDetailWidth}
                      name={visibleToolsets[2].name}
                    />
                  ) : null}
                </Box>
              </Box>
            </TitledFrameRow>
            {visibleToolsets.slice(3).map((toolset) => (
              <TitledFrameRow key={toolset.name} width={panelWidth}>
                <Box flexDirection={contentDirection}>
                  <Box width={workspaceColumnWidth} />
                  <Box paddingLeft={toolColumnGap} width={toolColumnWidth + toolColumnGap}>
                    <ToolLine detail={formatToolsetTools(toolset.tools)} detailWidth={toolDetailWidth} name={toolset.name} />
                  </Box>
                </Box>
              </TitledFrameRow>
            ))}
            {hiddenToolsetCount > 0 ? (
              <TitledFrameRow width={panelWidth}>
                <Box flexDirection={contentDirection}>
                  <Box width={workspaceColumnWidth} />
                  <Box paddingLeft={toolColumnGap} width={toolColumnWidth + toolColumnGap}>
                    <Text color={PALETTE.muted}>
                      {truncateEnd(`(and ${hiddenToolsetCount} more toolsets...)`, toolColumnWidth)}
                    </Text>
                  </Box>
                </Box>
              </TitledFrameRow>
            ) : null}
          </>
        )}
        <TitledFrameBottom width={panelWidth} />
      </Box>
    </Box>
  );
}

function StatusRule({
  busy,
  columns,
  config,
  elapsedMs,
  inputLength,
  notice,
}: {
  busy: boolean;
  columns: number;
  config: Config;
  elapsedMs: number;
  inputLength: number;
  notice: string;
}) {
  const defaults = config.agents.defaults;
  const status = busy ? THINK_FRAMES[Math.floor(elapsedMs / 850) % THINK_FRAMES.length] : notice || "idle";
  const ctx = defaults.contextWindowTokens ? `${Math.round(defaults.contextWindowTokens / 1024)}k ctx` : "ctx --";
  const ruleWidth = Math.max(0, columns - 2);

  return (
    <Box flexDirection="column">
      <Box paddingLeft={1}>
        <Text color={busy ? PALETTE.primary : PALETTE.success} bold>
          {busy ? "*" : "$"} {modelLabel(config)}
        </Text>
        <Text color={PALETTE.lineDim}> | </Text>
        <Text color={PALETTE.lemon}>{ctx}</Text>
        <Text color={PALETTE.lineDim}> | </Text>
        <Text color={PALETTE.muted}>iter {defaults.maxToolIterations}</Text>
        <Text color={PALETTE.lineDim}> | </Text>
        <Text color={busy ? PALETTE.primary : PALETTE.muted}>{status}</Text>
        <Text color={PALETTE.lineDim}> | </Text>
        <Text color={PALETTE.muted}>{formatDuration(elapsedMs)}</Text>
        <Text color={PALETTE.lineDim}> | </Text>
        <Text color={PALETTE.muted}>{inputLength} chars</Text>
      </Box>
      <Text color={PALETTE.line}>{repeated("─", ruleWidth)}</Text>
    </Box>
  );
}

function MemmyTui({ config, registerCleanup, sessionId, toolsets, version }: TuiProps) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const activeLoopRef = useRef<AgentLoop | null>(null);
  const activeAssistantIdRef = useRef<number | null>(null);
  const idRef = useRef(1);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [inputCursor, setInputCursor] = useState(0);
  const inputRef = useRef("");
  const inputCursorRef = useRef(0);
  const [messages, setMessages] = useState<TuiMessage[]>(() => []);
  const [notice, setNotice] = useState("ready");
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const sessionParts = useMemo(
    () => (sessionId.includes(":") ? (sessionId.split(/:(.*)/s).filter(Boolean).slice(0, 2) as [string, string]) : ["cli", sessionId]),
    [sessionId],
  );

  const appendMessage = useCallback((role: TuiMessageRole, text: string) => {
    setMessages((prev) => [...prev, { id: idRef.current++, role, text }].slice(-MAX_MESSAGES));
  }, []);

  const setDraft = useCallback((nextInput: string, nextCursor: number) => {
    const safeCursor = snapCursor(nextInput, nextCursor);
    inputRef.current = nextInput;
    inputCursorRef.current = safeCursor;
    setInput(nextInput);
    setInputCursor(safeCursor);
  }, []);

  const appendAssistantDelta = useCallback((delta: string) => {
    if (!delta) return;
    let id = activeAssistantIdRef.current;
    if (id == null) {
      id = idRef.current++;
      activeAssistantIdRef.current = id;
      const next: TuiMessage = { id, role: "assistant", text: delta };
      setMessages((prev) => [...prev, next].slice(-MAX_MESSAGES));
      return;
    }
    setMessages((prev) => prev.map((message) => (message.id === id ? { ...message, text: message.text + delta } : message)));
  }, []);

  const finishTurn = useCallback(() => {
    activeAssistantIdRef.current = null;
    setBusy(false);
    setTurnStartedAt(null);
    setNotice("ready");
  }, []);

  useEffect(() => {
    if (!busy) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [busy]);

  useEffect(() => {
    const cleanup = onceCleanup(async () => {
      const loop = activeLoopRef.current;
      if (!loop) return;
      loop.stop();
      await settleWithTimeout([loop.closeMcp()], 1500);
      activeLoopRef.current = null;
    });
    registerCleanup(cleanup);
    return () => {
      void cleanup();
    };
  }, [registerCleanup]);

  const handleProgress = useCallback(
    async (content: string, opts: Record<string, any> = {}) => {
      const metadata: Record<string, any> = { agentProgress: true, ...opts };
      const text = content ?? "";
      if (metadata.reasoning || metadata.reasoningDelta) {
        if (text.trim()) setNotice(text.trim().slice(0, 80));
        return;
      }
      if (metadata.reasoningEnd) return;
      if (metadata.agentProgress && text.trim()) {
        appendMessage("progress", text.trim());
        setNotice(text.trim().slice(0, 80));
      }
    },
    [appendMessage],
  );

  const submit = useCallback(
    (value: string) => {
      const text = value.replace(/[\r\n]+/g, "").trim();
      setDraft("", 0);
      if (!text) return;
      if (["exit", "quit", "/exit", "/quit", ":q"].includes(text.toLowerCase())) {
        appendMessage("system", "Goodbye.");
        exit();
        return;
      }
      if (busy) {
        appendMessage("system", "The agent is still working; wait for the current turn to finish.");
        return;
      }

      const [channel, chatId] = sessionParts;
      appendMessage("user", text);
      setBusy(true);
      setNotice("queued");
      setTurnStartedAt(Date.now());
      activeAssistantIdRef.current = null;
      const loop = AgentLoop.fromConfig(config);
      activeLoopRef.current = loop;
      void (async () => {
        try {
          const response = await loop.processDirect(text, {
            sessionKey: sessionId,
            channel,
            chatId,
            onProgress: withProgressCapabilities(handleProgress, {
              fileEditEvents: true,
              reasoning: true,
              toolEvents: true,
            }),
            onStream: async (delta: string) => {
              appendAssistantDelta(delta);
            },
            onStreamEnd: async () => undefined,
          });
          if (activeAssistantIdRef.current == null && response?.content) appendMessage("assistant", response.content);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          appendMessage("system", `Error: ${message}`);
        } finally {
          await settleWithTimeout([loop.closeMcp()], 1500);
          if (activeLoopRef.current === loop) activeLoopRef.current = null;
          finishTurn();
        }
      })();
    },
    [appendAssistantDelta, appendMessage, busy, config, exit, finishTurn, handleProgress, sessionId, sessionParts, setDraft],
  );

  useInput((value, key) => {
    if (key.ctrl && value === "c") {
      appendMessage("system", busy ? "Interrupted by user." : "Goodbye.");
      exit();
      return;
    }

    if (key.return) {
      submit(inputRef.current);
      return;
    }

    if (busy) return;

    const currentInput = inputRef.current;
    const currentCursor = inputCursorRef.current;
    const inputChar = value.toLowerCase();
    const actionMod = isActionMod(key);
    const wordMod = actionMod || key.meta;
    const actionHome = key.home || (!isMac && actionMod && inputChar === "a") || isMacActionFallback(key, value, "a");
    const actionEnd = key.end || (actionMod && inputChar === "e") || isMacActionFallback(key, value, "e");
    const actionDeleteToStart =
      (actionMod && inputChar === "u") ||
      (isMac && actionMod && (key.backspace || key.delete)) ||
      isMacActionFallback(key, value, "u");
    const actionKillToEnd = (actionMod && inputChar === "k") || isMacActionFallback(key, value, "k");
    const actionDeleteWord = (actionMod && inputChar === "w") || isMacActionFallback(key, value, "w");

    if (actionHome) {
      setDraft(currentInput, 0);
      return;
    }

    if (actionEnd) {
      setDraft(currentInput, currentInput.length);
      return;
    }

    if (key.leftArrow) {
      setDraft(currentInput, wordMod ? wordLeft(currentInput, currentCursor) : previousCursor(currentInput, currentCursor));
      return;
    }

    if (key.rightArrow) {
      setDraft(currentInput, wordMod ? wordRight(currentInput, currentCursor) : nextCursor(currentInput, currentCursor));
      return;
    }

    if (wordMod && inputChar === "b") {
      setDraft(currentInput, wordLeft(currentInput, currentCursor));
      return;
    }

    if (wordMod && inputChar === "f") {
      setDraft(currentInput, wordRight(currentInput, currentCursor));
      return;
    }

    if (actionDeleteToStart) {
      const cursor = snapCursor(currentInput, currentCursor);
      setDraft(currentInput.slice(cursor), 0);
      return;
    }

    if (actionKillToEnd) {
      const cursor = snapCursor(currentInput, currentCursor);
      setDraft(currentInput.slice(0, cursor), cursor);
      return;
    }

    if (actionDeleteWord) {
      const cursor = snapCursor(currentInput, currentCursor);
      if (cursor === 0) return;
      const previous = wordLeft(currentInput, cursor);
      setDraft(currentInput.slice(0, previous) + currentInput.slice(cursor), previous);
      return;
    }

    if (key.backspace || key.delete) {
      const cursor = snapCursor(currentInput, currentCursor);
      if (cursor === 0) return;
      const previous = wordMod ? wordLeft(currentInput, cursor) : previousCursor(currentInput, cursor);
      setDraft(currentInput.slice(0, previous) + currentInput.slice(cursor), previous);
      return;
    }

    if (!value || key.ctrl || key.meta || key.super) return;

    const text = value.replace(/\r/g, "");
    if (!text) return;
    if (text.includes("\n")) {
      submit(currentInput.slice(0, currentCursor) + text.replace(/\n.*$/s, ""));
      return;
    }

    const cursor = snapCursor(currentInput, currentCursor);
    setDraft(currentInput.slice(0, cursor) + text + currentInput.slice(cursor), cursor + text.length);
  });

  const visibleMessages = messages.slice(-8);
  const elapsedMs = turnStartedAt ? now - turnStartedAt : 0;
  const ruleWidth = Math.max(0, columns - 2);
  const inputPlaceholder = busy ? "agent is working..." : "Ask memmy, /quit to exit";

  return (
    <Box flexDirection="column" paddingX={1}>
      <Banner columns={columns} config={config} toolsets={toolsets} version={version} />

      {messages.length ? (
        <Box flexDirection="column">
          {visibleMessages.map((message) => (
            <MessageBlock key={message.id} columns={columns} message={message} />
          ))}
        </Box>
      ) : null}

      <StatusRule
        busy={busy}
        columns={columns}
        config={config}
        elapsedMs={elapsedMs}
        inputLength={input.length}
        notice={notice}
      />

      <Box flexDirection="column">
        <ComposerInput
          active={!busy}
          columns={columns}
          cursor={inputCursor}
          placeholder={inputPlaceholder}
          rows={rows}
          value={input}
        />
        <Text color={PALETTE.line}>{repeated("─", ruleWidth)}</Text>
      </Box>
    </Box>
  );
}

export async function runInkInteractiveAgent(config: Config, sessionId = "cli:direct"): Promise<null> {
  if (!process.stdin.isTTY) return null;
  const toolsets = readToolsets(config);
  let cleanup: TuiCleanup = async () => undefined;
  const registerCleanup = (next: TuiCleanup) => {
    cleanup = next;
  };

  process.stdout.write("\x1b[2J\x1b[H\x1b[3J");
  const instance = render(
    <MemmyTui config={config} registerCleanup={registerCleanup} sessionId={sessionId} toolsets={toolsets} version={VERSION} />,
    { exitOnCtrlC: false, maxFps: 60 },
  );

  try {
    await instance.waitUntilExit();
  } finally {
    await cleanup();
    instance.unmount();
  }

  return null;
}
