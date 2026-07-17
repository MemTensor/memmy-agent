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
  it("defaults memory gates and retrieval config", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {}
    }));

    expect(loadMemmyConfig(configPath).config.algorithm.enableMemoryAdd).toBe(true);
    expect(loadMemmyConfig(configPath).config.algorithm.enableMemorySearch).toBe(true);
    expect(loadMemmyConfig(configPath).config.algorithm.enableQueryRewrite).toBe(false);
    expect(loadMemmyConfig(configPath).config.algorithm.retrieval.llmFilterEnabled).toBe(true);
    expect(loadMemmyConfig(configPath).config.domain).toBe("");
    expect(loadMemmyConfig(configPath).config.algorithm.retrieval.readOnlyInjectionProfile).toBe("all");
  });

  it("defaults summary thinking off and evolution thinking on", () => {
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
            llmFilterEnabled: false
          }
        }
      }
    }));

    expect(loadMemmyConfig(configPath).config.algorithm.enableMemoryAdd).toBe(false);
    expect(loadMemmyConfig(configPath).config.algorithm.enableMemorySearch).toBe(false);
    expect(loadMemmyConfig(configPath).config.algorithm.enableQueryRewrite).toBe(true);
    expect(loadMemmyConfig(configPath).config.algorithm.retrieval.llmFilterEnabled).toBe(false);

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

  it("reads summary and evolution thinking switches from config and environment", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        summary: {
          enableThinking: true
        },
        evolution: {
          enableThinking: false
        }
      }
    }));

    expect(loadMemmyConfig(configPath).config.summary.enableThinking).toBe(true);
    expect(loadMemmyConfig(configPath).config.evolution.enableThinking).toBe(false);

    setEnv("MEMMY_SUMMARY_ENABLE_THINKING", "false");
    setEnv("MEMMY_EVOLUTION_ENABLE_THINKING", "1");
    expect(loadMemmyConfig(configPath).config.summary.enableThinking).toBe(false);
    expect(loadMemmyConfig(configPath).config.evolution.enableThinking).toBe(true);
  });

  it("selects active memory profiles and forces account models to openai-compatible runtime providers", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        activeProfile: "account",
        storage: {
          endpoint: "http://127.0.0.1:18960"
        },
        profiles: {
          byok: {
            embedding: {
              provider: "local"
            }
          },
          account: {
            userId: "user_account",
            summary: {
              endpoint: "https://apigw-pre.memtensor.cn/api/agentExternal/v1",
              model: "memory_summary",
              apiKey: "cloud-uuid"
            },
            evolution: {
              endpoint: "https://apigw-pre.memtensor.cn/api/agentExternal/v1",
              model: "memory_evolution",
              apiKey: "cloud-uuid"
            },
            embedding: {
              endpoint: "https://apigw-pre.memtensor.cn/api/agentExternal/v1",
              model: "embedding",
              apiKey: "cloud-uuid"
            }
          }
        }
      }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.activeProfile).toBe("account");
    expect(config.userId).toBe("user_account");
    expect(config.summary).toMatchObject({
      provider: "openai_compatible",
      vendor: "qwen",
      endpoint: "https://apigw-pre.memtensor.cn/api/agentExternal/v1",
      model: "memory_summary",
      apiKey: "cloud-uuid"
    });
    expect(config.evolution).toMatchObject({
      provider: "openai_compatible",
      vendor: "qwen",
      model: "memory_evolution",
      thinkingBudget: 1_000,
      timeoutMs: 180_000
    });
    expect(config.embedding).toMatchObject({
      provider: "openai_compatible",
      model: "embedding"
    });
  });

  it("keeps BYOK local embedding profiles local at runtime", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        activeProfile: "byok",
        profiles: {
          byok: {
            embedding: {
              provider: "local"
            }
          }
        }
      }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.activeProfile).toBe("byok");
    expect(config.embedding.provider).toBe("local");
    expect(config.evolution.thinkingBudget).toBeUndefined();
  });

  it("preserves an explicit BYOK evolution timeout without injecting a thinking budget", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        activeProfile: "byok",
        profiles: {
          byok: {
            evolution: {
              provider: "openai_compatible",
              endpoint: "https://example.com/v1",
              model: "qwen3.7-plus",
              apiKey: "sk-user",
              timeoutMs: 75_000
            },
            embedding: {
              provider: "local"
            }
          }
        }
      }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.evolution.timeoutMs).toBe(75_000);
    expect(config.evolution.thinkingBudget).toBeUndefined();
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
