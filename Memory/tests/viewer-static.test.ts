import { describe, expect, it } from "vitest";
import { isMemoryViewerPath, memoryPanelHtml, memoryViewerAsset } from "../src/viewer/static.js";

describe("Memory Viewer assets", () => {
  it("serves the built Preact application shell", () => {
    const html = memoryPanelHtml();
    expect(html).toContain("<title>Memmy Memory — Memory Viewer</title>");
    expect(html).toMatch(/<script[^>]+type="module"[^>]+\/viewer\/assets\//);
    expect(html).not.toContain("Memory Panel");
  });

  it("serves fingerprinted assets with immutable caching", () => {
    const html = memoryPanelHtml();
    const assetPath = html.match(/src="([^"]+\.js)"/)?.[1];
    expect(assetPath).toBeTruthy();
    const asset = memoryViewerAsset(assetPath!);
    expect(asset?.contentType).toContain("javascript");
    expect(asset?.cacheControl).toContain("immutable");
    expect(asset?.body.byteLength).toBeGreaterThan(1_000);
  });

  it("serves copied Viewer logos from stable offline paths", () => {
    expect(isMemoryViewerPath("/viewer/memos-logo.svg")).toBe(true);
    const logo = memoryViewerAsset("/viewer/memos-logo.svg");
    expect(logo?.contentType).toBe("image/svg+xml");
    expect(logo?.body.toString("utf8")).toContain("<svg");
    expect(memoryPanelHtml()).toContain("/viewer/memos-logo.svg");
  });

  it("recognizes only Viewer paths and rejects traversal", () => {
    expect(isMemoryViewerPath("/viewer/")).toBe(true);
    expect(isMemoryViewerPath("/user-memories")).toBe(true);
    expect(isMemoryViewerPath("/import")).toBe(false);
    expect(isMemoryViewerPath("/viewer/assets/app.js")).toBe(true);
    expect(isMemoryViewerPath("/help")).toBe(false);
    expect(isMemoryViewerPath("/api/v1/health")).toBe(false);
    expect(memoryViewerAsset("/viewer/../config.yaml")).toBeUndefined();
  });
});
