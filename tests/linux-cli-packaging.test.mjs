import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const installerPath = path.join(repoRoot, "scripts", "install.sh");
const builderPath = path.join(repoRoot, "scripts", "internal", "linux", "build-cli-archive.sh");
const linuxWorkflowPath = path.join(repoRoot, ".github", "workflows", "linux-cli-installer.yml");
const desktopReleaseWorkflowPath = path.join(
  repoRoot,
  ".github",
  "workflows",
  "github-draft-release-v2.yml",
);
const temporaryRoots = [];

function temporaryRoot(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function sha256(target) {
  return createHash("sha256").update(readFileSync(target)).digest("hex");
}

function cleanNpmLifecycleEnv(overrides = {}) {
  const entries = Object.entries(process.env).filter(([key]) => (
    !key.toLowerCase().startsWith("npm_") && key !== "INIT_CWD"
  ));
  return { ...Object.fromEntries(entries), ...overrides };
}

function makeInstallerFixture(root) {
  const release = path.join(root, "release");
  const payload = path.join(root, "payload");
  const agent = path.join(payload, "App", "memmy-agent");
  const backend = path.join(payload, "App", "backend");
  const memory = path.join(payload, "Memory");
  const migrations = path.join(payload, "Migrations");
  const contracts = path.join(payload, "App", "backend", "local-api-contracts");
  const model = path.join(
    payload,
    "resources",
    "embedding-models",
    "Xenova",
    "all-MiniLM-L6-v2",
  );
  const archive = path.join(release, "memmy-agent-linux-cli.tar.gz");
  mkdirSync(path.join(agent, "dist"), { recursive: true });
  mkdirSync(path.join(backend, "dist", "src", "services"), { recursive: true });
  mkdirSync(
    path.join(backend, "dist", "src", "adapters", "outbound", "skill-writer", "templates"),
    { recursive: true },
  );
  mkdirSync(path.join(memory, "dist", "src", "server"), { recursive: true });
  mkdirSync(path.join(memory, "dist", "src", "cli"), { recursive: true });
  mkdirSync(path.join(migrations, "dist"), { recursive: true });
  mkdirSync(path.join(contracts, "dist"), { recursive: true });
  mkdirSync(path.join(model, "onnx"), { recursive: true });
  mkdirSync(release, { recursive: true });
  writeFileSync(path.join(payload, "package.json"), JSON.stringify({
    name: "memmy-linux-fixture",
    version: "9.9.9",
    private: true,
    workspaces: ["Memory", "Migrations", "App/backend/local-api-contracts"],
  }, null, 2));
  writeFileSync(path.join(agent, "package.json"), JSON.stringify({
    name: "memmy-agent",
    version: "9.9.9",
    type: "module",
    bin: { memmy: "dist/main.js" },
  }, null, 2));
  writeFileSync(path.join(backend, "package.json"), JSON.stringify({
    name: "@memmy/backend",
    version: "0.0.0",
    type: "module",
  }, null, 2));
  writeFileSync(
    path.join(backend, "dist", "src", "services", "builtin-skill-target-registry.js"),
    "export function createBuiltinSkillTargetRegistry() { return { get() { return undefined; } }; }\n",
  );
  writeFileSync(
    path.join(backend, "dist", "src", "adapters", "outbound", "skill-writer", "templates", "memmy-resume-hook.js"),
    "export const fixture = true;\n",
  );
  writeFileSync(
    path.join(backend, "dist", "src", "adapters", "outbound", "skill-writer", "templates", "memmy-opencode-plugin.js"),
    "export const fixture = true;\n",
  );
  const lock = spawnSync("npm", [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ], { cwd: agent, encoding: "utf8", env: cleanNpmLifecycleEnv() });
  expect(lock.status, lock.stderr).toBe(0);
  writeFileSync(
    path.join(agent, "dist", "main.js"),
    "if (process.argv.includes('--version')) console.log('9.9.9');\n",
  );
  writeFileSync(path.join(memory, "package.json"), JSON.stringify({
    name: "@memmy/memory",
    version: "9.9.9",
    type: "module",
  }, null, 2));
  writeFileSync(path.join(migrations, "package.json"), JSON.stringify({
    name: "@memmy/migrations",
    version: "0.0.0",
    type: "module",
  }, null, 2));
  writeFileSync(path.join(contracts, "package.json"), JSON.stringify({
    name: "@memmy/local-api-contracts",
    version: "0.0.0",
    type: "module",
  }, null, 2));
  const rootLock = spawnSync("npm", [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ], { cwd: payload, encoding: "utf8", env: cleanNpmLifecycleEnv() });
  expect(rootLock.status, rootLock.stderr).toBe(0);
  writeFileSync(path.join(memory, "dist", "src", "server", "index.js"), "setInterval(() => {}, 1000);\n");
  writeFileSync(path.join(memory, "dist", "src", "cli", "index.js"), [
    "import fs from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'init') {",
    "  const index = args.indexOf('--config');",
    "  if (index >= 0) fs.writeFileSync(args[index + 1], 'memmyMemory:\\n  storage:\\n    token: fixture-token\\n');",
    "}",
    "if (args.includes('--version')) console.log('9.9.9');",
    "",
  ].join("\n"));
  writeFileSync(path.join(migrations, "dist", "index.js"), "export {};\n");
  writeFileSync(path.join(contracts, "dist", "index.js"), "export {};\n");
  writeFileSync(path.join(model, "config.json"), "{}\n");
  writeFileSync(path.join(model, "tokenizer.json"), "{}\n");
  writeFileSync(path.join(model, "tokenizer_config.json"), "{}\n");
  writeFileSync(path.join(model, "onnx", "model_quantized.onnx"), "fixture\n");
  const tar = spawnSync("tar", ["-czf", archive, "-C", payload, "."], { encoding: "utf8" });
  expect(tar.status, tar.stderr).toBe(0);
  writeFileSync(`${archive}.sha256`, `${sha256(archive)}  ${path.basename(archive)}\n`);
  return release;
}

function fakeLinuxTools(root) {
  const tools = path.join(root, "tools");
  mkdirSync(tools, { recursive: true });
  const uname = path.join(tools, "uname");
  writeFileSync(uname, [
    "#!/usr/bin/env bash",
    "case \"$1\" in",
    "  -s) printf 'Linux\\n' ;;",
    "  -m) printf 'x86_64\\n' ;;",
    "  *) printf 'Linux\\n' ;;",
    "esac",
    "",
  ].join("\n"));
  chmodSync(uname, 0o755);
  const npm = path.join(tools, "npm");
  writeFileSync(npm, [
    "#!/usr/bin/env bash",
    "if [ \"${MEMMY_FIXTURE_NPM_FAIL:-0}\" = \"1\" ]; then exit 42; fi",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(npm, 0o755);
  const systemctl = path.join(tools, "systemctl");
  writeFileSync(systemctl, [
    "#!/usr/bin/env bash",
    "if [ -n \"${MEMMY_FIXTURE_SYSTEMCTL_LOG:-}\" ]; then printf '%s\\n' \"$*\" >> \"$MEMMY_FIXTURE_SYSTEMCTL_LOG\"; fi",
    "if [ \"${MEMMY_FIXTURE_SYSTEMCTL_FAIL:-0}\" = \"1\" ] && [ \"${1:-}\" = \"--user\" ] && [ \"${2:-}\" = \"daemon-reload\" ]; then exit 43; fi",
    "if [ \"${1:-}\" = \"--user\" ] && [ \"${2:-}\" = \"show\" ] && [[ \"$*\" == *\"MainPID\"* ]]; then printf '%s\\n' \"$MEMMY_FIXTURE_MAIN_PID\"; exit 0; fi",
    "if [ \"${1:-}\" = \"--user\" ] && [ \"${2:-}\" = \"is-enabled\" ]; then exit 1; fi",
    "if [ \"${1:-}\" = \"--user\" ] && [ \"${2:-}\" = \"is-active\" ]; then exit 1; fi",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(systemctl, 0o755);
  const mv = path.join(tools, "mv");
  writeFileSync(mv, [
    "#!/usr/bin/env bash",
    "if [ \"${1:-}\" = \"-Tf\" ]; then",
    "  /bin/rm -f \"$3\"",
    "  exec /bin/mv -f \"$2\" \"$3\"",
    "fi",
    "exec /bin/mv \"$@\"",
    "",
  ].join("\n"));
  chmodSync(mv, 0o755);
  return tools;
}

function runInstaller(home, release, tools, overrides = {}) {
  return spawnSync("bash", [installerPath], {
    encoding: "utf8",
    env: cleanNpmLifecycleEnv({
      HOME: home,
      MEMMY_VERSION: "9.9.9",
      MEMMY_RELEASE_BASE_URL: pathToFileURL(release).href.replace(/\/$/, ""),
      MEMMY_FIXTURE_MAIN_PID: String(process.pid),
      PATH: `${tools}${path.delimiter}${process.env.PATH ?? ""}`,
      ...overrides,
    }),
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Linux CLI package boundary", () => {
  it("keeps the archive runtime-only and the installer architecture-neutral", () => {
    const builder = readFileSync(builderPath, "utf8");
    const installer = readFileSync(installerPath, "utf8");

    expect(builder).toContain("App/memmy-agent/dist/main.js");
    expect(builder).toContain("Memory/dist/src/server/index.js");
    expect(builder).toContain("Memory/dist/src/cli/index.js");
    expect(builder).toContain("builtin-skill-target-registry.js");
    expect(builder).toContain("analytics-transport.js");
    expect(builder).toContain("skill-writer");
    expect(builder).toContain("prepare-embedding-model.mjs");
    expect(builder).toContain("COPYFILE_DISABLE=1 tar --no-xattrs -czf");
    expect(builder).toContain("Migrations/dist/index.js");
    expect(builder).toContain("local-api-contracts/dist/index.js");
    expect(builder).not.toContain("App/shell/desktop");
    expect(builder).not.toContain("App/frontend/desktop");
    expect(installer).toContain('(cd "$AGENT_DIR" && npm ci --omit=dev');
    expect(installer).toContain("npm ci --omit=dev --workspace @memmy/memory");
    expect(installer).toContain('--home "$MEMMY_HOME_DIR"');
    expect(installer).toContain("--generate-token-if-missing");
    expect(installer).toContain("systemctl --user enable --now memmy-memory.service");
    expect(installer).toContain("systemctl --user restart memmy-memory.service");
    expect(installer).toContain("memmy-gateway.service did not become stable after update");
    expect(installer).toContain("memmy-gateway.service");
    expect(installer).toContain("MEMMY_LINUX_SYSTEMD_GATEWAY=1");
    expect(installer).toContain("MEMMY_GATEWAY_ENV_FILE=");
    expect(installer).toContain("EnvironmentFile=");
    expect(installer).toContain("gateway --config %s --workspace %s");
    expect(installer).toContain("x86_64|amd64");
    expect(installer).toContain("aarch64|arm64");
    expect(installer).toContain("Node.js 22 or newer is required");
    expect(installer).not.toMatch(/nohup|disown|pkill|killall|enable-linger/);
  });

  it("installs standalone Agent dependencies before Linux archive contract tests", () => {
    const linuxWorkflow = readFileSync(linuxWorkflowPath, "utf8");
    const agentInstall = "run: npm ci --prefix App/memmy-agent";
    const contractTests = "run: npm run test:linux-cli";

    expect(linuxWorkflow).toContain(agentInstall);
    expect(linuxWorkflow.indexOf(agentInstall)).toBeLessThan(
      linuxWorkflow.indexOf(contractTests),
    );
  });

  it("builds an archive with compiled CLI packages and no desktop payload", () => {
    const output = temporaryRoot("memmy-linux-archive-");
    const modelSource = path.join(output, "model-source", "Xenova", "all-MiniLM-L6-v2");
    mkdirSync(path.join(modelSource, "onnx"), { recursive: true });
    for (const file of ["config.json", "tokenizer.json", "tokenizer_config.json"]) {
      writeFileSync(path.join(modelSource, file), "{}\n");
    }
    writeFileSync(path.join(modelSource, "onnx", "model_quantized.onnx"), "fixture\n");
    const result = spawnSync("bash", [builderPath, "--output", output], {
      cwd: repoRoot,
      encoding: "utf8",
      env: cleanNpmLifecycleEnv({ MEMMY_EMBEDDING_MODEL_SOURCE_DIR: path.dirname(path.dirname(modelSource)) }),
    });
    expect(result.status, result.stderr).toBe(0);

    const archive = path.join(output, "memmy-agent-linux-cli.tar.gz");
    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout).toContain("App/memmy-agent/dist/main.js");
    expect(listing.stdout).toContain("Memory/dist/src/server/index.js");
    expect(listing.stdout).toContain("Memory/dist/src/cli/index.js");
    expect(listing.stdout).toContain("App/backend/dist/src/services/builtin-skill-target-registry.js");
    expect(listing.stdout).toContain("App/backend/dist/src/analytics/analytics-transport.js");
    expect(listing.stdout).toContain("App/backend/dist/src/adapters/outbound/skill-writer/templates/memmy-resume-hook.js");
    expect(listing.stdout).toContain("App/backend/dist/src/adapters/outbound/skill-writer/templates/memmy-opencode-plugin.js");
    expect(listing.stdout).toContain("resources/embedding-models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx");
    expect(listing.stdout).toContain("Migrations/dist/index.js");
    expect(listing.stdout).toContain("App/backend/local-api-contracts/dist/index.js");
    expect(listing.stdout).not.toMatch(/electron|\.dmg|\.exe|App\/frontend|App\/shell/i);
    expect(listing.stdout).not.toMatch(/node_modules|App\/memmy-agent\/src\/|Memory\/src\/(?!server|cli)/);
    expect(existsSync(`${archive}.sha256`)).toBe(true);
    expect(existsSync(path.join(output, "install.sh"))).toBe(true);

    const extracted = path.join(output, "extracted");
    mkdirSync(extracted);
    const extract = spawnSync("tar", ["-xzf", archive, "-C", extracted], { encoding: "utf8" });
    expect(extract.status, extract.stderr).toBe(0);
    const installDryRun = spawnSync("npm", [
      "ci",
      "--omit=dev",
      "--dry-run",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ], {
      cwd: path.join(extracted, "App", "memmy-agent"),
      encoding: "utf8",
      env: cleanNpmLifecycleEnv(),
    });
    expect(installDryRun.status, installDryRun.stderr).toBe(0);
    const memoryInstallDryRun = spawnSync("npm", [
      "ci",
      "--omit=dev",
      "--workspace",
      "@memmy/memory",
      "--include-workspace-root=false",
      "--dry-run",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ], {
      cwd: extracted,
      encoding: "utf8",
      env: cleanNpmLifecycleEnv(),
    });
    expect(memoryInstallDryRun.status, memoryInstallDryRun.stderr).toBe(0);

    rmSync(path.join(extracted, "node_modules"), { recursive: true, force: true });
    symlinkSync(path.join(repoRoot, "node_modules"), path.join(extracted, "node_modules"));
    const integrationModuleUrl = pathToFileURL(path.join(
      extracted,
      "App",
      "backend",
      "dist",
      "src",
      "services",
      "builtin-skill-target-registry.js",
    )).href;
    const integrationImport = spawnSync("node", [
      "--input-type=module",
      "--eval",
      [
        `const module = await import(${JSON.stringify(integrationModuleUrl)});`,
        `const registry = module.createBuiltinSkillTargetRegistry(${JSON.stringify(path.join(extracted, "config.yaml"))});`,
        "if (typeof registry.get('codex')?.installPlugin !== 'function') process.exit(2);",
        "if (typeof registry.get('opencode')?.installPlugin !== 'function') process.exit(3);",
      ].join("\n"),
    ], { cwd: extracted, encoding: "utf8" });
    expect(integrationImport.status, integrationImport.stderr).toBe(0);
  }, 120_000);

  it("keeps Linux publication isolated from the desktop Draft Release", () => {
    const linuxWorkflow = readFileSync(linuxWorkflowPath, "utf8");
    const desktopWorkflow = readFileSync(desktopReleaseWorkflowPath, "utf8");

    expect(linuxWorkflow).toContain("ubuntu-24.04-arm");
    expect(linuxWorkflow).toContain("types: [published]");
    expect(linuxWorkflow).toContain("needs: [build, install-smoke]");
    expect(linuxWorkflow).toContain("gh release upload");
    expect(linuxWorkflow).toContain("MEMMY_SMOKE_SECRET");
    expect(linuxWorkflow).toContain("systemctl --user is-active --quiet memmy-gateway.service");
    expect(linuxWorkflow).not.toMatch(/gh release (create|delete)/);
    expect(desktopWorkflow).not.toContain("memmy-agent-linux-cli");
    expect(desktopWorkflow).not.toContain("scripts/install.sh");
  });
});

describe("Linux one-line installer transaction", () => {
  it("installs, repeats PATH setup idempotently, and preserves the prior version on checksum failure", () => {
    const root = temporaryRoot("memmy-linux-installer-");
    const home = path.join(root, "home");
    mkdirSync(home, { recursive: true });
    const release = makeInstallerFixture(root);
    const tools = fakeLinuxTools(root);
    const systemctlLog = path.join(root, "systemctl.log");

    const first = runInstaller(home, release, tools, { MEMMY_FIXTURE_SYSTEMCTL_LOG: systemctlLog });
    expect(first.status, first.stderr).toBe(0);
    const launcher = path.join(home, ".local", "bin", "memmy");
    expect(existsSync(launcher)).toBe(true);
    const version = spawnSync(launcher, ["--version"], { encoding: "utf8" });
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe("9.9.9");
    const memoryLauncher = path.join(home, ".local", "bin", "memmy-memory");
    expect(existsSync(memoryLauncher)).toBe(true);
    expect(readFileSync(memoryLauncher, "utf8")).toContain("MEMMY_AGENT_INTEGRATION_ROOT=");
    expect(spawnSync(memoryLauncher, ["health"], { encoding: "utf8" }).status).toBe(0);
    const memoryUnit = readFileSync(
      path.join(home, ".config", "systemd", "user", "memmy-memory.service"),
      "utf8",
    );
    expect(memoryUnit).toContain("ExecStart=");
    expect(memoryUnit).toContain("/current/Memory/dist/src/server/index.js");
    expect(memoryUnit).toContain("Restart=on-failure");
    expect(memoryUnit).toContain("UMask=0077");
    expect(memoryUnit).toContain("WantedBy=default.target");
    const gatewayUnit = readFileSync(
      path.join(home, ".config", "systemd", "user", "memmy-gateway.service"),
      "utf8",
    );
    expect(gatewayUnit).toContain("Wants=memmy-memory.service");
    expect(gatewayUnit).toContain("/current/App/memmy-agent/dist/main.js");
    expect(gatewayUnit).toContain("After=memmy-memory.service");
    expect(gatewayUnit).toContain(
      `EnvironmentFile=-${path.join(home, ".memmy", "systemd", "gateway.env")}`,
    );
    expect(gatewayUnit).not.toMatch(/^EnvironmentFile=.*"/m);
    expect(gatewayUnit).toContain("Restart=on-failure");
    expect(gatewayUnit).toContain("StartLimitIntervalSec=60s");
    expect(gatewayUnit).toContain("StartLimitBurst=5");
    expect(gatewayUnit).toContain("UMask=0077");
    expect(readFileSync(systemctlLog, "utf8")).toContain("--user enable --now memmy-memory.service");
    expect(readFileSync(systemctlLog, "utf8")).not.toContain("--user enable --now memmy-gateway.service");
    expect(readFileSync(launcher, "utf8")).toContain("MEMMY_LINUX_SYSTEMD_GATEWAY=1");
    expect(readFileSync(launcher, "utf8")).toContain("MEMMY_GATEWAY_ENV_FILE=");

    const second = runInstaller(home, release, tools, { MEMMY_FIXTURE_SYSTEMCTL_LOG: systemctlLog });
    expect(second.status, second.stderr).toBe(0);
    const profileLines = readFileSync(path.join(home, ".profile"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line === 'export PATH="$HOME/.local/bin:$PATH"');
    expect(profileLines).toHaveLength(1);

    const current = path.join(home, ".local", "share", "memmy-agent", "current");
    const beforeFailure = readlinkSync(current);
    const npmFailed = runInstaller(home, release, tools, { MEMMY_FIXTURE_NPM_FAIL: "1" });
    expect(npmFailed.status).not.toBe(0);
    expect(npmFailed.stderr).toContain("Memory dependency installation failed");
    expect(readlinkSync(current)).toBe(beforeFailure);

    const configPath = path.join(home, ".memmy", "config.yaml");
    const configBeforeSystemdFailure = "sentinel: preserve-on-rollback\n";
    writeFileSync(configPath, configBeforeSystemdFailure);
    const systemdFailed = runInstaller(home, release, tools, {
      MEMMY_FIXTURE_SYSTEMCTL_FAIL: "1",
    });
    expect(systemdFailed.status).not.toBe(0);
    expect(systemdFailed.stderr).toContain("could not reload the systemd user manager");
    expect(readFileSync(configPath, "utf8")).toBe(configBeforeSystemdFailure);
    expect(readlinkSync(current)).toBe(beforeFailure);

    writeFileSync(
      path.join(release, "memmy-agent-linux-cli.tar.gz.sha256"),
      `0000000000000000000000000000000000000000000000000000000000000000  memmy-agent-linux-cli.tar.gz\n`,
    );
    const failed = runInstaller(home, release, tools);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("SHA-256 verification failed");
    expect(readlinkSync(current)).toBe(beforeFailure);
  }, 60_000);
});
