import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { checkReleaseSource, runGit, selectReleaseSourcePairs, sourceBranchFor } from "../scripts/check-release-source.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const script = fileURLToPath(new URL("../scripts/check-release-source.mjs", import.meta.url));

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function commit(cwd, name) {
  writeFileSync(join(cwd, name), `${name}\n`);
  git(cwd, "add", name);
  git(cwd, "commit", "-m", name);
  return git(cwd, "rev-parse", "HEAD");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "release-source-check-")); roots.push(root);
  const bare = join(root, "remote.git"), seed = join(root, "seed"), candidate = join(root, "candidate");
  git(root, "init", "--bare", bare);
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.name", "Release source fixture");
  git(seed, "config", "user.email", "release-source@example.invalid");
  commit(seed, "base.txt");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "checkout", "-b", "v1.2.6");
  const sourceSha = commit(seed, "source.txt");
  git(seed, "checkout", "-b", "release/v1.2.6", "main");
  commit(seed, "release.txt");
  git(seed, "push", "origin", "main", "v1.2.6", "release/v1.2.6");
  git(root, "clone", "--no-checkout", bare, candidate);
  git(candidate, "config", "user.name", "Release source fixture");
  git(candidate, "config", "user.email", "release-source@example.invalid");
  git(candidate, "checkout", "-b", "release/v1.2.6", "origin/release/v1.2.6");
  const options = { cwd: candidate, remote: "origin", releaseBranch: "release/v1.2.6", sourceSha };
  return { root, bare, seed, candidate, sourceSha, options,
    check: (overrides = {}, dependencies = {}) => checkReleaseSource({ ...options, ...overrides }, { allowLocalRemote: true, ...dependencies }),
    merge: () => git(candidate, "merge", "--no-edit", "origin/v1.2.6"),
    advanceSource() {
      git(seed, "checkout", "v1.2.6");
      const sha = commit(seed, "source-advanced.txt");
      git(seed, "push", "origin", "v1.2.6");
      return sha;
    }
  };
}

const codes = result => result.errors.map(error => error.code);

test("fails on unmerged source and reports actual missing commit facts", async () => {
  const f = fixture();
  const result = await f.check();
  assert.equal(result.passed, false);
  assert.equal(result.containsPinnedSource, false);
  assert.equal(result.missingSourceCommitCount, 1);
  assert.deepEqual(result.missingSourceCommitShas, [f.sourceSha]);
  assert.equal(result.remoteSourceBeforeSha, f.sourceSha);
  assert.ok(codes(result).includes("source_not_ancestor"));
});

test("passes a real merge and legitimate release-only fixes", async () => {
  const f = fixture(); f.merge(); commit(f.candidate, "release-only-extra.txt");
  const result = await f.check({ candidateSha: git(f.candidate, "rev-parse", "HEAD") });
  assert.equal(result.passed, true, JSON.stringify(result.errors));
  assert.equal(result.containsPinnedSource, true);
  assert.equal(result.missingSourceCommitCount, 0);
  assert.equal(result.candidateSha, result.candidateAfterSha);
});

test("rejects a remote source advance even if the pinned source was merged", async () => {
  const f = fixture(); f.merge();
  const advanced = f.advanceSource();
  const result = await f.check();
  assert.equal(result.passed, false);
  assert.equal(result.containsPinnedSource, true);
  assert.equal(result.remoteSourceBeforeSha, advanced);
  assert.ok(codes(result).includes("source_snapshot_mismatch"));
});

test("rejects the wrong candidate snapshot", async () => {
  const f = fixture(); f.merge();
  const result = await f.check({ candidateSha: f.sourceSha });
  assert.ok(codes(result).includes("candidate_snapshot_mismatch"));
});

test("fails closed on unknown source and unavailable pinned object", async () => {
  const f = fixture();
  git(f.candidate, "branch", "-m", "release/v1.2.7");
  const unknown = await f.check({ releaseBranch: "release/v1.2.7" });
  assert.ok(codes(unknown).includes("unknown_source"));
  const missing = await f.check({ releaseBranch: "release/v1.2.7", sourceSha: "c".repeat(40) });
  assert.ok(codes(missing).includes("source_object_missing"));
});

test("rejects a dirty candidate", async () => {
  const f = fixture(); f.merge(); writeFileSync(join(f.candidate, "untracked.txt"), "dirty");
  const result = await f.check();
  assert.ok(codes(result).includes("dirty_candidate"));
  assert.ok(codes(result).includes("dirty_candidate_after"));
});

test("rejects candidate HEAD changes during the real remote read", async () => {
  const f = fixture(); f.merge(); let changed = false;
  const result = await f.check({}, { git: async (cwd, args) => {
    const value = await runGit(cwd, args);
    if (args[0] === "ls-remote" && !changed) { changed = true; commit(f.candidate, "during-check.txt"); }
    return value;
  } });
  assert.ok(codes(result).includes("candidate_changed"));
  assert.notEqual(result.candidateSha, result.candidateAfterSha);
});

test("rejects source changes between the before and after remote reads", async () => {
  const f = fixture(); f.merge(); let changed = false;
  const result = await f.check({}, { git: async (cwd, args) => {
    const value = await runGit(cwd, args);
    if (args[0] === "ls-remote" && !changed) { changed = true; f.advanceSource(); }
    return value;
  } });
  assert.ok(codes(result).includes("source_changed_or_unpinned"));
  assert.notEqual(result.remoteSourceBeforeSha, result.remoteSourceAfterSha);
});

test("rejects losing an unpinned release branch binding during the check", async () => {
  const f = fixture(); f.merge(); let changed = false;
  const result = await f.check({}, { git: async (cwd, args) => {
    const value = await runGit(cwd, args);
    if (args[0] === "ls-remote" && !changed) { changed = true; git(f.candidate, "checkout", "--detach", "HEAD"); }
    return value;
  } });
  assert.equal(result.candidateSha, result.candidateAfterSha);
  assert.ok(codes(result).includes("unbound_detached_candidate_after"));
});

test("a source branch cannot masquerade as the release candidate", async () => {
  const f = fixture(); git(f.candidate, "checkout", "v1.2.6");
  const result = await f.check();
  assert.ok(codes(result).includes("wrong_candidate_branch"));
});

test("binds detached CI candidates to an explicit exact SHA", async () => {
  const f = fixture(); f.merge(); const sha = git(f.candidate, "rev-parse", "HEAD");
  git(f.candidate, "checkout", "--detach", sha);
  assert.ok(codes(await f.check()).includes("unbound_detached_candidate"));
  assert.equal((await f.check({ candidateSha: sha })).passed, true);
});

test("CLI supports --cwd but cannot enable a noncanonical remote transport", () => {
  const f = fixture(); f.merge();
  const result = spawnSync(process.execPath, [script, "--cwd", f.candidate, "--remote", "origin",
    "--release-branch", "release/v1.2.6", "--source-sha", f.sourceSha], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.ok(codes(JSON.parse(result.stdout)).includes("remote_identity"));
});

test("validates branch, remote and SHA input before any Git execution", async () => {
  assert.equal(sourceBranchFor("release/v1.2.6"), "v1.2.6");
  for (const releaseBranch of ["main", "release/main", "release/v1.2.6\n", "release/v1.2.6/other", "--upload-pack=other"]) {
    assert.throws(() => sourceBranchFor(releaseBranch));
  }
  const options = { releaseBranch: "release/v1.2.6", sourceSha: "a".repeat(40) };
  const noGit = { git: () => assert.fail("invalid input reached Git") };
  for (const change of [{ remote: "--upload-pack=other" }, { sourceSha: "HEAD" },
    { sourceBranch: "v1.2.5" }, { candidateSha: "a".repeat(40) + "\n" }]) {
    await assert.rejects(checkReleaseSource({ ...options, ...change }, noGit));
  }
});

test("source push selects and checks the real corresponding release candidate", async () => {
  const f = fixture();
  const releaseSha = git(f.candidate, "rev-parse", "HEAD");
  const heads = new Map([["v1.2.6", f.sourceSha], ["release/v1.2.6", releaseSha]]);
  const [pair] = selectReleaseSourcePairs(heads, { eventName: "push", refName: "v1.2.6", eventSha: f.sourceSha });
  assert.equal(pair.candidateSha, releaseSha);
  assert.notEqual(pair.candidateSha, f.sourceSha);
  const result = await f.check(pair);
  assert.equal(result.passed, false);
  assert.ok(codes(result).includes("source_not_ancestor"));
});

test("dispatch checks every corresponding pair and rejects missing/stale push snapshots", () => {
  const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40);
  const heads = new Map([["v1.2.6", a], ["release/v1.2.6", b], ["v1.2.7", a], ["release/v1.2.7", c]]);
  assert.equal(selectReleaseSourcePairs(heads, { eventName: "workflow_dispatch" }).length, 2);
  assert.equal(selectReleaseSourcePairs(heads, { eventName: "push", refName: "release/v1.2.6", eventSha: b })[0].sourceSha, a);
  assert.throws(() => selectReleaseSourcePairs(heads, { eventName: "push", refName: "v1.2.6", eventSha: b }));
  heads.delete("release/v1.2.6");
  assert.throws(() => selectReleaseSourcePairs(heads, { eventName: "push", refName: "v1.2.6", eventSha: a }));
});
