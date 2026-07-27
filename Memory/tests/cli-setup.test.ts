import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { formatOutput, runCommand } from "../src/cli/commands.js";
import { renderSetupResult } from "../src/cli/render/index.js";

const roots: string[] = [];
const envBackup: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete envBackup[key];
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("memmy-memory CLI setup commands", () => {
  it("initializes CLI config without creating local sqlite storage", async () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    const dbPath = join(root, "memory-service", "memory.sqlite");
    createAllAgentRoots(root);
    setEnv("HOME", root);

    const result = await runCommand({
      argv: ["init", "--home", root, "--config", configPath, "--db", dbPath, "--endpoint", "http://127.0.0.1:18888"]
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      command: "init",
      home: root,
      configPath,
      dbPath,
      endpoint: "http://127.0.0.1:18888"
    });
    const saved = YAML.parse(readFileSync(configPath, "utf8"));
    expect(saved).toMatchObject({
      memmyMemory: {
        version: 1,
        activeProfile: "byok",
        storage: {
          mode: "local",
          backend: "sqlite",
          sqlitePath: dbPath,
          endpoint: "http://127.0.0.1:18888"
        },
        profiles: {
          byok: {
            embedding: {
              provider: "local"
            }
          }
        },
        algorithm: {
          enableMemoryAdd: true,
          enableMemorySearch: true,
          enableQueryRewrite: false
        }
      }
    });
    expect(existsSync(dbPath)).toBe(false);
  });

  it("renders init results as a human-friendly success message", async () => {
    const root = tempRoot();
    createAllAgentRoots(root);
    setEnv("HOME", root);
    const result = await runCommand({
      argv: ["init", "--home", root, "--config", join(root, "config.yaml"), "--db", join(root, "memory.sqlite")]
    });

    const output = formatOutput(result);
    expect(output).toContain("Configuration saved successfully!");
    expect(output).toContain(`Config file: ${join(root, "config.yaml")}`);
    expect(output).toContain(`Database config: ${join(root, "memory.sqlite")}`);
    expect(output).toContain("Endpoint: http://127.0.0.1:18960");
    expect(output).toContain("Target agents: codex, cursor, claude, opencode, openclaw, hermes");
    expect(output).toContain("Shell completion: Skipped (disabled during init)");
    expect(output).toContain("Try running: memmy-memory health");
    expect(() => JSON.parse(output)).toThrow();

    expect(renderSetupResult(result, { color: true })).toContain("\u001b[");
  });

  it("installs all supported agent skills during init when no agent is specified", async () => {
    const root = tempRoot();
    const assetRoot = join(root, "assets");
    createCliAssets(assetRoot);
    createAllAgentRoots(root);
    setEnv("HOME", root);

    const result = await runCommand({
      argv: [
        "init",
        "--home", join(root, "memmy-home"),
        "--asset-root", assetRoot
      ]
    }) as Record<string, unknown>;

    expect(result.agents).toEqual([
      {
        agent: "codex",
        root: join(root, ".codex"),
        injectPath: join(root, ".codex", "AGENTS.md"),
        skillPath: join(root, ".codex", "skills", "memmy-memory"),
        dryRun: false
      },
      {
        agent: "cursor",
        root: join(root, ".cursor"),
        skillPath: join(root, ".cursor", "skills", "memmy-memory"),
        dryRun: false
      },
      {
        agent: "claude",
        root: join(root, ".claude"),
        injectPath: join(root, ".claude", "CLAUDE.md"),
        skillPath: join(root, ".claude", "skills", "memmy-memory"),
        dryRun: false
      },
      {
        agent: "opencode",
        root: join(root, ".config", "opencode"),
        injectPath: join(root, ".config", "opencode", "AGENTS.md"),
        skillPath: join(root, ".config", "opencode", "skills", "memmy-memory"),
        dryRun: false
      },
      {
        agent: "openclaw",
        root: join(root, ".openclaw"),
        injectPath: join(root, ".openclaw", "workspace", "AGENTS.md"),
        skillPath: join(root, ".openclaw", "skills", "memmy-memory"),
        dryRun: false
      },
      {
        agent: "hermes",
        root: join(root, ".hermes"),
        injectPath: join(root, ".hermes", "SOUL.md"),
        skillPath: join(root, ".hermes", "skills", "memmy-memory"),
        dryRun: false
      }
    ]);

    for (const injectPath of [
      join(root, ".codex", "AGENTS.md"),
      join(root, ".claude", "CLAUDE.md"),
      join(root, ".config", "opencode", "AGENTS.md"),
      join(root, ".openclaw", "workspace", "AGENTS.md"),
      join(root, ".hermes", "SOUL.md")
    ]) {
      expect(readFileSync(injectPath, "utf8")).toContain("<!-- memmy:start v=1 -->");
    }

    for (const skillPath of [
      join(root, ".codex", "skills", "memmy-memory", "SKILL.md"),
      join(root, ".cursor", "skills", "memmy-memory", "SKILL.md"),
      join(root, ".claude", "skills", "memmy-memory", "SKILL.md"),
      join(root, ".config", "opencode", "skills", "memmy-memory", "SKILL.md"),
      join(root, ".openclaw", "skills", "memmy-memory", "SKILL.md"),
      join(root, ".hermes", "skills", "memmy-memory", "SKILL.md")
    ]) {
      expect(readFileSync(skillPath, "utf8")).toContain("name: memmy-memory");
    }
  });

  it("skips an unavailable agent when installing all supported agent skills", async () => {
    const root = tempRoot();
    const assetRoot = join(root, "assets");
    createCliAssets(assetRoot);
    createAllAgentRoots(root);
    rmSync(join(root, ".hermes"), { recursive: true, force: true });
    setEnv("HOME", root);

    const result = await runCommand({
      argv: [
        "init",
        "--home", join(root, "memmy-home"),
        "--asset-root", assetRoot
      ]
    }) as Record<string, unknown>;

    expect((result.agents as Array<{ agent: string }>).map(({ agent }) => agent)).toEqual([
      "codex",
      "cursor",
      "claude",
      "opencode",
      "openclaw"
    ]);
    expect(existsSync(join(root, ".hermes"))).toBe(false);
    expect(existsSync(join(root, ".codex", "skills", "memmy-memory", "SKILL.md"))).toBe(true);
  });

  it("installs OpenCode into OPENCODE_CONFIG_DIR", async () => {
    const root = tempRoot();
    const assetRoot = join(root, "assets");
    const opencodeRoot = join(root, "custom-opencode");
    createCliAssets(assetRoot);
    mkdirSync(opencodeRoot, { recursive: true });
    setEnv("HOME", root);
    setEnv("OPENCODE_CONFIG_DIR", opencodeRoot);

    const result = await runCommand({
      argv: [
        "init",
        "--home", join(root, "memmy-home"),
        "--agent", "opencode",
        "--asset-root", assetRoot
      ]
    }) as Record<string, unknown>;

    expect(result.agents).toEqual([{
      agent: "opencode",
      root: opencodeRoot,
      injectPath: join(opencodeRoot, "AGENTS.md"),
      skillPath: join(opencodeRoot, "skills", "memmy-memory"),
      dryRun: false
    }]);
  });

  it("does not keep the legacy memory init namespace", async () => {
    const root = tempRoot();
    await expect(
      runCommand({
        argv: ["memory", "init", "--home", root, "--config", join(root, "config.yaml"), "--db", join(root, "memory.sqlite")]
      })
    ).rejects.toThrow("unknown command: memory init");
  });

  it("updates memmyMemory config during init and preserves unrelated fields", async () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    const dbPath = join(root, "memory.sqlite");
    createAllAgentRoots(root);
    setEnv("HOME", root);
    const original = [
      "uuid: old-top-level-cloud-login-uuid",
      "identity:",
      "  userId: old-identity-user",
      "app:",
      "  cloudUuid: old-app-cloud-login-uuid",
      "  userId: user_123",
      "agents:",
      "  defaults:",
      "    model: keep",
      "memmyMemory:",
      "  storage:",
      "    endpoint: http://old.local",
      ""
    ].join("\n");
    writeFileSync(configPath, original);

    await runCommand({
      argv: ["init", "--home", root, "--config", configPath, "--db", dbPath, "--endpoint", "http://new.local"]
    });
    const saved = YAML.parse(readFileSync(configPath, "utf8"));
    expect(saved.app).toEqual({
      cloudUuid: "old-app-cloud-login-uuid",
      userId: "user_123"
    });
    expect(saved.identity).toBeUndefined();
    expect(saved.uuid).toBeUndefined();
    expect(saved.agents.defaults.model).toBe("keep");
    expect(saved.memmyMemory).toMatchObject({
      version: 1,
      activeProfile: "byok",
      storage: {
        mode: "local",
        backend: "sqlite",
        sqlitePath: dbPath,
        endpoint: "http://new.local"
      },
      profiles: {
        byok: {
          userId: "user_123",
          embedding: {
            provider: "local"
          }
        }
      },
      algorithm: {
        enableMemoryAdd: true,
        enableMemorySearch: true,
        enableQueryRewrite: false
      }
    });
    expect(existsSync(dbPath)).toBe(false);
  });

  it("installs agent inject and skill folder during init when an agent is specified", async () => {
    const root = tempRoot();
    const agentRoot = join(root, ".codex");
    const assetRoot = join(root, "assets");
    mkdirSync(agentRoot, { recursive: true });
    writeFileSync(join(agentRoot, "AGENTS.md"), "manual prefix\n");
    writeFileSync(join(agentRoot, "skills-placeholder"), "keep\n");
    createCliAssets(assetRoot);

    const result = await runCommand({
      argv: [
        "init",
        "--home", join(root, "memmy-home"),
        "--agent", "codex",
        "--agent-root", agentRoot,
        "--asset-root", assetRoot
      ]
    }) as Record<string, unknown>;

    const agents = result.agents as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toEqual({
      agent: "codex",
      root: agentRoot,
      injectPath: join(agentRoot, "AGENTS.md"),
      skillPath: join(agentRoot, "skills", "memmy-memory"),
      dryRun: false
    });
    expect(readFileSync(join(agentRoot, "AGENTS.md"), "utf8")).toBe(
      [
        "manual prefix",
        "<!-- memmy:start v=1 -->",
        "# Agent Inject",
        "Use the memmy-memory skill.",
        "<!-- memmy:end v=1 -->",
        ""
      ].join("\n")
    );
    expect(readFileSync(join(agentRoot, "skills", "memmy-memory", "SKILL.md"), "utf8")).toContain("name: memmy-memory");
    expect(statSync(join(agentRoot, "skills", "memmy-memory", "references")).isDirectory()).toBe(true);
    expect(existsSync(join(agentRoot, "skills-placeholder"))).toBe(true);
  });

  it("initializes config without installing agent skills when requested", async () => {
    const root = tempRoot();
    const agentRoot = join(root, ".codex");
    mkdirSync(agentRoot, { recursive: true });

    const result = await runCommand({
      argv: [
        "init",
        "--home", join(root, "memmy-home"),
        "--agent-root", agentRoot,
        "--skip-agent-skills"
      ]
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      command: "init"
    });
    expect(result.agents).toBeUndefined();
    expect(existsSync(join(agentRoot, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(agentRoot, "skills", "memmy-memory"))).toBe(false);
  });

  it("uses per-agent inject paths and replaces existing marker blocks", async () => {
    const root = tempRoot();
    const assetRoot = join(root, "assets");
    createCliAssets(assetRoot);

    const cases = [
      ["claude", "CLAUDE.md"],
      ["opencode", "AGENTS.md"],
      ["openclaw", join("workspace", "AGENTS.md")],
      ["hermes", "SOUL.md"]
    ] as const;

    for (const [agent, injectRelativePath] of cases) {
      const agentRoot = join(root, agent);
      const injectPath = join(agentRoot, injectRelativePath);
      mkdirSync(dirname(injectPath), { recursive: true });
      writeFileSync(
        injectPath,
        ["before", "<!-- memmy:start v=1 -->", "old", "<!-- memmy:end v=1 -->", "after", ""].join("\n")
      );

      await runCommand({
        argv: [
          "init",
          "--home", join(root, `memmy-${agent}`),
          "--agent", agent,
          "--agent-root", agentRoot,
          "--asset-root", assetRoot
        ]
      });

      expect(readFileSync(injectPath, "utf8")).toBe(
        ["before", "<!-- memmy:start v=1 -->", "# Agent Inject", "Use the memmy-memory skill.", "<!-- memmy:end v=1 -->", "after", ""].join("\n")
      );
      expect(existsSync(join(agentRoot, "skills", "memmy-memory", "SKILL.md"))).toBe(true);
    }
  });

  it("does not create a missing agent root during init agent installation", async () => {
    const root = tempRoot();
    const agentRoot = join(root, ".codex");
    const assetRoot = join(root, "assets");
    createCliAssets(assetRoot);

    await expect(
      runCommand({
        argv: [
          "init",
          "--home", join(root, "memmy-home"),
          "--agent", "codex",
          "--agent-root", agentRoot,
          "--asset-root", assetRoot
        ]
      })
    ).rejects.toThrow("codex is not installed");
    expect(existsSync(agentRoot)).toBe(false);
  });

  it("replaces an existing skill directory only after staging the new skill", async () => {
    const root = tempRoot();
    const agentRoot = join(root, ".codex");
    const assetRoot = join(root, "assets");
    mkdirSync(join(agentRoot, "skills", "memmy-memory", "references"), { recursive: true });
    writeFileSync(join(agentRoot, "skills", "memmy-memory", "old.md"), "old skill file\n");
    writeFileSync(join(agentRoot, "skills", "memmy-memory", "references", "old.md"), "old reference\n");
    createCliAssets(assetRoot);

    await runCommand({
      argv: [
        "init",
        "--home", join(root, "memmy-home"),
        "--agent", "codex",
        "--agent-root", agentRoot,
        "--asset-root", assetRoot
      ]
    });

    expect(readFileSync(join(agentRoot, "skills", "memmy-memory", "SKILL.md"), "utf8")).toContain("name: memmy-memory");
    expect(existsSync(join(agentRoot, "skills", "memmy-memory", "old.md"))).toBe(false);
    expect(existsSync(join(agentRoot, "skills", "memmy-memory", "references", "old.md"))).toBe(false);
    expect(existsSync(join(agentRoot, "skills", "memmy-memory", "references", "health.md"))).toBe(true);
  });

  it("installs a local memmy-memory symlink after initialization", async () => {
    const root = tempRoot();
    const source = join(root, "dist", "src", "cli", "index.js");
    const binPath = join(root, "bin", "memmy-memory");
    createAllAgentRoots(root);
    setEnv("HOME", root);
    mkdirSync(join(root, "dist", "src", "cli"), { recursive: true });
    writeFileSync(source, "#!/usr/bin/env node\n", { mode: 0o755 });

    const result = await runCommand({
      argv: [
        "install",
        "--home", root,
        "--config", join(root, "config.yaml"),
        "--db", join(root, "memory.sqlite"),
        "--bin", binPath,
        "--source-path", source
      ]
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      ok: true,
      command: "install",
      binPath,
      source,
      pathReady: false
    });
    expect(lstatSync(binPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(binPath)).toBe(source);
  });

  it("does not replace an existing non-memmy-memory binary without force", async () => {
    const root = tempRoot();
    const source = join(root, "index.js");
    const binPath = join(root, "bin", "memmy-memory");
    createAllAgentRoots(root);
    setEnv("HOME", root);
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(source, "#!/usr/bin/env node\n");
    writeFileSync(binPath, "existing\n");

    await expect(
      runCommand({
        argv: [
          "install",
          "--home", root,
          "--config", join(root, "config.yaml"),
          "--db", join(root, "memory.sqlite"),
          "--bin", binPath,
          "--source-path", source
        ]
      })
    ).rejects.toThrow("already exists");
    expect(readFileSync(binPath, "utf8")).toBe("existing\n");
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-cli-setup-"));
  roots.push(root);
  return root;
}

function createCliAssets(assetRoot: string): void {
  mkdirSync(join(assetRoot, "skills", "memmy-memory", "references"), { recursive: true });
  writeFileSync(join(assetRoot, "agent_inject.md"), ["# Agent Inject", "Use the memmy-memory skill.", ""].join("\n"));
  writeFileSync(
    join(assetRoot, "skills", "memmy-memory", "SKILL.md"),
    ["---", "name: memmy-memory", "description: test skill", "---", ""].join("\n")
  );
  writeFileSync(join(assetRoot, "skills", "memmy-memory", "references", "health.md"), "# health\n");
}

function createAllAgentRoots(root: string): void {
  mkdirSync(join(root, ".codex"), { recursive: true });
  mkdirSync(join(root, ".cursor"), { recursive: true });
  mkdirSync(join(root, ".claude"), { recursive: true });
  mkdirSync(join(root, ".config", "opencode"), { recursive: true });
  mkdirSync(join(root, ".openclaw", "workspace"), { recursive: true });
  mkdirSync(join(root, ".hermes"), { recursive: true });
}

function setEnv(key: string, value: string): void {
  if (!(key in envBackup)) {
    envBackup[key] = process.env[key];
  }
  process.env[key] = value;
}
