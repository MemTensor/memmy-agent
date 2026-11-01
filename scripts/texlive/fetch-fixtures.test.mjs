import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { fetchFixtures } from "./fetch-fixtures.mjs";

const hash = data => createHash("sha256").update(data).digest("hex");
async function bundle(contents) {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(contents)) zip.file(name, text, { createFolders: false });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
function pin(buffer, contents) {
  return { format: "memmy-texlive-brand-fixtures-v1", version: "test-1",
    archive: { url: "https://fixtures.test.invalid/pinned.zip", bytes: buffer.length, sha256: hash(buffer) },
    files: Object.fromEntries(Object.entries(contents).map(([name, text]) => [name, hash(text)])) };
}
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "texlive-fixtures-test-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
test("extracts exactly the hash-verified files and refuses an existing output", async t => {
  const root = await workspace(t), contents = { "zh-CN/review.tex": "中文", "en/review.tex": "English" };
  const bytes = await bundle(contents), lock = pin(bytes, contents);
  const fetchFn = async (url, options) => { assert.equal(url.href, lock.archive.url); assert.equal(options.redirect, "error"); return new Response(bytes); };
  const result = await fetchFixtures(join(root, "out"), { lock, fetchFn });
  assert.equal(result.files, 2); assert.equal(await readFile(join(root, "out/zh-CN/review.tex"), "utf8"), "中文");
  await assert.rejects(fetchFixtures(join(root, "out"), { lock, fetchFn }));
});
test("rejects archive tampering before any extraction", async t => {
  const root = await workspace(t), contents = { "en/review.tex": "original" }, bytes = await bundle(contents);
  const tampered = Buffer.from(bytes); tampered[10] ^= 1;
  await assert.rejects(fetchFixtures(join(root, "out"), { lock: pin(bytes, contents), fetchFn: async () => new Response(tampered) }), /integrity/);
  assert.deepEqual(await readdir(root), []);
});
test("rejects oversized downloads, mismatched file hashes and extra archive entries", async t => {
  const root = await workspace(t), contents = { "en/review.tex": "original" }, bytes = await bundle(contents);
  await assert.rejects(fetchFixtures(join(root, "out"), { lock: pin(bytes, contents), fetchFn: async () => new Response(Buffer.concat([bytes, Buffer.from("extra")])) }), /size mismatch/);
  const lock = pin(bytes, contents); lock.files["en/review.tex"] = "0".repeat(64);
  await assert.rejects(fetchFixtures(join(root, "out"), { lock, fetchFn: async () => new Response(bytes) }), /file integrity/);
  const extra = await bundle({ ...contents, "extra.txt": "unexpected" });
  await assert.rejects(fetchFixtures(join(root, "out"), { lock: pin(extra, contents), fetchFn: async () => new Response(extra) }), /file set mismatch/);
  assert.deepEqual(await readdir(root), []);
});
test("rejects ZIP traversal names even when JSZip normalizes them", async t => {
  const root = await workspace(t), bytes = await bundle({ "../escape.txt": "bad" });
  const lock = pin(bytes, { "escape.txt": "bad" });
  await assert.rejects(fetchFixtures(join(root, "out"), { lock, fetchFn: async () => new Response(bytes) }), /Unexpected fixture/);
  assert.deepEqual(await readdir(root), []);
});
