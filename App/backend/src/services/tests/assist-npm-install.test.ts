import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { compareVersions, extractPackage, pickVersion, readTarEntries, satisfiesRange } from "../assist/npm-install.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-npm-install-"));
  roots.push(root);
  return root;
}

/**
 * 造一个最小 tar：只写 ustar 的固定字段，用于验证解包本身。
 * 真实 npm 包用的是同一套 header，多出来的只有 pax 扩展头（长路径）。
 */
function tarEntry(name: string, body: string, type = "0"): Buffer {
  const content = Buffer.from(body, "utf8");
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, 8, "utf8");
  header.write("0000000\0", 108, 8, "utf8");
  header.write("0000000\0", 116, 8, "utf8");
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write("00000000000\0", 136, 12, "utf8");
  header.write("        ", 148, 8, "utf8");
  header.write(type, 156, 1, "utf8");
  header.write("ustar\0" + "00", 257, 8, "utf8");
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512, 0);
  return Buffer.concat([header, content, padding]);
}

describe("版本范围", () => {
  it("compares three-part versions and puts a prerelease below its release", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
  });

  it("reads the ranges these adapters actually declare", () => {
    expect(satisfiesRange("4.6.7", "^4.0.0")).toBe(true);
    expect(satisfiesRange("5.0.0", "^4.0.0")).toBe(false);
    expect(satisfiesRange("2.6.9", "~2.6.0")).toBe(true);
    expect(satisfiesRange("2.7.0", "~2.6.0")).toBe(false);
    expect(satisfiesRange("9.0.3", "^9.0.1")).toBe(true);
    expect(satisfiesRange("3.1.1", ">=3.0.0")).toBe(true);
    expect(satisfiesRange("0.0.34", "^0.0.34")).toBe(true);
    expect(satisfiesRange("0.0.35", "^0.0.34")).toBe(false);
  });

  it("picks the highest stable version that satisfies the range", () => {
    const versions = ["4.5.0-beta.1", "4.5.0", "4.6.7", "5.0.0", "4.6.8-rc.1"];
    expect(pickVersion(versions, "^4.0.0")).toBe("4.6.7");
    expect(pickVersion(["1.0.0"], "^2.0.0")).toBeNull();
  });
});

describe("解开 npm 包", () => {
  it("drops the package/ prefix and writes the files under the target", () => {
    const root = tempRoot();
    const archive = Buffer.concat([
      tarEntry("package/", "", "5"),
      tarEntry("package/package.json", JSON.stringify({ name: "x", version: "1.0.0" })),
      tarEntry("package/dist/index.js", "console.log(1);\n")
    ]);
    extractPackage(archive, join(root, "node_modules", "x"));

    // 解出来的必须只是包内容，外层 package/ 不能出现在目标目录里。
    expect(readFileSync(join(root, "node_modules", "x", "package.json"), "utf8")).toContain("\"version\":\"1.0.0\"");
    expect(readFileSync(join(root, "node_modules", "x", "dist", "index.js"), "utf8")).toContain("console.log(1)");
  });

  it("reads the archive the way the registry serves it: gunzip, then read the tar", () => {
    // registry 给的是 .tgz：调用方先 gunzipSync 再解包，这条链路要和真实包一致。
    const compressed = gzipSync(Buffer.concat([tarEntry("package/a.txt", "hello")]));
    const entries = readTarEntries(gunzipSync(compressed));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("package/a.txt");
    expect(entries[0]?.body.toString("utf8")).toBe("hello");
  });

  it("refuses entries that try to escape the target directory", () => {
    const root = tempRoot();
    const archive = Buffer.concat([tarEntry("package/../../evil.txt", "x")]);
    extractPackage(archive, join(root, "node_modules", "x"));
    expect(() => readFileSync(join(root, "evil.txt"), "utf8")).toThrow();
  });
});
