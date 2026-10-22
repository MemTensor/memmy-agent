import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPROMISED_ROOT_COMMON_NAMES, distrustCompromisedCAs, isCompromisedRoot } from "../src/main/distrust-compromised-cas.js";

/** The three copies that must stay in sync, relative to this test file. */
const COPIES = [
  "../src/main/distrust-compromised-cas.ts",
  "../../../memmy-agent/src/distrust-compromised-cas.ts",
  "../../../../Memory/src/distrust-compromised-cas.ts"
];

/** The four process entrypoints that must each call the helper, relative to this test file. */
const ENTRYPOINTS = [
  "../src/main/main.ts",
  "../../../memmy-agent/src/main.ts",
  "../../../../Memory/src/server/index.ts",
  "../../../../Memory/src/cli/index.ts"
];

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function declaredRootNames(relative: string): string[] {
  const block = /COMPROMISED_ROOT_COMMON_NAMES: readonly string\[\] = \[([^\]]*)\]/.exec(read(relative));
  if (!block) throw new Error(`no compromised root list in ${relative}`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("isCompromisedRoot", () => {
  it("flags only emSign ECC Root CA - G3 and keeps the other emSign roots", () => {
    const bundled = tls.getCACertificates("bundled");
    const flagged = bundled.filter(isCompromisedRoot);
    // The bundle currently carries exactly one affected root; AAA Certificate Services is not in it.
    expect(flagged.length).toBeGreaterThan(0);
    for (const pem of flagged) {
      const subject = new X509Certificate(pem).subject;
      expect(COMPROMISED_ROOT_COMMON_NAMES.some((cn) => subject.includes(`CN=${cn}`)), subject).toBe(true);
    }
    const survivors = bundled.filter((pem) => !isCompromisedRoot(pem)).map((pem) => new X509Certificate(pem).subject);
    for (const cn of ["emSign Root CA - G1", "emSign Root CA - C1", "emSign ECC Root CA - C3"]) {
      expect(survivors.some((subject) => subject.includes(`CN=${cn}`)), cn).toBe(true);
    }
  });

  it("keeps input it cannot parse rather than dropping it", () => {
    expect(isCompromisedRoot("not a certificate")).toBe(false);
  });
});

describe("distrustCompromisedCAs", () => {
  it("removes the flagged roots and leaves none in the default bundle", () => {
    const expected = tls.getCACertificates("bundled").filter(isCompromisedRoot).length;
    expect(distrustCompromisedCAs()).toBe(expected);
    expect(tls.getCACertificates("default").filter(isCompromisedRoot)).toHaveLength(0);
  });
});

describe("copies and entrypoints", () => {
  it("declares the same compromised root list in all three copies", () => {
    for (const copy of COPIES) {
      expect(declaredRootNames(copy), copy).toEqual([...COMPROMISED_ROOT_COMMON_NAMES]);
    }
  });

  it("calls distrustCompromisedCAs() from all four process entrypoints", () => {
    for (const entry of ENTRYPOINTS) {
      expect(read(entry), entry).toContain("distrustCompromisedCAs();");
    }
  });
});
