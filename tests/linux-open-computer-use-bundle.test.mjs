import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bundleLinuxOpenComputerUse } from "../scripts/internal/linux/bundle-open-computer-use.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "memmy-linux-ocu-"));
  roots.push(root);
  const agent = join(root, "agent");
  const source = join(root, "source");
  mkdirSync(agent);
  const original = new URL("../App/memmy-agent/node_modules/open-computer-use", import.meta.url);
  cpSync(original, source, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const dependencies = { "open-computer-use": pkg.version };
  writeFileSync(join(agent, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies }));
  writeFileSync(join(agent, "package-lock.json"), JSON.stringify({
    name: "fixture", version: "1.0.0", lockfileVersion: 3,
    packages: { "": { name: "fixture", version: "1.0.0", dependencies },
      "node_modules/open-computer-use": { version: pkg.version, hasInstallScript: true, bin: pkg.bin } },
  }));
  return { root, agent, source };
}

it("installs OCU from a relocated Linux payload with an empty npm cache and no network", () => {
  const { root, agent, source } = fixture();
  const tarball = bundleLinuxOpenComputerUse(source, agent);
  const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  expect(listing).toContain("dist/linux/amd64/open-computer-use");
  expect(listing).toContain("dist/linux/arm64/open-computer-use");
  expect(listing).toContain("LICENSE");
  expect(listing).not.toMatch(/dist\/windows|Open Computer Use\.app/);
  const installed = join(root, "relocated");
  renameSync(agent, installed);
  rmSync(source, { recursive: true });
  const result = spawnSync("npm", ["ci", "--offline", "--omit=dev", "--no-audit", "--no-fund", "--cache", join(root, "empty-cache")], {
    cwd: installed, encoding: "utf8", timeout: 30_000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key) && key !== "INIT_CWD")),
  });
  expect(result.status, result.stderr).toBe(0);
  for (const arch of ["amd64", "arm64"]) {
    expect(existsSync(join(installed, "node_modules/open-computer-use/dist/linux", arch, "open-computer-use"))).toBe(true);
  }
  expect(existsSync(join(installed, "node_modules/open-computer-use/dist/windows"))).toBe(false);
});

it("rejects incomplete or mismatched source packages before changing the release manifests", () => {
  const { agent, source } = fixture();
  const before = readFileSync(join(agent, "package.json"), "utf8");
  rmSync(join(source, "dist/linux/arm64/open-computer-use"));
  expect(() => bundleLinuxOpenComputerUse(source, agent)).toThrow();
  expect(readFileSync(join(agent, "package.json"), "utf8")).toBe(before);
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  pkg.version = "99.0.0";
  writeFileSync(join(source, "package.json"), JSON.stringify(pkg));
  expect(() => bundleLinuxOpenComputerUse(source, agent)).toThrow("exact Agent dependency");
});
