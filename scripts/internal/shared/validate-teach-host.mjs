#!/usr/bin/env node
// Source/fixture validation only: does not operate the desktop or install an application.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const agent = path.join(root, "App/memmy-agent");
const frontend = path.join(root, "App/frontend/desktop");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--report-dir" || !path.isAbsolute(args[1]))) {
  throw new Error("Usage: validate-teach-host.mjs [--report-dir <absolute directory>]");
}
const parent = args[1] ?? os.tmpdir();
fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, "teach-host-validation-"));
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout?.trim();
const fingerprint = () => {
  const hash = createHash("sha256").update(git("rev-parse", "HEAD") ?? "").update(git("diff", "HEAD", "--binary") ?? "");
  for (const file of (git("ls-files", "--others", "--exclude-standard", "-z") ?? "").split("\0").filter(Boolean).sort()) {
    hash.update(file).update(fs.readFileSync(path.join(root, file)));
  }
  return hash.digest("hex");
};
const report = {
  commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
  sourceFingerprint: fingerprint(),
  workingTree: git("status", "--porcelain"), platform: process.platform, node: process.version,
  startedAt: new Date().toISOString(), status: "running", stages: [],
  scope: { desktopOperation: false, installedApp: false, physicalPlatformAcceptance: false },
};
const write = () => fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify(report, null, 2) + "\n");
const env = { ...process.env, MEMMY_WINDOWS_HISTORY_TEST_BIN_DIR: "" };
function run(name, cwd, command, args) {
  const started = Date.now();
  console.log(`[Teach Host] ${name}`);
  const log = path.join(directory, `${name}.log`);
  const descriptor = fs.openSync(log, "w");
  let result;
  try {
    result = spawnSync(command, args, { cwd, env, stdio: ["ignore", descriptor, descriptor], timeout: 600_000 });
  } finally { fs.closeSync(descriptor); }
  if (result.error) fs.appendFileSync(log, result.error.message);
  report.stages.push({ name, exitCode: result.status, signal: result.signal, elapsedMs: Date.now() - started, log,
    command, args, errorCode: result.error?.code ?? null, timedOut: result.error?.code === "ETIMEDOUT" });
  write();
  console.log(`[Teach Host] ${name}: ${result.status === 0 ? "passed" : `FAILED (see ${log})`}`);
  return result.status === 0;
}
const node = (name, cwd, args) => run(name, cwd, process.execPath, args);
const tsc = path.join(root, "node_modules/typescript/bin/tsc");
const tests = (name, cwd, files) => node(name, cwd, [path.join(cwd === agent ? agent : root, "node_modules/vitest/vitest.mjs"),
  "run", ...files, "--maxWorkers=2", "--reporter=default", "--reporter=json", `--outputFile=${path.join(directory, `${name}.json`)}`]);

try {
  for (const [name, config] of [
    ["source-core", "Memory/AgentSourceCore/tsconfig.json"], ["source-readers", "Memory/AgentSourceReaders/tsconfig.json"],
    ["knowledge", "Knowledge/tsconfig.json"], ["migrations", "Migrations/tsconfig.build.json"],
    ["contracts", "App/backend/local-api-contracts/tsconfig.json"], ["desktop-interface", "App/shell/desktop/interface/tsconfig.json"],
  ]) {
    if (!node(`build-${name}`, root, [tsc, "-p", config])) throw new Error(`Dependency build failed: ${name}`);
  }
  node("agent-types", agent, [tsc, "-p", "tsconfig.json", "--noEmit"]);
  node("agent-build", agent, [tsc, "-p", "tsconfig.build.json"]);
  node("backend-types", root, [tsc, "-p", "App/backend/tsconfig.json", "--noEmit"]);
  node("frontend-types", frontend, [tsc, "-p", "tsconfig.json", "--noEmit"]);
  node("agent-lint", agent, [path.join(agent, "node_modules/eslint/bin/eslint.js"),
    "src/tools/computer-history/**/*.ts", "tests/tools/computer-history/**/*.ts",
    "src/tools/computer-recordings/**/*.ts", "tests/tools/computer-recordings/**/*.ts",
    "src/core/agent-runtime/task-activity.ts", "src/core/agent-runtime/plugin-update-lease.ts",
    "src/core/agent-runtime/loop.ts", "src/core/agent-runtime/subagent.ts",
    "tests/core/agent-runtime/task-activity.test.ts", "tests/core/agent-runtime/plugin-update-lease.test.ts",
    "src/core/session/terminal-session-control.ts", "src/integrations/channels/websocket.ts",
    "tests/integrations/channels/websocket-http-routes.test.ts",
    "tests/core/agent-runtime/tools/mcp-tool.test.ts", "tests/core/agent-runtime/tools/mcp-probe.test.ts",
    "tests/providers/extra-body-config.test.ts"]);
  node("backend-lint", path.join(root, "App/backend"), [path.join(root, "node_modules/eslint/bin/eslint.js"),
    "src/services/plugin-service.ts", "src/services/plugin-update-service.ts", "src/services/index.ts",
    "src/services/tests/plugin-service.test.ts", "src/services/tests/plugin-update-service.test.ts",
    "src/adapters/outbound/memmy-agent-admin-client/**/*.ts"]);
  // Full Agent regression includes Provider, MCP, runtime admission, History and recording.
  // Keep the complete suite, partitioned by Vitest's exhaustive file sharding.
  // Cold hosted runners exceeded the per-process 10-minute bound while still
  // finishing tests; each shard keeps that bound and a separate JSON report.
  for (let shard = 1; shard <= 4; shard++) {
    tests(`agent-full-${shard}-of-4`, agent, [`--shard=${shard}/4`]);
  }
  tests("plugin-host", root, ["App/backend/src/services/tests/plugin-service.test.ts",
    "App/backend/src/services/tests/plugin-update-service.test.ts",
    "App/backend/src/services/tests/plugin-native-host-services.test.ts",
    "App/backend/src/adapters/outbound/memmy-agent-admin-client/tests"]);
  const packaging = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).scripts["test:packaging-guards"];
  tests("packaging-guards", root, packaging.replace(/^vitest run /, "").split(/\s+/));
  tests("recording-ui", frontend, ["src/pages/tests/task-recordings.interaction.test.tsx", "src/pages/tests/plugin-update-indicator.test.tsx",
    "src/pages/tests/conversation-features.interaction.test.tsx"]);
  report.status = report.stages.every(stage => stage.exitCode === 0) ? "passed" : "failed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
} finally {
  report.sourceChangedDuringRun = report.sourceFingerprint !== fingerprint();
  if (report.sourceChangedDuringRun) report.status = "failed";
  report.finishedAt = new Date().toISOString();
  write();
  console.log(`[Teach Host] ${report.status}: ${directory}`);
  if (report.status !== "passed") process.exitCode = 1;
}
