import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = resolve(import.meta.dirname, "..");
const workflowPath = resolve(repoRoot, ".github/workflows/yunxiao-github-sync.yml");
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = YAML.parse(workflowSource) as Record<string, any>;
const runStep = workflow.jobs.sync.steps.find(
  (step: Record<string, unknown>) => step.name === "Run sync",
);

function runSyncStep({
  eventName,
  mode = "",
  state = "",
  apply = "",
}: {
  eventName: string;
  mode?: string;
  state?: string;
  apply?: string;
}): string[] {
  const expressions: Record<string, string> = {
    "github.event_name": eventName,
    "inputs.mode": mode,
    "inputs.state": state,
    "inputs.apply": apply,
  };
  const script = runStep.run.replace(
    /\$\{\{\s*([^}]+?)\s*\}\}/g,
    (_match: string, expression: string) => {
      const key = expression.trim();
      if (!Object.hasOwn(expressions, key)) {
        throw new Error(`Unexpected workflow expression: ${key}`);
      }
      return expressions[key];
    },
  );
  const directory = mkdtempSync(join(tmpdir(), "memmy-yunxiao-workflow-"));
  try {
    // Capture the real shell invocation without executing the sync or its APIs.
    writeFileSync(join(directory, "python"), '#!/bin/sh\nprintf \'%s\\0\' "$@"\n', {
      mode: 0o755,
    });
    const output = execFileSync("bash", ["-c", script], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
    return output.split("\0").slice(0, -1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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

  it("provides preflight, backfill, and title-only migration controls", () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.mode.options).toEqual(["preflight", "backfill", "rename-titles"]);
    expect(inputs.state.options).toEqual(["open", "all"]);
    expect(inputs.apply.type).toBe("boolean");
    expect(workflow.jobs.sync.steps.at(-1).run).toContain("--dry-run");
  });

  it.each(["backfill", "rename-titles"])(
    "executes %s in dry-run mode when apply is false or omitted",
    (mode) => {
      for (const apply of ["false", ""]) {
        expect(
          runSyncStep({ eventName: "workflow_dispatch", mode, state: "open", apply }),
        ).toEqual([
          "scripts/yunxiao_github_sync.py",
          "--mode",
          mode,
          "--state",
          "open",
          "--dry-run",
        ]);
      }
    },
  );

  it.each(["backfill", "rename-titles"])(
    "executes %s with writes only when apply is true",
    (mode) => {
      expect(
        runSyncStep({ eventName: "workflow_dispatch", mode, state: "all", apply: "true" }),
      ).toEqual([
        "scripts/yunxiao_github_sync.py",
        "--mode",
        mode,
        "--state",
        "all",
        "--apply",
      ]);
    },
  );

  it.each(["issues", "pull_request_target"])(
    "keeps %s lifecycle events in apply mode",
    (eventName) => {
      expect(runSyncStep({ eventName })).toEqual([
        "scripts/yunxiao_github_sync.py",
        "--mode",
        "event",
        "--apply",
      ]);
    },
  );

  it("keeps preflight read-only even when apply is true", () => {
    expect(
      runSyncStep({
        eventName: "workflow_dispatch",
        mode: "preflight",
        state: "open",
        apply: "true",
      }),
    ).toEqual([
      "scripts/yunxiao_github_sync.py",
      "--mode",
      "preflight",
      "--state",
      "open",
    ]);
  });

  it("routes each repository through its own Yunxiao mapping variables", () => {
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
