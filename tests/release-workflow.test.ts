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
  it("uses the trusted base workflow for merged release/vX.Y.Z PRs targeting main", () => {
    expect(workflow.on.pull_request_target).toEqual({ types: ["closed"], branches: ["main"] });
    expect(workflow.on.pull_request).toBeUndefined();
    expect(releaseJob.if).toContain("github.event.pull_request.merged == true");
    expect(releaseJob.if).toContain("startsWith(github.event.pull_request.head.ref, 'release/v')");
    const resolveScript = script("Resolve and validate release");
    expect(resolveScript).toContain('if [[ "$EVENT_NAME" == "pull_request_target" ]]');
    expect(resolveScript).toContain(
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
    expect(script("Create draft release and upload every asset")).toContain(
      '--target "$TARGET_SHA"',
    );
    const duplicateCheck = script("Check for an existing tag or release");
    expect(duplicateCheck).toContain("git ls-remote --exit-code --tags");
    expect(duplicateCheck).toContain('gh release view "$TAG"');
    expect(duplicateCheck).not.toContain("--force");
  });

  it("keeps merged fork code out of the trusted release checkout", () => {
    const checkout = steps.find((step) => step.name === "Check out trusted base history");
    expect(checkout?.uses).toBe("actions/checkout@v4");
    expect(checkout?.with).toEqual({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(checkout?.with).not.toHaveProperty("ref");
    expect(JSON.stringify(checkout)).not.toContain("github.event.pull_request");
    expect(source).not.toContain("refs/pull/");
    expect(source).not.toContain("allow-unsafe-pr-checkout");

    const verifyScript = script("Verify target is on main");
    expect(verifyScript).toContain("git fetch --no-tags origin main");
    expect(verifyScript).toContain('git cat-file -e "$TARGET_SHA^{commit}"');
    const ancestorCheck = 'git merge-base --is-ancestor "$TARGET_SHA" origin/main';
    const detachTarget = 'git checkout --detach "$TARGET_SHA"';
    const verifyHead = 'test "$(git rev-parse HEAD)" = "$TARGET_SHA"';
    expect(verifyScript).toContain(ancestorCheck);
    expect(verifyScript).toContain(detachTarget);
    expect(verifyScript).toContain(verifyHead);
    expect(verifyScript.indexOf(detachTarget)).toBeGreaterThan(verifyScript.indexOf(ancestorCheck));
    expect(verifyScript.indexOf(verifyHead)).toBeGreaterThan(verifyScript.indexOf(detachTarget));

    const notesScript = script("Build release notes");
    expect(notesScript).toContain('manual_object="${TARGET_SHA}:${manual_notes}"');
    expect(notesScript).toContain('git show "$manual_object" > "$notes"');
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

  it("embeds the repository .env required by packaged desktop runtimes", () => {
    for (const config of packagingConfigs) {
      const packagingSource = readFileSync(
        resolve(import.meta.dirname, `../App/shell/desktop/${config}`),
        "utf8",
      );
      expect(packagingSource).toMatch(/from:\s+\.\.\/\.\.\/\.\.\/\.env(?:\s|$)/);
      expect(packagingSource).toMatch(/to:\s+\.env(?:\s|$)/);
    }
  });
});
