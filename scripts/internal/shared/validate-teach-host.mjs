#!/usr/bin/env node
// Source/fixture validation only: does not operate the desktop or install an application.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const report = {
  commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
  workingTree: git("status", "--porcelain"), platform: process.platform, node: process.version,
  startedAt: new Date().toISOString(), status: "running", stages: [],
  scope: { desktopOperation: false, installedApp: false, physicalPlatformAcceptance: false },
};
const write = () => fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify(report, null, 2) + "\n");
const env = { ...process.env, MEMMY_WINDOWS_HISTORY_TEST_BIN_DIR: "" };
function run(name, cwd, command, args) {
  const started = Date.now();
  console.log(`[Teach Host] ${name}`);
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  const log = path.join(directory, `${name}.log`);
  fs.writeFileSync(log, (result.stdout ?? "") + (result.stderr ?? "") + (result.error?.message ?? ""));
  report.stages.push({ name, exitCode: result.status, signal: result.signal, elapsedMs: Date.now() - started, log });
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
    "tests/core/agent-runtime/task-activity.test.ts", "tests/core/agent-runtime/plugin-update-lease.test.ts",
    "src/core/session/terminal-session-control.ts", "src/integrations/channels/websocket.ts",
    "tests/integrations/channels/websocket-http-routes.test.ts",
    "tests/core/agent-runtime/tools/mcp-tool.test.ts", "tests/providers/extra-body-config.test.ts"]);
  node("backend-lint", path.join(root, "App/backend"), [path.join(root, "node_modules/eslint/bin/eslint.js"),
    "src/services/plugin-service.ts", "src/services/plugin-update-service.ts", "src/services/index.ts",
    "src/services/tests/plugin-service.test.ts", "src/services/tests/plugin-update-service.test.ts",
    "src/adapters/outbound/memmy-agent-admin-client/**/*.ts"]);
  // Full Agent regression includes Provider, MCP, runtime admission, History and recording.
  tests("agent-full", agent, []);
  tests("plugin-host", root, ["App/backend/src/services/tests/plugin-service.test.ts",
    "App/backend/src/services/tests/plugin-update-service.test.ts",
    "App/backend/src/services/tests/plugin-native-host-services.test.ts",
    "App/backend/src/adapters/outbound/memmy-agent-admin-client/tests"]);
  const packaging = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).scripts["test:packaging-guards"];
  tests("packaging-guards", root, packaging.replace(/^vitest run /, "").split(/\s+/));
  tests("recording-ui", frontend, ["src/pages/tests/task-recordings.interaction.test.tsx", "src/pages/tests/plugin-update-indicator.test.tsx"]);
  report.status = report.stages.every(stage => stage.exitCode === 0) ? "passed" : "failed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
} finally {
  report.finishedAt = new Date().toISOString();
  write();
  console.log(`[Teach Host] ${report.status}: ${directory}`);
  if (report.status !== "passed") process.exitCode = 1;
}
