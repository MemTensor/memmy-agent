import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const buildEnv = {
  ...process.env,
  MEMMY_LEGAL_CN_BASE_URL: "https://memmy.cn",
  MEMMY_LEGAL_INTL_BASE_URL: "https://memmy.bot",
};
const pptxScripts = path.join(root, "src/skills/pptx/scripts");
const xlsxScripts = path.join(root, "src/skills/xlsx/scripts");

function run(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
}

describe("document skill CLIs", () => {
  it("exposes every PPTX and XLSX entry point as a standalone CLI", () => {
    const scripts = [
      ...fs.readdirSync(pptxScripts).filter((name) => name.endsWith(".mjs")).map((name) => path.join(pptxScripts, name)),
      ...fs.readdirSync(path.join(pptxScripts, "office")).filter((name) => name.endsWith(".mjs")).map((name) => path.join(pptxScripts, "office", name)),
      ...fs.readdirSync(xlsxScripts).filter((name) => name.endsWith(".mjs")).map((name) => path.join(xlsxScripts, name)),
      ...fs.readdirSync(path.join(xlsxScripts, "office")).filter((name) => name.endsWith(".mjs")).map((name) => path.join(xlsxScripts, "office", name)),
    ];
    for (const script of scripts) {
      const result = run(script, ["--help"]);
      expect(result.status, script).toBe(0);
    }
  });

  it("rejects missing inputs without touching the filesystem", () => {
    const missingPptx = run(path.join(pptxScripts, "check_deck.mjs"), ["--input", path.join(os.tmpdir(), "missing-memmy-deck.pptx"), "--json"]);
    expect(missingPptx.status).not.toBe(0);
    expect(missingPptx.stdout).toContain('"ok":false');
    const missingXlsx = run(path.join(xlsxScripts, "inspect_workbook.mjs"), ["--input", path.join(os.tmpdir(), "missing-memmy-workbook.xlsx"), "--json"]);
    expect(missingXlsx.status).not.toBe(0);
    expect(missingXlsx.stdout).toContain('"ok":false');
  });

  it("preserves Office source CLIs without distributing their skills by default", () => {
    const skills = ["docx", "pptx", "xlsx"];
    const sources = skills.map((skill) => fs.readFileSync(path.join(root, "src/skills", skill, "SKILL.md"), "utf8"));
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "--ignore-scripts", "build"], { cwd: root, env: buildEnv, stdio: "pipe" });
    for (const [index, skill] of skills.entries()) {
      expect(fs.existsSync(path.join(root, "dist/skills", skill))).toBe(false);
      expect(fs.readFileSync(path.join(root, "src/skills", skill, "SKILL.md"), "utf8")).toBe(sources[index]);
    }
  }, 60_000);
});
