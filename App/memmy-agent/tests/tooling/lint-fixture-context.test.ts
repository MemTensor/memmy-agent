import { ESLint } from "eslint";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const eslint = new ESLint({ cwd: root, fix: false });
const fixtures = [
  "src/tools/computer-history/win/native/tests/integration/browser-smoke.mjs",
  "src/tools/computer-history/win/native/tests/integration/electron-text-smoke.mjs",
  "tests/fixtures/external-browser-actions-live.mjs",
  "tests/fixtures/teaching-browser-basics-live.mjs",
  "tests/fixtures/teaching-browser-integrity-live.mjs"
];

it.each(fixtures)("recognizes the executable context of %s", async file => {
  const [result] = await eslint.lintFiles(resolve(root, file));
  expect(result.errorCount, JSON.stringify(result.messages)).toBe(0);
});

it("still rejects an identifier that is absent from every fixture runtime", async () => {
  const [result] = await eslint.lintText("console.log(process.platform, missingFixtureIdentifier);", {
    filePath: resolve(root, fixtures[0]!)
  });
  expect(result.messages.some(message => message.ruleId === "no-undef" && message.message.includes("missingFixtureIdentifier"))).toBe(true);
});

it("does not grant browser globals to the native Node fixture", async () => {
  const [result] = await eslint.lintText("console.log(window.location);", {
    filePath: resolve(root, fixtures[0]!)
  });
  expect(result.messages.some(message => message.ruleId === "no-undef" && message.message.includes("window"))).toBe(true);
});
