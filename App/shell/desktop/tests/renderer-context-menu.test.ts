import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { googleSearchUrlForSelection, resolveRendererContextMenuCommands, resolveRendererContextMenuMaxLabelWidth, type RendererContextMenuParams } from "../src/main/renderer-context-menu.js";

const mainSourcePath = fileURLToPath(new URL("../src/main/main.ts", import.meta.url));

describe("desktop renderer context menu", () => {
  it("does not open a native menu for plain empty right clicks", () => {
    expect(resolveRendererContextMenuCommands(params())).toEqual([]);
  });

  it("offers copy and Google search for selected conversation text", () => {
    const commands = resolveRendererContextMenuCommands(params({
      selectionText: "To get a real briefing, head to Settings -> Connections"
    }));

    expect(commands).toEqual([
      { kind: "role", role: "copy", enabled: true },
      {
        kind: "searchSelection",
        label: 'Search Google for "To get a real brief..."',
        url: "https://www.google.com/search?q=To%20get%20a%20real%20briefing%2C%20head%20to%20Settings%20-%3E%20Connections",
        text: "To get a real briefing, head to Settings -> Connections"
      }
    ]);
  });

  it("trims long selected text in menu labels without changing the search query", () => {
    const selection = "This is a very long selected agent answer that should fit inside a native context menu label.";
    const commands = resolveRendererContextMenuCommands(params({
      selectionText: selection,
      maxLabelWidthPx: resolveRendererContextMenuMaxLabelWidth(1000)
    }));

    expect(commands[1]).toMatchObject({
      kind: "searchSelection",
      label: 'Search Google for "This is a ve..."',
      url: googleSearchUrlForSelection(selection)
    });
  });

  it("caps selected-text menu labels against the app content width", () => {
    expect(resolveRendererContextMenuMaxLabelWidth(1600)).toBe(300);
    expect(resolveRendererContextMenuMaxLabelWidth(1000)).toBe(250);
    expect(resolveRendererContextMenuMaxLabelWidth(800)).toBe(200);
  });

  it("offers edit commands for editable fields", () => {
    const commands = resolveRendererContextMenuCommands(params({
      isEditable: true,
      selectionText: "draft",
      editFlags: {
        canUndo: true,
        canRedo: false,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canDelete: true,
        canSelectAll: true
      }
    }));

    expect(commands).toEqual([
      { kind: "role", role: "undo", enabled: true },
      { kind: "role", role: "redo", enabled: false },
      { kind: "separator" },
      { kind: "role", role: "cut", enabled: true },
      { kind: "role", role: "copy", enabled: true },
      { kind: "role", role: "paste", enabled: true },
      { kind: "role", role: "delete", enabled: true },
      { kind: "separator" },
      { kind: "role", role: "selectAll", enabled: true }
    ]);
  });

  it("offers safe link actions and rejects non-http link targets", () => {
    expect(resolveRendererContextMenuCommands(params({ linkURL: "https://example.com/docs?q=memmy" }))).toEqual([
      { kind: "openLink", label: "Open Link", url: "https://example.com/docs?q=memmy" },
      { kind: "copyLink", label: "Copy Link", url: "https://example.com/docs?q=memmy" }
    ]);
    expect(resolveRendererContextMenuCommands(params({ linkURL: "javascript:alert(1)" }))).toEqual([]);
  });

  it("wires the native renderer context menu into both desktop windows", () => {
    const source = readFileSync(mainSourcePath, "utf8");

    expect(source).toContain("clipboard, dialog, ipcMain, Menu");
    expect(source).toContain('import { resolveRendererContextMenuCommands, resolveRendererContextMenuMaxLabelWidth, type RendererContextMenuCommand } from "./renderer-context-menu.js";');
    expect(source).toContain("attachRendererContextMenu(targetMainWindow);");
    expect(source).toContain("attachRendererContextMenu(petWindow);");
    expect(source).toContain('targetWindow.webContents.on("context-menu"');
    expect(source).toContain("targetWindow.getContentBounds().width");
    expect(source).toContain("resolveRendererContextMenuCommands({");
    expect(source).toContain("Menu.buildFromTemplate");
    expect(source).toContain("clipboard.writeText(command.url)");
  });
});

function params(overrides: RendererContextMenuParams = {}): RendererContextMenuParams {
  return {
    isEditable: false,
    selectionText: "",
    linkURL: "",
    editFlags: {},
    ...overrides
  };
}
