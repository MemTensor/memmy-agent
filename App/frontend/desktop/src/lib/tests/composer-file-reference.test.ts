import { describe, expect, it } from "vitest";
import {
  MEMMY_COMPOSER_REFERENCE_MIME,
  mergeComposerContextReferences,
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
    const base = { kind: "kb" as const, id: "kb-1", label: "研究资料" };

    expect(mergeComposerContextReferences([first], [first, base])).toEqual([first, base]);
  });
});
