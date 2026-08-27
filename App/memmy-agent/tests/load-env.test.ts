import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCloudServiceEnv } from "../src/load-env.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("packaged memmy cloud-service loading", () => {
  it("prefers explicit env, then the ASAR manifest, then development .env", () => {
    const root = fixtureRoot();
    const moduleDir = join(root, "app.asar", "dist", "runtime", "memmy-agent", "dist");
    mkdirSync(moduleDir, { recursive: true });
    const manifestPath = resolve(moduleDir, "../../../main/desktop-edition.json");
    mkdirSync(resolve(moduleDir, "../../../main"), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ cloudService: "https://manifest.example.test" }));
    writeFileSync(join(root, ".env"), "MEMMY_CLOUD_SERVICE=https://dev.example.test\n");

    const externalEnv = { MEMMY_CLOUD_SERVICE: "https://external.example.test" };
    expect(loadCloudServiceEnv({ cwd: root, moduleDir, env: externalEnv })).toBe("environment");
    expect(externalEnv.MEMMY_CLOUD_SERVICE).toBe("https://external.example.test");

    const packagedEnv: NodeJS.ProcessEnv = {};
    expect(loadCloudServiceEnv({ cwd: root, moduleDir, env: packagedEnv })).toBe(manifestPath);
    expect(packagedEnv.MEMMY_CLOUD_SERVICE).toBe("https://manifest.example.test");

    rmSync(manifestPath);
    expect(() => loadCloudServiceEnv({ cwd: root, moduleDir, env: {} }))
      .toThrow(/manifest is missing/);

    const developmentModuleDir = join(root, "source", "App", "memmy-agent", "src");
    mkdirSync(developmentModuleDir, { recursive: true });
    const developmentEnv: NodeJS.ProcessEnv = {};
    expect(loadCloudServiceEnv({ cwd: root, moduleDir: developmentModuleDir, env: developmentEnv }))
      .toBe(join(root, ".env"));
    expect(developmentEnv.MEMMY_CLOUD_SERVICE).toBe("https://dev.example.test");
  });

  it("fails closed for a staged runtime and ignores a decoy manifest in source", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, ".env"), "MEMMY_CLOUD_SERVICE=https://dev.example.test\n");
    const stagedModuleDir = join(root, "dist", "runtime", "memmy-agent", "dist");
    mkdirSync(stagedModuleDir, { recursive: true });
    expect(() => loadCloudServiceEnv({ cwd: root, moduleDir: stagedModuleDir, env: {} }))
      .toThrow(/manifest is missing/);

    const sourceModuleDir = join(root, "source", "App", "memmy-agent", "src");
    mkdirSync(sourceModuleDir, { recursive: true });
    const decoyPath = resolve(sourceModuleDir, "../../../main/desktop-edition.json");
    mkdirSync(resolve(sourceModuleDir, "../../../main"), { recursive: true });
    writeFileSync(decoyPath, JSON.stringify({ cloudService: "https://decoy.example.test" }));
    const env: NodeJS.ProcessEnv = {};
    expect(loadCloudServiceEnv({ cwd: root, moduleDir: sourceModuleDir, env })).toBe(join(root, ".env"));
    expect(env.MEMMY_CLOUD_SERVICE).toBe("https://dev.example.test");
  });

  it("does not fall back when an explicit packaged manifest is invalid", () => {
    const root = fixtureRoot();
    const manifestPath = join(root, "desktop-edition.json");
    writeFileSync(manifestPath, JSON.stringify({ cloudService: "https://safe.example.test?token=x" }));
    expect(() => loadCloudServiceEnv({ cwd: root, moduleDir: root, manifestPath, env: {} }))
      .toThrow(/query or fragment/);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-agent-env-"));
  roots.push(root);
  return root;
}
