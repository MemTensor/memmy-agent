import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = resolve(import.meta.dirname, "..");
const workflowPath = resolve(repoRoot, ".github/workflows/yunxiao-github-sync.yml");
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = YAML.parse(workflowSource) as Record<string, any>;

describe("GitHub to Yunxiao sync workflow", () => {
  it("handles issue and trusted pull request lifecycle events", () => {
    expect(workflow.on.issues.types).toEqual(["opened", "closed", "reopened"]);
    expect(workflow.on.pull_request_target.types).toEqual([
      "opened",
      "closed",
      "reopened",
    ]);
    expect(workflow.on.pull_request).toBeUndefined();
  });

  it("provides preflight, dry-run backfill, and all-state backfill controls", () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.mode.options).toEqual(["preflight", "backfill"]);
    expect(inputs.state.options).toEqual(["open", "all"]);
    expect(inputs.apply.type).toBe("boolean");
    expect(workflow.jobs.sync.steps.at(-1).run).toContain("--dry-run");
  });

  it("routes each repository through its own Yunxiao mapping variables", () => {
    const runStep = workflow.jobs.sync.steps.find(
      (step: Record<string, unknown>) => step.name === "Run sync",
    );
    expect(runStep.env.YUNXIAO_PROJECT_ID).toContain("vars.YUNXIAO_PROJECT_ID");
    expect(runStep.env.YUNXIAO_PARENT_ID).toContain("vars.YUNXIAO_PARENT_ID");
    expect(runStep.env.YUNXIAO_SPRINT_ID).toContain("vars.YUNXIAO_SPRINT_ID");
    expect(runStep.env.YUNXIAO_PARTICIPANT_NAMES).toContain("vars.YUNXIAO_PARTICIPANT_NAMES");
    expect(runStep.env.YUNXIAO_TOKEN).toContain("secrets.YUNXIAO_TOKEN");
    expect(runStep.run).toContain("python scripts/yunxiao_github_sync.py");
    expect(runStep.env.YUNXIAO_PROJECT_ID).toContain("1832b179386e24414d3891e244");
    expect(runStep.env.YUNXIAO_PROJECT_NAME).toContain("'memmy'");
  });

  it("uses minimal read permissions and trusted checkout", () => {
    expect(workflow.permissions).toEqual({
      contents: "read",
      issues: "read",
      "pull-requests": "read",
    });
    const checkout = workflow.jobs.sync.steps.find(
      (step: Record<string, unknown>) => step.uses === "actions/checkout@v4",
    );
    expect(checkout.with["persist-credentials"]).toBe(false);
    expect(checkout.with.ref).toContain("default_branch");
  });
});
