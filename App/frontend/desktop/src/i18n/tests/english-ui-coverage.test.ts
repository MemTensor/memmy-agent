/** English ui coverage tests. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = resolve(__dirname, "..", "..");

const allowedSourceFiles = new Set([
  "i18n/error-notice-messages.ts",
  "i18n/messages.ts",
  "i18n/error-notice-messages.ts",
  "lib/nickname.ts",
  "pages/memory/skill-demo-data.ts",
  // Provider aliases are identifiers used for logo matching, not visible UI copy.
  "components/model-provider-logo.tsx",
  // App names people type to find an app in search, not visible UI copy.
  "pages/memory/app-search-aliases.ts",
  // 提示条里怎么称呼成员：一个人说名字、两人并列、更多人加人数，靠 language 参数而非 t() 拼。
  "pages/collab-board-text.ts",
  // 交给 Agent 执行的任务说明（不是界面文案）：让它在另一个 Agent 里确认记录位置并写读取规则。
  "pages/collab-agent-connect-prompt.ts",
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
