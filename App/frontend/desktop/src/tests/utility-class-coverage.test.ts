/** Utility class coverage tests. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = resolve(__dirname, "..");
const bundlePath = resolve(srcDir, "prototype-utilities.css");

/**
 * Border colours that the bundle does not carry, and that predate this check.
 *
 * Each one paints a near-black border today. They are left alone rather than
 * corrected blind, since picking a replacement shade is a judgement about the
 * page it sits on.
 */
const knownMissingBorderColors = new Set([
  "pages/agent-thread-messages.tsx: border-red-200/70",
  "pages/first-encounter-relay-challenge.tsx: hover:border-border-stone/35",
  "pages/memory-sources-page.tsx: border-status-error/25",
  "pages/memory-sources-page.tsx: hover:border-status-error/40",
  "pages/memory/analytics-sub-page.tsx: border-status-error/25",
  "pages/memory/logs-sub-page.tsx: border-status-error/25",
  "pages/memory/overview-sub-page.tsx: border-status-error/25",
  "pages/plugin-settings-section.tsx: border-border-stone/45"
]);

/**
 * Utility classes come from a precompiled bundle, not from a Tailwind build.
 *
 * Nothing in the toolchain scans this source for class names, so a utility the
 * bundle does not carry is not a Tailwind class at all — it is a no-op. Opacity
 * steps are where this bites, since the bundle holds a fixed set per colour
 * (`border-border-stone` has 20/30/40/50/60) and any other number reads like
 * valid Tailwind while doing nothing.
 *
 * Only border colours are checked. A missing `bg-*` or `text-*` step quietly
 * drops a tint, but a missing border colour leaves the width behind and the
 * border falls back to `currentColor` — a near-black line around a card that
 * was meant to have a pale one, which is what makes this worth a test.
 */
describe("utility class coverage", () => {
  it("边框颜色工具类必须存在于预编译包里", () => {
    const bundle = readFileSync(bundlePath, "utf8");
    const failures = listSourceFiles(srcDir).flatMap((file) => {
      const source = readFileSync(resolve(srcDir, file), "utf8");
      return collectBorderColorClasses(source)
        .filter((token) => !isInBundle(token, bundle))
        .map((token) => `${file}: ${token}`);
    });

    const unexpected = [...new Set(failures)].filter((entry) => !knownMissingBorderColors.has(entry));
    expect(unexpected.sort()).toEqual([]);
  });
});

/**
 * Pulls the border colour classes out of `className` attributes.
 *
 * Only tokens carrying an opacity modifier are returned, since a plain colour
 * is always compiled. Interpolated segments are skipped because their value is
 * unknown here.
 */
function collectBorderColorClasses(source: string): string[] {
  const tokens: string[] = [];
  for (const attribute of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const value = attribute[1] ?? attribute[2] ?? "";
    for (const candidate of value.split(/\s+/)) {
      // A template literal holds nested string literals, so a token can arrive
      // wearing their quotes.
      const raw = candidate.replace(/["'\\]/g, "");
      // An interpolated segment's value is unknown here, so it cannot be checked.
      if (!raw || candidate.includes("${") || candidate.includes("}")) continue;
      if (!/^(?:[a-z-]+:)*border-[a-z]/.test(raw) || !raw.includes("/")) continue;
      tokens.push(raw);
    }
  }
  return tokens;
}

/** Matches a token against the bundle, applying Tailwind's selector escaping. */
function isInBundle(token: string, bundle: string): boolean {
  const escaped = token.replace(/[.,:/[\]()%#]/g, (character) => `\\${character}`);
  return bundle.includes(`.${escaped}`);
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const absolute = join(dir, entry);
    if (statSync(absolute).isDirectory()) return listSourceFiles(absolute);
    return /\.tsx$/.test(entry) ? [relative(srcDir, absolute)] : [];
  });
}
