import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { zhCNMessages } from "../../i18n/messages.js";
import {
  AgentCommandPalette,
  buildVisibleSlashCommands,
  filterSlashCommands,
  localizeSlashCommands,
  readRecentSlashCommands,
  slashQueryFromInput,
  updateRecentSlashCommands,
  writeRecentSlashCommands,
  type SlashCommandPaletteItem,
  type SlashCommandStorageLike
} from "../agent-command-palette.js";

const commands: SlashCommandPaletteItem[] = [
  { command: "/status", title: "Show status", description: "Display runtime status", icon: "activity", argHint: "" },
  { command: "/history", title: "Show history", description: "Print persisted messages", icon: "history", argHint: "[n]" },
  { command: "/model", title: "Switch model", description: "Switch the active preset", icon: "brain", argHint: "[preset]" },
  { command: "/dream", title: "Run Dream", description: "Trigger memory consolidation", icon: "sparkles", argHint: "" }
];

describe("AgentCommandPalette", () => {
  it("detects slash query mode only for a leading command token", () => {
    expect(slashQueryFromInput("/")).toBe("");
    expect(slashQueryFromInput("/his")).toBe("his");
    expect(slashQueryFromInput("/history 5")).toBeNull();
    expect(slashQueryFromInput("show /history")).toBeNull();
  });

  it("filters by command metadata and caps visible results", () => {
    expect(filterSlashCommands(commands, "his", []).map((command) => command.command)).toEqual(["/history"]);
    expect(filterSlashCommands(commands, "preset", []).map((command) => command.command)).toEqual(["/model"]);
    expect(filterSlashCommands([...commands, ...commands, ...commands], "", [])).toHaveLength(8);
  });

  it("orders empty-query results by recent commands without storing /stop", () => {
    const recent = updateRecentSlashCommands("/history", updateRecentSlashCommands("/stop", ["/model"]));
    expect(recent).toEqual(["/history", "/model"]);
    expect(filterSlashCommands(commands, "", recent).map((command) => command.command).slice(0, 2)).toEqual(["/history", "/model"]);
  });

  it("stores recent commands through localStorage-compatible storage", () => {
    const storage = new MemoryStorage();

    writeRecentSlashCommands(["/history", "/model"], storage);

    expect(readRecentSlashCommands(storage)).toEqual(["/history", "/model"]);
  });

  it("prepends a synthetic /stop command only while streaming", () => {
    const stopCommand: SlashCommandPaletteItem = { command: "/stop", title: "Stop", description: "Cancel turn", icon: "square", argHint: "", synthetic: true };

    expect(buildVisibleSlashCommands(commands, false, stopCommand).map((command) => command.command)).not.toContain("/stop");
    expect(buildVisibleSlashCommands([{ ...stopCommand, synthetic: false }, ...commands], true, stopCommand).map((command) => command.command).slice(0, 2)).toEqual(["/stop", "/status"]);
  });

  it("localizes builtin command titles and descriptions for Chinese UI", () => {
    const localized = localizeSlashCommands(
      [
        { command: "/new", title: "New", description: "New chat", icon: "square-pen", argHint: "" },
        { command: "/status", title: "Status", description: "Show status", icon: "activity", argHint: "" },
        { command: "/history-dag", title: "History DAG", description: "Show history DAG", icon: "git-branch", argHint: "" },
        { command: "/plugin", title: "Plugin", description: "Plugin command", icon: "activity", argHint: "" }
      ],
      "zh-CN",
      (key) => zhCNMessages[key]
    );

    expect(localized).toEqual([
      { command: "/new", title: "新对话", description: "停止当前任务，并开始一段全新的对话。", icon: "square-pen", argHint: "" },
      { command: "/status", title: "查看状态", description: "显示运行时、模型供应商和频道状态。", icon: "activity", argHint: "" },
      { command: "/history-dag", title: "查看历史 DAG", description: "查看当前会话的任务状态图。", icon: "git-branch", argHint: "" },
      { command: "/plugin", title: "Plugin", description: "Plugin command", icon: "activity", argHint: "" }
    ]);
  });

  it("renders command metadata as a listbox", () => {
    const html = renderToString(<AgentCommandPalette commands={commands.slice(0, 2)} heading="Commands" selectedIndex={1} onSelect={() => undefined} />);

    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).toContain("Commands");
    expect(html).toContain("/status");
    expect(html).toContain("/history");
    expect(html).toContain("[n]");
    expect(html).toContain("Display runtime status");
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("w-full");
    expect(html).toContain('aria-labelledby="agent-command-palette-heading"');
    expect(html).toContain("max-height:min(432px, calc(100vh - 260px))");
    expect(html).toContain("rounded-card");
    expect(html).toContain("rounded-btn px-2.5 py-2");
    expect(html).toContain("font-mono text-xs font-semibold text-action-sky");
    expect(html).toContain("lucide-activity");
    expect(html).toContain("w-8 h-8");
    expect(html).not.toContain("grid-template-columns");
    expect(html).toContain("truncate");
  });
});

class MemoryStorage implements SlashCommandStorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}
