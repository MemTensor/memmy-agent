import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseCjkFonts, selectCjkFont } from "../src/cjk-fonts.mjs";
import { writeMetadataCollection, writeMetadataFont } from "./helpers/cjk-font-fixture.mjs";
import fontFilesystem from "node:fs/promises";

async function directory(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "office-cjk-font-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("CJK selection reads cmap coverage instead of trusting a font family label", async t => {
  const root = await directory(t);
  const latin = await writeMetadataFont(join(root, "latin.ttf"), "CJK Font In Name Only", "Latin");
  const partial = await writeMetadataFont(join(root, "partial.ttf"), "Partial Han", "中");
  const complete = await writeMetadataFont(join(root, "complete.ttf"), "Complete Han", "中文");
  const selected = await selectCjkFont("English 中文", JSON.stringify([latin, partial, complete]));
  assert.equal(selected.familyName, "Complete Han");
  assert.equal(selected.path, complete);
  await assert.rejects(selectCjkFont("中文", JSON.stringify([latin, partial])), { code: "office_cjk_font_missing" });
});

test("a collection face must cover all source Han, including supplementary code points", async t => {
  const root = await directory(t), han = "中文\u{20000}";
  const collection = await writeMetadataCollection(join(root, "faces.ttc"), [["Partial Face", "中文"], ["Complete Face", han]]);
  assert.equal((await selectCjkFont(han, JSON.stringify([collection]))).familyName, "Complete Face");
  const left = await writeMetadataFont(join(root, "left.ttf"), "Left", "中");
  const right = await writeMetadataFont(join(root, "right.ttf"), "Right", "文");
  await assert.rejects(selectCjkFont("中文", JSON.stringify([left, right])), { code: "office_cjk_font_missing" });
});

test("missing, invalid and unreadable fonts never establish Han coverage", async t => {
  const root = await directory(t), corrupt = join(root, "corrupt.ttf"); await writeFile(corrupt, "invalid font bytes");
  const valid = await writeMetadataFont(join(root, "valid.ttf"), "Valid Han", "中文");
  await assert.rejects(selectCjkFont("中文"), { code: "office_cjk_font_missing" });
  await assert.rejects(selectCjkFont("中文", JSON.stringify([join(root, "missing.ttf"), corrupt])), { code: "office_cjk_font_missing" });
  assert.equal((await selectCjkFont("中文", JSON.stringify([corrupt, valid]))).familyName, "Valid Han");
});

test("Host font configuration rejects relative, noncanonical and oversized entries", async t => {
  const root = await directory(t), font = await writeMetadataFont(join(root, "valid.ttf"), "Valid Han", "中文");
  const link = join(root, "link.ttf"); await symlink(font, link);
  const oversized = join(root, "oversized.ttf"), handle = await open(oversized, "wx");
  await handle.truncate(256 * 1024 * 1024 + 1); await handle.close();
  for (const value of ["invalid JSON", "{}", JSON.stringify(["relative.ttf"]), JSON.stringify(Array(17).fill(font)), JSON.stringify([link]), JSON.stringify([root]), JSON.stringify([oversized])]) {
    await assert.rejects(selectCjkFont("中文", value), { code: "office_cjk_font_configuration_invalid" });
  }
});

test("non-Han creation does not require or inspect a CJK font configuration", async () => {
  assert.equal(await selectCjkFont("Plain Latin text", "invalid JSON"), null);
});

test("Windows Host-approved fonts remain usable when Mount Manager realpath is denied", async t => {
  const root = await directory(t), file = await writeMetadataFont(join(root, "host-font.ttf"), "Owned Windows Han", "中文");
  const native = t.mock.method(fontFilesystem, "realpath", async () => { throw Object.assign(new Error("owned Mount Manager denial"), { code: "EPERM" }); });
  const selected = await selectCjkFont("中文", JSON.stringify([file]), "win32");
  assert.equal(selected.familyName, "Owned Windows Han");
  assert.equal(native.mock.calls.length, 0, "the Windows child must not query Mount Manager");
});

test("Windows exact-file validation rejects leaf and direct-parent links and unnormalized paths", async t => {
  const root = await directory(t), file = await writeMetadataFont(join(root, "font.ttf"), "Owned Han", "中文");
  const leaf = join(root, "leaf.ttf"), parent = join(root, "parent");
  await symlink(file, leaf); await symlink(root, parent, process.platform === "win32" ? "junction" : "dir");
  for (const path of [leaf, join(parent, "font.ttf"), root + "/./font.ttf"]) {
    await assert.rejects(selectCjkFont("中文", JSON.stringify([path]), "win32"), { code: "office_cjk_font_configuration_invalid" });
  }
});

test("non-Windows validation still rejects a native realpath denial", async t => {
  const root = await directory(t), file = await writeMetadataFont(join(root, "font.ttf"), "Owned Han", "中文");
  const native = t.mock.method(fontFilesystem, "realpath", async () => { throw Object.assign(new Error("owned native denial"), { code: "EPERM" }); });
  await assert.rejects(selectCjkFont("中文", JSON.stringify([file]), "darwin"), { code: "office_cjk_font_missing" });
  assert.equal(native.mock.calls.length, 1);
});

test("font diagnostics separate operation errors and cmap coverage without paths or source text", async t => {
  const root = await directory(t), file = await writeMetadataFont(join(root, "private-name.ttf"), "Do Not Log Family", "中文内容文档生成预览与交付");
  t.mock.method(fontFilesystem, "realpath", async () => { throw Object.assign(new Error("must not log private path " + file), { code: "EPERM" }); });
  const report = await diagnoseCjkFonts(JSON.stringify([file]));
  assert.equal(report.hostFileCount, 1);
  assert.equal(report.files[0].lstat.ok, true);
  assert.deepEqual(report.files[0].realpath, { ok: false, errno: "EPERM" });
  assert.deepEqual(report.files[0].open, { ok: true });
  assert.equal(report.files[0].cmap.coveringFaces, 1);
  assert.equal(report.files[0].cmap.bestCoverage, report.probeCodePointCount);
  const text = JSON.stringify(report);
  for (const forbidden of [file, root, "Do Not Log Family", "中文", "private path"]) assert.equal(text.includes(forbidden), false);
  assert.equal((await diagnoseCjkFonts("invalid JSON")).hostListValid, false);
});
