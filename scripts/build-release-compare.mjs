#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const options = parseArgs(process.argv.slice(2));
const baseSha = gitText(["rev-parse", "--verify", `${options.base}^{commit}`]).trim();
const targetSha = gitText(["rev-parse", "--verify", `${options.target}^{commit}`]).trim();

try {
  gitText(["merge-base", "--is-ancestor", baseSha, targetSha]);
} catch {
  throw new Error(
    `Release comparison base ${baseSha} is not an ancestor of target ${targetSha}`,
  );
}

const commits = readCommits(baseSha, targetSha, options.repository);
const changedFiles = readChangedFiles(baseSha, targetSha);
const outputPath = resolve(options.output);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      html_url: `https://github.com/${options.repository}/compare/${baseSha}...${targetSha}`,
      status: "ahead",
      ahead_by: commits.length,
      behind_by: 0,
      total_commits: commits.length,
      base_commit: { sha: baseSha },
      merge_base_commit: { sha: baseSha },
      head_commit: { sha: targetSha },
      commits,
      files: changedFiles,
      snapshot: {
        source: "local-git",
        complete: true,
        baseSha,
        targetSha,
        commitCount: commits.length,
        changedFileCount: changedFiles.length,
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(
  `Recorded complete release comparison with ${commits.length} commits and ${changedFiles.length} changed files`,
);

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "Usage: build-release-compare.mjs --base <ref> --target <ref> --repository <owner/name> --output <file>",
      );
    }
    const key = flag.slice(2);
    if (!["base", "target", "repository", "output"].includes(key) || parsed[key]) {
      throw new Error(`Unknown or duplicate option: ${flag}`);
    }
    parsed[key] = value;
  }

  for (const key of ["base", "target", "repository", "output"]) {
    if (!parsed[key]) throw new Error(`Missing --${key}`);
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.repository)) {
    throw new Error("Repository must use the owner/name form");
  }
  return parsed;
}

function gitText(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readCommits(baseSha, targetSha, repository) {
  const fields = splitNul(
    gitText([
      "log",
      "--reverse",
      "-z",
      "--format=%H%x00%B",
      `${baseSha}..${targetSha}`,
    ]),
  );
  if (fields.length % 2 !== 0) {
    throw new Error("Unexpected NUL-delimited git log output");
  }

  const commits = [];
  for (let index = 0; index < fields.length; index += 2) {
    const sha = fields[index];
    const message = fields[index + 1].replace(/\n+$/u, "");
    commits.push({
      sha,
      html_url: `https://github.com/${repository}/commit/${sha}`,
      commit: { message },
    });
  }
  return commits;
}

function readChangedFiles(baseSha, targetSha) {
  const statusFields = splitNul(
    gitText(["diff", "--name-status", "-z", "--find-renames", baseSha, targetSha]),
  );
  const stats = readNumstat(baseSha, targetSha);
  const consumedStats = new Set();
  const files = [];

  for (let index = 0; index < statusFields.length; ) {
    const rawStatus = statusFields[index++];
    const statusCode = rawStatus[0];
    const previousPath = statusCode === "R" || statusCode === "C" ? statusFields[index++] : null;
    const path = statusFields[index++];
    if (!rawStatus || !path) throw new Error("Unexpected NUL-delimited git status output");

    const fileStats = stats.get(path);
    if (!fileStats) throw new Error(`Missing numstat entry for changed path: ${path}`);
    consumedStats.add(path);
    files.push({
      filename: path,
      ...(previousPath ? { previous_filename: previousPath } : {}),
      status: statusName(statusCode),
      additions: fileStats.additions,
      deletions: fileStats.deletions,
      changes: fileStats.additions + fileStats.deletions,
    });
  }
  if (consumedStats.size !== stats.size) {
    const unmatched = [...stats.keys()].filter((path) => !consumedStats.has(path));
    throw new Error(`Numstat contains unmatched paths: ${unmatched.join(", ")}`);
  }
  return files;
}

function readNumstat(baseSha, targetSha) {
  const fields = splitNul(
    gitText(["diff", "--numstat", "-z", "--find-renames", baseSha, targetSha]),
  );
  const stats = new Map();

  for (let index = 0; index < fields.length; ) {
    const record = fields[index++];
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) {
      throw new Error("Unexpected NUL-delimited git numstat output");
    }

    const additions = parseStat(record.slice(0, firstTab));
    const deletions = parseStat(record.slice(firstTab + 1, secondTab));
    let path = record.slice(secondTab + 1);
    if (!path) {
      index += 1;
      path = fields[index++];
    }
    if (!path) throw new Error("Missing path in git numstat output");
    stats.set(path, { additions, deletions });
  }
  return stats;
}

function parseStat(value) {
  if (value === "-") return 0;
  if (!/^\d+$/.test(value)) throw new Error(`Invalid git numstat value: ${value}`);
  return Number(value);
}

function splitNul(value) {
  const fields = value.split("\0");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

function statusName(code) {
  const status = {
    A: "added",
    C: "copied",
    D: "removed",
    M: "modified",
    R: "renamed",
    T: "changed",
  }[code];
  if (!status) throw new Error(`Unsupported git diff status: ${code}`);
  return status;
}
