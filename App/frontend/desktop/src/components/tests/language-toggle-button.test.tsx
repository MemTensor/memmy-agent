/** Language toggle title-bar safety tests. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  LanguageToggleButton,
  PAGE_CORNER_ACTION_CONTAINER_STYLE
} from "../language-toggle-button.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("page corner title-bar safety", () => {
  it("keeps page corner actions below the Windows controls overlay", () => {
    expect(PAGE_CORNER_ACTION_CONTAINER_STYLE.top).toBe(
      "calc(1rem + env(titlebar-area-height, 0px))"
    );

    const html = renderToString(
      <LanguageToggleButton language="zh-CN" onClick={() => undefined} />
    );
    expect(html).toContain("top:calc(1rem + env(titlebar-area-height, 0px))");

    for (const page of [
      "pages/token-detail-page.tsx",
      "pages/api-key-page.tsx",
      "pages/model-page.tsx",
      "pages/api-key-optional-page.tsx"
    ]) {
      expect(readFileSync(resolve(sourceRoot, page), "utf8")).toContain(
        "style={PAGE_CORNER_ACTION_CONTAINER_STYLE}"
      );
    }
  });
});
