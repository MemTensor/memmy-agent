#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION_BRANCH = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;
const SHA = /^[0-9a-f]{40}$/u;
const CANONICAL_REMOTE = /^(?:https:\/\/github\.com\/MemTensor\/memmy-agent(?:\.git)?|git@github\.com:MemTensor\/memmy-agent(?:\.git)?|ssh:\/\/git@github\.com\/MemTensor\/memmy-agent(?:\.git)?)$/iu;

export function sourceBranchFor(releaseBranch) {
  const sourceBranch = releaseBranch?.startsWith("release/") ? releaseBranch.slice("release/".length) : "";
  if (!VERSION_BRANCH.test(sourceBranch)) throw new Error("Expected release/vX.Y.Z release branch");
  return sourceBranch;
}

/** Source pushes target the associated release HEAD, never the source HEAD itself. */
export function selectReleaseSourcePairs(heads, { eventName, refName, eventSha, releaseBranch } = {}) {
  let releases;
  if (eventName === "push") {
    const source = refName?.startsWith("release/") ? sourceBranchFor(refName) : refName;
    if (!VERSION_BRANCH.test(source ?? "")) throw new Error("Unsupported source/release push branch");
    if (!SHA.test(eventSha ?? "") || heads.get(refName) !== eventSha) throw new Error("Push snapshot is no longer the current remote branch tip");
    releases = [`release/${source}`];
  } else if (eventName === "workflow_dispatch") {
    releases = releaseBranch ? [releaseBranch] : [...heads.keys()].filter(branch => branch.startsWith("release/") && VERSION_BRANCH.test(branch.slice(8)));
  } else throw new Error("Unsupported release source check event");
  if (!releases.length || releases.length > 128) throw new Error("Expected between one and 128 release/source pairs");
  return releases.sort().map(release => {
    const source = sourceBranchFor(release);
    const candidateSha = heads.get(release), sourceSha = heads.get(source);
    if (!SHA.test(candidateSha ?? "") || !SHA.test(sourceSha ?? "")) throw new Error(`Missing release/source pair: ${release} / ${source}`);
    return { releaseBranch: release, sourceBranch: source, candidateSha, sourceSha };
  });
}

export function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "protocol.ext.allow=never", ...args], {
      cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" }
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(new Error(`Git command could not run: ${error.message}`));
      resolve({ status: error?.code ?? 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

/** Read-only check. The local transport exception is available only to fixture tests, not the CLI. */
export async function checkReleaseSource(options, { git = runGit, allowLocalRemote = false } = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const releaseBranch = options.releaseBranch;
  const sourceBranch = sourceBranchFor(releaseBranch);
  if (options.sourceBranch !== undefined && options.sourceBranch !== sourceBranch) throw new Error("Source branch must match the release version");
  const pinnedSourceSha = options.sourceSha;
  if (!SHA.test(pinnedSourceSha ?? "")) throw new Error("An exact lowercase 40-character --source-sha is required");
  if (options.candidateSha !== undefined && !SHA.test(options.candidateSha)) throw new Error("Invalid --candidate-sha");
  const remote = options.remote ?? "upstream";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(remote)) throw new Error("Invalid remote name");
  const result = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), releaseBranch, sourceBranch, remote,
    pinnedSourceSha, candidateSha: null, candidateAfterSha: null,
    remoteSourceBeforeSha: null, remoteSourceAfterSha: null, containsPinnedSource: false,
    missingSourceCommitCount: null, missingSourceCommitShas: [], errors: [], passed: false
  };
  const fail = (code, message) => result.errors.push({ code, message });
  const requiredGit = async (args) => {
    const value = await git(cwd, args);
    if (value.status !== 0) throw new Error(`git ${args[0]} failed: ${value.stderr || value.stdout}`);
    return value.stdout;
  };
  const snapshot = async () => {
    const head = await requiredGit(["rev-parse", "--verify", "HEAD^{commit}"]);
    const branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (![0, 1].includes(branch.status)) throw new Error("Cannot resolve candidate branch");
    return { head, branch: branch.status === 0 ? branch.stdout : null,
      clean: (await requiredGit(["status", "--porcelain=v1", "--untracked-files=all"])) === "" };
  };
  const readSource = async () => {
    const ref = `refs/heads/${sourceBranch}`;
    const lines = (await requiredGit(["ls-remote", "--refs", remote, ref])).split(/\r?\n/u).filter(Boolean);
    const match = lines.length === 1 ? lines[0].split(/\s+/u) : [];
    if (match.length !== 2 || !SHA.test(match[0]) || match[1] !== ref) return null;
    return match[0];
  };
  try {
    const before = await snapshot();
    result.candidateSha = before.head;
    if (!before.clean) fail("dirty_candidate", "Candidate worktree must be clean");
    if (before.branch && before.branch !== releaseBranch) fail("wrong_candidate_branch", `Candidate branch is ${before.branch}, expected ${releaseBranch}`);
    if (!before.branch && !options.candidateSha) fail("unbound_detached_candidate", "Detached check requires --candidate-sha");
    if (options.candidateSha && before.head !== options.candidateSha) fail("candidate_snapshot_mismatch", "Candidate HEAD does not match --candidate-sha");
    const urls = (await requiredGit(["remote", "get-url", "--all", remote])).split(/\r?\n/u).filter(Boolean);
    if (urls.length !== 1 || (!CANONICAL_REMOTE.test(urls[0]) && !(allowLocalRemote && path.isAbsolute(urls[0])))) {
      fail("remote_identity", "Remote must identify GitHub MemTensor/memmy-agent");
    } else {
      result.remoteUrl = urls[0];
      result.remoteSourceBeforeSha = await readSource();
      if (!result.remoteSourceBeforeSha) fail("unknown_source", `Remote source branch ${sourceBranch} is missing or ambiguous`);
      else if (result.remoteSourceBeforeSha !== pinnedSourceSha) fail("source_snapshot_mismatch", "Remote source does not match the pinned source SHA; fetch, review and repin explicitly");
      const sourceObject = await git(cwd, ["cat-file", "-e", `${pinnedSourceSha}^{commit}`]);
      if (sourceObject.status !== 0) fail("source_object_missing", "Pinned source object is unavailable locally; fetch the source explicitly");
      else {
        const ancestry = await git(cwd, ["merge-base", "--is-ancestor", pinnedSourceSha, before.head]);
        if (![0, 1].includes(ancestry.status)) throw new Error("Cannot resolve source ancestry");
        result.containsPinnedSource = ancestry.status === 0;
        if (!result.containsPinnedSource) fail("source_not_ancestor", "Candidate does not contain the pinned source commit");
        result.missingSourceCommitCount = Number(await requiredGit(["rev-list", "--count", `${before.head}..${pinnedSourceSha}`]));
        result.missingSourceCommitShas = (await requiredGit(["rev-list", "--max-count=10", `${before.head}..${pinnedSourceSha}`])).split(/\r?\n/u).filter(Boolean);
      }
      result.remoteSourceAfterSha = await readSource();
      if (result.remoteSourceAfterSha !== pinnedSourceSha) fail("source_changed_or_unpinned", "Remote source changed or no longer matches the pinned source SHA");
    }
  } catch (error) {
    fail("check_error", error.message);
  } finally {
    try {
      const after = await snapshot();
      result.candidateAfterSha = after.head;
      if (result.candidateSha !== after.head) fail("candidate_changed", "Candidate HEAD changed during the check");
      if (!after.clean) fail("dirty_candidate_after", "Candidate worktree is dirty after the check");
      if (after.branch && after.branch !== releaseBranch) fail("candidate_branch_changed", "Candidate branch changed during the check");
      if (!after.branch && !options.candidateSha) fail("unbound_detached_candidate_after", "Detached candidate after check requires --candidate-sha");
    } catch (error) {
      fail("candidate_recheck_error", error.message);
    }
  }
  result.passed = result.errors.length === 0;
  return result;
}

function parseArgs(args) {
  const options = {};
  const names = { "--cwd": "cwd", "--remote": "remote", "--release-branch": "releaseBranch",
    "--source-branch": "sourceBranch", "--source-sha": "sourceSha", "--candidate-sha": "candidateSha" };
  for (let index = 0; index < args.length; index += 1) {
    const name = names[args[index]];
    if (!name || !args[index + 1] || args[index + 1].startsWith("--") || options[name] !== undefined) throw new Error(`Invalid argument: ${args[index]}`);
    options[name] = args[++index];
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkReleaseSource(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ schemaVersion: 1, passed: false, errors: [{ code: "invalid_input", message: error.message }] }, null, 2));
    process.exitCode = 1;
  }
}
