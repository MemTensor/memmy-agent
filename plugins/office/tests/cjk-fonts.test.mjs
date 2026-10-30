import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectCjkFont } from "../src/cjk-fonts.mjs";
import { writeMetadataCollection, writeMetadataFont } from "./helpers/cjk-font-fixture.mjs";

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
