import { describe, expect, it } from "vitest";
import {
  buildDemoKnowledgeBases,
  buildInitialKnowledgeBases,
  buildDemoLibraryFiles,
  buildDemoSourceFolders,
  kbDefaultImportRoot,
  moveFilesToKnowledgeFolder
} from "../knowledge-demo-data.js";

describe("knowledge demo platform folders", () => {
  it("uses the Windows Documents label and root on win32", () => {
    const folders = buildDemoSourceFolders("win32");

    expect(folders[0]).toMatchObject({
      id: "documents",
      name: "文档 (Documents)",
      root: "文档"
    });
    expect(kbDefaultImportRoot("win32")).toBe("文档");
    expect(buildDemoLibraryFiles("win32")[0]?.path).toMatch(/^文档\//u);
  });

  it("keeps the macOS Documents presentation on darwin", () => {
    const folders = buildDemoSourceFolders("darwin");

    expect(folders[0]).toMatchObject({
      id: "documents",
      name: "文稿 (Documents)",
      root: "文稿"
    });
    expect(buildDemoLibraryFiles("darwin")[0]?.path).toMatch(/^文稿\//u);
  });

  it("moves files between virtual folders without changing knowledge-base membership", () => {
    const base = buildDemoKnowledgeBases()[0]!;
    const moved = moveFilesToKnowledgeFolder(base, ["d3"], "folder-core-papers");

    expect(moved.fileIds).toEqual(base.fileIds);
    expect(moved.folders[0]?.fileIds).toEqual(["d1", "d2", "d3"]);

    const returnedToRoot = moveFilesToKnowledgeFolder(moved, ["d1"], null);
    expect(returnedToRoot.fileIds).toEqual(base.fileIds);
    expect(returnedToRoot.folders[0]?.fileIds).toEqual(["d2", "d3"]);
  });

  it("does not seed knowledge bases before onboarding is complete", () => {
    expect(buildInitialKnowledgeBases(false)).toEqual([]);
    expect(buildInitialKnowledgeBases(true)).toHaveLength(5);
  });
});
