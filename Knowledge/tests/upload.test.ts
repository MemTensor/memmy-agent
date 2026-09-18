// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { uploadDocuments } from "../src/ui/upload.js";
import { MAX_UPLOAD_BYTES } from "../src/types.js";

it("uploads every selected file sequentially and continues after an individual failure", async () => {
  const files = [
    new File(["first"], "first.txt"),
    new File(["second"], "second.md"),
    new File(["third"], "third.pdf"),
  ];
  let active = 0;
  let peak = 0;
  const upload = vi.fn(async (file: File, content: string) => {
    active++;
    peak = Math.max(peak, active);
    expect(atob(content)).toBe(file.name.split(".")[0]);
    await Promise.resolve();
    active--;
    if (file.name === "second.md") throw new Error("服务暂时不可用");
  });
  const progress = vi.fn();
  const results = await uploadDocuments(files, upload, progress);
  expect(upload.mock.calls.map(([file]) => file.name)).toEqual(
    files.map((file) => file.name),
  );
  expect(peak).toBe(1);
  expect(results).toEqual([
    { name: "first.txt", ok: true },
    { name: "second.md", ok: false, error: "服务暂时不可用" },
    { name: "third.pdf", ok: true },
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
  const results = await uploadDocuments(
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
  expect(results[1]!.error).toContain("20 MB");
});

it("does nothing when the file picker is cancelled", async () => {
  const upload = vi.fn();
  const progress = vi.fn();
  expect(await uploadDocuments([], upload, progress)).toEqual([]);
  expect(upload).not.toHaveBeenCalled();
  expect(progress).not.toHaveBeenCalled();
});
