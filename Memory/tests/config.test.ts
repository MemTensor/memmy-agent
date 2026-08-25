import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfigPaths, loadMemmyConfig } from "../src/config/index.js";

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

describe("memmy memory config", () => {
  it("reads the configured agent timezone and leaves it absent for system detection", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      agents: { defaults: { timezone: "UTC" } },
      memmyMemory: {}
    }));

    expect(loadMemmyConfig(configPath).config.timeZone).toBe("+00:00");
    writeFileSync(configPath, YAML.stringify({ memmyMemory: {} }));
    expect(loadMemmyConfig(configPath).config.timeZone).toBeUndefined();
  });

  it.each(["profiles", "activeProfile"])(
    "rejects legacy memmyMemory.%s instead of migrating it during load",
    (legacyField) => {
      const root = tempRoot();
      const configPath = join(root, "config.yaml");
      writeFileSync(configPath, YAML.stringify({
        memmyMemory: legacyField === "profiles"
          ? { profiles: { byok: {} } }
          : { activeProfile: "byok" }
      }));

      expect(() => loadMemmyConfig(configPath)).toThrow(
        "memmyMemory legacy profiles require the registered runtime config migration"
      );
    }
  );

  it("defaults memory gates and retrieval config", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {}
    }));

    expect(loadMemmyConfig(configPath).config.algorithm.enableMemoryAdd).toBe(true);
    expect(loadMemmyConfig(configPath).config.algorithm.enableMemorySearch).toBe(true);
    expect(loadMemmyConfig(configPath).config.algorithm.enableQueryRewrite).toBe(false);
    expect(loadMemmyConfig(configPath).config.algorithm.retrieval.minRecallScore).toBe(0.12);
    expect(loadMemmyConfig(configPath).config.algorithm.negativeExperience).toMatchObject({
      enabled: true,
      failureRTaskThreshold: -0.15,
      implicitConfidenceCap: 0.65
    });
    expect(loadMemmyConfig(configPath).config.algorithm.retrieval.llmFilterEnabled).toBe(true);
    expect(loadMemmyConfig(configPath).config.domain).toBe("");
    expect(loadMemmyConfig(configPath).config.algorithm.retrieval.readOnlyInjectionProfile).toBe("all");
  });

  it("keeps summary thinking off and defaults evolution thinking on", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {}
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.summary.enableThinking).toBe(false);
    expect(config.evolution.enableThinking).toBe(true);
    expect(config.evolution.thinkingBudget).toBeUndefined();
    expect(config.evolution.timeoutMs).toBe(180_000);
  });

  it("expands home-relative sqlite paths from config files", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        version: 1,
        storage: {
          sqlitePath: "~/.memmy/memory-service/memory.sqlite",
          endpoint: "http://127.0.0.1:18960"
        },
        embedding: {
          provider: "local"
        }
      }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.storage.sqlitePath).toBe(join(homedir(), ".memmy", "memory-service", "memory.sqlite"));
  });

  it("reads user id from memmyMemory config and environment aliases", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      app: {
        userId: "user_from_file"
      },
      memmyMemory: {
        userId: "user_from_memory"
      }
    }));

    expect(loadMemmyConfig(configPath).config.userId).toBe("user_from_memory");

    setEnv("MEMMY_MEMORY_USER_ID", "user_from_env");
    expect(loadMemmyConfig(configPath).config.userId).toBe("user_from_env");
  });

  it("reads memory gates from memmyMemory algorithm config", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        algorithm: {
          enableMemoryAdd: false,
          enableMemorySearch: false,
          enableQueryRewrite: true,
          retrieval: {
            llmFilterEnabled: false,
            minRecallScore: 0.35
          }
        }
      }
    }));

    expect(loadMemmyConfig(configPath).config.algorithm.enableMemoryAdd).toBe(false);
    expect(loadMemmyConfig(configPath).config.algorithm.enableMemorySearch).toBe(false);
    expect(loadMemmyConfig(configPath).config.algorithm.enableQueryRewrite).toBe(true);
    expect(loadMemmyConfig(configPath).config.algorithm.retrieval.llmFilterEnabled).toBe(false);
    expect(loadMemmyConfig(configPath).config.algorithm.retrieval.minRecallScore).toBe(0.35);

    setEnv("MEMMY_ENABLE_MEMORY_ADD", "true");
    setEnv("MEMMY_ENABLE_MEMORY_SEARCH", "1");
    setEnv("MEMMY_ENABLE_QUERY_REWRITE", "false");
    expect(loadMemmyConfig(configPath).config.algorithm.enableMemoryAdd).toBe(true);
    expect(loadMemmyConfig(configPath).config.algorithm.enableMemorySearch).toBe(true);
    expect(loadMemmyConfig(configPath).config.algorithm.enableQueryRewrite).toBe(false);
  });

  it("reads explicit research domain and retrieval injection profile", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        domain: "research",
        algorithm: {
          retrieval: {
            readOnlyInjectionProfile: "skill_experience"
          }
        }
      }
    }));

    expect(loadMemmyConfig(configPath).config.domain).toBe("research");
    expect(loadMemmyConfig(configPath).config.algorithm.retrieval.readOnlyInjectionProfile).toBe("skill_experience");

    setEnv("MEMMY_MEMORY_DOMAIN", "research");
    setEnv("MEMMY_RETRIEVAL_INJECTION_PROFILE", "experience");
    const fromEnv = loadMemmyConfig(configPath).config;
    expect(fromEnv.domain).toBe("research");
    expect(fromEnv.algorithm.retrieval.readOnlyInjectionProfile).toBe("experience");
  });

  it("ignores summary thinking switches and reads the evolution switch", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        roleRouting: {
          summary: "fixed",
          evolution: "fixed"
        },
        summary: {
          enableThinking: true
        },
        evolution: {
          enableThinking: false
        }
      }
    }));

    expect(loadMemmyConfig(configPath).config.summary.enableThinking).toBe(false);
    expect(loadMemmyConfig(configPath).config.evolution.enableThinking).toBe(false);

    setEnv("MEMMY_SUMMARY_ENABLE_THINKING", "true");
    setEnv("MEMMY_EVOLUTION_ENABLE_THINKING", "1");
    expect(loadMemmyConfig(configPath).config.summary.enableThinking).toBe(false);
    expect(loadMemmyConfig(configPath).config.evolution.enableThinking).toBe(true);
  });

  it("defaults evolution output to 4096 tokens", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({ memmyMemory: {} }));

    expect(loadMemmyConfig(configPath).config.evolution.maxTokens).toBe(4096);
  });

  it("defaults summary output to 512 tokens", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({ memmyMemory: {} }));

    expect(loadMemmyConfig(configPath).config.summary.maxTokens).toBe(512);
  });

  it("resolves follow roles and cloud embedding from the account model projection", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      providers: {
        memmy_account: {
          apiKey: "cloud-uuid",
          ownerAccountId: "user_account",
          endpoints: {
            memory: {
              apiBase: "https://apigw-pre.memtensor.cn/api/agentExternal/v1",
              protocol: "memmy-account"
            }
          }
        }
      },
      modelPresets: {
        "memmy-account-summary": {
          provider: "memmy_account",
          endpoint: "memory",
          model: "agent_chat",
          source: "account",
          ownerAccountId: "user_account",
          capabilities: ["memory_summary"]
        },
        "memmy-account-evolution": {
          provider: "memmy_account",
          endpoint: "memory",
          model: "memory_evolution",
          source: "account",
          ownerAccountId: "user_account",
          capabilities: ["memory_evolution"]
        },
        "memmy-account-embedding": {
          provider: "memmy_account",
          endpoint: "memory",
          model: "embedding",
          source: "account",
          ownerAccountId: "user_account",
          capabilities: ["embedding"]
        }
      },
      modelAssignments: {
        byok: {},
        account: {
          ownerAccountId: "user_account",
          memorySummary: "memmy-account-summary",
          memoryEvolution: "memmy-account-evolution",
          embedding: "memmy-account-embedding"
        }
      },
      app: {
        userMode: "account",
        userId: "user_account"
      },
      memmyMemory: {
        userId: "user_account",
        roleRouting: {
          summary: "follow",
          evolution: "follow"
        },
        embedding: {
          mode: "cloud"
        },
        storage: {
          endpoint: "http://127.0.0.1:18960"
        }
      }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.roleRouting).toEqual({ summary: "follow", evolution: "follow" });
    expect(config.userId).toBe("user_account");
    expect(config.summary).toMatchObject({
      provider: "openai_compatible",
      sourceProvider: "memmy_account",
      endpoint: "https://apigw-pre.memtensor.cn/api/agentExternal/v1",
      model: "agent_chat",
      apiKey: "cloud-uuid"
    });
    expect(config.evolution).toMatchObject({
      provider: "openai_compatible",
      sourceProvider: "memmy_account",
      model: "memory_evolution",
      thinkingBudget: 1_000,
      timeoutMs: 180_000
    });
    expect(config.embedding).toMatchObject({
      mode: "cloud",
      provider: "openai_compatible",
      sourceProvider: "memmy_account",
      model: "embedding"
    });
  });

  it("keeps local embedding independent from role routing", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        roleRouting: {
          summary: "follow",
          evolution: "follow"
        },
        embedding: {
          mode: "local"
        }
      }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.embedding.mode).toBe("local");
    expect(config.embedding.provider).toBe("local");
    expect(config.evolution.thinkingBudget).toBeUndefined();
  });

  it("rejects a legacy fixed BYOK evolution connection before runtime use", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        roleRouting: {
          summary: "follow",
          evolution: "fixed"
        },
        evolution: {
          provider: "openai_compatible",
          endpoint: "https://example.com/v1",
          model: "qwen3.7-plus",
          apiKey: "sk-user",
          timeoutMs: 75_000
        },
        embedding: {
          mode: "local"
        }
      }
    }));

    expect(() => loadMemmyConfig(configPath)).toThrow(
      "memmyMemory legacy model config requires the registered runtime config migration"
    );
  });

  it("uses only MEMMY_CONFIG and the default config.yaml candidate", () => {
    const root = tempRoot();
    setEnv("MEMMY_CONFIG", join(root, "custom.yaml"));
    setEnv("MEMMY_HOME", join(root, "ignored-home"));

    expect(defaultConfigPaths()).toEqual([
      join(root, "custom.yaml"),
      join(homedir(), ".memmy", "config.yaml")
    ]);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-config-"));
  roots.push(root);
  return root;
}

function setEnv(name: string, value: string): void {
  if (!(name in envBackup)) envBackup[name] = process.env[name];
  process.env[name] = value;
}
