/** English ui coverage tests. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const srcDir = resolve(__dirname, "..", "..");

const allowedSourceFiles = new Set([
  "i18n/error-notice-messages.ts",
  "i18n/messages.ts",
  // These two legacy plugin renderers explicitly select English or Chinese; locale behavior is covered separately.
  "app/plugin-interaction-waiting-label.ts",
  "pages/literature-review-source-card.tsx",
  "lib/nickname.ts",
  "pages/memory/skill-demo-data.ts",
  // Provider aliases are identifiers used for logo matching, not visible UI copy.
  "components/model-provider-logo.tsx",
  // App names people type to find an app in search, not visible UI copy.
  "pages/memory/app-search-aliases.ts",
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

  it("ignores Han characters used only by a regular-expression literal", () => {
    const source = String.raw`const recording = /^录音-\d{4}\.webm$/u;`;
    expect(collectChineseLines("fixture.ts", source)).toEqual([]);
  });

  it.each([
    'const label = "开始录音";',
    'const label = `开始录音`;',
    'const label = <button>开始录音</button>;',
    'const label = <button title="开始录音" />;',
    String.raw`const recording = /^录音-\d{4}\.webm$/u; const label = "开始录音";`,
  ])("still detects untranslated UI text in %s", (source) => {
    const failures = collectChineseLines("fixture.tsx", source);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("开始录音");
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
  return maskRegularExpressionLiterals(file, source)
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /\p{Script=Han}/u.test(line))
    .map(({ line, number }) => `${file}:${number}: ${line.trim()}`);
}

function maskRegularExpressionLiterals(file: string, source: string): string {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const ranges: Array<[number, number]> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(node)) ranges.push([node.getStart(parsed), node.end]);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  for (const [start, end] of ranges.sort((left, right) => right[0] - left[0])) {
    source = source.slice(0, start) + source.slice(start, end).replace(/[^\r\n]/g, " ") + source.slice(end);
  }
  return source;
}
