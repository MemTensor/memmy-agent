/// <reference types="node" />
/** Tools v1 archive tests. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("tools v1 archive guard", () => {
  it("removes the old ToolDetailDrawer component and right modal placement", () => {
    const drawerPath = resolve(sourceRoot, "components/tool-detail-drawer.tsx");
    const drawerTestPath = resolve(sourceRoot, "components/tests/tool-detail-drawer.test.tsx");
    const modalSource = readFileSync(resolve(sourceRoot, "components/modal.tsx"), "utf8");
    const stylesSource = readFileSync(resolve(sourceRoot, "styles.css"), "utf8");

    expect(existsSync(drawerPath)).toBe(false);
    expect(existsSync(drawerTestPath)).toBe(false);
    expect(modalSource).not.toContain("placement");
    expect(stylesSource).not.toContain("modal-right");
    expect(stylesSource).not.toContain("modal-placement-right");
  });

  it("removes v2 local BrandIcon and hand-drawn integration assets", () => {
    const brandIconPath = resolve(sourceRoot, "components/brand-icon.tsx");
    const brandIconTestPath = resolve(sourceRoot, "components/tests/brand-icon.test.tsx");
    const localAssetsPath = resolve(sourceRoot, "assets/integrations");
    const fixturePath = resolve(sourceRoot, "mocks/fixtures/integrations.ts");

    expect(existsSync(brandIconPath)).toBe(false);
    expect(existsSync(brandIconTestPath)).toBe(false);
    expect(existsSync(localAssetsPath)).toBe(false);
    expect(existsSync(fixturePath)).toBe(false);
  });
});
