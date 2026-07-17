/// <reference types="node" />
/** Codex sidebar layout tests. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCodexSidebarLayout } from "../codex-sidebar-layout.js";

const tokenCss = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../tokens.css"), "utf8");

describe("codex sidebar layout tokens", () => {
  it("reads default, min, and max widths from tokens.css", () => {
    expect(parseCodexSidebarLayout(tokenCss)).toEqual({
      defaultWidth: 250,
      minWidth: 240,
      maxWidth: 520
    });
  });
});
