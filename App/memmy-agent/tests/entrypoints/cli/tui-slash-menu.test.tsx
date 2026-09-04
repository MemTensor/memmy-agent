import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import type { TuiSlashCommand } from "../../../src/entrypoints/cli/tui-gateway-client.js";
import {
  buildTuiSlashCommands,
  classifyTuiInput,
  completeTuiSlashCommand,
  formatTuiSlashMenuRows,
  isTuiSlashDraft,
  isTuiSlashMenuOpen,
  queryTuiSlashCommands,
  slashMenuStatusText,
  tuiSlashMenuRowCount,
  tuiVisibleMessageCount,
} from "../../../src/entrypoints/cli/tui-slash-menu.js";

function command(name: string, title = `${name} title`, argHint = ""): TuiSlashCommand {
  return {
    command: name,
    title,
    description: `${name} searchable description`,
    icon: "test",
    argHint,
    source: "gateway",
  };
}

const idle = {
  connection: "connected" as const,
  attached: true,
  busy: false,
  ownedByTui: false,
  activeTurnId: null,
};

describe("TUI slash menu", () => {
  it("composes primary commands without duplicating local or unsafe Gateway commands", () => {
    const gateway = [
      command("/future-z"),
      command("/quit"),
      command("/restart"),
      command("/history-dag"),
      command("/stop"),
      command("/help"),
      command("/new"),
      command("/status"),
      command("/model", "Switch model preset", "[list|preset]"),
      command("/history", "Show conversation history", "[n]"),
      command("/goal"),
      command("/future-a"),
    ];

    expect(buildTuiSlashCommands(gateway, idle).map((item) => item.command)).toEqual([
      "/new",
      "/status",
      "/model",
      "/history",
      "/last-compaction",
      "/goal",
      "/help",
      "/quit",
      "/history-dag",
      "/future-z",
      "/future-a",
    ]);
  });

  it("shows local stop only for the exact active TUI ownership state", () => {
    const gateway = [command("/new"), command("/status")];
    const owned = buildTuiSlashCommands(gateway, {
      ...idle,
      busy: true,
      ownedByTui: true,
      activeTurnId: "turn-tui",
    });
    expect(owned.map((item) => item.command)).toEqual([
      "/stop",
      "/new",
      "/status",
      "/last-compaction",
      "/quit",
    ]);
    expect(owned[0]).toMatchObject({ source: "local", title: "Stop current TUI Turn" });

    const external = buildTuiSlashCommands(gateway, {
      ...idle,
      busy: true,
      ownedByTui: false,
      activeTurnId: null,
    });
    expect(external.map((item) => item.command)).toEqual(["/status", "/last-compaction", "/quit"]);
  });

  it("classifies only the three TUI-local actions and preserves manual Gateway commands", () => {
    expect(classifyTuiInput(" /stop ")).toBe("local-stop");
    expect(classifyTuiInput("/LAST-COMPACTION")).toBe("local-last-compaction");
    for (const alias of ["/quit", "/exit", "exit", "quit", ":q"]) {
      expect(classifyTuiInput(alias)).toBe("local-quit");
    }
    for (const value of ["/new", "/restart", "/help", "/history-dag", "/stop now"]) {
      expect(classifyTuiInput(value)).toBe("gateway");
    }
  });

  it("recognizes one-token slash drafts and reopens only after the text changes", () => {
    expect(isTuiSlashDraft("/his")).toBe(true);
    expect(isTuiSlashDraft("/history-dag")).toBe(true);
    expect(isTuiSlashDraft("/history ")).toBe(false);
    expect(isTuiSlashDraft("/goal create")).toBe(false);
    expect(isTuiSlashDraft("./path")).toBe(false);
    expect(isTuiSlashMenuOpen("/his", null)).toBe(true);
    expect(isTuiSlashMenuOpen("/his", "/his")).toBe(false);
    expect(isTuiSlashMenuOpen("/hist", "/his")).toBe(true);
  });

  it("ranks exact, prefix, then searchable matches and returns at most eight", () => {
    const commands = [
      command("/model", "Switch model preset", "[list|preset]"),
      command("/models-extra"),
      command("/status", "Model runtime status"),
      ...Array.from({ length: 8 }, (_, index) =>
        command(`/future-${index}`, `Model future ${index}`),
      ),
    ];
    expect(queryTuiSlashCommands(commands, "/model").map((item) => item.command)).toEqual([
      "/model",
      "/models-extra",
      "/status",
      "/future-0",
      "/future-1",
      "/future-2",
      "/future-3",
      "/future-4",
    ]);
    expect(queryTuiSlashCommands(commands, "/")).toHaveLength(8);
    expect(queryTuiSlashCommands(commands, "/missing")).toEqual([]);
  });

  it("completes argument commands with a space while exact Enter can still execute", () => {
    expect(completeTuiSlashCommand(command("/model", "Switch model", "[list|preset]"))).toBe(
      "/model ",
    );
    expect(completeTuiSlashCommand(command("/quit"))).toBe("/quit");
  });

  it("keeps wide and narrow menu rows single-line and caps the message window", () => {
    const commands = [
      command("/model", "切换模型预设", "[list|preset]"),
      command("/history", "Show conversation history", "[n]"),
    ];
    const wide = formatTuiSlashMenuRows(commands, 0, 52);
    expect(wide).toMatchInlineSnapshot(`
      [
        "› /model [list|preset]  切换模型预设",
        "  /history [n]          Show conversation history",
      ]
    `);
    const narrow = formatTuiSlashMenuRows(commands, 1, 12);
    expect(narrow.every((row) => !row.includes("\n") && stringWidth(row) <= 12)).toBe(true);
    expect(tuiSlashMenuRowCount(true, 0)).toBe(1);
    expect(tuiSlashMenuRowCount(true, 8)).toBe(8);
    expect(tuiVisibleMessageCount(8)).toBe(0);
    expect(tuiVisibleMessageCount(0)).toBe(8);
  });

  it("uses fixed local-only fallback messages without replacing stale candidates", () => {
    expect(slashMenuStatusText("loading")).toBe("Loading Gateway commands...");
    expect(slashMenuStatusText("error")).toBe(
      "Gateway commands unavailable; local commands remain available.",
    );
    expect(slashMenuStatusText("ready")).toBe("No matching command.");
    expect(slashMenuStatusText("stale")).toBe("No matching command.");
  });
});
