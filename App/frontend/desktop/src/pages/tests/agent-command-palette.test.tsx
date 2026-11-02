import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { enUSMessages, zhCNMessages } from "../../i18n/messages.js";
import {
  AgentCommandPalette,
  buildVisibleSlashCommands,
  defaultSlashCommandIndex,
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
  it("detects a trailing slash query after arbitrary draft text", () => {
    expect(slashQueryFromInput("/")).toBe("");
    expect(slashQueryFromInput("/his")).toBe("his");
    expect(slashQueryFromInput("/history 5")).toBe("history 5");
    expect(slashQueryFromInput("/GOAL  p")).toBe("goal p");
    expect(slashQueryFromInput("/goal ")).toBe("goal ");
    expect(slashQueryFromInput("/goal\npause")).toBeNull();
    expect(slashQueryFromInput("show /history")).toBeNull();
  });

  it("filters only by command-name prefix, case-insensitively", () => {
    expect(filterSlashCommands(commands, "his", []).map((command) => command.command)).toEqual(["/history"]);
    expect(filterSlashCommands(commands, "MoD", []).map((command) => command.command)).toEqual(["/model list", "/model"]);
    expect(filterSlashCommands(commands, "preset", [])).toEqual([]);
    expect(filterSlashCommands(commands, "istory", [])).toEqual([]);
  });

  it("keeps every available command reachable beyond the first eight results", () => {
    const available = ["/new", "/restart", "/status", "/model", "/history", "/history-dag", "/goal", "/help", "/pairing", "/last-compaction"]
      .map((command) => ({ command, title: command, description: "Available command", icon: "activity", argHint: "" }));
    expect(filterSlashCommands(available, "", []).slice(0, available.length)).toEqual(available);
    expect(filterSlashCommands(available, "", []).map((item) => item.command)).toContain("/goal budget none");
    for (const command of available) {
      expect(filterSlashCommands(available, slashQueryFromInput(command.command)!, [])).toContainEqual(command);
    }
  });

  it("matches every literal subcommand in the same flat candidate list", () => {
    const available = ["/goal", "/pairing", "/model", "/history", "/dream-log"].map((command) => ({
      command, title: command, description: "", icon: "activity", argHint: ""
    }));
    const match = (input: string) => filterSlashCommands(available, slashQueryFromInput(input)!, []);
    const expected = {
      "/goal ": ["status", "help", "create", "pause", "resume", "edit", "budget", "budget none", "clear"],
      "/pairing ": ["list", "approve", "deny", "revoke"],
      "/model ": ["list"],
      "/goal budget ": ["none"]
    };
    for (const [prefix, suffixes] of Object.entries(expected)) {
      expect(match(prefix).map((item) => item.command)).toEqual(suffixes.map((suffix) => prefix + suffix).sort((a, b) => b.length - a.length));
      for (const suffix of suffixes) {
        expect(match(prefix + suffix).at(-1)?.command).toBe(prefix + suffix);
        expect(match(prefix + suffix[0]).map((item) => item.command)).toContain(prefix + suffix);
      }
    }
    expect(match("/GOAL   P").map((item) => item.command)).toEqual(["/goal pause"]);
    expect(match("/pairing a")[0]).toMatchObject({ command: "/pairing approve", argHint: "<code>" });
    expect(match("/goal c").map((item) => item.command)).toEqual(["/goal create", "/goal clear"]);
    expect(match("/goal create")[0]?.argHint).toBe("<objective>");
    for (const input of ["/history 5", "/dream-log abc", "/pairing approve abc", "/goal create write tests", "/goal budget 1000", "/goal status ", "/goal my objective"]) {
      expect(match(input)).toEqual([]);
    }
    expect(filterSlashCommands([], "goal p", [])).toEqual([]);
  });

  it("matches parent and descendant commands together and places exact matches last", () => {
    const available = ["/goal", "/pairing", "/model"].map((command) => ({
      command, title: command, description: "", icon: "activity", argHint: ""
    }));
    const match = (query: string) => filterSlashCommands(available, query, []).map((item) => item.command);
    expect(match("goal")).toEqual([
      "/goal budget none", "/goal status", "/goal create", "/goal resume", "/goal budget",
      "/goal pause", "/goal clear", "/goal help", "/goal edit", "/goal"
    ]);
    expect(match("g")).toEqual(match("goal"));
    expect(match("goal b")).toEqual(["/goal budget none", "/goal budget"]);
    expect(match("p")).toEqual(match("pairing"));
    expect(match("m")).toEqual(match("model"));
    expect(match("goal ")).not.toContain("/goal");
    expect(match("goal budget")).toEqual(["/goal budget none", "/goal budget"]);
    expect(match("goal budget ")).toEqual(["/goal budget none"]);
    expect(match("pairing")).toEqual(["/pairing approve", "/pairing revoke", "/pairing list", "/pairing deny", "/pairing"]);
    expect(match("model")).toEqual(["/model list", "/model"]);
  });

  it("places closer prefix matches nearest the input and selects the bottom result", () => {
    const available = ["/history", "/history-dag"].map((command) => ({
      command, title: command, description: "", icon: "activity", argHint: ""
    }));
    for (const query of ["h", "history"]) {
      const matches = filterSlashCommands(available, query, []);
      expect(matches.map((item) => item.command)).toEqual(["/history-dag", "/history"]);
      expect(matches[defaultSlashCommandIndex(query, matches.length)]?.command).toBe("/history");
    }
    expect(defaultSlashCommandIndex("", 5)).toBe(0);
    expect(defaultSlashCommandIndex("missing", 0)).toBe(0);
  });

  it("matches available model preset names without changing their case", () => {
    const presets = [
      { name: "FastModel", available: true },
      { name: "unavailable", available: false }
    ];
    expect(filterSlashCommands(commands, "model ", [], presets).map((item) => item.command)).toEqual(["/model FastModel", "/model list"]);
    expect(filterSlashCommands(commands, "m", [], presets).map((item) => item.command)).toEqual(["/model FastModel", "/model list", "/model"]);
    expect(filterSlashCommands(commands, "model fa", [], presets)[0]).toMatchObject({ command: "/model FastModel", argHint: "" });
    expect(filterSlashCommands(commands, "model un", [], presets)).toEqual([]);
    expect(filterSlashCommands(commands, "model FastModel ", [], presets)).toEqual([]);
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

  it("shows /stop while streaming or searching, but not in idle default suggestions", () => {
    const stopCommand: SlashCommandPaletteItem = { command: "/stop", title: "Stop", description: "Cancel turn", icon: "square", argHint: "", synthetic: true };

    expect(buildVisibleSlashCommands(commands, false, stopCommand).map((command) => command.command)).not.toContain("/stop");
    expect(buildVisibleSlashCommands([{ ...stopCommand, synthetic: false }, ...commands], true, stopCommand).map((command) => command.command).slice(0, 2)).toEqual(["/stop", "/status"]);
    for (const input of ["/s", "/stop"]) {
      const query = slashQueryFromInput(input)!;
      const visible = buildVisibleSlashCommands([stopCommand, ...commands], false, stopCommand, query);
      const matches = filterSlashCommands(visible, query, []);
      expect(matches.filter((command) => command.command === "/stop")).toEqual([stopCommand]);
    }
    expect(filterSlashCommands(buildVisibleSlashCommands(commands, false, stopCommand, "model"), "model", [])).not.toContainEqual(stopCommand);
  });

  it("does not suggest /new when its description contains Stop", () => {
    const stopCommand: SlashCommandPaletteItem = { command: "/stop", title: "Stop", description: "Cancel turn", icon: "square", argHint: "", synthetic: true };
    const available = [
      ...commands,
      { command: "/new", title: "New chat", description: "Stop the current task and start a fresh conversation.", icon: "square-pen", argHint: "" }
    ];
    for (const isSending of [false, true]) {
      for (const [input, expected] of [["/s", ["/status", "/stop"]], ["/stop", ["/stop"]]] as const) {
        const query = slashQueryFromInput(input)!;
        const visible = buildVisibleSlashCommands(available, isSending, stopCommand, query);
        expect(filterSlashCommands(visible, query, []).map((command) => command.command)).toEqual(expected);
      }
    }
  });

  it("localizes builtin command titles and descriptions for Chinese UI", () => {
    const localized = localizeSlashCommands(
      [
        { command: "/new", title: "New", description: "New chat", icon: "square-pen", argHint: "" },
        { command: "/status", title: "Status", description: "Show status", icon: "activity", argHint: "" },
        { command: "/history-dag", title: "History DAG", description: "Show history DAG", icon: "git-branch", argHint: "" },
        { command: "/goal", title: "Goal", description: "Start goal", icon: "activity", argHint: "[status|create <objective>|pause]" },
        { command: "/plugin", title: "Plugin", description: "Plugin command", icon: "activity", argHint: "" }
      ],
      "zh-CN",
      (key) => zhCNMessages[key]
    );

    expect(localized).toEqual([
      { command: "/new", title: "新对话", description: "停止当前任务，并开始一段全新的对话。", icon: "square-pen", argHint: "" },
      { command: "/status", title: "查看状态", description: "显示运行时、模型供应商和频道状态。", icon: "activity", argHint: "" },
      { command: "/history-dag", title: "查看历史 DAG", description: "查看当前会话的任务状态图。", icon: "git-branch", argHint: "" },
      { command: "/goal", title: "开始长期目标", description: "让 Agent 将本次请求作为长期目标处理。", icon: "activity", argHint: "" },
      { command: "/plugin", title: "Plugin", description: "Plugin command", icon: "activity", argHint: "" }
    ]);
  });

  it("hides the Goal argument hint in non-Chinese palettes", () => {
    const localized = localizeSlashCommands(
      [{ command: "/goal", title: "Goal", description: "Start goal", icon: "activity", argHint: "[status|create <objective>|pause]" }],
      "en-US",
      (key) => enUSMessages[key]
    );

    expect(localized[0]).toMatchObject({ title: "Goal", description: "Start goal", argHint: "" });
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
    expect(html).toContain("max-height:min(286px, calc(100vh - 260px))");
    expect(html).toContain("height:56px;box-sizing:border-box");
    expect(html).toContain("rounded-card");
    expect(html).toContain("rounded-btn px-2.5 py-2");
    expect(html).toContain("shrink-0 whitespace-nowrap font-mono");
    expect(html).toContain("min-w-0 flex-1 truncate text-xs");
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
