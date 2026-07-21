import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const workflowPath = resolve(import.meta.dirname, "../.github/workflows/github-release.yml");
const repoRoot = resolve(import.meta.dirname, "..");
const source = readFileSync(workflowPath, "utf8");
const workflow = YAML.parse(source);
const releaseJob = workflow.jobs.release;
const steps = releaseJob.steps as Array<Record<string, unknown>>;
const script = (name: string) => String(steps.find((step) => step.name === name)?.run ?? "");
const packagingConfigs = [
  "electron-builder.yml",
  "electron-builder.unsigned.yml",
  "electron-builder.win.yml",
  "electron-builder.win.unsigned.yml",
];

describe("GitHub release workflow", () => {
  it("only automatically handles merged release/vX.Y.Z PRs targeting main", () => {
    expect(workflow.on.pull_request).toEqual({ types: ["closed"], branches: ["main"] });
    expect(releaseJob.if).toContain("github.event.pull_request.merged == true");
    expect(releaseJob.if).toContain("startsWith(github.event.pull_request.head.ref, 'release/v')");
    expect(script("Resolve and validate release")).toContain(
      "^release/v((0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*))$",
    );
  });

  it("supports a strictly validated manual version and resolves main", () => {
    expect(workflow.on.workflow_dispatch.inputs.version.required).toBe(true);
    const resolveScript = script("Resolve and validate release");
    expect(resolveScript).toContain('version="$MANUAL_VERSION"');
    expect(resolveScript).toContain("git/ref/heads/main");
    expect(resolveScript).toContain(
      "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$",
    );
  });

  it("binds the tag to the merged commit and refuses existing releases", () => {
    const resolveScript = script("Resolve and validate release");
    expect(resolveScript).toContain('target_sha="$PR_MERGE_SHA"');
    expect(steps.find((step) => step.name === "Check out the exact release commit")?.with).toEqual(
      expect.objectContaining({ ref: "${{ steps.release.outputs.target_sha }}" }),
    );
    const duplicateCheck = script("Check for an existing tag or release");
    expect(duplicateCheck).toContain("git ls-remote --exit-code --tags");
    expect(duplicateCheck).toContain('gh release view "$TAG"');
    expect(duplicateCheck).not.toContain("--force");
  });

  it("downloads all four OSS artifacts and verifies Content-MD5", () => {
    const download = script("Download and verify OSS artifacts");
    expect(download).toContain("curl --fail --location --retry 5 --retry-all-errors");
    expect(download).toContain("Content-MD5");
    expect(download).toContain('test -s "release-assets/$artifact"');
    expect(download.match(/Memmy-\$VERSION-/g)).toHaveLength(4);
    expect(download).toContain("MD5SUMS.txt");
    expect(download).toContain("SHA256SUMS.txt");
  });

  it("composes notes and only publishes after the draft assets upload", () => {
    const notes = script("Build release notes");
    expect(notes).toContain('.github/release-notes/$TAG.md');
    expect(notes).toContain("releases/generate-notes");
    expect(notes).toContain("## Downloads");
    expect(notes).toContain("## Installation");
    expect(notes).toContain("## Checksums");

    const createIndex = steps.findIndex((step) => step.name === "Create draft release and upload every asset");
    const publishIndex = steps.findIndex((step) => step.name === "Publish release as latest");
    expect(script("Create draft release and upload every asset")).toContain("--draft");
    expect(script("Create draft release and upload every asset")).toContain("gh release upload");
    expect(script("Publish release as latest")).toContain("--draft=false --latest");
    expect(publishIndex).toBeGreaterThan(createIndex);
  });

  it("allows versioned manual release notes to be tracked", () => {
    const result = spawnSync(
      "git",
      ["check-ignore", "--quiet", "--no-index", ".github/release-notes/v1.2.3.md"],
      { cwd: repoRoot },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
  });

  it("uses the release environment, minimal permissions, and per-version concurrency", () => {
    expect(workflow.permissions).toEqual({ contents: "write" });
    expect(releaseJob.environment).toBe("release");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
    expect(workflow.concurrency.group).toContain("inputs.version");
    expect(workflow.concurrency.group).toContain("pull_request.head.ref");
  });

  it("does not embed a repository .env file in desktop installers", () => {
    for (const config of packagingConfigs) {
      const packagingSource = readFileSync(
        resolve(import.meta.dirname, `../App/shell/desktop/${config}`),
        "utf8",
      );
      expect(packagingSource).not.toMatch(/from:\s+.*\.env(?:\s|$)/);
      expect(packagingSource).not.toMatch(/to:\s+\.env(?:\s|$)/);
    }
  });
});
