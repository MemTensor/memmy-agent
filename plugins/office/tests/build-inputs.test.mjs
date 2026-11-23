import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInputCacheKey, downloadPinnedInput, pinnedBuildInputs } from "../scripts/office-build-inputs.mjs";

const bytes = Buffer.from("verified Office build input");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const fixture = { filename: "input.dmg", sha256, urls: ["https://first.test.invalid/input", "https://second.test.invalid/input"] };
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "office-build-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("retired macOS inputs retain both original hashes and use the exact immutable archive build", () => {
  for (const [arch, folder, suffix, expected] of [
    ["arm64", "aarch64", "aarch64", "ca074e0b13571efb30a31fc531c5f95e997030637325e5d5de92d67aefdf0dfc"],
    ["x64", "x86_64", "x86-64", "4c7464313a529e9074400cbcdc894fc40ac4ef9421ded03b16b5a78d12cb155e"],
  ]) {
    const input = pinnedBuildInputs("darwin", arch).libreoffice;
    assert.equal(input.version, "26.8.1"); assert.equal(input.buildVersion, "26.8.1.1"); assert.equal(input.sha256, expected);
    assert.equal(input.urls[0], "https://downloadarchive.documentfoundation.org/libreoffice/old/26.8.1.1/mac/" + folder + "/LibreOffice_26.8.1.1_MacOS_" + suffix + ".dmg");
  }
  assert.throws(() => pinnedBuildInputs("darwin", "arm"), /Unsupported/);
});

test("Windows inputs pin one maintenance build and keep the verified Poppler digest", () => {
  const inputs = pinnedBuildInputs("win32", "x64");
  assert.equal(inputs.libreoffice.buildVersion, "26.2.7.3");
  assert.equal(inputs.libreoffice.sha256, "480fecf759fc6393bd614fbf43753eb95a8198fc1a065d41b727e3b664cd1e59");
  assert.equal(inputs.poppler.sha256, "7a6f256a0ddf7536182246a5733331bf4677cbcc34f4663774947ad34556c8d0");
  assert.throws(() => pinnedBuildInputs("win32", "arm64"), /Unsupported/);
  assert.notEqual(buildInputCacheKey("darwin", "arm64"), buildInputCacheKey("darwin", "x64"));
  assert.notEqual(buildInputCacheKey("win32", "x64"), buildInputCacheKey("darwin", "x64"));
});

test("only a fully verified download is published, and a failed mirror leaves no partial input", async t => {
  const root = await directory(t), attempts = [], warnings = [];
  const output = await downloadPinnedInput(fixture, root, {
    fetchFile: async (url, target) => {
      attempts.push(url); await writeFile(target, attempts.length === 1 ? "wrong bytes" : bytes);
      assert.equal((await readdir(root)).some(file => file === fixture.filename), false);
    },
    warn: message => warnings.push(message),
  });
  assert.deepEqual(attempts, fixture.urls); assert.equal(warnings.length, 1);
  assert.deepEqual(await readFile(output), bytes);
  assert.deepEqual(await readdir(root), [fixture.filename]);
});

test("a valid cache is rehashed and a corrupted cache is never accepted as a hit", async t => {
  const root = await directory(t), target = join(root, fixture.filename);
  await writeFile(target, bytes);
  await downloadPinnedInput(fixture, root, { fetchFile: async () => assert.fail("verified cache must not download") });
  await writeFile(target, "corrupted after cache restoration");
  let downloads = 0;
  await downloadPinnedInput(fixture, root, { fetchFile: async (_url, file) => { downloads++; await writeFile(file, bytes); } });
  assert.equal(downloads, 1); assert.deepEqual(await readFile(target), bytes);
});

test("transport failures and invalid content fail closed without leaving files to install", async t => {
  const root = await directory(t);
  await assert.rejects(downloadPinnedInput(fixture, root, {
    fetchFile: async (url, target) => {
      await writeFile(target, "partial transfer");
      if (url === fixture.urls[0]) throw new Error("download deadline reached");
    }, warn: () => {},
  }), /No verified Office build input/);
  assert.deepEqual(await readdir(root), []);
});

test("unsafe cache filenames, digests and transport URLs are rejected before downloading", async t => {
  const root = await directory(t);
  for (const input of [{ ...fixture, filename: "../input.dmg" }, { ...fixture, sha256: "not-a-digest" },
    { ...fixture, urls: ["http://input.test.invalid/unchecked"] }, { ...fixture, urls: ["https://user:password@input.test.invalid/input"] }]) {
    await assert.rejects(downloadPinnedInput(input, root, { fetchFile: async () => assert.fail("invalid input must not download") }));
  }
  assert.deepEqual(await readdir(root), []);
});
