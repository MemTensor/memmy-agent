import { Box, Text } from "ink";
import React, { useMemo } from "react";
import stringWidth from "string-width";
import type {
  TuiGatewayState,
  TuiSlashCommand,
  TuiSlashCommandsStatus,
} from "./tui-gateway-client.js";

export type TuiInputClassification =
  | "gateway"
  | "local-last-compaction"
  | "local-quit"
  | "local-stop";

type SlashCommandAvailability = Pick<
  TuiGatewayState,
  "activeTurnId" | "attached" | "busy" | "connection" | "ownedByTui"
>;

const MAX_SLASH_RESULTS = 8;
const PRIMARY_ORDER = [
  "/stop",
  "/new",
  "/status",
  "/model",
  "/history",
  "/last-compaction",
  "/goal",
  "/help",
  "/quit",
  "/history-dag",
  "/dream",
  "/dream-log",
  "/dream-restore",
  "/pairing",
] as const;
const PRIMARY_RANK = new Map<string, number>(
  PRIMARY_ORDER.map((command, index) => [command, index]),
);
const RESERVED_LOCAL_COMMANDS = new Set(["/stop", "/last-compaction", "/quit"]);
const EXIT_ALIASES = new Set(["/quit", "/exit", "exit", "quit", ":q"]);
const SLASH_DRAFT_PATTERN = /^\/[A-Za-z0-9_-]*$/;

const LOCAL_STOP: TuiSlashCommand = {
  command: "/stop",
  title: "Stop current TUI Turn",
  description: "Stop only the active Turn owned by this TUI.",
  icon: "square",
  argHint: "",
  source: "local",
};

const LOCAL_LAST_COMPACTION: TuiSlashCommand = {
  command: "/last-compaction",
  title: "Show last compaction",
  description: "Show the latest saved compaction summary for this Session.",
  icon: "book-open",
  argHint: "",
  source: "local",
};

const LOCAL_QUIT: TuiSlashCommand = {
  command: "/quit",
  title: "Exit TUI",
  description: "Disconnect and exit without stopping the active Turn.",
  icon: "log-out",
  argHint: "",
  source: "local",
};

export function classifyTuiInput(text: string): TuiInputClassification {
  const normalized = text.trim().toLowerCase();
  if (normalized === "/stop") return "local-stop";
  if (normalized === "/last-compaction") return "local-last-compaction";
  if (EXIT_ALIASES.has(normalized)) return "local-quit";
  return "gateway";
}

export function isTuiSlashDraft(draft: string): boolean {
  return SLASH_DRAFT_PATTERN.test(draft);
}

export function isTuiSlashMenuOpen(draft: string, dismissedDraft: string | null): boolean {
  return isTuiSlashDraft(draft) && dismissedDraft !== draft;
}

export function buildTuiSlashCommands(
  gatewayCommands: readonly TuiSlashCommand[],
  gatewayState: SlashCommandAvailability,
): TuiSlashCommand[] {
  const commands = gatewayCommands.filter((command) => {
    if (command.command === "/restart" || RESERVED_LOCAL_COMMANDS.has(command.command))
      return false;
    return !(command.command === "/new" && gatewayState.busy && !gatewayState.ownedByTui);
  });
  if (
    gatewayState.connection === "connected" &&
    gatewayState.attached &&
    gatewayState.busy &&
    gatewayState.ownedByTui &&
    gatewayState.activeTurnId
  ) {
    commands.push(LOCAL_STOP);
  }
  commands.push(LOCAL_LAST_COMPACTION, LOCAL_QUIT);

  return commands
    .map((command, serviceIndex) => ({ command, serviceIndex }))
    .sort((left, right) => {
      const leftRank = PRIMARY_RANK.get(left.command.command);
      const rightRank = PRIMARY_RANK.get(right.command.command);
      if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
      if (leftRank !== undefined) return -1;
      if (rightRank !== undefined) return 1;
      return left.serviceIndex - right.serviceIndex;
    })
    .map(({ command }) => command);
}

export function queryTuiSlashCommands(
  commands: readonly TuiSlashCommand[],
  draft: string,
): TuiSlashCommand[] {
  if (!isTuiSlashDraft(draft)) return [];
  const query = draft.slice(1).toLowerCase();
  if (!query) return commands.slice(0, MAX_SLASH_RESULTS);

  return commands
    .map((command, index) => {
      const commandKey = command.command.slice(1).toLowerCase();
      const searchable = [commandKey, command.title, command.description, command.argHint]
        .join("\n")
        .toLowerCase();
      const rank =
        commandKey === query
          ? 0
          : commandKey.startsWith(query)
            ? 1
            : searchable.includes(query)
              ? 2
              : null;
      return { command, index, rank };
    })
    .filter(
      (item): item is { command: TuiSlashCommand; index: number; rank: number } =>
        item.rank !== null,
    )
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, MAX_SLASH_RESULTS)
    .map(({ command }) => command);
}

export function completeTuiSlashCommand(command: TuiSlashCommand): string {
  return command.argHint ? `${command.command} ` : command.command;
}

export function slashMenuStatusText(status: TuiSlashCommandsStatus): string {
  if (status === "loading") return "Loading Gateway commands...";
  if (status === "error") {
    return "Gateway commands unavailable; local commands remain available.";
  }
  return "No matching command.";
}

function truncateLine(value: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(value) <= width) return value;
  if (width <= 3) return ".".repeat(width);
  let output = "";
  for (const character of value) {
    if (stringWidth(output + character) > width - 3) break;
    output += character;
  }
  return `${output}...`;
}

export function formatTuiSlashMenuRows(
  commands: readonly TuiSlashCommand[],
  selectedIndex: number,
  columns: number,
): string[] {
  if (commands.length === 0) return [];
  const contentWidth = Math.max(1, columns - 4);
  const leftValues = commands.map((command) =>
    command.argHint ? `${command.command} ${command.argHint}` : command.command,
  );
  const leftCap = Math.max(1, Math.floor(contentWidth * 0.6));
  const leftWidth = Math.max(
    1,
    Math.min(leftCap, Math.max(...leftValues.map((value) => stringWidth(value)))),
  );
  const rightWidth = contentWidth - leftWidth - 2;

  return commands.map((command, index) => {
    const prefix = index === selectedIndex ? "› " : "  ";
    const left = truncateLine(leftValues[index]!, leftWidth);
    if (rightWidth < 3) return `${prefix}${truncateLine(left, contentWidth)}`;
    const padding = " ".repeat(Math.max(0, leftWidth - stringWidth(left)));
    return `${prefix}${left}${padding}  ${truncateLine(command.title, rightWidth)}`;
  });
}

export function tuiSlashMenuRowCount(open: boolean, candidateCount: number): number {
  return open ? Math.max(1, candidateCount) : 0;
}

export function tuiVisibleMessageCount(menuRowCount: number): number {
  return Math.max(0, 8 - menuRowCount);
}

export function SlashMenu({
  columns,
  commands,
  selectedIndex,
  status,
}: {
  columns: number;
  commands: readonly TuiSlashCommand[];
  selectedIndex: number;
  status: TuiSlashCommandsStatus;
}) {
  const rows = useMemo(
    () => formatTuiSlashMenuRows(commands, selectedIndex, columns),
    [columns, commands, selectedIndex],
  );

  return (
    <Box flexDirection="column">
      {rows.length > 0 ? (
        rows.map((row, index) => (
          <Text
            key={commands[index]!.command}
            bold={index === selectedIndex}
            color={index === selectedIndex ? "#F59E6B" : "#EAF6F3"}
            wrap="truncate-end"
          >
            {row}
          </Text>
        ))
      ) : (
        <Text color="#9BB6B0" wrap="truncate-end">
          {slashMenuStatusText(status)}
        </Text>
      )}
    </Box>
  );
}
