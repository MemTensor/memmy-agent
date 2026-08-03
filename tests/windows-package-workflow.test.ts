import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const workflowPath = resolve(import.meta.dirname, "../.github/workflows/windows-package.yml");
const source = readFileSync(workflowPath, "utf8");
const workflow = YAML.parse(source);
const packageJob = workflow.jobs.package;
const steps = packageJob.steps as Array<Record<string, unknown>>;

describe("Windows package workflow", () => {
  it("only auto-runs on isolated package branches", () => {
    expect(workflow.on.push.branches).toEqual(["actions/windows-package/**"]);
    expect(workflow.on.workflow_dispatch).toEqual({});
    expect(workflow.on.pull_request_target).toBeUndefined();
  });

  it("uses a Windows runner with read-only repository access", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(packageJob["runs-on"]).toBe("windows-latest");
    expect(packageJob.defaults.run.shell).toBe("bash");
  });

  it("builds the existing unsigned China package and uploads only its artifact", () => {
    const build = steps.find((step) => step.name === "Build unsigned Windows x64 China installer");
    const upload = steps.find((step) => step.name === "Upload installer artifact");
    expect(build?.run).toBe("npm run package:win:x64:cn:unsigned");
    expect(upload?.uses).toBe("actions/upload-artifact@v4");
    expect(JSON.stringify(upload?.with)).toContain("Memmy-*-win32-x64-cn-unsigned.exe");
    expect(JSON.stringify(upload?.with)).not.toContain("-cn-signed.exe");
  });
});
