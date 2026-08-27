/** Tooltip tests. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tooltip } from "../tooltip.js";

describe("Tooltip", () => {
  it("renders accessible trigger markup without native title", () => {
    const html = renderToString(
      <Tooltip content="归档对话">
        <button type="button" aria-label="归档对话">
          A
        </button>
      </Tooltip>
    );

    expect(html).toContain('aria-label="归档对话"');
    expect(html).toContain('aria-describedby="app-tooltip-singleton"');
    expect(html).not.toContain('title="归档对话"');
  });

  it("uses a singleton body overlay implementation", () => {
    const source = readFileSync(resolve(__dirname, "..", "tooltip.tsx"), "utf8");

    expect(source).toContain('const tooltipId = "app-tooltip-singleton"');
    expect(source).toContain("let tooltipElement");
    expect(source).toContain("document.body.appendChild(tooltipElement)");
    expect(source).toContain("activeTrigger = trigger");
    expect(source).toContain('window.addEventListener("scroll", hideActiveTooltip, true)');
    expect(source).not.toContain("createPortal");
  });
});
