import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = resolve(import.meta.dirname, "..");
const legacyWorkflowPath = resolve(repoRoot, ".github/workflows/github-release.yml");
const draftWorkflowPath = resolve(repoRoot, ".github/workflows/github-draft-release-v2.yml");
const releaseCompareScriptPath = resolve(repoRoot, "scripts/build-release-compare.mjs");
const draftSource = readFileSync(draftWorkflowPath, "utf8");
const releaseCompareSource = readFileSync(releaseCompareScriptPath, "utf8");
const draftWorkflow = YAML.parse(draftSource);
const draftJob = draftWorkflow.jobs.release;
const draftSteps = draftJob.steps as Array<Record<string, unknown>>;
const draftScript = (name: string) =>
  String(draftSteps.find((step) => step.name === name)?.run ?? "");
const heredocBodies = (script: string, marker: string) => {
  const lines = script.split(/\r?\n/);
  const bodies: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes(`<<'${marker}'`)) continue;

    const body: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      if (lines[cursor] === marker) break;
      body.push(lines[cursor]);
    }

    expect(cursor, `unterminated heredoc ${marker}`).toBeLessThan(lines.length);
    bodies.push(body.join("\n"));
    index = cursor;
  }

  return bodies;
};
const packagingConfigs = [
  "electron-builder.yml",
  "electron-builder.unsigned.yml",
  "electron-builder.win.yml",
  "electron-builder.win.unsigned.yml",
];
const versionedManifests = [
  "Memory/package.json",
  "Memory/src/cli/npm/package.json",
  "App/memmy-agent/package.json",
  "App/shell/desktop/package.json",
];

function readJson(relativePath: string): {
  version?: string;
  packages?: Record<string, { version?: string }>;
} {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8"));
}

describe("Memmy release workflow metadata", () => {
  it("keeps every release manifest and lockfile aligned to the root version", () => {
    const version = readJson("package.json").version;

    for (const manifest of versionedManifests) {
      expect(readJson(manifest).version, manifest).toBe(version);
    }

    const rootLock = readJson("package-lock.json");
    expect(rootLock.version).toBe(version);
    expect(rootLock.packages?.[""].version).toBe(version);
    expect(rootLock.packages?.Memory.version).toBe(version);
    expect(rootLock.packages?.["App/shell/desktop"].version).toBe(version);

    const agentLock = readJson("App/memmy-agent/package-lock.json");
    expect(agentLock.version).toBe(version);
    expect(agentLock.packages?.[""].version).toBe(version);
  });

  it("removes the legacy workflow that published releases automatically", () => {
    expect(existsSync(legacyWorkflowPath)).toBe(false);
  });

  it("tracks release notes whose title matches the current project version", () => {
    const version = readJson("package.json").version;
    const notes = readFileSync(
      resolve(repoRoot, `.github/release-notes/v${version}.md`),
      "utf8",
    );

    expect(notes.split(/\r?\n/, 1)[0]).toBe(`# Memmy v${version}`);
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

  it("keeps repository and dependency env files outside packaged desktop artifacts", () => {
    for (const config of packagingConfigs) {
      const packagingSource = readFileSync(
        resolve(repoRoot, `App/shell/desktop/${config}`),
        "utf8",
      );
      expect(packagingSource).not.toMatch(/from:\s+\.\.\/\.\.\/\.\.\/\.env(?:\s|$)/);
      expect(packagingSource).not.toMatch(/to:\s+\.env(?:\s|$)/);
      expect(packagingSource).toContain('- "!**/.env"');
      expect(packagingSource).toContain('- "!**/.env.*"');
    }

    const macSource = readFileSync(resolve(repoRoot, "scripts/internal/mac/build-dmg.sh"), "utf8");
    const winSource = readFileSync(resolve(repoRoot, "scripts/internal/win/build-nsis.sh"), "utf8");
    for (const source of [macSource, winSource]) {
      expect(source).toContain("write-desktop-edition-manifest.mjs");
      expect(source).toContain("prune-runtime-env-files.mjs");
      expect(source).toContain("verify-package-version.mjs");
    }
  });
});

describe("GitHub Draft Release v2 workflow", () => {
  it("builds an uncapped, NUL-safe comparison from the trusted local Git graph", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "memmy-release-compare-"));
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: tempDir, encoding: "utf8" });

    expect(git(["init", "--initial-branch=main"]).status).toBe(0);
    expect(git(["config", "user.name", "Release Test"]).status).toBe(0);
    expect(git(["config", "user.email", "release-test@example.invalid"]).status).toBe(0);
    writeFileSync(resolve(tempDir, "base file.txt"), "base\n");
    expect(git(["add", "."]).status).toBe(0);
    expect(git(["commit", "-m", "base"]).status).toBe(0);
    const baseSha = git(["rev-parse", "HEAD"]).stdout.trim();

    for (let index = 0; index < 301; index += 1) {
      writeFileSync(resolve(tempDir, `bulk-${String(index).padStart(3, "0")}.txt`), `${index}\n`);
    }
    expect(git(["add", "."]).status).toBe(0);
    expect(git(["commit", "-m", "add more than 300 files"]).status).toBe(0);
    expect(git(["mv", "base file.txt", "renamed file.txt"]).status).toBe(0);
    writeFileSync(resolve(tempDir, "bulk-000.txt"), "updated\n");
    expect(git(["add", "."]).status).toBe(0);
    expect(git(["commit", "-m", "rename and update"]).status).toBe(0);
    const targetSha = git(["rev-parse", "HEAD"]).stdout.trim();
    const outputPath = resolve(tempDir, "compare.json");

    const result = spawnSync(
      "node",
      [
        releaseCompareScriptPath,
        "--base",
        baseSha,
        "--target",
        targetSha,
        "--repository",
        "MemTensor/memmy-agent",
        "--output",
        outputPath,
      ],
      { cwd: tempDir, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);

    const comparison = JSON.parse(readFileSync(outputPath, "utf8"));
    expect(comparison.total_commits).toBe(2);
    expect(comparison.commits).toHaveLength(2);
    expect(comparison.files).toHaveLength(302);
    expect(comparison.files).toContainEqual(
      expect.objectContaining({
        filename: "renamed file.txt",
        previous_filename: "base file.txt",
        status: "renamed",
      }),
    );
    expect(comparison.snapshot).toEqual({
      source: "local-git",
      complete: true,
      baseSha,
      targetSha,
      commitCount: 2,
      changedFileCount: 302,
    });

    expect(releaseCompareSource).toContain('"--reverse"');
    expect(releaseCompareSource).toContain('"--name-status", "-z"');
    expect(releaseCompareSource).toContain('"--numstat", "-z"');
    expect(releaseCompareSource).toContain('"merge-base", "--is-ancestor"');
  });

  it("keeps every shell block syntactically valid", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "memmy-release-workflow-"));

    for (const [index, step] of draftSteps.entries()) {
      const script = String(step.run ?? "");
      if (!script) continue;

      const scriptPath = resolve(tempDir, `step-${index}.sh`);
      writeFileSync(scriptPath, script);
      const result = spawnSync("bash", ["-n", scriptPath], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      expect(result.status, `${String(step.name)}\n${result.stderr}`).toBe(0);
    }
  });

  it("keeps embedded Node heredocs syntactically valid", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "memmy-release-workflow-node-"));
    const nodeHeredocs = draftSteps.flatMap((step) =>
      heredocBodies(String(step.run ?? ""), "NODE").map((body, index) => ({
        body,
        name: `${String(step.name)} heredoc ${index + 1}`,
      })),
    );

    expect(nodeHeredocs.length).toBeGreaterThan(0);

    for (const [index, heredoc] of nodeHeredocs.entries()) {
      const scriptPath = resolve(tempDir, `node-heredoc-${index}.cjs`);
      writeFileSync(scriptPath, heredoc.body);
      const result = spawnSync("node", ["--check", scriptPath], {
        cwd: repoRoot,
        encoding: "utf8",
      });

      expect(result.status, `${heredoc.name}\n${result.stderr}`).toBe(0);
    }
  });

  it("creates Draft Releases only from merged vX.Y.Z or release/vX.Y.Z PRs and keeps manual fallback", () => {
    expect(draftWorkflow.on.pull_request_target).toEqual({
      types: ["closed"],
      branches: ["main"],
    });
    expect(draftWorkflow.on.pull_request).toBeUndefined();
    expect(draftWorkflow.on.workflow_dispatch.inputs.version.required).toBe(true);
    expect(draftWorkflow.on.workflow_dispatch.inputs.target_sha.required).toBe(false);
    expect(draftWorkflow.on.workflow_dispatch.inputs.preflight_level.default).toBe("smoke");
    expect(draftWorkflow.on.workflow_dispatch.inputs.preflight_level.options).toEqual([
      "smoke",
      "full",
    ]);
    expect(draftWorkflow.on.workflow_dispatch.inputs.create_draft.default).toBe(false);
    const normalizedJobCondition = String(draftJob.if).replace(/\s+/g, " ").trim();
    expect(normalizedJobCondition).toBe(
      "github.event_name == 'workflow_dispatch' || " +
      "(github.event.pull_request.merged == true && " +
      "github.event.pull_request.head.repo.full_name == github.repository && " +
      "(startsWith(github.event.pull_request.head.ref, 'v') || " +
      "startsWith(github.event.pull_request.head.ref, 'release/v')))",
    );

    const resolve = draftScript("Resolve and validate release");
    expect(resolve).toContain('if [[ "$EVENT_NAME" == "pull_request_target" ]]');
    expect(resolve).toContain(
      "^(release/)?v((0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*))$",
    );
    expect(resolve).toContain("Release branch must match vX.Y.Z or release/vX.Y.Z");
    expect(resolve).toContain('version="${BASH_REMATCH[2]}"');
    expect(resolve).toContain('target_sha="$PR_MERGE_SHA"');
    expect(resolve).toContain('preflight_level="full"');
    expect(resolve).toContain('create_draft="true"');
    expect(resolve).toContain('version="$MANUAL_VERSION"');
    expect(resolve).toContain('if [[ "$CREATE_DRAFT_INPUT" == "true" ]]');
    expect(resolve).toContain('if [[ -n "$MANUAL_TARGET_SHA" ]]');
    expect(resolve).toContain('manual_target_sha_supplied="true"');
    expect(resolve).toContain("manual_target_sha_supplied=$manual_target_sha_supplied");
    expect(resolve).toContain("preflight_level=$preflight_level");
    expect(resolve).toContain("create_draft=$create_draft");
    expect(resolve).toContain("git/ref/heads/main");
  });

  it("uses trusted base code and checks out the merged main commit", () => {
    const checkout = draftSteps.find((step) => step.name === "Check out trusted base history");
    expect(checkout?.uses).toBe("actions/checkout@v4");
    expect(checkout?.with).toEqual({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(checkout?.with).not.toHaveProperty("ref");
    expect(JSON.stringify(checkout)).not.toContain("github.event.pull_request");
    expect(draftSource).not.toContain("refs/pull/");
    expect(draftSource).not.toContain("allow-unsafe-pr-checkout");

    const verify = draftScript("Verify target is on main");
    expect(verify).toContain("git fetch --no-tags origin main");
    expect(verify).toContain('git cat-file -e "$TARGET_SHA^{commit}"');
    expect(verify).toContain('git merge-base --is-ancestor "$TARGET_SHA" origin/main');
    expect(verify).toContain("Release target missing");
    expect(verify).toContain("Release target is not on main");
    expect(verify).toContain('git checkout --detach "$TARGET_SHA"');
    expect(verify).toContain('test "$(git rev-parse HEAD)" = "$TARGET_SHA"');
  });

  it("requires the requested version to match every release manifest", () => {
    const verify = draftScript("Verify repository version metadata");
    expect(draftSteps.find((step) => step.name === "Verify repository version metadata")?.if).toBe(
      "${{ steps.release.outputs.preflight_level == 'full' }}",
    );
    expect(verify).toContain("require('./package.json').version");
    expect(verify).toContain('= "$VERSION"');
    expect(verify).toContain("npm run version:check");
    expect(verify).toContain("Root version mismatch");
    expect(verify).toContain("Release version metadata mismatch");
  });

  it("smoke-checks the Doc Agent draft endpoint before release branches are merged", () => {
    const preflight = draftSteps.find(
      (step) => step.name === "Preflight Doc Agent draft endpoint",
    );
    expect(preflight).toBeDefined();
    expect(preflight?.if).toBeUndefined();
    const script = draftScript("Preflight Doc Agent draft endpoint");

    expect(script).toContain("DOC_AGENT_RELEASE_NOTES_DRAFT_URL");
    expect(script).toContain("DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN");
    expect(script).toContain("Doc Agent draft URL is missing");
    expect(script).toContain("Doc Agent draft token is missing");
    expect(script).toContain("/internal/(memmy-)?release-notes/draft");
    expect(script).toContain("--data-binary '[]'");
    expect(script).toContain("400|422");
    expect(script).toContain("Doc Agent smoke contract mismatch");
    expect(script).toContain("Doc Agent draft token rejected");
    expect(script).toContain("Doc Agent draft endpoint disabled or wrong path");
    expect(script).toContain("Doc Agent draft endpoint unavailable");
    expect(script).toContain("Doc Agent smoke response contract mismatch");
    expect(script).toContain("LLM generation: not invoked by smoke");
  });

  it("reuses a pre-existing tag only when it points at the target commit", () => {
    expect(
      draftSteps.find((step) => step.name === "Check for an existing tag or release")?.if,
    ).toBe("${{ steps.release.outputs.preflight_level == 'full' }}");
    const duplicateCheck = draftScript("Check for an existing tag or release");
    expect(duplicateCheck).toContain("git ls-remote --tags");
    expect(duplicateCheck).toContain('"refs/tags/$TAG^{}"');
    expect(duplicateCheck).toContain("tag_preexists=true");
    expect(duplicateCheck).toContain("tag_preexists=false");
    expect(duplicateCheck).toContain("Release tag points to a different commit");
    expect(duplicateCheck).toContain("create the missing Draft Release without moving the tag");
    expect(duplicateCheck).toContain("Manual recovery target requires an existing tag");
    expect(duplicateCheck).toContain("A target_sha was supplied");
    expect(duplicateCheck).toContain("tag-exists/release-missing recovery");
    expect(duplicateCheck).toContain('gh release view "$TAG"');
    expect(duplicateCheck).toContain("Release already exists");
    expect(duplicateCheck).not.toContain("--force");
    expect(draftSource).toContain("gh release create");
    expect(draftSource).toContain("--draft");
    expect(draftSource).not.toContain("--draft=false");
    expect(draftSource).not.toContain("Publish release as latest");
  });

  it("downloads all four OSS artifacts and verifies Content-MD5", () => {
    expect(draftSteps.find((step) => step.name === "Download and verify OSS artifacts")?.if).toBe(
      "${{ steps.release.outputs.preflight_level == 'full' }}",
    );
    const download = draftScript("Download and verify OSS artifacts");
    expect(download).toContain("curl --fail --location --retry 5 --retry-all-errors");
    expect(download).toContain("Content-MD5");
    expect(download).toContain("Installer asset is missing");
    expect(download).toContain("Installer checksum header missing");
    expect(download).toContain("Installer download failed");
    expect(download).toContain("Installer checksum mismatch");
    expect(download).toContain('[[ ! -s "release-assets/$artifact" ]]');
    expect(download).toContain("Installer download is empty");
    expect(download.match(/Memmy-\$VERSION-/g)).toHaveLength(4);
    expect(download).toContain("MD5SUMS.txt");
    expect(download).toContain("SHA256SUMS.txt");
  });

  it("does not expect a nonexistent head_commit in GitHub Compare metadata", () => {
    const realCompareMetadataShape = {
      base_commit: { sha: "base-sha" },
      merge_base_commit: { sha: "base-sha" },
      status: "ahead",
      ahead_by: 2,
      behind_by: 0,
      total_commits: 2,
      commits: [{ sha: "first-commit" }],
      files: [],
    };
    expect(realCompareMetadataShape).not.toHaveProperty("head_commit");

    const snapshot = draftScript("Build complete release change snapshot");
    expect(snapshot).not.toContain("api_head=");
    expect(snapshot).not.toContain(
      "'.head_commit.sha // empty' release-assets/COMPARE_METADATA.json",
    );
    expect(snapshot).toContain('"repos/${GITHUB_REPOSITORY}/commits/${TARGET_SHA}"');
    expect(snapshot).toContain("TARGET_COMMIT_METADATA.json");
    expect(snapshot).toContain("Release target metadata failed");
    expect(snapshot).toContain("api_target");
    expect(snapshot).toContain('"$api_target" != "$TARGET_SHA"');
    expect(snapshot).toContain(
      "'.head_commit.sha // empty' release-assets/COMPARE.json",
    );
  });

  it("records independently auditable commits, PRs, files, versions, and assets", () => {
    for (const stepName of [
      "Build complete release change snapshot",
      "Build release notes",
      "Build auditable release evidence",
    ]) {
      expect(draftSteps.find((step) => step.name === stepName)?.if).toBe(
        "${{ steps.release.outputs.preflight_level == 'full' }}",
      );
    }

    expect(
      draftSteps.find((step) => step.name === "Create draft release and upload every asset")?.if,
    ).toBe("${{ steps.release.outputs.create_draft == 'true' }}");
    expect(draftSteps.find((step) => step.name === "Record the manual publish boundary")?.if).toBe(
      "${{ steps.release.outputs.create_draft == 'true' }}",
    );

    expect(draftScript("Resolve previous stable release tag")).toContain(
      'git fetch --force origin "refs/tags/v*:refs/tags/v*"',
    );
    expect(draftScript("Resolve previous stable release tag")).toContain(
      "Release version is not newer",
    );
    const releaseNotes = draftScript("Build release notes");
    expect(releaseNotes).toContain("DOC_AGENT_RELEASE_NOTES_DRAFT_URL");
    expect(releaseNotes).toContain("DOC_AGENT_RELEASE_NOTES_DRAFT_TOKEN");
    expect(releaseNotes).toContain("DOC_AGENT_RELEASE_NOTES_REQUEST.json");
    expect(releaseNotes).toContain("MEMMY_RELEASE_STYLE_EXAMPLES.json");
    expect(releaseNotes).toContain("candidate_count: 3");
    expect(releaseNotes).toContain(".release_notes_md // .release_notes_markdown");
    expect(releaseNotes).toContain("Doc Agent draft configuration missing");
    expect(releaseNotes).toContain("Doc Agent draft generation failed");
    expect(releaseNotes).toContain("do not fall back silently");
    expect(releaseNotes).toContain("Doc Agent returned invalid release notes");
    expect(releaseNotes).toContain("Doc Agent quality report missing");
    expect(releaseNotes).toContain("Doc Agent candidate selection missing");
    expect(releaseNotes).toContain("Doc Agent release notes need review");
    expect(releaseNotes).toContain("requested_candidate_count");
    expect(releaseNotes).toContain("Release notes generation produced an empty body");
    expect(releaseNotes).toContain("RELEASE_NOTES_SOURCE.json");
    expect(releaseNotes).toContain("QUALITY_REPORT.json");
    expect(releaseNotes).not.toContain("releases/generate-notes");
    expect(releaseNotes).not.toContain("github-generated");
    const snapshot = draftScript("Build complete release change snapshot");
    expect(snapshot).toContain("git merge-base --is-ancestor");
    expect(snapshot).toContain("scripts/build-release-compare.mjs");
    expect(snapshot).toContain("COMPARE_METADATA.json");
    expect(snapshot).toContain("api_merge_base");
    expect(snapshot).toContain("api_total");
    expect(snapshot).toContain("gh api --paginate");
    expect(snapshot).toContain("?per_page=100");
    expect(snapshot).toContain("remoteMetadataValidated");
    const evidence = draftScript("Build auditable release evidence");
    expect(evidence).toContain("Complete release snapshot is missing");
    expect(evidence).toContain("Release snapshot is incomplete");
    expect(evidence).toContain("Release compare target mismatch");
    expect(evidence).toContain("memmy.release.evidence.v2");
    expect(evidence).toContain("changedFiles");
    expect(evidence).toContain("versionFiles");
    expect(evidence).toContain("releaseNotesSha256");
    expect(evidence).toContain("releaseNotesSource");
    expect(evidence).toContain("releaseNotesNeedsReview");
    expect(evidence).toContain("artifacts");
    expect(releaseNotes).toContain(
      "doc-agent: source-id=memmy-official-changelog-v2",
    );
    const uploadAudit = draftSteps.find((step) => step.name === "Upload release audit artifact");
    expect(uploadAudit?.uses).toBe("actions/upload-artifact@v4");
    expect(JSON.stringify(uploadAudit)).toContain("RELEASE_NOTES.md");
    expect(JSON.stringify(uploadAudit)).toContain("RELEASE_NOTES_SOURCE.json");
    expect(JSON.stringify(uploadAudit)).toContain("QUALITY_REPORT.json");
    expect(JSON.stringify(uploadAudit)).toContain("COMPARE_METADATA.json");
    expect(JSON.stringify(uploadAudit)).toContain("TARGET_COMMIT_METADATA.json");
    expect(JSON.stringify(uploadAudit)).toContain("COMPARE.json");
    expect(JSON.stringify(uploadAudit)).toContain("PULL_REQUESTS.json");
    expect(draftScript("Create draft release and upload every asset")).toContain(
      "RELEASE_EVIDENCE.json",
    );
    expect(draftScript("Create draft release and upload every asset")).toContain(
      "RELEASE_NOTES_SOURCE.json",
    );
  });

  it("cleans up a half-created Draft Release if asset upload fails", () => {
    const create = draftScript("Create draft release and upload every asset");
    expect(create).toContain("cleanup_draft_release()");
    expect(create).toContain("TAG_PREEXISTS");
    expect(create).toContain('draft_created=1');
    expect(create).toContain("preserving the pre-existing tag");
    expect(create).toContain('gh release delete "$TAG" --cleanup-tag --yes');
    expect(create).toContain('gh release delete "$TAG" --yes');
    expect(create).toContain("Draft Release creation failed");
    expect(create).toContain("Draft asset upload failed");
    expect(create).toContain("Automatic recovery");
    expect(create.indexOf("gh release create")).toBeLessThan(create.indexOf("draft_created=1"));
    expect(create.indexOf("draft_created=1")).toBeLessThan(create.indexOf("gh release upload"));
    expect(create).toContain("trap - EXIT");
  });

  it("uses the release environment, minimal permissions, and global non-cancelling concurrency", () => {
    expect(draftWorkflow.permissions).toEqual({
      contents: "write",
      "pull-requests": "read",
    });
    expect(draftJob.environment).toBe("release");
    expect(draftWorkflow.concurrency).toBeUndefined();
    expect(draftJob.concurrency).toEqual({
      group: "draft-release-v2",
      "cancel-in-progress": false,
      queue: "max",
    });
  });

  it("records the manual Publish boundary in the workflow summary", () => {
    const boundary = draftScript("Record the manual publish boundary");
    expect(boundary).toContain("This workflow intentionally stops before Publish.");
    expect(boundary).toContain("A human must audit");
    expect(boundary).toContain("|| printf");
  });

  it("keeps fork manual testing side-effect free unless create_draft is explicit", () => {
    const preflight = draftScript("Record preflight result");
    expect(draftSteps.find((step) => step.name === "Record preflight result")?.if).toBe(
      "${{ steps.release.outputs.create_draft != 'true' }}",
    );
    expect(preflight).toContain("No tag, Release, assets, or external publication was created.");
    expect(preflight).toContain("Smoke validates the target commit and Doc Agent draft endpoint configuration.");
    expect(preflight).toContain("It intentionally skips release version metadata");
    expect(preflight).toContain("Run full preflight before creating a Draft Release.");
    expect(preflight).toContain("Set create_draft=true only when intentionally creating a Draft Release.");
  });
});
