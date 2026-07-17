/** Secret redactor tests. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../secret-redactor.js";

interface RedactorFixture {
  fileName: string;
  token: string;
  positives: string[];
  negatives: string[];
}

const fixtureDirectory = join(import.meta.dirname, "__fixtures__", "redactor");

describe("redactSecrets", () => {
  for (const fixture of readFixtures()) {
    it(`redacts positive cases from ${fixture.fileName}`, () => {
      for (const input of fixture.positives) {
        expect(redactSecrets(input)).toContain(fixture.token);
      }
    });

    it(`keeps negative cases from ${fixture.fileName} unchanged`, () => {
      for (const input of fixture.negatives) {
        expect(redactSecrets(input)).toBe(input);
      }
    });
  }

  it("redacts very large data URL payloads without recursive regexp failures", () => {
    const input = `image_url=data:image/png;base64,${"A".repeat(2_000_000)}`;

    const redacted = redactSecrets(input);

    expect(redacted).toBe(`image_url=data:image/png;base64,[REDACTED:base64_secret]`);
  });
});

function readFixtures(): RedactorFixture[] {
  return readdirSync(fixtureDirectory)
    .filter((fileName) => fileName.endsWith(".txt"))
    .sort()
    .map((fileName) => parseFixture(fileName, readFileSync(join(fixtureDirectory, fileName), "utf8")));
}

function parseFixture(fileName: string, content: string): RedactorFixture {
  const token = /^# token=(.+)$/m.exec(content)?.[1];
  const positiveBlock = /--- positive\n([\s\S]+?)\n--- negative/.exec(content)?.[1];
  const negativeBlock = /--- negative\n([\s\S]+)$/.exec(content)?.[1];

  if (!token || !positiveBlock || !negativeBlock) {
    throw new Error(`Invalid redactor fixture: ${fileName}`);
  }

  return {
    fileName,
    token,
    positives: splitCases(positiveBlock),
    negatives: splitCases(negativeBlock)
  };
}

function splitCases(block: string): string[] {
  return block
    .trim()
    .split(/\n===\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
