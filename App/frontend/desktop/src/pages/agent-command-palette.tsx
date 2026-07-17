import {
  Activity,
  BookOpen,
  Brain,
  CircleQuestionMark,
  GitBranch,
  History,
  RotateCw,
  Shield,
  Sparkles,
  Square,
  SquarePen,
  Undo2,
  type LucideIcon
} from "lucide-react";
import type { MemmyAgentSlashCommand } from "../api/memmy-agent-client.js";
import type { MessageKey, ResolvedLanguage } from "../i18n/messages.js";

export const RECENT_SLASH_COMMANDS_STORAGE_KEY = "memmy-agent-recent-slash-commands";
export const MAX_VISIBLE_SLASH_COMMANDS = 8;
export const MAX_RECENT_SLASH_COMMANDS = 5;

export type SlashCommandPaletteItem = MemmyAgentSlashCommand & {
  synthetic?: boolean;
};

export type SlashCommandTranslator = (key: MessageKey) => string;

export interface AgentCommandPaletteProps {
  commands: SlashCommandPaletteItem[];
  heading: string;
  selectedIndex: number;
  onSelect: (command: SlashCommandPaletteItem) => void;
}

export interface SlashCommandStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

const iconByName: Record<string, LucideIcon> = {
  activity: Activity,
  "book-open": BookOpen,
  brain: Brain,
  "circle-help": CircleQuestionMark,
  "git-branch": GitBranch,
  history: History,
  "rotate-cw": RotateCw,
  shield: Shield,
  sparkles: Sparkles,
  square: Square,
  "square-pen": SquarePen,
  "undo-2": Undo2
};

const localizedBuiltinCommandKeys: Record<string, { title: MessageKey; description: MessageKey }> = {
  "/new": {
    title: "home.command.newTitle",
    description: "home.command.newDescription"
  },
  "/stop": {
    title: "home.command.stopTitle",
    description: "home.command.stopDescription"
  },
  "/restart": {
    title: "home.command.restartTitle",
    description: "home.command.restartDescription"
  },
  "/status": {
    title: "home.command.statusTitle",
    description: "home.command.statusDescription"
  },
  "/model": {
    title: "home.command.modelTitle",
    description: "home.command.modelDescription"
  },
  "/history": {
    title: "home.command.historyTitle",
    description: "home.command.historyDescription"
  },
  "/history-dag": {
    title: "home.command.historyDagTitle",
    description: "home.command.historyDagDescription"
  },
  "/goal": {
    title: "home.command.goalTitle",
    description: "home.command.goalDescription"
  },
  "/dream": {
    title: "home.command.dreamTitle",
    description: "home.command.dreamDescription"
  },
  "/dream-log": {
    title: "home.command.dreamLogTitle",
    description: "home.command.dreamLogDescription"
  },
  "/dream-restore": {
    title: "home.command.dreamRestoreTitle",
    description: "home.command.dreamRestoreDescription"
  },
  "/help": {
    title: "home.command.helpTitle",
    description: "home.command.helpDescription"
  },
  "/pairing": {
    title: "home.command.pairingTitle",
    description: "home.command.pairingDescription"
  }
};

export function localizeSlashCommands(
  commands: MemmyAgentSlashCommand[],
  language: ResolvedLanguage,
  t: SlashCommandTranslator
): MemmyAgentSlashCommand[] {
  if (language !== "zh-CN") {
    return commands;
  }

  return commands.map((command) => {
    const keys = localizedBuiltinCommandKeys[command.command];
    return keys
      ? { ...command, title: t(keys.title), description: t(keys.description) }
      : command;
  });
}

export function AgentCommandPalette(props: AgentCommandPaletteProps) {
  if (!props.commands.length) {
    return null;
  }

  return (
    <div className="w-full rounded-card border border-border-stone/40 bg-background-paper shadow-xl overflow-hidden">
      <div id="agent-command-palette-heading" className="px-3 pt-3 pb-1 text-xs text-text-ink/50">
        {props.heading}
      </div>
      <div
        role="listbox"
        aria-labelledby="agent-command-palette-heading"
        className="px-1.5 pb-1.5 overflow-y-auto"
        style={{ maxHeight: "min(432px, calc(100vh - 260px))" }}
      >
        {props.commands.map((command, index) => {
          const Icon = iconByName[command.icon] ?? Activity;
          const selected = index === props.selectedIndex;
          return (
            <button
              key={`${command.synthetic ? "synthetic" : "command"}:${command.command}`}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => props.onSelect(command)}
              className={`w-full rounded-btn px-2.5 py-2 text-left cursor-pointer transition-colors flex items-start gap-2.5 ${selected ? "bg-canvas-oat/80" : "hover:bg-canvas-oat/50"}`}
            >
              <span className="mt-0.5 w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-btn bg-canvas-oat/70 text-text-ink/60">
                <Icon size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="min-w-0 font-mono text-xs font-semibold text-action-sky truncate">{command.command}</span>
                  {command.argHint ? <span className="min-w-0 text-xs text-text-ink/45 truncate">{command.argHint}</span> : null}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-text-ink/50">{command.description || command.title}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function slashQueryFromInput(input: string): string | null {
  if (!input.startsWith("/")) {
    return null;
  }
  const token = input.slice(1);
  return /\s/.test(token) ? null : token.toLowerCase();
}

export function buildVisibleSlashCommands(
  commands: MemmyAgentSlashCommand[],
  isSending: boolean,
  stopCommand: SlashCommandPaletteItem
): SlashCommandPaletteItem[] {
  const filtered = commands.filter((command) => command.command !== "/stop");
  return isSending ? [stopCommand, ...filtered] : filtered;
}

export function filterSlashCommands(
  commands: SlashCommandPaletteItem[],
  query: string,
  recentCommands: string[]
): SlashCommandPaletteItem[] {
  const normalizedQuery = query.toLowerCase();
  const matched = normalizedQuery
    ? commands.filter((command) => commandMatchesQuery(command, normalizedQuery))
    : sortByRecent(commands, recentCommands);
  return matched.slice(0, MAX_VISIBLE_SLASH_COMMANDS);
}

export function readRecentSlashCommands(storage: SlashCommandStorageLike | null = browserStorage()): string[] {
  if (!storage) {
    return [];
  }
  try {
    const parsed = JSON.parse(storage.getItem(RECENT_SLASH_COMMANDS_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.startsWith("/")).slice(0, MAX_RECENT_SLASH_COMMANDS)
      : [];
  } catch {
    return [];
  }
}

export function writeRecentSlashCommands(commands: string[], storage: SlashCommandStorageLike | null = browserStorage()): void {
  if (!storage) {
    return;
  }
  storage.setItem(RECENT_SLASH_COMMANDS_STORAGE_KEY, JSON.stringify(commands.slice(0, MAX_RECENT_SLASH_COMMANDS)));
}

export function updateRecentSlashCommands(command: string, previous: string[]): string[] {
  if (command === "/stop") {
    return previous.slice(0, MAX_RECENT_SLASH_COMMANDS);
  }
  return [command, ...previous.filter((item) => item !== command)].slice(0, MAX_RECENT_SLASH_COMMANDS);
}

function commandMatchesQuery(command: SlashCommandPaletteItem, query: string): boolean {
  return [command.command, command.title, command.description, command.argHint]
    .some((value) => value.toLowerCase().includes(query));
}

function sortByRecent(commands: SlashCommandPaletteItem[], recentCommands: string[]): SlashCommandPaletteItem[] {
  const recentIndex = new Map(recentCommands.map((command, index) => [command, index]));
  return [...commands].sort((left, right) => {
    const leftIndex = recentIndex.get(left.command);
    const rightIndex = recentIndex.get(right.command);
    if (leftIndex != null && rightIndex != null) {
      return leftIndex - rightIndex;
    }
    if (leftIndex != null) {
      return -1;
    }
    if (rightIndex != null) {
      return 1;
    }
    return 0;
  });
}

function browserStorage(): SlashCommandStorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
