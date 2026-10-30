#!/usr/bin/env node
// Run the History regression baseline without npm lifecycle/version-sync hooks.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const agent = path.join(root, "App/memmy-agent");
const frontend = path.join(root, "App/frontend/desktop");
const nativeTest = "tests/tools/computer-history/win/native-adapter.test.ts";
const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (argument === "--help") {
    console.log(`Usage: node scripts/internal/shared/validate-computer-history.mjs [options]

  --report-dir <absolute-dir>  parent for a new run directory (default: OS temp)
  --native-bin <absolute-dir>  Windows production EXE + fixture build directory

Builds TypeScript dependencies and Agent, checks types/lint, runs History tests
with two workers, checks both summary CLI paths and builds the frontend.
Optional native smoke tests cover lifecycle only; they do not activate windows
or inject input. Full foreground/IME tests and App acceptance are separate.
Each run saves logs, Vitest JSON reports, skipped test names and results.json.
Requires installed repository and Agent dependencies; downloads nothing.`);
    process.exit(0);
  }
  if (!["--report-dir", "--native-bin"].includes(argument) || options[argument]) {
    throw new Error(`Unknown or repeated option: ${argument}`);
  }
  const value = process.argv[++index];
  if (!value || !path.isAbsolute(value)) throw new Error(`${argument} needs an absolute directory`);
  options[argument] = value;
}
if (options["--native-bin"]) {
  if (process.platform !== "win32") throw new Error("--native-bin requires Windows");
  for (const name of ["memmy-history-recorder.exe", "memmy-history-fixture.exe"]) {
    if (!fs.statSync(path.join(options["--native-bin"], name)).isFile()) throw new Error(`Missing ${name}`);
  }
}

const parent = options["--report-dir"] ?? os.tmpdir();
fs.mkdirSync(parent, { recursive: true });
const directory = fs.mkdtempSync(path.join(parent, "computer-history-validation-"));
const report = { platform: process.platform, node: process.version, startedAt: new Date().toISOString(),
  status: "running", stages: [], scope: {
    nativeLifecycle: !!options["--native-bin"], foregroundCapture: false, installedApp: false,
    actualModelService: false, macDesktopAcceptance: false,
  } };
const environment = { ...process.env, MEMMY_WINDOWS_HISTORY_TEST_BIN_DIR: "",
  MEMMY_WINDOWS_HISTORY_TEST_ARTIFACTS: path.join(directory, "native-artifacts") };
const writeReport = () => fs.writeFileSync(path.join(directory, "results.json"), JSON.stringify(report, null, 2) + "\n");
function binary(cwd, name) {
  const [dependency, ...relative] = name.split("/");
  const manifest = createRequire(path.join(cwd, "package.json")).resolve(`${dependency}/package.json`);
  return path.join(path.dirname(manifest), ...relative);
}

function run(name, cwd, args, env = environment) {
  console.log(`\n[History] ${name}`);
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", windowsHide: true,
    timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  const log = path.join(directory, `${name}.log`);
  fs.writeFileSync(log, (result.stdout ?? "") + (result.stderr ?? "") + (result.error?.message ?? ""));
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  report.stages.push({ name, exitCode: result.status, signal: result.signal, elapsedMs: Date.now() - started, log });
  writeReport();
  if (result.error || result.status !== 0) throw new Error(`${name} failed; see ${log}`);
}

function tests(name, cwd, files, env = environment) {
  const output = path.join(directory, `${name}.json`);
  try {
    run(name, cwd, [binary(cwd, "vitest/vitest.mjs"), "run", ...files, "--maxWorkers=2",
      "--reporter=default", "--reporter=json", `--outputFile=${output}`], env);
  } finally {
    if (fs.existsSync(output)) {
      const result = JSON.parse(fs.readFileSync(output, "utf8"));
      Object.assign(report.stages.at(-1), {
        testReport: output, passed: result.numPassedTests, failed: result.numFailedTests,
        skipped: result.numPendingTests,
        skippedTests: result.testResults.flatMap((file) => file.assertionResults
          .filter((test) => test.status === "pending" || test.status === "skipped" || test.status === "todo")
          .map((test) => ({ file: path.relative(root, file.name), name: test.fullName }))),
      });
    }
    writeReport();
  }
}

try {
  console.log(`[History] Evidence: ${directory}`);
  for (const [relative, config] of [["Knowledge", "tsconfig.json"], ["Migrations", "tsconfig.build.json"],
    ["App/backend/local-api-contracts", "tsconfig.json"], ["App/shell/desktop/interface", "tsconfig.json"]]) {
    const cwd = path.join(root, relative);
    run(`build-${path.basename(relative)}`, cwd, [binary(cwd, "typescript/bin/tsc"), "-p", config]);
  }
  run("agent-types", agent, [binary(agent, "typescript/bin/tsc"), "-p", "tsconfig.json", "--noEmit"]);
  run("agent-build", agent, [binary(agent, "typescript/bin/tsc"), "-p", "tsconfig.build.json"]);
  run("frontend-types", frontend, [binary(frontend, "typescript/bin/tsc"), "-p", "tsconfig.json", "--noEmit"]);
  run("agent-lint", agent, [binary(agent, "eslint/bin/eslint.js"),
    "src/tools/computer-recordings/**/*.ts", "tests/tools/computer-recordings/**/*.ts",
    "src/tools/computer-history/**/*.ts", "tests/tools/computer-history/**/*.ts",
    "src/tools/computer-use/extract-workflow-candidate.ts", "tests/tools/computer-use/extract-workflow-candidate.test.ts",
    "src/integrations/channels/websocket.ts", "tests/integrations/channels/websocket-computer-history-routes.test.ts",
    "tests/core/agent-runtime/skills-loader.test.ts"]);
  const frontendTests = ["src/app/tests/computer-history-model-sync.test.tsx",
    "src/pages/tests/task-recordings.interaction.test.tsx",
    ...["computer-history-platform", "computer-history-sub-page", "computer-history-permission-guide", "windows-history-settings"]
      .map((name) => `src/pages/tests/${name}.interaction.test.tsx`), "src/pages/tests/computer-history-quota.test.tsx"];
  run("frontend-lint", frontend, [binary(frontend, "eslint/bin/eslint.js"),
    "src/api/computer-recordings-client.ts", "src/pages/memory/task-recordings.tsx",
    "src/api/computer-history-contract.ts", "src/api/memmy-agent-client.ts", "src/app/computer-history-platform.ts",
    "src/app/computer-history-model-sync.ts", "src/i18n/messages.ts",
    ...["app-icon", "computer-history-sub-page", "computer-history-recording-confirmation", "windows-history-settings"]
      .map((name) => `src/pages/memory/${name}.tsx`), ...frontendTests]);
  // Exclude native capture independently of ambient environment variables.
  tests("agent-tests", agent, ["tests/tools/computer-history", "tests/tools/computer-use/extract-workflow-candidate.test.ts",
    "tests/tools/computer-recordings",
    "tests/core/agent-runtime/skills-loader.test.ts", "tests/integrations/channels/websocket-computer-history-routes.test.ts",
    `--exclude=${nativeTest}`]);
  tests("frontend-tests", frontend, frontendTests);
  tests("recording-media-proxy-tests", root, ["App/shell/desktop/tests/recording-media-proxy.test.ts", "App/shell/desktop/tests/task-recording-exit.test.ts"]);
  tests("contract-packaging-tests", root, ["tests/computer-history-contract.test.ts", "tests/computer-history-packaging.test.mjs",
    "tests/computer-history-windows-packaging.test.mjs", "tests/windows-history-workflow.test.ts"],
  { ...environment, ...(options["--native-bin"] ? { MEMMY_WINDOWS_HISTORY_TEST_BIN_DIR: options["--native-bin"] } : {}) });
  for (const platform of ["core", "mac"]) {
    run(`summary-cli-${platform}`, agent, [`dist/tools/computer-history/${platform}/summarize-history.js`, "--help"]);
  }
  if (options["--native-bin"]) {
    tests("native-lifecycle-tests", agent, [nativeTest, "-t",
      "runs the product service|starts, pauses, resumes|ends on the bounded duration"],
    { ...environment, MEMMY_WINDOWS_HISTORY_TEST_BIN_DIR: options["--native-bin"] });
  }
  run("frontend-build", frontend, [binary(frontend, "vite/bin/vite.js"), "build"]);
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  console.error(`[History] ${error.message}`);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  writeReport();
  console.log(`[History] ${report.status}; evidence: ${directory}`);
  console.log("[History] Skips remain explicit. This baseline is not foreground capture or installed-App acceptance.");
}
