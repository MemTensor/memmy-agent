/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../collab-knowledge-dialog.module.css", import.meta.url), "utf8");

describe("knowledge dialog layout and palette", () => {
  it("outranks the shared modal width and gives the search the full content width", () => {
    expect(css).toMatch(/:global\(\.modal\)\.dialog\s*\{[^}]*width: min\(640px, calc\(100vw - 32px\)\)/);
    expect(css).toMatch(/\.search\s*\{[^}]*width: 100%/);
    expect(css).toMatch(/\.results\s*\{[^}]*max-height: min\(360px, 42dvh\)/);
    expect(css).not.toMatch(/min-height:\s*(?:260|360|420)px/);
  });

  it("uses Memmy theme colors instead of introducing a separate palette", () => {
    expect(css).toMatch(/accent-color: var\(--color-action-sky\)/);
    expect(css).toContain("background: var(--color-nav-active-bg)");
    expect(css).toContain("color: var(--color-accent-deep)");
    expect(css).not.toMatch(/#[a-f\d]{3,8}\b|rgba?\(/i);
    expect(css).toMatch(/\.dialog \.footer\s*\{[^}]*border-top:/);
  });
});
