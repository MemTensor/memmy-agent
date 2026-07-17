/** Codex sidebar layout module. */
import tokensCssBundled from "./tokens.css?raw";

export interface CodexSidebarLayout {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

export const CODEX_SIDEBAR_CSS_VARS = {
  width: "--codex-sidebar-width",
  minWidth: "--codex-sidebar-min-width",
  maxWidth: "--codex-sidebar-max-width"
} as const;

const vitestTokensCss = import.meta.env.VITEST ? readTokensCssFromDisk() : null;

let cachedLayoutFromTokens: CodexSidebarLayout | null = null;

/** Parses parse css pixel var. */
export function parseCssPixelVar(cssText: string, varName: string): number {
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}:\\s*([\\d.]+)px`).exec(cssText);
  if (!match) {
    throw new Error(`Missing ${varName} in design tokens`);
  }

  const matched = match[1];
  if (!matched) {
    throw new Error(`Invalid ${varName} value`);
  }

  const value = Number.parseFloat(matched);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid ${varName} value`);
  }

  return value;
}

/**
 * Parses the Codex sidebar width bounds from the tokens.css text.
 *
 * @param cssText The design token stylesheet text; defaults to reading the bundled or on-disk tokens.css.
 * @returns The default, minimum, and maximum sidebar widths (px).
 */
export function parseCodexSidebarLayout(cssText: string = resolveTokensCssText()): CodexSidebarLayout {
  return {
    defaultWidth: parseCssPixelVar(cssText, CODEX_SIDEBAR_CSS_VARS.width),
    minWidth: parseCssPixelVar(cssText, CODEX_SIDEBAR_CSS_VARS.minWidth),
    maxWidth: parseCssPixelVar(cssText, CODEX_SIDEBAR_CSS_VARS.maxWidth)
  };
}

/**
 * Reads the Codex sidebar layout dimensions from the current document.
 *
 * @param root The root node to read custom properties from; defaults to `document.documentElement`.
 * @returns The sidebar's default, minimum, and maximum widths (px).
 */
export function readCodexSidebarLayout(root?: HTMLElement | null): CodexSidebarLayout {
  const element = root ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!element || typeof getComputedStyle === "undefined") {
    return getLayoutFromTokens();
  }

  const style = getComputedStyle(element);
  const fromTokens = getLayoutFromTokens();
  return {
    defaultWidth: readCssPixelLength(style, CODEX_SIDEBAR_CSS_VARS.width) ?? fromTokens.defaultWidth,
    minWidth: readCssPixelLength(style, CODEX_SIDEBAR_CSS_VARS.minWidth) ?? fromTokens.minWidth,
    maxWidth: readCssPixelLength(style, CODEX_SIDEBAR_CSS_VARS.maxWidth) ?? fromTokens.maxWidth
  };
}

function getLayoutFromTokens(): CodexSidebarLayout {
  if (!cachedLayoutFromTokens) {
    cachedLayoutFromTokens = parseCodexSidebarLayout();
  }

  return cachedLayoutFromTokens;
}

function resolveTokensCssText(): string {
  if (typeof tokensCssBundled === "string" && /--codex-sidebar-width:\s*[\d.]+px/.test(tokensCssBundled)) {
    return tokensCssBundled;
  }

  if (vitestTokensCss) {
    return vitestTokensCss;
  }

  throw new Error("Codex sidebar layout tokens are unavailable");
}

function readTokensCssFromDisk(): string {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { dirname, resolve } = require("node:path") as typeof import("node:path");
  const { fileURLToPath } = require("node:url") as typeof import("node:url");
  const tokensPath = resolve(dirname(fileURLToPath(import.meta.url)), "./tokens.css");
  return readFileSync(tokensPath, "utf8");
}

function readCssPixelLength(style: CSSStyleDeclaration, varName: string): number | null {
  const raw = style.getPropertyValue(varName).trim();
  const match = /^([\d.]+)px$/.exec(raw);
  if (!match) {
    return null;
  }

  const matched = match[1];
  if (!matched) {
    return null;
  }

  const value = Number.parseFloat(matched);
  return Number.isFinite(value) ? value : null;
}
