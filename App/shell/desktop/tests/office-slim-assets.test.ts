import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { FileMatcher } from "app-builder-lib/out/fileMatcher.js";

const checker = fileURLToPath(new URL("../../../../scripts/internal/shared/check-office-slim-assets.mjs", import.meta.url));
const roots: string[] = [];
const excluded = [
  "dist/skills/docx", "dist/skills/pptx", "dist/skills/xlsx",
  "dist/extra-dependencies/office-rendering", "dist/extra-dependencies/docx-rendering",
];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-office-slim-"));
  roots.push(root);
  mkdirSync(join(root, "dist"));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Office slim runtime boundary", () => {
  it("accepts a clean runtime without creating an installer", () => {
    expect(() => execFileSync(process.execPath, [checker, fixture()], { stdio: "pipe" })).not.toThrow();
  });

  it.each(excluded)("rejects a stale Office asset directory: %s", (relative) => {
    const root = fixture();
    mkdirSync(join(root, relative), { recursive: true });
    expect(() => execFileSync(process.execPath, [checker, root], { stdio: "pipe" }))
      .toThrow(/Office assets must be absent/);
  });

  it("rejects a dangling Office asset symlink", () => {
    const root = fixture();
    const entry = join(root, "dist/skills/docx");
    mkdirSync(dirname(entry), { recursive: true });
    symlinkSync(join(root, "missing-skill"), entry, "junction");
    expect(() => execFileSync(process.execPath, [checker, root], { stdio: "pipe" }))
      .toThrow(/Office assets must be absent/);
  });

  it("fails closed for a missing runtime root", () => {
    expect(() => execFileSync(process.execPath, [checker, join(fixture(), "missing")], { stdio: "pipe" }))
      .toThrow(/Runtime dist directory is missing/);
  });

  it.each([
    "electron-builder.yml", "electron-builder.unsigned.yml",
    "electron-builder.win.yml", "electron-builder.win.unsigned.yml",
  ])("%s excludes Office assets while keeping Computer Use", (name) => {
    const root = fixture();
    const config = parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
    const filter = new FileMatcher(root, join(root, "target"), (value: string) => value, config.files).createFilter();
    const excludedFiles = excluded.map((relative) => `dist/runtime/memmy-agent/${relative}/asset.bin`);
    const includedFiles = [
      "dist/runtime/memmy-agent/dist/skills/computer-history/SKILL.md",
      "dist/runtime/memmy-agent/dist/tools/computer-history/mac/human-recorder.swift",
      "dist/runtime/memmy-agent/dist/tools/computer-use/open-computer-use-binary.js",
    ];
    for (const [files, expected] of [[excludedFiles, false], [includedFiles, true]] as const) {
      for (const relative of files) {
        const file = join(root, relative);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "fixture");
        expect(filter(file, lstatSync(file)), relative).toBe(expected);
      }
    }
  });

  it("all platform staging scripts enforce the same Office-free boundary", () => {
    for (const [name, runtime] of [
      ["mac/build-dmg.sh", "$RUNTIME_DIR/memmy-agent"],
      ["win/build-nsis.sh", "$RUNTIME_DIR/memmy-agent"],
      ["linux/build-cli-archive.sh", "$PAYLOAD_DIR/App/memmy-agent"],
    ]) {
      const source = readFileSync(new URL(`../../../../scripts/internal/${name}`, import.meta.url), "utf8");
      const repoRoot = name.startsWith("linux/") ? "$REPO_ROOT" : "$ROOT_DIR";
      expect(source).toContain(`node "${repoRoot}/scripts/internal/shared/check-office-slim-assets.mjs" "${runtime}"`);
      expect(source).not.toContain("verify_office_skill_payload");
      expect(source).not.toContain("ALLOW_MISSING_OFFICE_PAYLOAD");
    }
  });
});
