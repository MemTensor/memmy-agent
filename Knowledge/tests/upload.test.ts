// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import {
  fileRelativePath,
  folderSegments,
  isAbortError,
  isJunkUpload,
  resolveFolderId,
  summarizeUploads,
  uploadDocuments,
} from "../src/ui/upload.js";
import { MAX_UPLOAD_BYTES } from "../src/types.js";

it("uploads every selected file sequentially and continues after an individual failure", async () => {
  const files = [
    new File(["first"], "first.txt"),
    new File(["second"], "second.md"),
    new File(["third"], "third.pdf"),
  ];
  let active = 0;
  let peak = 0;
  const upload = vi.fn(async (file: File) => {
    active++;
    peak = Math.max(peak, active);
    expect(file.size).toBeGreaterThan(0);
    await Promise.resolve();
    active--;
    if (file.name === "second.md") throw new Error("服务暂时不可用");
  });
  const progress = vi.fn();
  const { results, stopped } = await uploadDocuments(files, upload, progress);
  expect(stopped).toBe(false);
  expect(upload.mock.calls.map(([file]) => file.name)).toEqual(
    files.map((file) => file.name),
  );
  expect(peak).toBe(1);
  expect(results).toEqual([
    { name: "first.txt", ok: true, bytes: 5 },
    {
      name: "second.md",
      ok: false,
      error: "服务暂时不可用",
      reason: "other",
      bytes: 6,
    },
    { name: "third.pdf", ok: true, bytes: 5 },
  ]);
  expect(progress.mock.calls).toEqual([
    [0, 3, "first.txt"],
    [1, 3, "second.md"],
    [2, 3, "third.pdf"],
  ]);
});

it("checks size and format for each file without blocking valid files in the batch", async () => {
  const oversized = new File(["large"], "large.pdf");
  Object.defineProperty(oversized, "size", { value: MAX_UPLOAD_BYTES + 1 });
  const upload = vi.fn(async () => undefined);
  const { results } = await uploadDocuments(
    [
      new File([], "empty.txt"),
      oversized,
      new File(["app"], "app.exe"),
      new File(["ok"], "valid.txt"),
    ],
    upload,
    () => {},
  );
  expect(upload).toHaveBeenCalledTimes(1);
  expect(results.map((result) => result.ok)).toEqual([
    false,
    false,
    false,
    true,
  ]);
  expect(results[1]!.error).toContain("100 MB");
  expect(summarizeUploads(results)).toMatchObject({
    succeeded: 1,
    failed: 3,
    format: 1,
    size: 2,
    other: 0,
  });
});

it("does nothing when the file picker is cancelled", async () => {
  const upload = vi.fn();
  const progress = vi.fn();
  expect(await uploadDocuments([], upload, progress)).toEqual({
    results: [],
    stopped: false,
  });
  expect(upload).not.toHaveBeenCalled();
  expect(progress).not.toHaveBeenCalled();
});

it("stops the remaining files when the batch is aborted", async () => {
  const controller = new AbortController();
  const upload = vi.fn(async (file: File) => {
    if (file.name === "first.txt") controller.abort();
  });
  const { results, stopped } = await uploadDocuments(
    [
      new File(["first"], "first.txt"),
      new File(["second"], "second.md"),
    ],
    upload,
    () => {},
    true,
    controller.signal,
  );
  expect(stopped).toBe(true);
  expect(results).toEqual([{ name: "first.txt", ok: true, bytes: 5 }]);
  expect(upload).toHaveBeenCalledTimes(1);
});

it("reads folder segments from the browser relative path and skips junk files", () => {
  const nested = new File(["ok"], "readme.md");
  Object.defineProperty(nested, "webkitRelativePath", {
    value: "docs/api/readme.md",
  });
  expect(fileRelativePath(nested)).toBe("docs/api/readme.md");
  expect(folderSegments("docs/api/readme.md")).toEqual(["docs", "api"]);
  expect(isJunkUpload("docs/.DS_Store")).toBe(true);
  expect(isJunkUpload("__MACOSX/foo.txt")).toBe(true);
  expect(isJunkUpload("docs/readme.md")).toBe(false);
});

it("treats aborted fetches as abort errors", () => {
  expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true);
  expect(isAbortError(new Error("The user aborted a request."))).toBe(true);
  expect(isAbortError(new Error("知识库文件暂时无法加载，请稍后重试。"))).toBe(
    false,
  );
});

it("reuses existing folders when restoring a relative path", async () => {
  const created: string[] = [];
  const id = await resolveFolderId(
    ["docs", "api"],
    "",
    (parentId, name) =>
      parentId === "" && name === "docs" ? "folder-docs" : undefined,
    async (parentId, name) => {
      const next = `${parentId}:${name}`;
      created.push(next);
      return next;
    },
  );
  expect(id).toBe("folder-docs:api");
  expect(created).toEqual(["folder-docs:api"]);
});
