import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("standalone runtime packaging", () => {
  it("resolves the patched Node 24.22.1 runtime from the installed pkg toolchain", () => {
    const memoryRequire = createRequire(import.meta.url);
    const pkgRequire = createRequire(memoryRequire.resolve("@yao-pkg/pkg/package.json"));
    const { getNodeVersion } = pkgRequire("@yao-pkg/pkg-fetch") as {
      getNodeVersion: (range: string) => string;
    };
    expect(getNodeVersion("node24.22.1")).toBe("v24.22.1");
  });

  it("targets the Node 24 pkg runtime and keeps both Linux sqlite prebuilds", async () => {
    const source = await readFile(resolve(import.meta.dirname, "../src/cli/scripts/build-standalone.mjs"), "utf8");
    expect(source).toContain('const PKG_NODE_RANGE = "node24.22.1";');
    expect(source).toContain("linux-${arch}.node");
    expect(source).toContain("linuxmusl-${arch}.node");
    expect(source).toContain("better-sqlite3 has no ${name} prebuild");
  });
});
