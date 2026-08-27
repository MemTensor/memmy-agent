import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCloudServiceEnv } from "../load-env.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("backend cloud-service env loading", () => {
  it("keeps an explicit environment origin ahead of the packaged manifest", () => {
    const root = fixtureRoot();
    const manifestPath = writeManifest(root, "https://manifest.example.test");
    const env = { MEMMY_CLOUD_SERVICE: "https://external.example.test" };

    expect(loadCloudServiceEnv({ env, manifestPath })).toBe("environment");
    expect(env.MEMMY_CLOUD_SERVICE).toBe("https://external.example.test");
  });

  it("loads only the allowlisted cloud service from a packaged manifest", () => {
    const root = fixtureRoot();
    const manifestPath = join(root, "desktop-edition.json");
    writeFileSync(manifestPath, JSON.stringify({
      edition: "cn",
      cloudService: "https://manifest.example.test",
      secretToken: "must-not-be-injected",
    }));
    const env: NodeJS.ProcessEnv = { MEMMY_CLOUD_SERVICE: "   " };

    expect(loadCloudServiceEnv({ env, manifestPath })).toBe(manifestPath);
    expect(env).toEqual({ MEMMY_CLOUD_SERVICE: "https://manifest.example.test" });
  });

  it("falls back to a development .env when no manifest is requested", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, ".env"), "MEMMY_CLOUD_SERVICE=https://dev.example.test\n");
    const env: NodeJS.ProcessEnv = {};

    expect(loadCloudServiceEnv({ cwd: root, moduleDir: root, env })).toBe(join(root, ".env"));
    expect(env.MEMMY_CLOUD_SERVICE).toBe("https://dev.example.test");
  });

  it("fails closed when a requested packaged manifest is missing or malformed", () => {
    const root = fixtureRoot();
    expect(() => loadCloudServiceEnv({ env: {}, manifestPath: join(root, "missing.json") }))
      .toThrow(/manifest is missing/);
    const manifestPath = join(root, "desktop-edition.json");
    writeFileSync(manifestPath, JSON.stringify({ cloudService: "http://unsafe.example.test" }));
    expect(() => loadCloudServiceEnv({ env: {}, manifestPath })).toThrow(/HTTPS/);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-backend-env-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeManifest(root: string, cloudService: string): string {
  const path = join(root, "desktop-edition.json");
  writeFileSync(path, JSON.stringify({ cloudService }));
  return path;
}
