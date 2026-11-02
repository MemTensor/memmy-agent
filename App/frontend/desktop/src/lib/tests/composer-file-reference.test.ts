import { describe, expect, it } from "vitest";
import {
  appendComposerContextReferences,
  composerDropEntriesFromDataTransfer,
  composerFolderReferenceFromFiles,
  MEMMY_COMPOSER_REFERENCE_MIME,
  mergeComposerContextReferences,
  partitionComposerDropFiles,
  readComposerReferenceDrag,
  writeComposerReferenceDrag
} from "../composer-file-reference.js";

function fakeDataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    effectAllowed: "uninitialized",
    setData(type: string, value: string) {
      values.set(type, value);
    },
    getData(type: string) {
      return values.get(type) ?? "";
    },
    get types() {
      return [...values.keys()];
    }
  } as DataTransfer;
}

describe("composer file references", () => {
  it("round-trips an internal drag payload", () => {
    const transfer = fakeDataTransfer();
    const reference = { kind: "path" as const, id: "references/paper.pdf", label: "paper.pdf" };

    writeComposerReferenceDrag(transfer, reference);

    expect(transfer.getData(MEMMY_COMPOSER_REFERENCE_MIME)).toContain("references/paper.pdf");
    expect(readComposerReferenceDrag(transfer)).toEqual(reference);
    expect(transfer.effectAllowed).toBe("copy");
  });

  it("deduplicates references by kind and id", () => {
    const first = { kind: "path" as const, id: "paper.pdf", label: "paper.pdf" };
    const folder = { kind: "path" as const, id: "研究资料", label: "研究资料/" };

    expect(mergeComposerContextReferences([first], [first, folder])).toEqual([first, folder]);
  });

  it("collapses a directory selection into one folder reference", () => {
    const file = new File(["paper"], "paper.pdf");
    Object.defineProperty(file, "webkitRelativePath", { value: "Papers/2026/paper.pdf" });

    expect(composerFolderReferenceFromFiles(
      [file],
      () => "/Users/memmy/Papers/2026/paper.pdf"
    )).toEqual({
      kind: "path",
      id: "/Users/memmy/Papers",
      label: "Papers/"
    });
  });

  it.each([
    ["/Users/memmy/研究资料", "/Users/memmy/研究资料"],
    ["C:\\Users\\memmy\\研究资料", "C:/Users/memmy/研究资料"]
  ])("keeps the full path of a directly dropped folder: %s", (path, expected) => {
    expect(composerFolderReferenceFromFiles([new File([], "研究资料")], () => path)).toEqual({
      kind: "path", id: expected, label: "研究资料/"
    });
  });

  it("separates directories from attachments without reading directory contents", () => {
    const folder = new File([], "Papers.pdf");
    const itemFolder = new File([], "Papers.pdf");
    const file = new File(["paper"], "paper.pdf");
    expect(partitionComposerDropFiles({
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => itemFolder, webkitGetAsEntry: () => ({ isDirectory: true }) },
        { kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false }) }
      ],
      files: [folder, file]
    })).toEqual({ files: [file], folders: [itemFolder] });
  });

  it("uses FileList when a directory item does not expose getAsFile", () => {
    const folder = new File([], "Empty folder");
    expect(partitionComposerDropFiles({
      items: [{ kind: "file", getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true }) }],
      files: [folder]
    })).toEqual({ files: [], folders: [folder] });
    expect(() => partitionComposerDropFiles({
      items: [{ kind: "file", getAsFile: () => null, webkitGetAsEntry: () => ({ isDirectory: true }) }]
    })).toThrow("home.media.error.sendReadFailed");
  });

  it("keeps files and directories interleaved in drag-store order", () => {
    const files = [new File(["a"], "a.txt"), new File([], "Folder"), new File(["b"], "b.txt")];
    expect(composerDropEntriesFromDataTransfer({
      files,
      items: files.map((file, index) => ({
        kind: "file",
        getAsFile: () => index === 1 ? null : file,
        webkitGetAsEntry: () => ({ isDirectory: index === 1 })
      }))
    })).toEqual([
      { kind: "file", file: files[0] },
      { kind: "folder", file: files[1] },
      { kind: "file", file: files[2] }
    ]);
  });

  it("includes quoted folder paths in ordinary messages and folder-only messages", () => {
    const references = [{ kind: "path" as const, id: '/Users/memmy/研究 "资料"', label: '研究 "资料"/' }];
    const path = JSON.stringify(references[0]!.id);
    expect(appendComposerContextReferences("Summarize this folder", references)).toBe(`Summarize this folder\n\n${path}`);
    expect(appendComposerContextReferences("", references)).toBe(path);
    expect(appendComposerContextReferences("Unchanged\n", [])).toBe("Unchanged\n");
  });
});
