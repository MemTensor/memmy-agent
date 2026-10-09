import { existsSync, readFileSync } from "node:fs";
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
      "AgentSourceCore/**",
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
