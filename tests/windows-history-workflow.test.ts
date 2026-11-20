import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, ".github/workflows/windows-history-native-validation.yml"), "utf8");
const workflow = YAML.parse(source);
const steps = workflow.jobs.validate.steps as { uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown>; if?: string }[];

describe("Windows History validation workflow", () => {
  it("validates changes with read-only permissions and serial native tests before product validation", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(workflow.on.push.branches).toEqual(["pxlin/dev", "integrate/**", "feature/windows-history-native-core"]);
    expect(workflow.on.pull_request.paths).toContain("App/memmy-agent/**");
    expect(workflow.jobs.validate["runs-on"]).toBe("windows-2025");
    expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["persist-credentials"]).toBe(false);
    const build = steps.findIndex((step) => step.run?.includes("history-recorder-native.ps1"));
    const native = steps.findIndex((step) => step.run?.includes("& $ctest --test-dir"));
    const product = steps.findIndex((step) => step.run?.includes("validate-computer-history.mjs"));
    expect(native).toBeGreaterThan(build); expect(product).toBeGreaterThan(native);
    expect(steps[native]!.run).toContain("--parallel 1");
    expect(steps[native]!.run).toContain("--output-junit");
    expect(steps[product]!.run).toContain("--native-bin");
    expect(steps[product]!.env).toEqual({
      MEMMY_LEGAL_CN_BASE_URL: "https://memmy.cn",
      MEMMY_LEGAL_INTL_BASE_URL: "https://memmy.bot",
    });
    expect(steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))?.if).toContain("always()");
  });
});

const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const hasPowerShell = spawnSync(powershell, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { windowsHide: true }).status === 0;
describe.skipIf(!hasPowerShell)("CTest evidence reporting", () => {
  it.each([
    { name: "records desktop skips separately from passing tests", failed: false, skipMandatory: false, accepted: true },
    { name: "fails when a native case fails", failed: true, skipMandatory: false, accepted: false },
    { name: "fails when metadata validation is skipped", failed: false, skipMandatory: true, accepted: false },
  ])("$name", ({ failed, skipMandatory, accepted }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "history-ci-report-"));
    try {
      const report = path.join(directory, "results.xml"), output = path.join(directory, "summary.json");
      fs.writeFileSync(report, `<testsuite>${["unit", "win.boundaries", "win.metadata", "integration.cli_contract", "task_video.media_integrity"].map((name) =>
        `<testcase name="${name}">${skipMandatory && name === "win.metadata" ? "<skipped/>" : ""}</testcase>`).join("")}
        <testcase name="integration.snapshot_content"><skipped/></testcase>
        <testcase name="integration.other">${failed ? "<failure/>" : ""}</testcase></testsuite>`);
      const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-File", path.join(root, "scripts/internal/win/history-validation-report.ps1"),
        "-Report", report, "-Output", output], { encoding: "utf8", windowsHide: true, timeout: 10000,
        env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(accepted ? 0 : 1);
      const summary = JSON.parse(fs.readFileSync(output, "utf8"));
      expect(summary.total).toBe(7); expect(summary.skipped).toBe(skipMandatory ? 2 : 1);
      expect(summary.failed).toBe(failed ? 1 : 0);
      expect(summary.skippedTests).toContain("integration.snapshot_content");
      expect(summary.passed + summary.failed + summary.skipped).toBe(summary.total);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
