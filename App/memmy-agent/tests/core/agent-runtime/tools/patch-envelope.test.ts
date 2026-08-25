import { describe, expect, it } from "vitest";
import {
  PatchError,
  normalizePatchPath,
  parsePatchEnvelope,
  scanPatchEnvelopePrefix,
} from "../../../../src/core/agent-runtime/tools/patch-envelope.js";

describe("patch envelope parser", () => {
  it("parses mixed add, update, delete, and move operations", () => {
    const operations = parsePatchEnvelope([
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const value = 1;",
      "*** Update File: src/old.ts",
      "*** Move to: src/moved.ts",
      "@@ export function value() {",
      "-  return 1;",
      "+  return 2;",
      " }",
      "*** Delete File: src/dead.ts",
      "*** End Patch",
    ].join("\n"));

    expect(operations).toEqual([
      { kind: "add", path: "src/new.ts", line: 2, lines: ["export const value = 1;"] },
      {
        kind: "update",
        path: "src/old.ts",
        line: 4,
        moveTo: "src/moved.ts",
        moveLine: 5,
        hunks: [{
          line: 6,
          anchor: "export function value() {",
          lines: [
            { kind: "remove", text: "  return 1;" },
            { kind: "add", text: "  return 2;" },
            { kind: "context", text: "}" },
          ],
          endOfFile: false,
        }],
      },
      { kind: "delete", path: "src/dead.ts", line: 10 },
    ]);
  });

  it("accepts empty Add File, pure move, bare hunk headers, EOF appends, and one final newline", () => {
    expect(parsePatchEnvelope("*** Begin Patch\n*** Add File: empty.txt\n*** End Patch\n")[0]).toMatchObject({
      kind: "add",
      lines: [],
    });
    expect(parsePatchEnvelope([
      "*** Begin Patch",
      "*** Update File: old.txt",
      "*** Move to: new.txt",
      "*** End Patch",
    ].join("\n"))[0]).toMatchObject({ kind: "update", moveTo: "new.txt", hunks: [] });
    expect(parsePatchEnvelope([
      "*** Begin Patch",
      "*** Update File: old.txt",
      "@@",
      "+appended",
      "*** End of File",
      "*** End Patch",
    ].join("\n"))[0]).toMatchObject({
      kind: "update",
      hunks: [{ anchor: null, endOfFile: true }],
    });
  });

  it("normalizes CRLF and CR input", () => {
    const crlf = "*** Begin Patch\r\n*** Add File: a.txt\r\n+x\r\n*** End Patch";
    const cr = "*** Begin Patch\r*** Delete File: a.txt\r*** End Patch";
    expect(parsePatchEnvelope(crlf)[0]).toMatchObject({ kind: "add", lines: ["x"] });
    expect(parsePatchEnvelope(cr)[0]).toMatchObject({ kind: "delete", path: "a.txt" });
  });

  it.each([
    ["missing envelope", "*** Add File: a\n+x", "expected *** Begin Patch"],
    ["empty patch", "*** Begin Patch\n*** End Patch", "at least one file operation"],
    ["extra final newline", "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\n\n", "only one final newline"],
    ["unknown line", "*** Begin Patch\nnope\n*** End Patch", "file operation header"],
    ["delete body", "*** Begin Patch\n*** Delete File: a\n-old\n*** End Patch", "cannot contain a body"],
    ["late move", "*** Begin Patch\n*** Update File: a\n@@\n-old\n+new\n*** Move to: b\n*** End Patch", "before the first hunk"],
    ["empty hunk", "*** Begin Patch\n*** Update File: a\n@@\n@@\n-old\n+new\n*** End Patch", "must add or remove"],
    ["context-only hunk", "*** Begin Patch\n*** Update File: a\n@@\n same\n*** End Patch", "must add or remove"],
    ["unlocated insert", "*** Begin Patch\n*** Update File: a\n@@\n+new\n*** End Patch", "must end with *** End of File"],
    ["empty anchor", "*** Begin Patch\n*** Update File: a\n@@ \n-old\n+new\n*** End Patch", "invalid hunk anchor"],
    ["section hunk", "*** Begin Patch\n*** Update File: a\n@@ value @@\n-old\n+new\n*** End Patch", "invalid hunk anchor"],
  ])("rejects %s", (_name, input, message) => {
    expect(() => parsePatchEnvelope(input)).toThrow(message);
  });

  it("rejects duplicate and conflicting paths", () => {
    expect(() => parsePatchEnvelope([
      "*** Begin Patch",
      "*** Add File: a",
      "*** Delete File: ./a",
      "*** End Patch",
    ].join("\n"))).toThrow("duplicate file operation path");
    expect(() => parsePatchEnvelope([
      "*** Begin Patch",
      "*** Update File: old",
      "*** Move to: target",
      "*** Delete File: target",
      "*** End Patch",
    ].join("\n"))).toThrow("move target");
    expect(() => parsePatchEnvelope([
      "*** Begin Patch",
      "*** Add File: a",
      "*** Add File: a/b",
      "*** End Patch",
    ].join("\n"))).toThrow("file targets conflict");
  });

  it("limits patches to twenty file operations", () => {
    const files = Array.from({ length: 21 }, (_, index) => `*** Add File: ${index}.txt`);
    expect(() => parsePatchEnvelope(["*** Begin Patch", ...files, "*** End Patch"].join("\n"))).toThrow(
      "at most 20 file operations",
    );
  });

  it.each(["~/a", "/a", "\\a", "C:a", "C:\\a", "../a", "a/../b", "a\0b"])(
    "rejects unsafe path %s",
    (unsafe) => expect(() => normalizePatchPath(unsafe)).toThrow(PatchError),
  );

  it("normalizes separators, empty segments, and dot segments", () => {
    expect(normalizePatchPath(" ./src\\nested//./file.ts ")).toBe("src/nested/file.ts");
  });
});

describe("patch envelope prefix scanner", () => {
  it("returns only complete file headers and body lines", () => {
    const files = scanPatchEnvelopePrefix([
      "*** Begin Patch",
      "*** Add File: a.txt",
      "+one",
      "*** Update File: old.txt",
      "*** Move to: new.txt",
      "@@",
      "-old",
      "+new",
      "*** Delete File: dea",
    ].join("\n"));

    expect(files).toEqual([
      { kind: "add", path: "a.txt", moveTo: null, added: 1, deleted: 0 },
      { kind: "update", path: "old.txt", moveTo: "new.txt", added: 1, deleted: 1 },
    ]);
  });

  it("waits for a complete begin line and does not treat body text as control lines", () => {
    expect(scanPatchEnvelopePrefix("*** Begin Pat")).toEqual([]);
    expect(scanPatchEnvelopePrefix("*** Begin Patch\n*** Add File: a\n+*** Update File: fake\n")).toEqual([
      { kind: "add", path: "a", moveTo: null, added: 1, deleted: 0 },
    ]);
  });

  it("stops at the first complete invalid line", () => {
    expect(scanPatchEnvelopePrefix([
      "*** Begin Patch",
      "*** Add File: first",
      "+ok",
      "invalid",
      "*** Add File: ignored",
      "+ignored",
      "",
    ].join("\n"))).toEqual([
      { kind: "add", path: "first", moveTo: null, added: 1, deleted: 0 },
    ]);
  });
});
