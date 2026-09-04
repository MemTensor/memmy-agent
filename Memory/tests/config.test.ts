import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID } from "@memmy/local-api-contracts";
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
    expect(loadMemmyConfig(configPath).config.algorithm).not.toHaveProperty("lightweightMemory");
    expect(loadMemmyConfig(configPath).config).not.toHaveProperty("logging");
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
    expect(config.summary.timeoutMs).toBe(180_000);
    expect(config.evolution.enableThinking).toBe(true);
    expect(config.evolution.thinkingBudget).toBeUndefined();
    expect(config.evolution.timeoutMs).toBe(180_000);
  });

  it("allows the summary timeout default to be overridden by environment", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({ memmyMemory: {} }));
    setEnv("MEMMY_SUMMARY_TIMEOUT_MS", "240000");

    expect(loadMemmyConfig(configPath).config.summary.timeoutMs).toBe(240_000);
  });

  it("preserves an explicit embedding token budget and allows an environment override", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        embedding: {
          mode: "custom",
          provider: "openai_compatible",
          endpoint: "https://embedding.example/v1",
          model: "deployment-alias",
          maxInputTokens: 1_200
        }
      }
    }));

    expect(loadMemmyConfig(configPath).config.embedding.maxInputTokens).toBe(1_200);
    setEnv("MEMMY_EMBEDDING_MAX_INPUT_TOKENS", "640");
    expect(loadMemmyConfig(configPath).config.embedding.maxInputTokens).toBe(640);
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
          lightweightMemory: { enabled: true },
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
    expect(loadMemmyConfig(configPath).config.algorithm).not.toHaveProperty("lightweightMemory");
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

  it("resolves follow roles and defaults account embedding to the cloud assignment", () => {
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
        "memmy-account-agent": {
          provider: "memmy_account",
          endpoint: "memory",
          model: "agent_chat",
          source: "account",
          ownerAccountId: "user_account",
          capabilities: ["agent"]
        },
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
          agent: {
            candidates: ["memmy-account-agent"],
            default: "memmy-account-agent"
          },
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
      model: "agent_chat",
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

  it("resolves the explicit built-in local Embedding assignment in account mode", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      modelAssignments: {
        byok: {},
        account: {
          ownerAccountId: "user_account",
          embedding: BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID
        }
      },
      app: {
        userMode: "account",
        userId: "user_account"
      },
      memmyMemory: {
        embedding: { mode: "cloud" }
      }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.embedding).toMatchObject({
      mode: "local",
      provider: "local",
      sourceProvider: "local",
      model: "Xenova/all-MiniLM-L6-v2"
    });
    expect(config.embedding.endpoint).toBeUndefined();
    expect(config.embedding.apiKey).toBeUndefined();
    expect(config.embedding.selectionError).toBeUndefined();
  });

  it("rejects a built-in local Embedding assignment owned by another account", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      modelAssignments: {
        byok: {},
        account: {
          ownerAccountId: "other_account",
          embedding: BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID
        }
      },
      app: {
        userMode: "account",
        userId: "user_account"
      },
      memmyMemory: {
        embedding: { mode: "local" }
      }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.embedding).toMatchObject({
      mode: "cloud",
      provider: "openai_compatible",
      model: "",
      selectionError: "model_selection_unavailable"
    });
  });

  it("does not treat an unconfigured account Embedding assignment as local", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      modelAssignments: {
        byok: {},
        account: {
          ownerAccountId: "user_account",
          embedding: null
        }
      },
      app: {
        userMode: "account",
        userId: "user_account"
      },
      memmyMemory: {
        embedding: { mode: "local" }
      }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.embedding).toMatchObject({
      mode: "cloud",
      provider: "openai_compatible",
      model: "",
      selectionError: "model_selection_unavailable"
    });
  });

  it.each([
    ["assignment owner", undefined, "user_account"],
    ["active account", "user_account", undefined],
    ["both account identities", undefined, undefined]
  ])("rejects a built-in local Embedding assignment missing %s", (_label, ownerAccountId, userId) => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      modelAssignments: {
        byok: {},
        account: {
          ...(ownerAccountId ? { ownerAccountId } : {}),
          embedding: BUILTIN_LOCAL_EMBEDDING_ASSIGNMENT_ID
        }
      },
      app: {
        userMode: "account",
        ...(userId ? { userId } : {})
      },
      memmyMemory: {
        embedding: { mode: "local" }
      }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.embedding).toMatchObject({
      mode: "cloud",
      provider: "openai_compatible",
      model: "",
      selectionError: "model_selection_unavailable"
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

  it("reports cloud embedding unavailable when no shared model catalog exists", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        embedding: { mode: "cloud" }
      }
    }));

    expect(loadMemmyConfig(configPath).config.embedding).toMatchObject({
      mode: "cloud",
      provider: "openai_compatible",
      model: "",
      selectionError: "model_selection_unavailable"
    });
  });

  it("uses local embedding for an absent BYOK assignment despite stale custom mode", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      providers: {},
      modelPresets: {},
      modelAssignments: {
        byok: { embedding: null },
        account: {}
      },
      app: { userMode: "byok" },
      memmyMemory: {
        embedding: {
          mode: "custom",
          endpoint: "https://embedding.example.com/v1",
          model: "text-embedding-3-small",
          apiKey: "sk-stale",
          extraHeaders: { "X-Stale": "true" },
          extraBody: { dimensions: 1024 }
        }
      }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.embedding).toMatchObject({
      mode: "local",
      provider: "local",
      sourceProvider: "local",
      model: "Xenova/all-MiniLM-L6-v2"
    });
    expect(config.embedding.endpoint).toBeUndefined();
    expect(config.embedding.apiKey).toBeUndefined();
    expect(config.embedding.extraHeaders).toBeUndefined();
    expect(config.embedding.extraBody).toBeUndefined();
    expect(config.embedding.selectionError).toBeUndefined();
  });

  it("does not fall back locally for an explicit invalid BYOK embedding assignment", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      providers: {},
      modelPresets: {},
      modelAssignments: {
        byok: { embedding: "missing-embedding-preset" },
        account: {}
      },
      app: { userMode: "byok" },
      memmyMemory: { embedding: { mode: "local" } }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.embedding.provider).not.toBe("local");
    expect(config.embedding.selectionError).toBe("model_selection_unavailable");
  });

  it.each([
    ["blank string", "   "],
    ["number", 42],
    ["object", { presetId: "missing" }]
  ])("does not treat an explicit invalid %s assignment as absent", (_label, embeddingAssignment) => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      providers: {},
      modelPresets: {},
      modelAssignments: {
        byok: { embedding: embeddingAssignment },
        account: {}
      },
      app: { userMode: "byok" },
      memmyMemory: { embedding: { mode: "local" } }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.embedding.provider).not.toBe("local");
    expect(config.embedding.selectionError).toBe("model_selection_unavailable");
  });

  it("uses fixed role connections from memmyMemory", () => {
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

    const { config } = loadMemmyConfig(configPath);

    expect(config.roleRouting.evolution).toBe("fixed");
    expect(config.evolution).toMatchObject({
      provider: "openai_compatible",
      endpoint: "https://example.com/v1",
      model: "qwen3.7-plus",
      apiKey: "sk-user",
      timeoutMs: 75_000
    });
    expect(config.summary).toMatchObject({
      provider: "openai_compatible",
      endpoint: "https://example.com/v1",
      model: "qwen3.7-plus",
      apiKey: "sk-user",
      enableThinking: false,
      maxTokens: 512
    });
  });

  it("does not let the evolution model inherit the weaker summary model", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      memmyMemory: {
        roleRouting: {
          summary: "fixed",
          evolution: "follow"
        },
        summary: {
          provider: "openai_compatible",
          endpoint: "https://summary.example/v1",
          model: "summary-only",
          apiKey: "sk-summary"
        }
      }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.summary.model).toBe("summary-only");
    expect(config.evolution).toMatchObject({
      provider: "",
      model: "",
      enableThinking: true
    });
  });

  it("does not let catalog assignments override fixed memmyMemory models", () => {
    const root = tempRoot();
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      providers: {
        openai: {
          apiKey: "catalog-key",
          endpoints: {
            default: {
              apiBase: "https://catalog.example/v1",
              protocol: "openai-chat-completions"
            },
            embedding: {
              apiBase: "https://catalog.example/v1",
              protocol: "openai-embeddings"
            }
          }
        }
      },
      modelPresets: {
        summary: {
          provider: "openai",
          endpoint: "default",
          model: "catalog-summary",
          source: "byok",
          capabilities: ["memory_summary"]
        },
        evolution: {
          provider: "openai",
          endpoint: "default",
          model: "catalog-evolution",
          source: "byok",
          capabilities: ["memory_evolution"]
        },
        embedding: {
          provider: "openai",
          endpoint: "embedding",
          model: "catalog-embedding",
          source: "byok",
          capabilities: ["embedding"]
        }
      },
      modelAssignments: {
        byok: {
          memorySummary: "summary",
          memoryEvolution: "evolution",
          embedding: "embedding"
        },
        account: {}
      },
      app: { userMode: "byok" },
      memmyMemory: {
        roleRouting: { summary: "fixed", evolution: "fixed" },
        summary: {
          provider: "anthropic",
          endpoint: "https://fixed-summary.example/v1",
          model: "fixed-summary",
          apiKey: "fixed-summary-key"
        },
        evolution: {
          provider: "gemini",
          endpoint: "https://fixed-evolution.example/v1",
          model: "fixed-evolution",
          apiKey: "fixed-evolution-key"
        },
        embedding: {
          mode: "custom",
          provider: "openai_compatible",
          endpoint: "https://fixed-embedding.example/v1",
          model: "fixed-embedding",
          apiKey: "fixed-embedding-key"
        }
      }
    }));

    const { config } = loadMemmyConfig(configPath);

    expect(config.summary.model).toBe("fixed-summary");
    expect(config.evolution.model).toBe("fixed-evolution");
    expect(config.embedding).toMatchObject({
      mode: "custom",
      endpoint: "https://fixed-embedding.example/v1",
      model: "fixed-embedding",
      apiKey: "fixed-embedding-key"
    });
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
