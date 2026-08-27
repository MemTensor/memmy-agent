import { describe, expect, it } from "vitest";
import type { InventoryEntry } from "../../../src/service/project-environment/types.js";
import { classifyProjectInventory } from "../../../src/service/project-environment/project-classifier.js";

describe("project environment classifier", () => {
  it.each([
    ["Git repository", [directory(".git"), file("notes.txt")]],
    ["Git worktree marker", [directory(".git"), file("README.md")]],
    ["non-Git manifest project", [file("apps/web/package.json")]],
    ["source with a conventional entry", [file("src/main.py")]],
    ["source with tests", [file("lib/value.ts"), file("tests/value.test.ts")]],
    ["five source files", [1, 2, 3, 4, 5].map((index) => file(`lib/value-${index}.rb`))]
  ])("recognizes %s as code", (_label, entries) => {
    expect(classifyProjectInventory(entries as InventoryEntry[]).kind).toBe("code");
  });

  it("does not inherit a parent repository or infer code from a few unrelated files", () => {
    const entries = [
      file("draft.ts"),
      file("archive/old.py"),
      file("notes/ideas.js"),
      file("资料/说明.md")
    ];
    expect(classifyProjectInventory(entries).kind).toBe("folder");
  });

  it("reclassifies from folder to code and back from each complete inventory", () => {
    const folder = [file("需求.docx"), file("排期.xlsx")];
    const code = [...folder, file("package.json")];
    expect(classifyProjectInventory(folder).kind).toBe("folder");
    expect(classifyProjectInventory(code).kind).toBe("code");
    expect(classifyProjectInventory(folder).kind).toBe("folder");
  });
});

function file(relativePath: string): Extract<InventoryEntry, { type: "file" }> {
  return { relativePath, type: "file", size: 1, mtimeMs: 1 };
}

function directory(relativePath: string): Extract<InventoryEntry, { type: "directory" }> {
  return { relativePath, type: "directory", mtimeMs: 1 };
}
