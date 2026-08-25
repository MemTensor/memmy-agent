/** English ui coverage tests. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { enUSMessages, zhCNMessages } from "../messages.js";

const srcDir = resolve(__dirname, "..", "..");

const allowedSourceFiles = new Set([
  "i18n/error-notice-messages.ts",
  "i18n/messages.ts",
  "lib/nickname.ts",
  "pages/memory/skill-demo-data.ts",
  // Provider aliases are identifiers used for logo matching, not visible UI copy.
  "components/model-provider-logo.tsx",
  // English ui coverage tests.
  "dev-agent-preview.tsx"
]);

describe("English UI coverage", () => {
  it("主要 UI 源码不保留静态中文文案", () => {
    const failures = listSourceFiles(srcDir).flatMap((file) => {
      const source = stripComments(readFileSync(resolve(srcDir, file), "utf8"));
      return collectChineseLines(file, source);
    });

    expect(failures).toEqual([]);
  });

  it("文献综述页面的可见文案全部经过本地化", () => {
    const page = stripComments(readFileSync(resolve(srcDir, "pages/literature-review-page.tsx"), "utf8"));
    const model = stripComments(readFileSync(resolve(srcDir, "pages/literature-review-model.ts"), "utf8"));
    const keys = Object.keys(zhCNMessages).filter((key) => key.startsWith("literatureReview."));

    expect(keys.length).toBeGreaterThan(50);
    expect(keys.every((key) => enUSMessages[key as keyof typeof enUSMessages]?.trim())).toBe(true);
    expect(page).toContain("useTranslation");
    expect(page).not.toMatch(/(?:aria-label|placeholder|title)="[^"]*[A-Za-z][^"]*"/);
    expect(page.split("\n").filter((line) => />\s*[A-Za-z][^<{]*</.test(line))).toEqual([]);
    expect(model).not.toContain("What topic or research field");
    expect(model).not.toContain("Last 3 years");
  });
});

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const file = join(dir, entry);
    const stats = statSync(file);
    if (stats.isDirectory()) {
      return listSourceFiles(file);
    }

    const rel = relative(srcDir, file).replaceAll("\\", "/");
    if (!/\.(ts|tsx)$/.test(rel) || rel.includes("/tests/") || rel.includes(".test.") || allowedSourceFiles.has(rel)) {
      return [];
    }

    return [rel];
  });
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function collectChineseLines(file: string, source: string): string[] {
  return source
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /\p{Script=Han}/u.test(line))
    .map(({ line, number }) => `${file}:${number}: ${line.trim()}`);
}
