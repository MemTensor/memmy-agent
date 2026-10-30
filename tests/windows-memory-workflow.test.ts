import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const path = resolve(import.meta.dirname, "../.github/workflows/windows-memory-validation.yml");
const source = existsSync(path) ? readFileSync(path, "utf8") : "{}";
const workflow = YAML.parse(source);
const job = workflow.jobs?.validate ?? {};
interface WorkflowStep {
  id?: string;
  uses?: string;
  run?: string;
  shell?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  if?: unknown;
  "continue-on-error"?: boolean;
}
const steps = (job.steps ?? []) as WorkflowStep[];
const powershell = process.platform === "win32" ? "pwsh.exe" : "pwsh";
const hasPowerShell = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8" }).status === 0;

describe("Windows Memory validation workflow", () => {
  it("validates PRs and manual runs without release permissions or persisted credentials", () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(["pull_request", "workflow_dispatch"]);
    expect(workflow.on.pull_request.paths).toEqual(expect.arrayContaining([
      ".github/workflows/windows-memory-validation.yml",
      "tests/windows-memory-workflow.test.ts",
      "Memory/**",
      "Memory/AgentSourceCore/**",
      "package-lock.json",
    ]));
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(source).not.toMatch(/secrets\.|github\.token|gh release|npm publish|action-gh-release|memory-release\.yml/);
  });

  it("pins Windows 2025 and Node 22 x64 for native process and task behavior", () => {
    expect(job["runs-on"]).toBe("windows-2025");
    const setupNode = steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
    expect(String(setupNode?.with?.["node-version"])).toBe("22");
    expect(setupNode?.with?.architecture).toBe("x64");
  });

  it("requires an interactive session and opts into actual native tests without accepting skips", () => {
    const preflightIndex = steps.findIndex((step) => step.id === "interactive-session");
    const nativeIndex = steps.findIndex((step) => String(step.run ?? "").includes("Memory/tests/runtime-installer-windows.integration.test.ts"));
    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(nativeIndex).toBeGreaterThan(preflightIndex);
    const preflight = steps[preflightIndex]!;
    expect(preflight.shell ?? job.defaults?.run?.shell).toBe("pwsh");
    for (const check of ["[Environment]::UserInteractive", ".SessionId", "quser.exe", "Active", "throw"]) {
      expect(preflight.run).toContain(check);
    }
    expect(preflight.if).toBeUndefined();
    expect(preflight["continue-on-error"]).toBeUndefined();
    const native = steps[nativeIndex]!;
    expect(native.env?.MEMMY_WINDOWS_SERVICE_INTEGRATION).toBe("1");
    expect(native.if).toBeUndefined();
    expect(native["continue-on-error"]).toBeUndefined();
    expect(native.run).toContain("--reporter=json");
    expect(native.run).toContain("$LASTEXITCODE -ne 0");
    expect(native.run).toContain("$report.numTotalTests -lt 1");
    expect(native.run).toContain("$report.numPendingTests -ne 0");
    expect(native.run).toContain("$report.numPassedTests -ne $report.numTotalTests");
    expect(native.run).toContain("throw");
    expect(steps.some((step) => String(step.run ?? "").includes("Memory/tests/runtime-installer-windows.test.ts"))).toBe(true);
  });
});

describe.skipIf(process.platform !== "win32" && !hasPowerShell)("Windows session preflight behavior", () => {
  const activeOutput = " USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME\n>runneradmin           console             2  Active      none   9/7/2026 7:15 AM";

  it.each([
    { name: "accepts the active session using the direct query even when the wrapper fails", output: activeOutput, exitCode: 0, accepted: true },
    { name: "rejects a failed native query despite apparently active output", output: activeOutput, exitCode: 1, accepted: false },
    { name: "rejects a disconnected session", output: activeOutput.replace("Active", "Disc"), exitCode: 0, accepted: false },
    { name: "rejects a different session", output: activeOutput.replace("2  Active", "3  Active"), exitCode: 0, accepted: false },
    { name: "rejects empty output", output: "", exitCode: 0, accepted: false },
  ])("$name", ({ output, exitCode, accepted }) => {
    const preflight = steps.find((step) => step.id === "interactive-session")!.run!;
    const queryStart = preflight.indexOf("$sessions =");
    const runtimeCheck = preflight.indexOf("node -e");
    expect(queryStart).toBeGreaterThanOrEqual(0);
    expect(runtimeCheck).toBeGreaterThan(queryStart);
    // Execute the workflow's actual PowerShell decision with controlled native
    // query output, including the active session shown in the failing CI log.
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$sessionId = 2",
      "$fixture = $env:MEMMY_TEST_SESSION_QUERY | ConvertFrom-Json",
      "function query.exe { $global:LASTEXITCODE = 1; $fixture.output }",
      "function quser.exe { param([int]$id) if ($id -ne $sessionId) { throw 'Wrong query session' }; $global:LASTEXITCODE = $fixture.exitCode; $fixture.output }",
      "try {",
      preflight.slice(queryStart, runtimeCheck),
      "exit 0",
      "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
    ].join("\n");
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, MEMMY_TEST_SESSION_QUERY: JSON.stringify({ output, exitCode }) },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(accepted ? 0 : 1);
  });
});


// Execute the producer's actual inline JavaScript with controlled provider and
// native-process boundaries. No fixture result is uploaded as provider evidence.
const historyPath = resolve(import.meta.dirname, "../.github/workflows/windows-computer-history-validation.yml");
const historySource = readFileSync(historyPath, "utf8");
const historyWorkflow = YAML.parse(historySource);
const historySteps = historyWorkflow.jobs.validate.steps as WorkflowStep[];
const historyStep = (id: string) => historySteps.find(step => step.id === id)!;
const candidateSha = "a".repeat(40);
const callerSha = "b".repeat(40);
const requiredWindowsSteps = ["source", "exact-head", "windows-os", "workspace-dependencies", "agent-dependencies",
  "native-go", "computer-use-go", "source-build", "app-icons", "native-runtime", "history-contracts", "packaged-assets", "installer-boundary"];
const passedWindowsSteps = () => Object.fromEntries(requiredWindowsSteps.map(id => [id, { outcome: "success", conclusion: "success" }]));

function executeHistoryStep(id: string, overrides: Record<string, string> = {}, actualHead = candidateSha, platform = "win32", release = "10.0.26100", dirty = false) {
  const writes = new Map<string, string>();
  const env = {
    INPUT_SOURCE_SHA: candidateSha, EVENT_NAME: "workflow_dispatch", EVENT_SHA: callerSha,
    PR_HEAD_SHA: candidateSha, PR_HEAD_REPOSITORY: "MemTensor/memmy-agent",
    SOURCE_REPOSITORY: "MemTensor/memmy-agent", CANDIDATE_REPOSITORY: "MemTensor/memmy-agent",
    CONTROLLER_WORKFLOW_REF: "MemTensor/memmy-agent/.github/workflows/main-sync.yml@refs/heads/main",
    CONTROLLER_WORKFLOW_SHA: callerSha, GITHUB_OUTPUT: "/output", RUNNER_TEMP: "/runner-temp",
    EXPECTED_HEAD_SHA: candidateSha, SOURCE_MODE: "workflow_call", RECEIPT_ALLOWED: "true", PROVIDER_RUN_ID: "12345", PROVIDER_RUN_ATTEMPT: "2",
    VALIDATION_STEPS: JSON.stringify(passedWindowsSteps()), ...overrides,
  };
  const modules: Record<string, unknown> = {
    "node:fs": {
      appendFileSync: (file: string, value: string) => writes.set(file, (writes.get(file) ?? "") + value),
      writeFileSync: (file: string, value: string) => writes.set(file, value), mkdirSync: () => {},
    },
    "node:path": { join: (...parts: string[]) => parts.join("/") },
    "node:os": { platform: () => platform, release: () => release, arch: () => "x64" },
    "node:child_process": { execFileSync: (command: string, args: string[]) => {
      expect(command).toBe("git");
      if (args[0] === "diff") { if (dirty) throw new Error("Tracked source changed"); return ""; }
      expect(args).toEqual(["rev-parse", "HEAD"]); return actualHead + "\n";
    } },
  };
  let error: unknown;
  try { runInNewContext(historyStep(id).run!, { process: { env }, require: (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected module ${name}`); return modules[name];
  } }); } catch (caught) { error = caught; }
  return { writes, error };
}

const receipts = (result: ReturnType<typeof executeHistoryStep>) => [...result.writes.entries()]
  .filter(([file]) => file.includes(`/windows-provider-receipt-${candidateSha}-`) && file.endsWith("windows-provider-receipt.json"));
const legacyReceipts = (result: ReturnType<typeof executeHistoryStep>) => [...result.writes.entries()]
  .filter(([file]) => file.includes(`/windows-provider-receipt-legacy-${candidateSha}-`) && file.endsWith("windows-provider-receipt.json"));

describe("Windows History reusable provider source contract", () => {
  it("keeps PR/manual entry points and adds a required exact-SHA reusable input", () => {
    expect(Object.keys(historyWorkflow.on).sort()).toEqual(["pull_request", "workflow_call", "workflow_dispatch"]);
    expect(historyWorkflow.on.workflow_call.inputs.source_sha).toMatchObject({ required: true, type: "string" });
    expect(historyWorkflow.on.pull_request.paths).toContain("tests/windows-memory-workflow.test.ts");
    expect(historyWorkflow.permissions).toEqual({ contents: "read" });
    expect(historyWorkflow.jobs.validate.permissions).toBeUndefined();
    expect(historySource).not.toMatch(/secrets\.|github\.token|pull_request_target|contents: write|actions: write/);
    const checkout = historySteps.find(step => step.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.with).toMatchObject({ ref: "${{ steps.source.outputs.sha }}", "persist-credentials": false });
    expect(historySteps.indexOf(historyStep("source"))).toBeLessThan(historySteps.indexOf(checkout));
    expect(historySteps.indexOf(historyStep("exact-head"))).toBeGreaterThan(historySteps.indexOf(checkout));
  });

  it.each(["github-draft-release-v2.yml", "main-sync.yml", "main-sync-validation.yml"])("binds nested reusable %s to input SHA instead of caller github.sha", caller => {
    const result = executeHistoryStep("source", { CONTROLLER_WORKFLOW_REF: `MemTensor/memmy-agent/.github/workflows/${caller}@refs/heads/main` });
    expect(result.error).toBeUndefined();
    expect(result.writes.get("/output")).toBe(`sha=${candidateSha}\nmode=workflow_call\nrepository=MemTensor/memmy-agent\nreceipt_allowed=true\n`);
  });

  it.each(["pull_request", "workflow_dispatch"])("binds the %s source SHA without reusable input", event => {
    const result = executeHistoryStep("source", { INPUT_SOURCE_SHA: "", EVENT_NAME: event, CONTROLLER_WORKFLOW_REF: "MemTensor/memmy-agent/.github/workflows/windows-computer-history-validation.yml@refs/heads/main" });
    expect(result.error).toBeUndefined();
    const expected = event === "pull_request" ? candidateSha : callerSha;
    expect(result.writes.get("/output")).toBe(`sha=${expected}\nmode=${event}\nrepository=MemTensor/memmy-agent\nreceipt_allowed=true\n`);
  });

  it.each(["a".repeat(39), "g".repeat(40), "refs/heads/main", candidateSha + "\n", "$(echo attack)"])("rejects invalid candidate %j before checkout", value => {
    const result = executeHistoryStep("source", { INPUT_SOURCE_SHA: value });
    expect(result.error).toBeDefined(); expect(result.writes.size).toBe(0);
  });

  it.each([
    { SOURCE_REPOSITORY: "fork/memmy-agent" },
    { CONTROLLER_WORKFLOW_REF: "fork/memmy-agent/.github/workflows/main-sync.yml@refs/heads/main" },
    { CONTROLLER_WORKFLOW_REF: "MemTensor/memmy-agent/.github/workflows/main-sync.yml@refs/heads/candidate" },
    { CONTROLLER_WORKFLOW_REF: "MemTensor/memmy-agent/.github/workflows/other.yml@refs/heads/main" },
    { CONTROLLER_WORKFLOW_SHA: "short" },
    { INPUT_SOURCE_SHA: "", EVENT_NAME: "workflow_run" },
    { INPUT_SOURCE_SHA: "", EVENT_NAME: "workflow_dispatch" },
  ])("rejects untrusted or unbound reusable invocation %j", overrides => {
    const result = executeHistoryStep("source", overrides);
    expect(result.error).toBeDefined(); expect(result.writes.size).toBe(0);
  });

  it("fails exact checkout mismatch before native validation", () => {
    const result = executeHistoryStep("exact-head", {}, callerSha);
    expect(result.error).toBeDefined(); expect(result.writes.size).toBe(0);
  });
  it("binds the authoritative fork head repository", () => {
    const result = executeHistoryStep("source", { INPUT_SOURCE_REPOSITORY: "Fixture/memmy-agent" });
    expect(result.error).toBeUndefined();
    expect(result.writes.get("/output")).toContain("repository=Fixture/memmy-agent\n");
    expect(result.writes.get("/output")).toContain("receipt_allowed=true\n");
    expect(historySteps.find(step => step.uses?.startsWith("actions/checkout@"))?.with?.repository)
      .toBe("${{ steps.source.outputs.repository }}");
  });
  it("validates a direct fork PR without issuing a trusted receipt", () => {
    const result = executeHistoryStep("source", { INPUT_SOURCE_SHA: "", EVENT_NAME: "pull_request",
      PR_HEAD_REPOSITORY: "Fixture/memmy-agent",
      CONTROLLER_WORKFLOW_REF: "MemTensor/memmy-agent/.github/workflows/windows-computer-history-validation.yml@refs/heads/main" });
    expect(result.error).toBeUndefined();
    expect(result.writes.get("/output")).toContain(`sha=${candidateSha}\nmode=pull_request\nrepository=Fixture/memmy-agent\nreceipt_allowed=false\n`);
    expect(historyStep("provider-receipt").if).toBe("${{ success() && steps.source.outputs.receipt_allowed == 'true' }}");
  });
});

describe("Windows History provider completion contract", () => {
  it("requires every existing native and package check without soft failures", () => {
    expect(historyWorkflow.jobs.validate["runs-on"]).toBe("windows-2025");
    for (const id of requiredWindowsSteps) {
      expect(historyStep(id), id).toBeDefined();
      expect(historyStep(id).if).toBeUndefined();
      expect(historyStep(id)["continue-on-error"]).toBeUndefined();
    }
    expect(historyStep("native-go").run).toContain("go test ./...");
    expect(historyStep("native-go").run).toContain("go vet -unsafeptr=false ./...");
    expect(historyStep("computer-use-go").run).toContain("go test ./...");
    expect(historyStep("computer-use-go").run).toContain("go vet ./...");
    expect(historyStep("history-contracts").run).toContain("tests/windows-memory-workflow.test.ts");
    for (const id of ["workspace-dependencies", "agent-dependencies", "native-go", "source-build", "app-icons", "native-runtime", "history-contracts", "packaged-assets", "installer-boundary"]) {
      expect(historyStep(id).run, id).toContain("$LASTEXITCODE -ne 0");
    }
    expect(historyStep("native-runtime").run).toContain("$workerProbe.workerApiCompiled");
    expect(historyStep("native-runtime").run).toContain("$probe.pureSelfTest");
    expect(historyStep("native-runtime").run).toContain("$probe.desktopAccess -ne $false");
    expect(historyStep("provider-receipt").shell).toBe("node {0}");
    expect(historyStep("provider-receipt").if).toContain("steps.source.outputs.receipt_allowed == 'true'");
    const upload = historySteps.find(step => step.uses?.startsWith("actions/upload-artifact@"))!;
    expect(upload.if).toContain("steps.provider-receipt.outcome == 'success'");
    expect(upload.with?.["if-no-files-found"]).toBe("error");
    expect(upload.with?.name).toBe("${{ steps.provider-receipt.outputs.artifact_name }}");
    expect(historySteps.indexOf(historyStep("provider-receipt"))).toBeGreaterThan(historySteps.indexOf(historyStep("installer-boundary")));
  });

  it("writes an exact-head receipt only after complete Windows native validation", () => {
    const dirty = executeHistoryStep("provider-receipt", {}, candidateSha, "win32", "10.0.26100", true);
    expect(dirty.error).toBeDefined(); expect(receipts(dirty)).toHaveLength(0);
    const result = executeHistoryStep("provider-receipt");
    expect(result.error).toBeUndefined(); expect(receipts(result)).toHaveLength(1);
    const [file, json] = receipts(result)[0]!;
    expect(file).toContain(`windows-provider-receipt-${candidateSha}-2/`);
    expect(JSON.parse(json)).toMatchObject({ provider: "windows", status: "passed", headSha: candidateSha,
      runId: "12345", runAttempt: 2, workflow_sha: callerSha,
      os: { platform: "win32", build: 26100, arch: "x64" },
      nativeModules: { windowsHistory: { goTests: "passed", goVet: "passed", workerSelfTest: "passed" } },
      liveCaptureValidated: false, signedInstallerValidated: false });
    expect(result.writes.get("/output")).toContain(`artifact_name=windows-provider-receipt-${candidateSha}-2`);
    expect(legacyReceipts(result)).toHaveLength(1);
    const legacy = JSON.parse(legacyReceipts(result)[0]![1]);
    expect(legacy).toMatchObject({ provider: "windows", status: "passed", headSha: candidateSha,
      workflowRef: "MemTensor/memmy-agent/.github/workflows/main-sync.yml@refs/heads/main",
      workflowSha: callerSha, runId: "12345", runAttempt: 2, runnerOS: "Windows",
      runnerArch: "X64", windowsBuild: 26100, liveCaptureValidated: false, signedInstallerValidated: false,
      nativeModules: ["App/native-computer-history/apps/OpenComputerHistoryWindows", "App/native-computer-use/apps/OpenComputerUseWindows"] });
    expect(result.writes.get("/output")).toContain(`legacy_artifact_name=windows-provider-receipt-legacy-${candidateSha}-2`);
  });
  it("never writes either receipt when the source does not authorize it", () => {
    const result = executeHistoryStep("provider-receipt", { RECEIPT_ALLOWED: "false" });
    expect(result.error).toBeDefined();
    expect(result.writes.size).toBe(0);
  });

  it.each(requiredWindowsSteps)("does not emit passed receipt when %s is missing, skipped or failed", id => {
    for (const state of [undefined, { outcome: "skipped", conclusion: "skipped" },
      { outcome: "failure", conclusion: "success" }, { outcome: "success", conclusion: "failure" }]) {
      const steps = passedWindowsSteps() as Record<string, unknown>;
      if (state) steps[id] = state; else delete steps[id];
      const result = executeHistoryStep("provider-receipt", { VALIDATION_STEPS: JSON.stringify(steps) });
      expect(result.error).toBeDefined(); expect(receipts(result)).toHaveLength(0); expect(result.writes.size).toBe(0);
    }
  });

  it.each([
    { overrides: {}, head: callerSha },
    { overrides: { EXPECTED_HEAD_SHA: "short" } },
    { overrides: { PROVIDER_RUN_ATTEMPT: "0" } },
    { overrides: { PROVIDER_RUN_ID: "" } },
    { overrides: { CONTROLLER_WORKFLOW_SHA: "short" } },
    { overrides: {}, platform: "darwin" },
    { overrides: {}, release: "10.0.19045" },
  ])("does not issue provider success for invalid head/provider/OS %j", fixture => {
    const result = executeHistoryStep("provider-receipt", fixture.overrides, fixture.head, fixture.platform, fixture.release);
    expect(result.error).toBeDefined(); expect(receipts(result)).toHaveLength(0); expect(result.writes.size).toBe(0);
  });
});
