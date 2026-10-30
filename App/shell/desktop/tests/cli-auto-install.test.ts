import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledCliInstallDecision, memmyCliAppCandidates, renderMemmyCliLauncher, shellSingleQuote } from "../src/main/cli-auto-install.js";

describe("bundled CLI install decision", () => {
  it("installs from Applications, the home Applications folder, and Downloads", () => {
    expect(bundledCliInstallDecision("/Applications/Memmy.app")).toBe("install");
    expect(bundledCliInstallDecision("/Users/ada/Applications/Memmy.app")).toBe("install");
    expect(bundledCliInstallDecision("/Users/ada/Downloads/Memmy.app")).toBe("install");
  });

  it("classifies a disk image and App Translocation so they are not the only install target", () => {
    expect(bundledCliInstallDecision("/Volumes/Memmy Installer/Memmy.app")).toBe("disk-image");
    expect(bundledCliInstallDecision("/private/var/folders/xx/T/AppTranslocation/ABC/d/Memmy.app")).toBe("translocated");
  });
});

describe("user CLI launcher", () => {
  it("keeps a disk image as a candidate and always falls back to Applications", () => {
    expect(memmyCliAppCandidates("/Volumes/Memmy Installer/Memmy.app", "/Users/ada")).toEqual([
      "/Volumes/Memmy Installer/Memmy.app",
      "/Applications/Memmy.app",
      "/Users/ada/Applications/Memmy.app"
    ]);
  });

  it("does not list the Applications bundle twice", () => {
    expect(memmyCliAppCandidates("/Applications/Memmy.app", "/Users/ada")).toEqual([
      "/Applications/Memmy.app",
      "/Users/ada/Applications/Memmy.app"
    ]);
  });

  it("renders an executable bash script that execs memmy-project inside the app", () => {
    const script = renderMemmyCliLauncher("memmy-project", [
      "/Volumes/Memmy Installer/Memmy.app",
      "/Applications/Memmy.app"
    ]);
    expect(script).toContain("# Memmy CLI launcher");
    expect(script).toContain('"$app/Contents/Resources/cli/memmy-project"');
    expect(script).toContain("search_app '/Volumes/Memmy Installer/Memmy.app' \"$@\"");
    expect(script).toContain("search_app '/Applications/Memmy.app' \"$@\"");
    expect(script).not.toContain("ln -s");
    expect(shellSingleQuote("Memmy's.app")).toBe("'Memmy'\\''s.app'");

    const checked = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    expect(checked.status).toBe(0);
  });

  it("uses the next Memmy.app when the first copy is gone", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-cli-launcher-"));
    const missing = join(root, "gone.app");
    const present = join(root, "Memmy.app");
    const launcher = join(present, "Contents", "Resources", "cli", "memmy-project");
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, "#!/bin/sh\necho project-ok\n", "utf8");
    chmodSync(launcher, 0o755);
    const scriptPath = join(root, "memmy-project");
    writeFileSync(scriptPath, renderMemmyCliLauncher("memmy-project", [missing, present]), "utf8");
    chmodSync(scriptPath, 0o755);

    const ran = spawnSync(scriptPath, ["--version"], { encoding: "utf8" });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain("project-ok");

    const absentPath = join(root, "absent-session");
    writeFileSync(absentPath, renderMemmyCliLauncher("memmy-project", [missing]), "utf8");
    chmodSync(absentPath, 0o755);
    const missingApp = spawnSync(absentPath, [], { encoding: "utf8" });
    expect(missingApp.status).toBe(127);
    expect(missingApp.stderr).toContain("找不到 Memmy");
  });
});
