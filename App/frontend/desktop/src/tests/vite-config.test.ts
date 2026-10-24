/** Vite config tests. */
import { fileURLToPath } from "node:url";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { build, type AliasOptions, type UserConfig } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import viteConfig, { PUBLIC_MEMMY_RENDERER_ENV_KEYS } from "../../vite.config.js";

type AliasEntry = {
  /** Find. */
  find: string | RegExp;
  /** Replacement. */
  replacement: string;
};

describe("vite workspace resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads local API contracts from source instead of generated dist", () => {
    const config = resolveConfig("test");
    const aliases = normalizeAliasEntries(config.resolve?.alias);

    expect(aliases).toContainEqual({
      find: "@memmy/local-api-contracts",
      replacement: fileURLToPath(new URL("../../../../backend/local-api-contracts/src/index.ts", import.meta.url))
    });
  });

  it("isolates test validation without mutating process env", () => {
    vi.stubEnv("MEMMY_LEGAL_CN_BASE_URL", "http://invalid.test");
    vi.stubEnv("MEMMY_LEGAL_INTL_BASE_URL", "https://invalid.test/path");

    expect(() => resolveConfig("test")).not.toThrow();
    expect(process.env.MEMMY_LEGAL_CN_BASE_URL).toBe("http://invalid.test");
    expect(process.env.MEMMY_LEGAL_INTL_BASE_URL).toBe("https://invalid.test/path");
  });

  it("keeps development validation strict", () => {
    vi.stubEnv("MEMMY_LEGAL_CN_BASE_URL", "http://invalid.test");
    vi.stubEnv("MEMMY_LEGAL_INTL_BASE_URL", "https://valid.test");

    expect(() => resolveConfig("development")).toThrow(/MEMMY_LEGAL_CN_BASE_URL/);
  });

  it("exposes only the explicit public MEMMY allowlist to renderer code", () => {
    vi.stubEnv("MEMMY_PRIVATE_TOKEN", "must-not-be-rendered");
    const config = resolveConfig("test");

    expect(config.envPrefix).toEqual(["VITE_"]);
    expect(Object.keys(config.define ?? {}).sort()).toEqual(
      PUBLIC_MEMMY_RENDERER_ENV_KEYS.map((key) => `import.meta.env.${key}`).sort(),
    );
    expect(JSON.stringify(config.define)).not.toContain("MEMMY_PRIVATE_TOKEN");
    expect(JSON.stringify(config.define)).not.toContain("must-not-be-rendered");
  });

  it("ignores source watcher events during stable Electron demo runs", () => {
    vi.stubEnv("MEMMY_STABLE_ELECTRON_DEMO", "1");

    const config = resolveConfig("test");

    expect(config.server?.watch).toEqual({ ignored: ["**/*"] });
    expect(config.server?.hmr).toEqual({
      host: "127.0.0.1",
      port: 19001
    });
  });

  it("keeps source watching enabled for normal frontend development", () => {
    vi.stubEnv("MEMMY_STABLE_ELECTRON_DEMO", "0");

    const config = resolveConfig("test");

    expect(config.server?.watch).toBeUndefined();
    expect(config.server?.hmr).toEqual({
      host: "127.0.0.1",
      port: 19001
    });
  });
});

describe("production React workspace identity", () => {
  it("shares the hook dispatcher when a linked package has its own React copy", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "memmy-react-workspace-"));
    const require = createRequire(import.meta.url);
    const reactDirectory = dirname(require.resolve("react/package.json"));
    const reactDomDirectory = dirname(require.resolve("react-dom/package.json"));
    const schedulerDirectory = dirname(require.resolve("scheduler/package.json"));
    const frontendRoot = fileURLToPath(new URL("../..", import.meta.url));
    const configFile = join(frontendRoot, "vite.config.ts");
    const entryFile = join(fixture, "entry.js");
    const linkedPackage = join(fixture, "linked-package");

    try {
      await cp(reactDirectory, join(linkedPackage, "node_modules/react"), { recursive: true });
      await cp(reactDomDirectory, join(linkedPackage, "node_modules/react-dom"), { recursive: true });
      await cp(schedulerDirectory, join(linkedPackage, "node_modules/scheduler"), { recursive: true });
      await writeFile(join(linkedPackage, "index.js"), [
        'export { default as linkedReact } from "react";',
        'export { jsx as linkedJsx } from "react/jsx-runtime";',
        'export { createRoot as linkedCreateRoot } from "react-dom/client";',
      ].join("\n"));
      await writeFile(entryFile, [
        `import appReact from ${JSON.stringify(join(reactDirectory, "index.js"))};`,
        `import { jsx as appJsx } from ${JSON.stringify(join(reactDirectory, "jsx-runtime.js"))};`,
        `import { createRoot as appCreateRoot } from ${JSON.stringify(join(reactDomDirectory, "client.js"))};`,
        'import { linkedReact, linkedJsx, linkedCreateRoot } from "./linked-package/index.js";',
        "export const sameInstance = appReact === linkedReact;",
        "export const sameDispatcher = appReact.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE === linkedReact.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;",
        "export const sameJsxRuntime = appJsx === linkedJsx;",
        "export const sameRootFactory = appCreateRoot === linkedCreateRoot;",
      ].join("\n"));

      const bundleIdentity = async (useDesktopConfig: boolean) => {
        const output = await build({
          root: frontendRoot,
          configFile: useDesktopConfig ? configFile : false,
          mode: "test",
          logLevel: "silent",
          build: {
            write: false,
            minify: true,
            rolldownOptions: { input: entryFile, preserveEntrySignatures: "strict" },
          },
        });
        const builds = Array.isArray(output) ? output : [output];
        const entry = builds.flatMap((result) => "output" in result ? result.output : [])
          .find((item) => item.type === "chunk" && item.isEntry);
        if (!entry || entry.type !== "chunk") throw new Error("Missing production fixture entry");
        return await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`) as {
          sameInstance: boolean;
          sameDispatcher: boolean;
          sameJsxRuntime: boolean;
          sameRootFactory: boolean;
        };
      };

      // Prove the fixture recreates two physical React copies, then validate the
      // actual production configuration preserves a single hook dispatcher.
      expect(await bundleIdentity(false)).toMatchObject({
        sameInstance: false,
        sameDispatcher: false,
        sameJsxRuntime: false,
        sameRootFactory: false,
      });
      expect(await bundleIdentity(true)).toMatchObject({
        sameInstance: true,
        sameDispatcher: true,
        sameJsxRuntime: true,
        sameRootFactory: true,
      });
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }, 30_000);
});

/** Handles resolve config. */
function resolveConfig(mode: string): UserConfig {
  if (typeof viteConfig !== "function") {
    return viteConfig;
  }

  const config = viteConfig({
    command: "serve",
    mode,
    isSsrBuild: false,
    isPreview: false
  });

  if (config instanceof Promise) {
    throw new Error("Expected frontend desktop Vite config to be synchronous.");
  }

  return config;
}

/** Normalizes normalize alias entries. */
function normalizeAliasEntries(alias: AliasOptions | undefined): AliasEntry[] {
  if (!alias) {
    return [];
  }

  if (Array.isArray(alias)) {
    return alias.map((entry) => ({
      find: entry.find,
      replacement: entry.replacement
    }));
  }

  return Object.entries(alias).map(([find, replacement]) => ({
    find,
    replacement
  }));
}
