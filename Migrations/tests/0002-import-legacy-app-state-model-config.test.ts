import { createCipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importLegacyAppStateModelConfigForTest } from "../src/migrations/v1.0.7/0002-import-legacy-app-state-model-config.js";
import type { AgentWorkspaceMigrationContext } from "../src/types.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-legacy-model-import-"));
  roots.push(value);
  return value;
}

function context(base: string, configPath: string, databaseFile?: string): AgentWorkspaceMigrationContext {
  return {
    profileWorkspace: base,
    sessionsDir: path.join(base, "sessions"),
    runtimeConfigFile: configPath,
    sessionDagDir: path.join(base, "session-dag"),
    ...(databaseFile ? { appDatabaseFile: databaseFile } : {}),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function encrypt(secret: string): { ciphertext: string; iv: string; authTag: string } {
  const key = createHash("sha256").update("Memmy local SecretStore v1").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function createDatabase(databaseFile: string): Database.Database {
  const db = new Database(databaseFile);
  db.exec(`
    CREATE TABLE account_model_config (
      uuid TEXT PRIMARY KEY,
      provider TEXT,
      base_url TEXT,
      model_id TEXT,
      api_key_ref TEXT,
      embedding_mode TEXT,
      embedding_base_url TEXT,
      embedding_model_id TEXT,
      embedding_api_key_ref TEXT,
      memory_provider TEXT,
      memory_base_url TEXT,
      memory_model_id TEXT,
      memory_api_key_ref TEXT,
      skill_provider TEXT,
      skill_base_url TEXT,
      skill_model_id TEXT,
      skill_api_key_ref TEXT,
      asr_provider TEXT,
      asr_base_url TEXT,
      asr_model_id TEXT,
      asr_api_key_ref TEXT,
      image_provider TEXT,
      image_base_url TEXT,
      image_model_id TEXT,
      image_api_key_ref TEXT
    );
    CREATE TABLE model_config (
      id TEXT PRIMARY KEY,
      provider TEXT,
      base_url TEXT,
      model_id TEXT,
      api_key_ref TEXT,
      embedding_mode TEXT,
      embedding_base_url TEXT,
      embedding_model_id TEXT,
      embedding_api_key_ref TEXT
    );
    CREATE TABLE secret_store (
      ref TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL
    );
  `);
  return db;
}

function insertSecret(db: Database.Database, ref: string, secret: string): void {
  const encrypted = encrypt(secret);
  db.prepare("INSERT INTO secret_store (ref, ciphertext, iv, auth_tag) VALUES (?, ?, ?, ?)")
    .run(ref, encrypted.ciphertext, encrypted.iv, encrypted.authTag);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => fs.rm(value, { recursive: true, force: true })));
});

describe("v1.0.7/0002-import-legacy-app-state-model-config", () => {
  it("defers without creating a missing app database", async () => {
    const base = await root();
    const databaseFile = path.join(base, "missing.sqlite");
    const configPath = path.join(base, "config.yaml");
    await expect(importLegacyAppStateModelConfigForTest(context(base, configPath, databaseFile)))
      .resolves.toEqual({ scanned: 0, changed: 0, ignored: 0, deferred: true });
    await expect(fs.stat(databaseFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("imports only the local BYOK row, preferring it over cloud and singleton rows", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    const configPath = path.join(base, "config.yaml");
    const db = createDatabase(databaseFile);
    insertSecret(db, "local-primary", "sk-local");
    insertSecret(db, "local-embedding", "sk-local-embedding");
    insertSecret(db, "cloud-primary", "sk-cloud-do-not-import");
    insertSecret(db, "singleton-primary", "sk-singleton-do-not-import");
    db.prepare(`INSERT INTO account_model_config (
      uuid, provider, base_url, model_id, api_key_ref,
      embedding_mode, embedding_base_url, embedding_model_id, embedding_api_key_ref
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "cloud-account-a", "anthropic", "https://cloud.invalid", "cloud-model", "cloud-primary",
      "local", null, null, null,
    );
    db.prepare(`INSERT INTO account_model_config (
      uuid, provider, base_url, model_id, api_key_ref,
      embedding_mode, embedding_base_url, embedding_model_id, embedding_api_key_ref
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      "local-byok-onboarding", "openai_compatible", "https://local.example/v1", "gpt-local", "local-primary",
      "custom", "https://embedding.example/v1", "embed-local", "local-embedding",
    );
    db.prepare(`INSERT INTO model_config (
      id, provider, base_url, model_id, api_key_ref, embedding_mode
    ) VALUES ('default', ?, ?, ?, ?, ?)`).run(
      "qwen", "https://singleton.invalid", "singleton-model", "singleton-primary", "disabled",
    );
    db.close();
    const before = await fs.readFile(databaseFile);

    await expect(importLegacyAppStateModelConfigForTest(context(base, configPath, databaseFile)))
      .resolves.toEqual({ scanned: 1, changed: 1, ignored: 0 });
    const config = YAML.parse(await fs.readFile(configPath, "utf8"));
    expect(config.app.modelCatalogVersion).toBe(1);
    expect(config.providers.openai.apiKey).toBe("sk-local");
    expect(config.providers.openai.endpoints.chat.apiBase).toBe("https://local.example/v1");
    expect(JSON.stringify(config)).not.toContain("cloud-model");
    expect(JSON.stringify(config)).not.toContain("sk-cloud-do-not-import");
    expect(JSON.stringify(config)).not.toContain("singleton-model");
    expect(config.modelAssignments.byok.agent.candidates).toHaveLength(1);
    expect(config.modelAssignments.byok.memorySummary).toBe(config.modelAssignments.byok.agent.default);
    expect(config.modelAssignments.byok.embedding).toMatch(/^byok-openai-/);
    await expect(fs.readFile(databaseFile)).resolves.toEqual(before);
  });

  it("does not open or decrypt SQLite when YAML already has a valid BYOK catalog", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    const configPath = path.join(base, "config.yaml");
    await fs.writeFile(databaseFile, "not a sqlite database", "utf8");
    await fs.writeFile(configPath, YAML.stringify({
      providers: {
        openai: { apiKey: "sk-new", endpoints: { chat: { apiBase: "https://new.example/v1", protocol: "openai-chat-completions" } } },
      },
      modelPresets: {
        current: { provider: "openai", endpoint: "chat", model: "gpt-new", source: "byok", capabilities: ["agent"] },
      },
      modelAssignments: {
        byok: { agent: { candidates: ["current"], default: "current" } },
      },
    }), "utf8");
    const before = await fs.readFile(configPath, "utf8");

    await expect(importLegacyAppStateModelConfigForTest(context(base, configPath, databaseFile)))
      .resolves.toEqual({ scanned: 0, changed: 0, ignored: 1 });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(before);
  });

  it.each([
    ["agent", "openai", "openai-chat-completions", "agent"],
    ["memory_summary", "openai", "openai-responses", "memorySummary"],
    ["memory_evolution", "anthropic", "anthropic-messages", "memoryEvolution"],
    ["embedding", "openai", "openai-embeddings", "embedding"],
    ["asr", "dashscope", "dashscope-input-audio-chat", "asr"],
    ["image_generation", "dashscope", "dashscope-multimodal-generation", "imageGeneration"],
  ] as const)("short-circuits SQLite for a fully valid %s-only BYOK assignment", async (
    capability,
    provider,
    protocol,
    assignmentField,
  ) => {
    const base = await root();
    const databaseFile = path.join(base, "invalid.sqlite");
    const configPath = path.join(base, "config.yaml");
    const presetId = `${capability}-preset`;
    const assignment = assignmentField === "agent"
      ? { agent: { candidates: [presetId], default: presetId } }
      : { [assignmentField]: presetId };
    await fs.writeFile(databaseFile, "not a sqlite database", "utf8");
    await fs.writeFile(configPath, YAML.stringify({
      providers: {
        [provider]: {
          endpoints: { endpoint: { apiBase: "https://valid.example/v1", protocol } },
        },
      },
      modelPresets: {
        [presetId]: {
          provider,
          endpoint: "endpoint",
          model: "valid-model",
          source: "byok",
          capabilities: [capability],
        },
      },
      modelAssignments: { byok: assignment },
    }), "utf8");
    const before = await fs.readFile(configPath, "utf8");

    await expect(importLegacyAppStateModelConfigForTest(context(base, configPath, databaseFile)))
      .resolves.toEqual({ scanned: 0, changed: 0, ignored: 1 });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(before);
  });

  it("does not treat an embedding preset with a chat protocol as valid", async () => {
    const base = await root();
    const databaseFile = path.join(base, "invalid.sqlite");
    const configPath = path.join(base, "config.yaml");
    await fs.writeFile(databaseFile, "not a sqlite database", "utf8");
    await fs.writeFile(configPath, YAML.stringify({
      providers: {
        openai: {
          endpoints: { embedding: { apiBase: "https://valid.example/v1", protocol: "openai-chat-completions" } },
        },
      },
      modelPresets: {
        fake: {
          provider: "openai",
          endpoint: "embedding",
          model: "text-embedding-3-small",
          source: "byok",
          capabilities: ["embedding"],
        },
      },
      modelAssignments: { byok: { embedding: "fake" } },
    }), "utf8");

    await expect(importLegacyAppStateModelConfigForTest(context(base, configPath, databaseFile)))
      .rejects.toMatchObject({
        code: "migration_io_failed",
        message: "Legacy app-state model config could not be read",
      });
  });

  it("reports a stable redacted error when the selected credential cannot be decrypted", async () => {
    const base = await root();
    const databaseFile = path.join(base, "app.sqlite");
    const configPath = path.join(base, "config.yaml");
    const db = createDatabase(databaseFile);
    db.prepare("INSERT INTO secret_store (ref, ciphertext, iv, auth_tag) VALUES (?, ?, ?, ?)")
      .run("sensitive-ref", "bad", "bad", "bad");
    db.prepare(`INSERT INTO account_model_config (
      uuid, provider, base_url, model_id, api_key_ref, embedding_mode
    ) VALUES (?, ?, ?, ?, ?, ?)`).run(
      "local-byok-onboarding", "openai_compatible", "https://local.example/v1", "gpt-local", "sensitive-ref", "local",
    );
    db.close();

    const error = await importLegacyAppStateModelConfigForTest(context(base, configPath, databaseFile))
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "migration_config_invalid", migrationId: "v1.0.7/0002-import-legacy-app-state-model-config" });
    expect((error as Error).message).toBe("Legacy BYOK credentials could not be imported");
    expect((error as Error).message).not.toContain("sensitive-ref");
    await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
