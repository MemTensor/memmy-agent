import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";
import { createPackageWithOptions, listPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import {
  normalizePublicCloudService,
  writeDesktopEditionManifest,
} from "../scripts/internal/shared/write-desktop-edition-manifest-lib.mjs";
import { pruneRuntimeEnvFiles } from "../scripts/internal/shared/prune-runtime-env-files-lib.mjs";
import { windowsPEFixture } from "./fixtures/windows-pe-fixture.mjs";

import { memoryRuntimeBuildIdentity } from "../scripts/internal/shared/memory-runtime-build-identity.mjs";

const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

// These cases stage ASAR fixtures and launch independent verification processes.
describe("packaged desktop runtime configuration", { timeout: 20_000 }, () => {
  it.each(["mac/build-dmg.sh", "win/build-nsis.sh"])("stages executable scan ordering for standalone agent contracts: %s", (script) => {
    const root = fixtureRoot();
    const memory = join(root, "Memory");
    const core = join(memory, "AgentSourceCore");
    mkdirSync(join(core, "dist/src"), { recursive: true });
    const repo = dirname(dirname(fileURLToPath(import.meta.url)));
    writeFileSync(join(core, "package.json"), readFileSync(join(repo, "Memory/AgentSourceCore/package.json")));
    // Packaging guards run before workspace builds on a clean checkout.
    // Compile the actual shared implementation inside the isolated fixture.
    const source = readFileSync(join(repo, "Memory/AgentSourceCore/src/scan-state.ts"), "utf8");
    writeFileSync(join(core, "dist/src/scan-state.js"), transpileModule(source, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    }).outputText);
    const runtime = join(root, "runtime");
    const build = readFileSync(join(repo, "scripts/internal", script), "utf8");
    const stage = build.slice(build.lastIndexOf('RUNTIME_AGENT_SOURCE_CORE_DIR='), build.indexOf('RUNTIME_LOCAL_API_CONTRACTS_DIR='));
    expect(stage).toContain('cp -R');
    const staged = spawnSync("bash", ["-eu", "-c", stage], { env: { ...process.env, MEMORY_DIR: memory, RUNTIME_DIR: runtime }, encoding: "utf8" });
    expect(staged.status, staged.stderr).toBe(0);
    const agent = join(runtime, "memmy-agent");
    writeFileSync(join(agent, "check.mjs"), `import { acceptsScanUpdate } from '@memmy/agent-source-core/scan-state';
      import { createRequire } from 'node:module';
      createRequire(import.meta.url).resolve('@memmy/agent-source-core/package.json');
      if (acceptsScanUpdate({version:{generation:2,sequence:3}}, {version:{generation:2,sequence:2}})) throw Error('stale accepted');`);
    const imported = spawnSync(process.execPath, [join(agent, "check.mjs")], { encoding: "utf8" });
    expect(imported.status, imported.stderr).toBe(0);
  });

  it("writes exactly the public allowlist and never serializes env decoys", async () => {
    const root = fixtureRoot();
    const envFile = join(root, ".env");
    const output = join(root, "dist", "main", "desktop-edition.json");
    writeFileSync(envFile, [
      "MEMMY_CLOUD_SERVICE=https://manifest.example.test/",
      "MEMMY_PRIVATE_TOKEN=must-not-be-packaged",
      "MEMMY_LEGAL_CN_BASE_URL=https://legal.example.test",
    ].join("\n"));

    await writeDesktopEditionManifest({
      output,
      edition: "cn",
      accountChannel: "phone",
      signing: "signed",
      environment: {},
      envFile,
    });

    const manifestText = readFileSync(output, "utf8");
    const manifest = JSON.parse(manifestText);
    expect(manifest).toEqual({
      edition: "cn",
      accountChannel: "phone",
      signing: "signed",
      cloudService: "https://manifest.example.test",
    });
    expect(manifestText).not.toContain("MEMMY_PRIVATE_TOKEN");
    expect(manifestText).not.toContain("must-not-be-packaged");
    expect(manifestText).not.toContain("MEMMY_LEGAL_CN_BASE_URL");
  });

  it("uses an explicit environment origin before the root env file", async () => {
    const root = fixtureRoot();
    const envFile = join(root, ".env");
    const output = join(root, "desktop-edition.json");
    writeFileSync(envFile, "MEMMY_CLOUD_SERVICE=https://file.example.test\n");

    await writeDesktopEditionManifest({
      output,
      edition: "intl",
      accountChannel: "email",
      signing: "unsigned",
      environment: { MEMMY_CLOUD_SERVICE: "https://external.example.test" },
      envFile,
    });

    expect(JSON.parse(readFileSync(output, "utf8")).cloudService).toBe(
      "https://external.example.test",
    );
  });

  it.each([
    "ftp://api.example.test",
    "https://user:pass@api.example.test",
    "https://api.example.test/path",
    "https://api.example.test?token=value",
    "https://api.example.test/#fragment",
  ])("rejects a non-public cloud-service value: %s", (value) => {
    expect(() => normalizePublicCloudService(value)).toThrow(/MEMMY_CLOUD_SERVICE/);
  });

  it.each([
    ["http://127.0.0.1:8101", "http://127.0.0.1:8101"],
    ["http://localhost:8101/", "http://localhost:8101"],
    ["http://[::1]:8101", "http://[::1]:8101"],
    ["http://192.0.2.10:8101", "http://192.0.2.10:8101"],
  ])("allows an HTTP cloud-service origin: %s", (value, expected) => {
    expect(normalizePublicCloudService(value)).toBe(expected);
  });

  it("removes runtime env files and symlinks without touching normal files", async () => {
    const root = fixtureRoot();
    const dependency = join(root, "node_modules", "dependency");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, ".env"), "REDIS_HOST=127.0.0.1\n");
    writeFileSync(join(dependency, ".env.local"), "TOKEN=decoy\n");
    writeFileSync(join(dependency, "runtime.js"), "export {};\n");
    try {
      symlinkSync(join(dependency, "runtime.js"), join(dependency, ".env.production"));
    } catch (error) {
      if (error?.code !== "EPERM") throw error;
      writeFileSync(join(dependency, ".env.production"), "TOKEN=platform-fallback\n");
    }

    expect(await pruneRuntimeEnvFiles(root)).toBe(3);
    expect(existsSync(join(dependency, ".env"))).toBe(false);
    expect(existsSync(join(dependency, ".env.local"))).toBe(false);
    expect(existsSync(join(dependency, ".env.production"))).toBe(false);
    expect(existsSync(join(dependency, "runtime.js"))).toBe(true);
    expect(await pruneRuntimeEnvFiles(root)).toBe(0);
  });

  it("executes the writer and pruner CLI entrypoints", () => {
    const root = fixtureRoot();
    const output = join(root, "desktop-edition.json");
    const writer = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "internal",
      "shared",
      "write-desktop-edition-manifest.mjs",
    );
    const writerResult = spawnSync(process.execPath, [
      writer,
      "--output", output,
      "--edition", "cn",
      "--account-channel", "phone",
      "--signing", "unsigned",
    ], {
      encoding: "utf8",
      env: { ...process.env, MEMMY_CLOUD_SERVICE: "https://cli.example.test" },
    });
    expect(writerResult.status, writerResult.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8")).cloudService).toBe("https://cli.example.test");

    const runtime = join(root, "runtime");
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, ".env"), "TOKEN=decoy\n");
    const pruner = join(dirname(writer), "prune-runtime-env-files.mjs");
    const pruneResult = spawnSync(process.execPath, [pruner, runtime], { encoding: "utf8" });
    expect(pruneResult.status, pruneResult.stderr).toBe(0);
    expect(existsSync(join(runtime, ".env"))).toBe(false);
  });

  it("changes Memory build identity when runtime code changes without a version bump", async () => {
    const root = fixtureRoot();
    seedMemoryBuildInputs(root);
    const before = await memoryRuntimeBuildIdentity(root);
    writeFileSync(join(root, "Memory/src/storage/schema.ts"), "export const SCHEMA_VERSION = 9;\r\n");
    expect(await memoryRuntimeBuildIdentity(root)).toEqual(before);
    writeFileSync(join(root, "Memory/src/server.ts"), "export const behavior = 'new';\n");
    const changed = await memoryRuntimeBuildIdentity(root);
    expect(changed.buildId).not.toBe(before.buildId);
    expect(changed.schemaVersion).toBe(9);
    writeFileSync(join(root, "Memory/src/storage/schema.ts"), "export const SCHEMA_VERSION = 10;\n");
    expect(await memoryRuntimeBuildIdentity(root)).toMatchObject({ schemaVersion: 10 });
  });

  it("creates a standalone Windows Memory manifest without private workspace dependencies", () => {
    const root = fixtureRoot();
    seedMemoryBuildInputs(root);
    const sourcePackage = join(root, "Memory", "package.json");
    const runtimePackage = join(root, "runtime", "package.json");
    const runtimeMetadata = join(root, "runtime", "memory-runtime.json");
    writeFixtureJson(sourcePackage, {
      name: "@memmy/memory",
      version: "2.1.0",
      dependencies: {
        "@memmy/agent-source-core": "0.0.0",
        zod: "^4.4.3",
      },
    });
    const generator = join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "scripts", "internal", "win", "create-memory-runtime-manifest.mjs",
    );

    const result = spawnSync(process.execPath, [
      generator,
      sourcePackage,
      runtimePackage,
      runtimeMetadata,
    ], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(runtimePackage, "utf8"))).toEqual({
      name: "@memmy/packaged-memory-runtime",
      version: "2.1.0",
      private: true,
      type: "module",
      dependencies: { zod: "^4.4.3" },
    });
    expect(JSON.parse(readFileSync(runtimeMetadata, "utf8"))).toEqual({
      buildId: expect.stringMatching(/^[a-f0-9]{64}$/),
      schemaVersion: 9,
      version: "2.1.0",
      protocolVersion: 1,
      target: "windows-x64",
      entrypoint: "dist/src/server/index.js",
      viewer: "dist/viewer/index.html",
    });
  });

  it("creates a standalone macOS Memory manifest and stages its workspace parser package", () => {
    const root = fixtureRoot();
    seedMemoryBuildInputs(root);
    const memoryDir = join(root, "Memory");
    const runtimeDir = join(root, "runtime");
    const coreDir = join(root, "Memory", "AgentSourceCore");
    const buildScript = readFileSync(join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "scripts", "internal", "mac", "build-dmg.sh",
    ), "utf8").replaceAll("\r\n", "\n");
    writeFixtureJson(join(memoryDir, "package.json"), {
      version: "2.1.1",
      dependencies: { "@memmy/agent-source-core": "0.0.0", zod: "4.4.3" },
    });
    writeFixtureJson(join(root, "package-lock.json"), {
      lockfileVersion: 3,
      requires: true,
      packages: {
        "node_modules/@memmy/agent-source-core": { resolved: "Memory/AgentSourceCore", link: true },
        "Memory/AgentSourceCore": { name: "@memmy/agent-source-core", version: "0.0.0" },
        "node_modules/zod": { version: "4.4.3" },
      },
    });
    const manifestFunction = buildScript.slice(
      buildScript.indexOf("create_memory_runtime_manifest() {"),
      buildScript.indexOf("\nprune_better_sqlite3_build_artifacts()"),
    );
    const generated = spawnSync("bash", ["-c", `${manifestFunction}\ncreate_memory_runtime_manifest "$MEMORY_RUNTIME_DIR"`], {
      encoding: "utf8",
      env: { ...process.env, ROOT_DIR: root, MEMORY_DIR: memoryDir, MEMORY_RUNTIME_DIR: runtimeDir, TARGET_CPU: "arm64" },
    });
    expect(generated.status, generated.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(runtimeDir, "memory-runtime.json"), "utf8"))).toMatchObject({
      buildId: expect.stringMatching(/^[a-f0-9]{64}$/), schemaVersion: 9
    });
    expect(JSON.parse(readFileSync(join(runtimeDir, "package.json"), "utf8")).dependencies).toEqual({
      "@memmy/agent-source-core": "file:../../../../../../Memory/AgentSourceCore",
      zod: "4.4.3",
    });
    const lock = JSON.parse(readFileSync(join(runtimeDir, "package-lock.json"), "utf8"));
    expect(lock.packages[""].dependencies).toEqual({
      "@memmy/agent-source-core": "file:../../../../../../Memory/AgentSourceCore",
      zod: "4.4.3",
    });
    expect(lock.packages["node_modules/@memmy/agent-source-core"]).toBeUndefined();
    expect(lock.packages["node_modules/zod"].version).toBe("4.4.3");

    writeFixtureJson(join(coreDir, "package.json"), {
      name: "@memmy/agent-source-core", version: "0.0.0", type: "module", main: "./dist/src/index.js",
    });
    mkdirSync(join(coreDir, "dist", "src"), { recursive: true });
    writeFileSync(join(coreDir, "dist", "src", "index.js"), 'export { readCodexSourceTurn } from "./codex-source-turn.js";\n');
    writeFileSync(join(coreDir, "dist", "src", "codex-source-turn.js"), 'export const readCodexSourceTurn = () => "packaged-parser";\n');
    mkdirSync(join(memoryDir, "dist", "src"), { recursive: true });
    mkdirSync(join(memoryDir, "dist", "viewer"), { recursive: true });
    mkdirSync(join(memoryDir, "adapters"), { recursive: true });
    mkdirSync(join(root, "App", "memmy-agent", "dist"), { recursive: true });
    mkdirSync(join(runtimeDir, "memmy-agent"), { recursive: true });
    const stageStart = buildScript.indexOf('mkdir -p "$RUNTIME_DIR/memory/dist"');
    const stageEnd = buildScript.indexOf('\nnode "$ROOT_DIR/scripts/internal/shared/check-office-slim-assets.mjs"', stageStart);
    expect(stageStart).toBeGreaterThanOrEqual(0);
    expect(stageEnd).toBeGreaterThan(stageStart);
    const staged = spawnSync("bash", ["-c", buildScript.slice(stageStart, stageEnd)], {
      encoding: "utf8",
      env: { ...process.env, ROOT_DIR: root.replaceAll("\\", "/"), RUNTIME_DIR: runtimeDir.replaceAll("\\", "/"),
        MEMORY_DIR: memoryDir.replaceAll("\\", "/"), AGENT_DIR: join(root, "App", "memmy-agent").replaceAll("\\", "/") },
    });
    expect(staged.status, staged.stderr).toBe(0);
    expect(existsSync(join(runtimeDir, "memory", "AgentSourceCore", "package.json"))).toBe(true);
    expect(existsSync(join(runtimeDir, "memory", "AgentSourceCore", "dist", "src", "index.js"))).toBe(true);
    expect(buildScript).toContain('npm ci --prefix "$RUNTIME_DIR/memory" --omit=dev --install-links');
    expect(buildScript).toContain('require_packaged_runtime_file "$packaged_agent_source_core/dist/src/index.js"');
    expect(buildScript).toContain('require_packaged_runtime_file "$packaged_agent_source_core/dist/src/codex-source-turn.js"');
    expect(buildScript).toContain('require_packaged_runtime_file "$packaged_memory_runtime/dist/src/agent-source/integration/workspace-bridge/memmy-workspace-bridge.mjs"');
    expect(buildScript).toContain('[ -L "$packaged_agent_source_core" ]');
  });

  it("validates desktop and Memory ASAR versions against independent authorities", async () => {
    const root = fixtureRoot();
    const verifier = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "internal",
      "shared",
      "verify-packaged-asar.mjs",
    );
    const asar = await createAsarFixture(
      root,
      "independent-component-versions",
      "1.1.2",
      false,
      true,
      [],
      "win32",
      "complete",
      "2.1.0",
    );

    const verified = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(asar, "1.1.2", "win32", "x64", "2.1.0")],
      { encoding: "utf8" },
    );
    expect(verified.status, verified.stderr).toBe(0);

    const staleMemory = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(asar, "1.1.2", "win32", "x64", "2.0.9")],
      { encoding: "utf8" },
    );
    expect(staleMemory.status).not.toBe(0);
    expect(staleMemory.stderr).toContain("dist/runtime/memory/package.json");

    const missingMemoryAuthority = spawnSync(process.execPath, [
      verifier,
      "--asar", asar,
      "--expected", "1.1.2",
      "--platform", "win32",
      "--arch", "x64",
    ], { encoding: "utf8" });
    expect(missingMemoryAuthority.status).not.toBe(0);
    expect(missingMemoryAuthority.stderr).toContain("--expected-memory is required");

    const invalidMemoryAuthority = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(asar, "1.1.2", "win32", "x64", "invalid")],
      { encoding: "utf8" },
    );
    expect(invalidMemoryAuthority.status).not.toBe(0);
    expect(invalidMemoryAuthority.stderr).toContain(
      "Expected packaged Memory version must use semantic version syntax",
    );

    const unexpectedDarwinMemoryAuthority = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(asar, "1.1.2", "darwin", "arm64"), "--expected-memory", "2.1.0"],
      { encoding: "utf8" },
    );
    expect(unexpectedDarwinMemoryAuthority.status).not.toBe(0);
    expect(unexpectedDarwinMemoryAuthority.stderr).toContain(
      "--expected-memory is only supported for win32 packages",
    );

    const emptyDarwinMemoryAuthority = spawnSync(process.execPath, [
      verifier,
      ...verifierArgs(asar, "1.1.2", "darwin", "arm64"),
      "--expected-memory", "",
    ], { encoding: "utf8" });
    expect(emptyDarwinMemoryAuthority.status).not.toBe(0);
    expect(emptyDarwinMemoryAuthority.stderr).toContain(
      "--expected-memory is only supported for win32 packages",
    );

    const staleAgentAsar = await createAsarFixture(
      root,
      "stale-agent-version",
      "1.1.2",
      false,
      true,
      [],
      "win32",
      "complete",
      "2.1.0",
      "1.1.1",
    );
    const staleAgent = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(staleAgentAsar, "1.1.2", "win32", "x64", "2.1.0")],
      { encoding: "utf8" },
    );
    expect(staleAgent.status).not.toBe(0);
    expect(staleAgent.stderr).toContain("dist/runtime/memmy-agent/package.json");
  });

  it("verifies standalone Windows Memory outside the ASAR", async () => {
    const root = fixtureRoot();
    const memoryRoot = join(root, "memory-resource");
    const asar = await createAsarFixture(root, "external-memory", "1.1.8", false, true, [], "win32", "complete", "2.1.3", "1.1.8", false);
    const verifier = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "internal", "shared", "verify-packaged-asar.mjs");
    writeFixtureJson(join(memoryRoot, "package.json"), { version: "2.1.3" });
    writeFixtureJson(join(memoryRoot, "node_modules/@memmy/agent-source-core/package.json"), { version: "0.0.0" });
    const core = join(memoryRoot, "node_modules/@memmy/agent-source-core/dist/src/index.js");
    mkdirSync(dirname(core), { recursive: true });
    writeFileSync(core, "export {};\n");
    const onnx = join(memoryRoot, "node_modules/onnxruntime-node/bin/napi-v3/win32/x64");
    mkdirSync(onnx, { recursive: true });
    writeFileSync(join(onnx, "onnxruntime_binding.node"), "win-x64-node");
    writeFileSync(join(onnx, "onnxruntime.dll"), "win-x64-dll");
    const args = [verifier, ...verifierArgs(asar, "1.1.8", "win32", "x64", "2.1.3"), "--memory-root", memoryRoot];
    const valid = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(valid.status, valid.stderr).toBe(0);
    writeFixtureJson(join(memoryRoot, "package.json"), { version: "2.1.2" });
    const stale = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain("Packaged Memory resource version");
  });

  it("fails closed on ASAR env files and stale embedded versions", async () => {
    const root = fixtureRoot();
    const verifier = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "scripts",
      "internal",
      "shared",
      "verify-packaged-asar.mjs",
    );
    const goodAsar = await createAsarFixture(root, "good", "1.0.8");
    const good = spawnSync(process.execPath, [verifier, ...verifierArgs(goodAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(good.status, good.stderr).toBe(0);

    const historyPrefix = "dist/runtime/memmy-agent/dist/tools/computer-history/win/";
    const missingHelper = await createAsarFixture(root, "missing-history-helper", "1.0.8");
    rmSync(join(`${missingHelper}.unpacked`, historyPrefix, "memmy-history-recorder.exe"));
    const missing = spawnSync(process.execPath, [verifier, ...verifierArgs(missingHelper, "1.0.8")], { encoding: "utf8" });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("memmy-history-recorder.exe");
    for (const [name, extra, expectedError] of [
      ["invalid-history-pe", [`${historyPrefix}memmy-history-recorder.exe`, "not an executable"], "x64 PE executable"],
      ["history-test-sources", [`${historyPrefix}native/tests/fixture.cpp`, "test source"], "native build/test sources"],
    ]) {
      const invalid = await createAsarFixture(root, name, "1.0.8", false, true, [extra]);
      const result = spawnSync(process.execPath, [verifier, ...verifierArgs(invalid, "1.0.8")], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(expectedError);
    }

    const missingAgentSourceCoreAsar = await createAsarFixture(
      root,
      "without-agent-source-core",
      "1.0.8",
      false,
      true,
      [],
      "win32",
      "manifest-only",
    );
    const missingAgentSourceCore = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(missingAgentSourceCoreAsar, "1.0.8")],
      { encoding: "utf8" },
    );
    expect(missingAgentSourceCore.status).not.toBe(0);
    expect(missingAgentSourceCore.stderr).toContain(
      "dist/runtime/memory/node_modules/@memmy/agent-source-core/dist/src/index.js",
    );

    const darwinAsar = await createAsarFixture(root, "darwin", "1.0.8", false, true, [], "darwin");
    const darwin = spawnSync(process.execPath, [verifier, ...verifierArgs(darwinAsar, "1.0.8", "darwin", "arm64")], {
      encoding: "utf8",
    });
    expect(darwin.status, darwin.stderr).toBe(0);

    const noLocksAsar = await createAsarFixture(root, "without-locks", "1.0.8", false, false);
    const withoutLocks = spawnSync(
      process.execPath,
      [verifier, ...verifierArgs(noLocksAsar, "1.0.8")],
      { encoding: "utf8" },
    );
    expect(withoutLocks.status, withoutLocks.stderr).toBe(0);

    const staleAsar = await createAsarFixture(root, "stale", "1.0.7");
    const stale = spawnSync(process.execPath, [verifier, ...verifierArgs(staleAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain("does not match the requested version");

    const envAsar = await createAsarFixture(root, "with-env", "1.0.8", true);
    const withEnv = spawnSync(process.execPath, [verifier, ...verifierArgs(envAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(withEnv.status).not.toBe(0);
    expect(withEnv.stderr).toContain("forbidden environment file");

    const foreignNativeAsar = await createAsarFixture(root, "foreign-native", "1.0.8", false, true, [
      ["dist/runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/linux/x64/libonnxruntime.so", "foreign"],
    ]);
    const foreignNative = spawnSync(process.execPath, [verifier, ...verifierArgs(foreignNativeAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(foreignNative.status).not.toBe(0);
    expect(foreignNative.stderr).toContain("incompatible onnxruntime-node platform");

    const toolchainAsar = await createAsarFixture(root, "toolchain", "1.0.8", false, true, [
      ["dist/runtime/memmy-agent/node_modules/vitest/index.js", "test-only"],
    ]);
    const toolchain = spawnSync(process.execPath, [verifier, ...verifierArgs(toolchainAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(toolchain.status).not.toBe(0);
    expect(toolchain.stderr).toContain("optional-peer test toolchain");

    const thirdPartyMapAsar = await createAsarFixture(root, "third-party-map", "1.0.8", false, true, [
      ["dist/runtime/memory/node_modules/dependency/dist/index.js.map", "third-party-map"],
    ]);
    const thirdPartyMap = spawnSync(process.execPath, [verifier, ...verifierArgs(thirdPartyMapAsar, "1.0.8")], {
      encoding: "utf8",
    });
    expect(thirdPartyMap.status).not.toBe(0);
    expect(thirdPartyMap.stderr).toContain("third-party production source map");
  });

  it("passes the defined Windows package architecture to the shared ASAR verifier", () => {
    const buildScript = readFileSync(join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "scripts", "internal", "win", "build-nsis.sh",
    ), "utf8");
    const verifierCall = buildScript.slice(
      buildScript.indexOf('node "$ROOT_DIR/scripts/internal/shared/verify-packaged-asar.mjs"'),
      buildScript.indexOf("\n}", buildScript.indexOf('node "$ROOT_DIR/scripts/internal/shared/verify-packaged-asar.mjs"')),
    );

    expect(verifierCall).toContain('--arch "$PACKAGE_ARCH"');
    expect(verifierCall).toContain('--expected-memory "$MEMORY_VERSION"');
    expect(verifierCall).not.toContain("TARGET_ARCH");
  });

  it("rejects a package without the Computer Use page or its unpacked native panel", async () => {
    const root = fixtureRoot();
    const verifier = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts/internal/shared/verify-packaged-asar.mjs");
    const asar = await createAsarFixture(root, "native-pip", "1.2.0", false, true, [], "darwin");
    const run = path => spawnSync(process.execPath, [verifier, ...verifierArgs(path, "1.2.0", "darwin", "arm64")], { encoding: "utf8" });
    expect(run(asar).status).toBe(0);
    rmSync(join(`${asar}.unpacked`, "dist/native/memmy-pip.node"));
    const missingNative = run(asar);
    expect(missingNative.status).not.toBe(0);
    expect(missingNative.stderr).toContain("Packaged native PiP addon is missing from unpacked resources");
    const missingPage = await createAsarFixture(root, "missing-pip-page", "1.2.0", false, true,
      [["dist/main/computer-use-surface.html", null]], "darwin");
    const missing = run(missingPage);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain("dist/main/computer-use-surface.html");
  });

  it("rejects missing Windows preview assets and a packed-only or foreign helper", async () => {
    const root = fixtureRoot();
    const verifier = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts/internal/shared/verify-packaged-asar.mjs");
    const helper = "dist/runtime/memmy-agent/dist/native-computer-use/windows/amd64/memmy-computer-use.exe";
    const run = path => spawnSync(process.execPath, [verifier, ...verifierArgs(path, "1.2.0")], { encoding: "utf8" });
    const asar = await createAsarFixture(root, "windows-cu", "1.2.0");
    expect(run(asar).status).toBe(0);
    rmSync(join(`${asar}.unpacked`, helper));
    const missingUnpacked = run(asar);
    expect(missingUnpacked.status).not.toBe(0);
    expect(missingUnpacked.stderr).toContain("helper is missing from unpacked resources");
    for (const file of ["dist/main/computer-use-surface.html", "dist/preload/computer-use-surface-preload.cjs", helper]) {
      const missing = await createAsarFixture(root, `missing-${file.split('/').pop()}`, "1.2.0", false, true, [[file, null]]);
      expect(run(missing).status).not.toBe(0);
      expect(run(missing).stderr).toContain(file);
    }
    const foreign = await createAsarFixture(root, "windows-foreign-helper", "1.2.0", false, true,
      [[helper, windowsPEFixture(0xaa64)]]);
    expect(run(foreign).status).not.toBe(0);
    expect(run(foreign).stderr).toContain("x64 PE32+ executable");
    const addon = await createAsarFixture(root, "windows-mac-addon", "1.2.0", false, true,
      [["dist/native/memmy-pip.node", "Mach-O fixture"]]);
    expect(run(addon).status).not.toBe(0);
    expect(run(addon).stderr).toContain("macOS-only native Computer Use addon");
  });

  it("rejects a missing, foreign, or packed-only Windows History recorder", async () => {
    const root = fixtureRoot();
    const verifier = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts/internal/shared/verify-packaged-asar.mjs");
    const helper = "dist/runtime/memmy-agent/dist/native-computer-history/windows/amd64/memmy-computer-history.exe";
    const run = path => spawnSync(process.execPath, [verifier, ...verifierArgs(path, "1.2.0")], { encoding: "utf8" });
    const asar = await createAsarFixture(root, "windows-history", "1.2.0");
    expect(run(asar).status).toBe(0);
    rmSync(join(`${asar}.unpacked`, helper));
    expect(run(asar).stderr).toContain("History recorder is missing from unpacked resources");
    for (const [name, bytes, error] of [
      ["missing", null, "missing required runtime file"],
      ["foreign", Buffer.concat([windowsPEFixture(0xaa64), Buffer.from("MemmyWindowsHistoryRuntimeV1")]), "x64 PE32+"],
      ["fixture", windowsPEFixture(), "no current native runtime identity"],
    ]) {
      const broken = await createAsarFixture(root, `windows-history-${name}`, "1.2.0", false, true, [[helper, bytes]]);
      expect(run(broken).status).not.toBe(0);
      expect(run(broken).stderr).toContain(error);
    }
  });

  it("accepts the current Windows browser modules without the removed autofill vault", async () => {
    const root = fixtureRoot();
    const verifier = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts/internal/shared/verify-packaged-asar.mjs");
    const asar = await createAsarFixture(root, "current-browser-modules", "1.2.2-rc.1");
    const entries = listPackage(asar).map(path => path.replaceAll("\\", "/").replace(/^\/+/, ""));
    expect(entries).toContain("dist/main/browser-auth-form.js");
    expect(entries).toContain("dist/main/browser-browsing-data.js");
    expect(entries).not.toContain("dist/main/browser-autofill-vault.js");
    const result = spawnSync(process.execPath, [verifier, ...verifierArgs(asar, "1.2.2-rc.1")], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("extracts preview, unpacked renderer and JSON entries with Windows host separators", async () => {
    const root = fixtureRoot();
    const verifier = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts/internal/shared/verify-packaged-asar.mjs");
    const asar = await createAsarFixture(root, "windows-host-separators", "1.2.2-rc.1");
    const prelude = join(root, "windows-host-asar.mjs");
    // Exercise the real ASAR lookup with Windows separators in an isolated child.
    // Physical temporary files keep their host paths so this also runs on macOS.
    writeFileSync(prelude, String.raw`
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
const nativePath = createRequire(import.meta.url)("node:path");
const hostJoin = nativePath.join;
const hostDirname = nativePath.dirname;
const hostBasename = nativePath.basename;
nativePath.sep = "\\";
nativePath.join = (...parts) => parts.every(part => !part.includes("/") && !part.includes("\\"))
  ? nativePath.win32.join(...parts)
  : hostJoin(...parts.map(part => part.replaceAll("\\", "/")));
nativePath.dirname = path => path.includes("\\") && !path.includes("/")
  ? nativePath.win32.dirname(path) : hostDirname(path);
nativePath.basename = path => path.includes("\\") && !path.includes("/")
  ? nativePath.win32.basename(path) : hostBasename(path);
syncBuiltinESMExports();
process.argv.splice(1, 1);
await import(pathToFileURL(process.argv[1]).href);
`);
    const result = spawnSync(process.execPath, [prelude, verifier, ...verifierArgs(asar, "1.2.2-rc.1")], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Verified packaged ASAR boundary and version 1.2.2-rc.1");
  });

  it.each(["dist/main/browser-auth-form.js", "dist/main/browser-browsing-data.js"])(
    "rejects a Windows package missing current browser module %s", async file => {
      const root = fixtureRoot();
      const verifier = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts/internal/shared/verify-packaged-asar.mjs");
      const asar = await createAsarFixture(root, "missing-current-browser-module", "1.2.2-rc.1", false, true,
        [[file, null], ["dist/main/browser-autofill-vault.js", "obsolete module cannot replace current module\n"]]);
      const result = spawnSync(process.execPath, [verifier, ...verifierArgs(asar, "1.2.2-rc.1")], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Packaged ASAR is missing required runtime file: ${file}`);
    },
  );

  it("stages the private agent source workspace package without resolving it from npm", () => {
    const buildScript = readFileSync(join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "scripts", "internal", "win", "build-nsis.sh",
    ), "utf8");

    expect(buildScript).toContain('AGENT_SOURCE_CORE_DIR="$ROOT_DIR/Memory/AgentSourceCore"');
    expect(buildScript).toContain(
      'node "$ROOT_DIR/scripts/internal/win/create-memory-runtime-manifest.mjs"',
    );
    expect(buildScript).toContain(
      'RUNTIME_AGENT_SOURCE_CORE_DIR="$RUNTIME_DIR/memory/node_modules/@memmy/agent-source-core"',
    );
    expect(buildScript).toContain(
      'cp -R "$AGENT_SOURCE_CORE_DIR/dist" "$RUNTIME_AGENT_SOURCE_CORE_DIR/dist"',
    );
    expect(buildScript).toContain(
      'require_packaged_runtime_file "$RUNTIME_AGENT_SOURCE_CORE_DIR/dist/src/index.js"',
    );
    expect(buildScript.indexOf('npm_ci_win_x64 "$RUNTIME_DIR/memory"')).toBeLessThan(
      buildScript.indexOf('RUNTIME_AGENT_SOURCE_CORE_DIR="$RUNTIME_DIR/memory/node_modules/@memmy/agent-source-core"'),
    );
    expect(buildScript).toContain(
      'local packaged_memory_runtime="$UNPACKED_DIR/resources/memory-runtime"',
    );
    expect(buildScript).toContain(
      'require_packaged_runtime_file "$packaged_agent_source_core/package.json"',
    );
    expect(buildScript).toContain(
      'require_packaged_runtime_file "$packaged_agent_source_core/dist/src/index.js"',
    );
  });

  it("copies Memory node_modules into both Windows offline runtime variants", () => {
    for (const configName of [
      "electron-builder.win.yml",
      "electron-builder.win.unsigned.yml",
    ]) {
      const config = readFileSync(join(
        dirname(fileURLToPath(import.meta.url)),
        "..", "App", "shell", "desktop", configName,
      ), "utf8");
      expect(config.replaceAll("\r\n", "\n")).toContain([
        "  - from: dist/runtime/memory/node_modules",
        "    to: memory-runtime/node_modules",
        "    filter:",
        '      - "**/*"',
      ].join("\n"));
    }
  });
});

async function createAsarFixture(
  root,
  name,
  version,
  includeEnv = false,
  includeLocks = true,
  extraFiles = [],
  platform = "win32",
  agentSourceCoreFixture = "complete",
  memoryVersion = version,
  agentVersion = version,
  memoryInAsar = true,
) {
  const source = join(root, `${name}-source`);
  const asar = join(root, `${name}.asar`);
  const manifest = { version };
  writeFixtureJson(join(source, "package.json"), manifest);
  writeFixtureJson(join(source, "dist/main/desktop-edition.json"), {
    cloudService: "https://manifest.example.test",
  });
  for (const file of ["dist/main/computer-use-surface-window.js", "dist/main/computer-use-surface.html",
    "dist/preload/computer-use-surface-preload.cjs",
    ...(platform === "darwin" ? ["dist/native/memmy-pip.node", "dist/native/menu-bar-appearance.node"] : [])]) {
    mkdirSync(dirname(join(source, file)), { recursive: true });
    writeFileSync(join(source, file), "preview-asset\n");
  }
  const renderer = join(source, "dist/renderer");
  mkdirSync(join(renderer, "assets"), { recursive: true });
  writeFileSync(join(renderer, "index.html"), '<script type="module" src="./assets/main.js"></script>\n');
  writeFileSync(join(renderer, "assets/main.js"), "export {};\n");
  for (const component of ["memory", "memmy-agent"]) {
    if (component === "memory" && !memoryInAsar) continue;
    const componentVersion = component === "memory" ? memoryVersion : agentVersion;
    const componentManifest = { version: componentVersion };
    const componentLock = { version: componentVersion, packages: { "": { version: componentVersion } } };
    writeFixtureJson(join(source, `dist/runtime/${component}/package.json`), componentManifest);
    if (includeLocks) writeFixtureJson(join(source, `dist/runtime/${component}/package-lock.json`), componentLock);
  }
  const contracts = join(
    source,
    "dist/runtime/memmy-agent/node_modules/@memmy/local-api-contracts/dist/index.js",
  );
  mkdirSync(dirname(contracts), { recursive: true });
  writeFileSync(contracts, "export {};\n");
  const knowledge = join(source, "dist/runtime/memmy-agent/node_modules/@memmy/knowledge/dist/index.js");
  mkdirSync(dirname(knowledge), { recursive: true });
  writeFileSync(knowledge, "export {};\n");
  if (platform === "win32") {
    const historyRoot = join(source, "dist/runtime/memmy-agent/dist/tools/computer-history/win");
    mkdirSync(historyRoot, { recursive: true });
    const pe = Buffer.alloc(128);
    pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.write("PE\0\0", 64); pe.writeUInt16LE(0x8664, 68);
    writeFileSync(join(historyRoot, "memmy-history-recorder.exe"), pe);
    writeFileSync(join(historyRoot, "memmy-history-recorder.NOTICES.md"), "MIT fixture");
    for (const relativePath of [
      "dist/main/computer-use-window-capture.js",
      "dist/runtime/memmy-agent/dist/tools/computer-use/managed-ocu-session.js",
      "dist/runtime/memmy-agent/dist/tools/computer-use/native-surface-control.js",
      "dist/runtime/memmy-agent/dist/tools/computer-use/windows-focus-guard.js",
      "dist/main/browser-sidebar-bridge.js",
      "dist/main/browser-history-store.js",
      "dist/main/browser-download-catalog.js",
      "dist/main/browser-site-permissions.js",
      "dist/main/browser-access-store.js",
      "dist/main/browser-download-settings.js",
      "dist/main/browser-auth-form.js",
      "dist/main/browser-browsing-data.js",
      "dist/runtime/memmy-agent/dist/core/agent-runtime/tools/browser-profile.js",
      "dist/runtime/memmy-agent/dist/core/agent-runtime/tools/browser-downloads.js",
      "dist/runtime/memmy-agent/dist/core/agent-runtime/tools/browser-site-permissions.js",
      "dist/runtime/memmy-agent/dist/core/agent-runtime/tools/browser-access-approval.js",
      "dist/runtime/memmy-agent/dist/core/agent-runtime/tools/browser-window-visibility.js",
    ]) {
      const target = join(source, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "export {};\n");
    }
    const helper = join(source, "dist/runtime/memmy-agent/dist/native-computer-use/windows/amd64/memmy-computer-use.exe");
    mkdirSync(dirname(helper), { recursive: true });
    writeFileSync(helper, windowsPEFixture());
    const historyHelper = join(source, "dist/runtime/memmy-agent/dist/native-computer-history/windows/amd64/memmy-computer-history.exe");
    mkdirSync(dirname(historyHelper), { recursive: true });
    writeFileSync(historyHelper, Buffer.concat([windowsPEFixture(), Buffer.from("MemmyWindowsHistoryRuntimeV1")]));
    const ownSourceMap = join(source, "dist/runtime/memmy-agent/dist/main.js.map");
    mkdirSync(dirname(ownSourceMap), { recursive: true });
    writeFileSync(ownSourceMap, "own-production-map\n");
    if (memoryInAsar && agentSourceCoreFixture === "complete") {
      const agentSourceCore = join(
        source,
        "dist/runtime/memory/node_modules/@memmy/agent-source-core/dist/src/index.js",
      );
      mkdirSync(dirname(agentSourceCore), { recursive: true });
      writeFileSync(agentSourceCore, "export {};\n");
    }
    if (memoryInAsar && agentSourceCoreFixture !== "missing") {
      writeFixtureJson(
        join(source, "dist/runtime/memory/node_modules/@memmy/agent-source-core/package.json"),
        {
          name: "@memmy/agent-source-core",
          version: "0.0.0",
          type: "module",
          main: "./dist/src/index.js",
        },
      );
    }
  }
  const targetArch = platform === "darwin" ? "arm64" : "x64";
  if (memoryInAsar) {
    const onnxRuntimeRoot = join(source, `dist/runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/${platform}/${targetArch}`);
    mkdirSync(onnxRuntimeRoot, { recursive: true });
    writeFileSync(join(onnxRuntimeRoot, "onnxruntime_binding.node"), `${platform}-${targetArch}-node`);
    if (platform === "win32") writeFileSync(join(onnxRuntimeRoot, "onnxruntime.dll"), "win-x64-dll");
  }
  const lifecycleSidecar = join(
    source,
    "node_modules/@memmy/backend/dist/src/adapters/outbound/skill-writer/workspace-bridge/memmy-workspace-bridge.mjs",
  );
  mkdirSync(dirname(lifecycleSidecar), { recursive: true });
  writeFileSync(lifecycleSidecar, "export {};\n");
  for (const [relativePath, contents] of extraFiles) {
    const targetPath = join(source, relativePath);
    if (contents === null) { rmSync(targetPath, { force: true }); continue; }
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, contents);
  }
  if (includeEnv) writeFileSync(join(source, ".env.production"), "TOKEN=decoy\n");
  const output = await createPackageWithOptions(source, asar, { unpackDir: "dist/renderer", unpack: "**/*.{node,exe}" });
  await finished(output);
  return asar;
}

function verifierArgs(asar, expected, platform = "win32", arch = "x64", expectedMemory = expected) {
  const args = ["--asar", asar, "--expected", expected, "--platform", platform, "--arch", arch];
  if (platform === "win32") args.push("--expected-memory", expectedMemory);
  return args;
}

function writeFixtureJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "memmy-packaged-runtime-"));
  roots.push(root);
  return root;
}

function seedMemoryBuildInputs(root) {
  for (const path of ["Memory/src/storage", "Memory/viewer/src", "Memory/viewer/public", "Memory/adapters", "Memory/AgentSourceCore/src"]) {
    mkdirSync(join(root, path), { recursive: true });
  }
  for (const path of ["Memory/package.json", "Memory/tsconfig.json", "Memory/tsconfig.base.json",
    "Memory/viewer/package.json", "Memory/AgentSourceCore/package.json", "Memory/AgentSourceCore/tsconfig.json",
    "tsconfig.base.json", "package-lock.json"]) writeFixtureJson(join(root, path), {});
  writeFileSync(join(root, "Memory/src/storage/schema.ts"), "export const SCHEMA_VERSION = 9;\n");
  writeFileSync(join(root, "Memory/viewer/vite.config.ts"), "export default {};\n");
  writeFileSync(join(root, "Memory/viewer/index.html"), "<html></html>\n");
  const relative = "scripts/internal/shared/memory-runtime-build-identity.mjs";
  mkdirSync(dirname(join(root, relative)), { recursive: true });
  writeFileSync(join(root, relative), readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", relative)));
}
