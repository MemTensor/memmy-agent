import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { collectThirdPartyNotices } from "../scripts/third-party-notices.mjs";

const root = resolve(import.meta.dirname, "..");

test("built fontkit notices preserve the upstream declaration and a distinct SPDX reference", async () => {
  const notices = await readFile(resolve(root, "dist/THIRD-PARTY-NOTICES.txt"), "utf8");
  const block = notices.split("--- fontkit@2.0.4 (MIT) ---")[1]?.split(/\n--- [^\n]+@/)[0] ?? "";
  assert.match(block, /Upstream declaration \(fontkit@2\.0\.4\)/);
  assert.match(block, /author metadata only; not a copyright notice/);
  assert.match(block, /SPDX MIT standard terms reference/);
  assert.match(block, /Copyright \(c\) <year> <copyright holders>/);
  assert.match(block, /not an upstream LICENSE file/);
  assert.match(block, /Human review remains required/);
});

async function fixture(t, withFontkit = false) {
  const target = await mkdtemp(join(tmpdir(), "office-notices-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  await mkdir(join(target, "licenses"));
  const packages = {};
  if (withFontkit) {
    await cp(resolve(root, "licenses"), join(target, "licenses"), { recursive: true });
    const source = resolve(root, "node_modules/fontkit"), installed = join(target, "node_modules/fontkit");
    await mkdir(installed, { recursive: true });
    for (const file of ["package.json", "README.md"]) await cp(join(source, file), join(installed, file));
    const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
    packages["node_modules/fontkit"] = lock.packages["node_modules/fontkit"];
  } else {
    await writeFile(join(target, "licenses/supplements.json"), JSON.stringify({ schemaVersion: 1, supplements: [] }));
  }
  await writeFile(join(target, "package-lock.json"), JSON.stringify({ packages }));
  return target;
}

test("collector retains common publisher filename variants and unknown declarations without guessing", async t => {
  const target = await fixture(t), installed = join(target, "node_modules/fixture-publisher");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "package.json"), JSON.stringify({ name: "fixture-publisher", version: "1.0.0", license: "LicenseRef-Publisher-Only" }));
  const declarations = { "LICENSE.markdown": "Publisher markdown terms, unchanged.", "LICENCE.txt": "Publisher alternative spelling, unchanged.", "LICENCE-MIT.md": "Publisher named license file, unchanged.", "COPYRIGHT": "Publisher supplied rights statement, unchanged." };
  for (const [file, text] of Object.entries(declarations)) await writeFile(join(installed, file), text);
  await writeFile(join(installed, "license-helper.js"), "This is implementation code, not a notice.");
  await writeFile(join(target, "package-lock.json"), JSON.stringify({ packages: { "node_modules/fixture-publisher": { version: "1.0.0" } } }));
  const notices = await collectThirdPartyNotices(target);
  for (const [file, text] of Object.entries(declarations)) { assert.ok(notices.includes(`Publisher file: ${file}`)); assert.ok(notices.includes(text)); }
  assert.match(notices, /LicenseRef-Publisher-Only/);
  assert.doesNotMatch(notices, /Permission is hereby granted|implementation code/);
});

test("publisher files remain intact beside the explicitly separate supplement", async t => {
  const target = await fixture(t, true), publisher = "Original publisher file retained verbatim.\n";
  await writeFile(join(target, "node_modules/fontkit/LICENSE.markdown"), publisher);
  const notices = await collectThirdPartyNotices(target);
  assert.ok(notices.includes(publisher));
  assert.match(notices, /Upstream declaration \(fontkit@2\.0\.4\)/);
  assert.match(notices, /SPDX MIT standard terms reference/);
});

test("a changed supplement source fails its pinned hash check", async t => {
  const target = await fixture(t, true);
  await appendFile(join(target, "licenses/fontkit-2.0.4/NOTICE-SUPPLEMENT.txt"), "changed");
  await assert.rejects(collectThirdPartyNotices(target), /supplement hash mismatch/);
});

test("package version and tarball integrity must match the pinned supplement", async t => {
  for (const change of ["version", "integrity"]) {
    const target = await fixture(t, true), file = join(target, "package-lock.json");
    const lock = JSON.parse(await readFile(file, "utf8"));
    if (change === "version") {
      lock.packages["node_modules/fontkit"].version = "2.0.5";
      const installed = join(target, "node_modules/fontkit/package.json"), info = JSON.parse(await readFile(installed, "utf8"));
      info.version = "2.0.5"; await writeFile(installed, JSON.stringify(info));
    } else lock.packages["node_modules/fontkit"].integrity = "sha512-unverified";
    await writeFile(file, JSON.stringify(lock));
    await assert.rejects(collectThirdPartyNotices(target), /supplement package identity mismatch/);
  }
});

test("installed upstream declarations and the required supplement cannot silently drift", async t => {
  const changed = await fixture(t, true);
  await appendFile(join(changed, "node_modules/fontkit/README.md"), "changed");
  await assert.rejects(collectThirdPartyNotices(changed), /installed source hash mismatch/);
  const missing = await fixture(t, true);
  await writeFile(join(missing, "licenses/supplements.json"), JSON.stringify({ schemaVersion: 1, supplements: [] }));
  await assert.rejects(collectThirdPartyNotices(missing), /pinned fontkit notice supplement is required/);
});

test("supplement file paths cannot escape their checked source root", async t => {
  const target = await fixture(t, true), file = join(target, "licenses/supplements.json");
  const registry = JSON.parse(await readFile(file, "utf8"));
  registry.supplements[0].files[0].path = "../outside.txt";
  await writeFile(file, JSON.stringify(registry));
  await assert.rejects(collectThirdPartyNotices(target), /Invalid notice source path/);
});

test("autocrlf checkout preserves pinned notice bytes and collector verification", async t => {
  const repository = await mkdtemp(join(tmpdir(), "office-notice-checkout-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const office = join(repository, "plugins/office");
  await mkdir(office, { recursive: true });
  await cp(resolve(root, "licenses"), join(office, "licenses"), { recursive: true });
  const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
  await writeFile(join(office, "package-lock.json"), JSON.stringify({ packages: { "node_modules/fontkit": lock.packages["node_modules/fontkit"] } }));
  const attributes = await readFile(resolve(root, "../../.gitattributes")).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (attributes) await writeFile(join(repository, ".gitattributes"), attributes);
  const git = (...args) => execFileSync("git", ["-C", repository, ...args], { stdio: "pipe", timeout: 10000 });
  git("init", "--quiet");
  git("config", "--local", "core.autocrlf", "false");
  git("add", ".");
  git("-c", "user.name=Office notice checkout fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Owned notice checkout fixture");
  // Removing only the owned source fixture forces a real working-tree checkout.
  await rm(join(repository, "plugins"), { recursive: true });
  git("config", "--local", "core.autocrlf", "true");
  git("checkout", "HEAD", "--", "plugins/office");
  // npm tarballs retain publisher bytes independently of Git's text conversion.
  const installed = join(office, "node_modules/fontkit");
  await mkdir(installed, { recursive: true });
  for (const file of ["package.json", "README.md"]) await cp(resolve(root, "node_modules/fontkit", file), join(installed, file));
  assert.match(await collectThirdPartyNotices(office), /SPDX MIT standard terms reference/);
  const registry = JSON.parse(await readFile(resolve(root, "licenses/supplements.json"), "utf8"));
  for (const file of registry.supplements[0].files) {
    assert.deepEqual(await readFile(join(office, "licenses", file.path)), await readFile(resolve(root, "licenses", file.path)));
  }
});
