import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

export class CommitInfo {
  sha: string;
  hash: string;
  message: string;
  timestamp: string;

  constructor(sha?: string, message?: string, timestamp?: string);
  constructor(init: { sha?: string; hash?: string; message?: string; timestamp?: string });
  constructor(
    shaOrInit: string | { sha?: string; hash?: string; message?: string; timestamp?: string } = "",
    message = "",
    timestamp = "",
  ) {
    if (typeof shaOrInit === "object") {
      this.sha = shaOrInit.sha ?? shaOrInit.hash ?? "";
      this.hash = this.sha;
      this.message = shaOrInit.message ?? "";
      this.timestamp = shaOrInit.timestamp ?? "";
      return;
    }
    this.sha = shaOrInit;
    this.hash = shaOrInit;
    this.message = message;
    this.timestamp = timestamp;
  }

  format(diff = ""): string {
    const title = this.message.split(/\r?\n/)[0] || this.message;
    const header = `## ${title}\n\`${this.sha}\` - ${this.timestamp}\n`;
    return diff ? `${header}\n\`\`\`diff\n${diff}\n\`\`\`` : `${header}\n(no file changes)`;
  }
}

export class LineAge {
  ageDays: number;

  constructor(ageDaysOrInit: number | { ageDays?: number } = 0) {
    const ageDays =
      typeof ageDaysOrInit === "number" ? ageDaysOrInit : (ageDaysOrInit.ageDays ?? 0);
    this.ageDays = ageDays;
  }
}

type IsoGitRequest = {
  op: "init" | "autoCommit" | "diffCommits" | "lineAges" | "log" | "resolveSha" | "revert";
  dir: string;
  trackedFiles: string[];
  message?: string;
  sha?: string;
  sha1?: string;
  sha2?: string;
  filePath?: string;
  maxEntries?: number;
  now?: number;
};

type IsoGitResponse<T> = { ok: true; value: T } | { ok: false; error: string };

const ISO_GIT_SPEC = import.meta.resolve("isomorphic-git");
const ISO_GIT_TIMEOUT_MS = 60_000;
const AUTHOR = { name: "memmy", email: "memmy@agent" };

const ISO_GIT_WORKER = String.raw`
import { workerData } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";

const gitModule = await import(workerData.isomorphicGitSpec);
const git = gitModule.default ?? gitModule;
const AUTHOR = { name: "memmy", email: "memmy@agent" };

function shortSha(fullSha) {
  return String(fullSha || "").trim().slice(0, 8);
}

function safeCommitPrefix(value) {
  return /^[0-9a-fA-F]{4,40}$/.test(String(value || ""));
}

function toPosix(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

function trackedFiles() {
  return (workerData.request.trackedFiles || []).map(toPosix);
}

function splitLines(content) {
  if (!content) return [];
  return String(content).replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

function formatTimestamp(seconds) {
  const date = new Date(Number(seconds || 0) * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

function ensureTrackedFiles(dir, files) {
  for (const rel of files) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, "", "utf8");
  }
}

async function addOrRemoveTracked(dir, files) {
  for (const rel of files) {
    const file = path.join(dir, rel);
    if (fs.existsSync(file)) {
      await git.add({ fs, dir, filepath: rel, force: true });
    } else {
      try {
        await git.remove({ fs, dir, filepath: rel });
      } catch {
        // Missing and untracked files do not need staging.
      }
    }
  }
}

async function hasTrackedChanges(dir, files) {
  if (!files.length) return false;
  let head = null;
  try {
    head = await git.resolveRef({ fs, dir, ref: "HEAD" });
  } catch {
    return true;
  }
  for (const rel of files) {
    const file = path.join(dir, rel);
    const workdir = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    const committed = await readBlobAt(dir, head, rel);
    if (workdir !== committed) return true;
  }
  return false;
}

async function commitTracked(dir, files, message) {
  if (!(await hasTrackedChanges(dir, files))) return null;
  await addOrRemoveTracked(dir, files);
  const sha = await git.commit({ fs, dir, message, author: AUTHOR });
  return shortSha(sha);
}

async function getLog(dir, maxEntries) {
  const depth = Math.max(1, Number(maxEntries || 20));
  const commits = await git.log({ fs, dir, depth });
  return commits.map((entry) => ({
    sha: shortSha(entry.oid),
    message: String(entry.commit.message || "").trimEnd(),
    timestamp: formatTimestamp(entry.commit.author?.timestamp),
  }));
}

async function resolveSha(dir, prefix) {
  if (!safeCommitPrefix(prefix)) return null;
  const wanted = String(prefix).toLowerCase();
  const commits = await git.log({ fs, dir, depth: 1000 });
  const match = commits.find((entry) => entry.oid.toLowerCase().startsWith(wanted));
  return match?.oid ?? null;
}

async function readBlobAt(dir, oid, filepath) {
  if (!oid) return null;
  try {
    const result = await git.readBlob({ fs, dir, oid, filepath });
    return Buffer.from(result.blob).toString("utf8");
  } catch {
    return null;
  }
}

function buildLineDiff(filePath, oldContent, newContent) {
  if (oldContent === newContent) return "";
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const oldStart = oldLines.length ? 1 : 0;
  const newStart = newLines.length ? 1 : 0;
  const header = [
    "diff --git a/" + filePath + " b/" + filePath,
    "--- a/" + filePath,
    "+++ b/" + filePath,
    "@@ -" + oldStart + "," + oldLines.length + " +" + newStart + "," + newLines.length + " @@",
  ];
  return [
    ...header,
    ...oldLines.map((line) => "-" + line),
    ...newLines.map((line) => "+" + line),
  ].join("\n");
}

async function diffCommits(dir, files, sha1, sha2) {
  const full1 = await resolveSha(dir, sha1);
  const full2 = await resolveSha(dir, sha2);
  if (!full1 || !full2) return "";
  const diffs = [];
  for (const rel of files) {
    const oldContent = await readBlobAt(dir, full1, rel);
    const newContent = await readBlobAt(dir, full2, rel);
    const diff = buildLineDiff(rel, oldContent ?? "", newContent ?? "");
    if (diff) diffs.push(diff);
  }
  return diffs.join("\n");
}

function carryLineTimes(oldLines, oldTimes, newLines, timestamp) {
  const oldLen = oldLines.length;
  const newLen = newLines.length;
  const dp = Array.from({ length: oldLen + 1 }, () => Array(newLen + 1).fill(0));
  for (let i = oldLen - 1; i >= 0; i -= 1) {
    for (let j = newLen - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const nextTimes = Array(newLen).fill(timestamp);
  let i = 0;
  let j = 0;
  while (i < oldLen && j < newLen) {
    if (oldLines[i] === newLines[j]) {
      nextTimes[j] = oldTimes[i] ?? timestamp;
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return nextTimes;
}

async function lineAges(dir, filePath, nowMs) {
  const target = path.join(dir, filePath);
  if (!fs.existsSync(target) || fs.statSync(target).size === 0) return [];
  const currentLines = splitLines(fs.readFileSync(target, "utf8"));
  if (!currentLines.length) return [];

  const commits = (await git.log({ fs, dir, depth: 1000 })).reverse();
  let knownLines = [];
  let knownTimes = [];
  let sawFile = false;
  for (const entry of commits) {
    const content = await readBlobAt(dir, entry.oid, filePath);
    if (content == null) {
      knownLines = [];
      knownTimes = [];
      sawFile = false;
      continue;
    }
    const lines = splitLines(content);
    const timestamp = Number(entry.commit.author?.timestamp || 0) * 1000;
    knownTimes = sawFile ? carryLineTimes(knownLines, knownTimes, lines, timestamp) : lines.map(() => timestamp);
    knownLines = lines;
    sawFile = true;
  }
  if (!sawFile) {
    knownLines = [];
    knownTimes = [];
  }
  if (knownLines.join("\n") !== currentLines.join("\n")) {
    knownTimes = carryLineTimes(knownLines, knownTimes, currentLines, nowMs);
  }
  return knownTimes.map((timestamp) => ({
    ageDays: Math.max(0, Math.floor((nowMs - Number(timestamp || nowMs)) / 86400000)),
  }));
}

async function revertCommit(dir, files, sha) {
  const full = await resolveSha(dir, sha);
  if (!full) return null;
  const target = await git.readCommit({ fs, dir, oid: full });
  const parent = target.commit.parent?.[0] ?? null;
  if (!parent) return null;
  for (const rel of files) {
    const content = await readBlobAt(dir, parent, rel);
    const file = path.join(dir, rel);
    if (content == null) {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
  const title = String(target.commit.message || "commit").split(/\r?\n/)[0] || "commit";
  return commitTracked(dir, files, "revert: " + title);
}

async function run() {
  const request = workerData.request;
  const dir = request.dir;
  const files = trackedFiles();
  switch (request.op) {
    case "init":
      await git.init({ fs, dir });
      ensureTrackedFiles(dir, files);
      await git.add({ fs, dir, filepath: ".gitignore" });
      await addOrRemoveTracked(dir, files);
      await git.commit({ fs, dir, message: "init: memmy memory store", author: AUTHOR });
      return true;
    case "autoCommit":
      return commitTracked(dir, files, request.message || "update");
    case "diffCommits":
      return diffCommits(dir, files, request.sha1, request.sha2);
    case "lineAges":
      return lineAges(dir, toPosix(request.filePath || ""), Number(request.now || Date.now()));
    case "log":
      return getLog(dir, request.maxEntries);
    case "resolveSha":
      return resolveSha(dir, request.sha);
    case "revert":
      return revertCommit(dir, files, request.sha);
    default:
      throw new Error("unsupported git operation: " + request.op);
  }
}

try {
  const value = await run();
  fs.writeFileSync(workerData.resultFile, JSON.stringify({ ok: true, value }), "utf8");
} catch (error) {
  fs.writeFileSync(workerData.resultFile, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }), "utf8");
} finally {
  const signal = new Int32Array(workerData.signal);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}
`;

function shortSha(fullSha: string): string {
  return fullSha.trim().slice(0, 8);
}

function safeCommitPrefix(value: string): boolean {
  return /^[0-9a-fA-F]{4,40}$/.test(value);
}

function runIsoGit<T>(request: IsoGitRequest): T {
  const signalBuffer = new SharedArrayBuffer(4);
  const signal = new Int32Array(signalBuffer);
  const resultFile = path.join(os.tmpdir(), `memmy-isogit-${process.pid}-${randomUUID()}.json`);
  const worker = new Worker(ISO_GIT_WORKER, {
    eval: true,
    workerData: {
      isomorphicGitSpec: ISO_GIT_SPEC,
      request,
      resultFile,
      signal: signalBuffer,
    },
  });
  const deadline = Date.now() + ISO_GIT_TIMEOUT_MS;
  try {
    while (Atomics.load(signal, 0) === 0) {
      if (Date.now() >= deadline) throw new Error(`isomorphic-git ${request.op} timed out`);
      Atomics.wait(signal, 0, 0, 250);
    }
    const raw = fs.readFileSync(resultFile, "utf8");
    const response = JSON.parse(raw) as IsoGitResponse<T>;
    if (!response.ok) throw new Error(response.error);
    return response.value;
  } finally {
    worker.unref();
    void worker.terminate();
    if (fs.existsSync(resultFile)) fs.rmSync(resultFile, { force: true });
  }
}

export class GitStore {
  workspacePath: string;
  workspace: string;
  trackedFiles: string[];

  constructor(workspace: string, trackedFiles: string[] = []) {
    this.workspacePath = this.workspace = path.resolve(workspace);
    this.trackedFiles = trackedFiles.map((file) => file.replaceAll(path.sep, "/"));
  }

  isInitialized(): boolean {
    const gitPath = path.join(this.workspacePath, ".git");
    return fs.existsSync(gitPath) && fs.statSync(gitPath).isDirectory();
  }

  init(): boolean {
    fs.mkdirSync(this.workspacePath, { recursive: true });
    if (this.isInitialized()) return false;
    if (this.isInsideGitRepo()) return false;

    try {
      this.mergeGitignore();
      return Boolean(
        runIsoGit<boolean>({
          op: "init",
          dir: this.workspacePath,
          trackedFiles: this.trackedFiles,
        }),
      );
    } catch {
      return false;
    }
  }

  private mergeGitignore(): void {
    const gitignore = path.join(this.workspacePath, ".gitignore");
    const desired = this.buildGitignore();
    if (!fs.existsSync(gitignore)) {
      fs.writeFileSync(gitignore, desired, "utf8");
      return;
    }
    const existing = fs.readFileSync(gitignore, "utf8");
    const existingLines = new Set(existing.split(/\r?\n/));
    const newLines = desired.split(/\r?\n/).filter((line) => line && !existingLines.has(line));
    if (!newLines.length) return;
    fs.writeFileSync(
      gitignore,
      `${existing.replace(/\n*$/, "\n")}${newLines.join("\n")}\n`,
      "utf8",
    );
  }

  autoCommit(message: string): string | null {
    if (!this.isInitialized()) return null;
    try {
      return runIsoGit<string | null>({
        op: "autoCommit",
        dir: this.workspacePath,
        trackedFiles: this.trackedFiles,
        message,
      });
    } catch {
      return null;
    }
  }

  resolveSha(short: string): string | null {
    if (!this.isInitialized() || !safeCommitPrefix(short)) return null;
    try {
      return runIsoGit<string | null>({
        op: "resolveSha",
        dir: this.workspacePath,
        trackedFiles: this.trackedFiles,
        sha: short,
      });
    } catch {
      return null;
    }
  }

  isInsideGitRepo(): boolean {
    let current = path.resolve(this.workspacePath);
    while (true) {
      if (fs.existsSync(path.join(current, ".git"))) return true;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }

  buildGitignore(): string {
    const dirs = new Set<string>();
    for (const file of this.trackedFiles) {
      const parent = path.posix.dirname(file.replaceAll(path.sep, "/"));
      if (parent !== ".") dirs.add(parent);
    }
    const lines = ["/*"];
    for (const dir of [...dirs].sort()) lines.push(`!${dir}/`);
    for (const file of this.trackedFiles) lines.push(`!${file.replaceAll(path.sep, "/")}`);
    lines.push("!.gitignore");
    return `${lines.join("\n")}\n`;
  }

  log(maxEntries = 20): CommitInfo[] {
    if (!this.isInitialized()) return [];
    try {
      return runIsoGit<Array<{ sha: string; message: string; timestamp: string }>>({
        op: "log",
        dir: this.workspacePath,
        trackedFiles: this.trackedFiles,
        maxEntries,
      }).map((commit) => new CommitInfo(commit));
    } catch {
      return [];
    }
  }

  lineAges(filePath: string): LineAge[] {
    if (!this.isInitialized()) return [];
    try {
      return runIsoGit<Array<{ ageDays?: number }>>({
        op: "lineAges",
        dir: this.workspacePath,
        trackedFiles: this.trackedFiles,
        filePath,
        now: Date.now(),
      }).map((age) => new LineAge(age));
    } catch {
      return [];
    }
  }

  diffCommits(sha1: string, sha2: string): string {
    if (!this.isInitialized()) return "";
    try {
      return runIsoGit<string>({
        op: "diffCommits",
        dir: this.workspacePath,
        trackedFiles: this.trackedFiles,
        sha1,
        sha2,
      });
    } catch {
      return "";
    }
  }

  findCommit(short: string, maxEntries = 20): CommitInfo | null {
    return this.log(maxEntries).find((commit) => commit.sha.startsWith(short)) ?? null;
  }

  showCommitDiff(short: string, maxEntries = 20): [CommitInfo, string] | null {
    const commits = this.log(maxEntries);
    for (let i = 0; i < commits.length; i += 1) {
      if (!commits[i].sha.startsWith(short)) continue;
      const diff =
        i + 1 < commits.length ? this.diffCommits(commits[i + 1].sha, commits[i].sha) : "";
      return [commits[i], diff];
    }
    return null;
  }

  revert(short: string): string | null {
    if (!this.isInitialized()) return null;
    if (!safeCommitPrefix(short)) return null;
    try {
      return runIsoGit<string | null>({
        op: "revert",
        dir: this.workspacePath,
        trackedFiles: this.trackedFiles,
        sha: short,
      });
    } catch {
      return null;
    }
  }
}
