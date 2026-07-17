/** Model config repo tests. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_BYOK_ACCOUNT_UUID } from "../account-context.js";
import { createAppStateStore } from "../index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("model config repository", () => {
  it("stores unauthenticated BYOK writes in the local BYOK scope without setting active uuid", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-model-config-"));
    const store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });

    const input = {
      provider: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "gpt-4.1-mini",
      apiKey: "sk-live-secret",
      embedding: {
        mode: "custom",
        baseUrl: "https://embedding.example.com/v1",
        modelId: "text-embedding-3-large",
        apiKey: "emb-live-secret"
      }
    } as const;

    const view = store.repositories.modelConfig.upsert(input);
    const rows = store.db.prepare("SELECT uuid, base_url, model_id, api_key_ref FROM account_model_config").all() as Record<string, unknown>[];
    const settings = store.db.prepare("SELECT active_uuid FROM app_settings WHERE id = 'default'").get() as { active_uuid: string | null };
    store.close();

    expect(view).toMatchObject({
      provider: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "gpt-4.1-mini",
      hasApiKey: true,
      apiKeyMasked: "sk-l••••cret",
      embedding: {
        mode: "custom",
        baseUrl: "https://embedding.example.com/v1",
        modelId: "text-embedding-3-large",
        hasApiKey: true
      }
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      uuid: LOCAL_BYOK_ACCOUNT_UUID,
      base_url: "https://api.example.com/v1",
      model_id: "gpt-4.1-mini",
      api_key_ref: `account:${LOCAL_BYOK_ACCOUNT_UUID}:model-api-key`
    });
    expect(settings.active_uuid).toBeNull();
  });

  it("reloads the saved local BYOK model config from app-state and SecretStore", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-model-config-"));
    const databasePath = join(tempDir, "app.sqlite");
    const store = createAppStateStore({ databasePath });

    store.repositories.modelConfig.upsert({
      provider: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "main-model",
      apiKey: "sk-main-secret",
      embedding: {
        mode: "custom",
        baseUrl: "https://embedding.example.com/v1",
        modelId: "embedding-model",
        apiKey: "sk-embedding-secret"
      },
      memmyMemory: {
        summary: {
          provider: "anthropic",
          baseUrl: "https://memory.example.com/v1",
          modelId: "memory-model",
          apiKey: "sk-memory-secret"
        },
        evolution: {
          provider: "qwen",
          baseUrl: "https://skill.example.com/v1",
          modelId: "skill-model",
          apiKey: "sk-skill-secret"
        }
      },
      asr: {
        provider: "aliyun",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        modelId: "qwen3-asr-flash",
        apiKey: "sk-asr-secret"
      }
    });
    store.close();
    const reloadedStore = createAppStateStore({ databasePath });
    const reloaded = reloadedStore.repositories.modelConfig.get();
    reloadedStore.close();

    expect(reloaded).toMatchObject({
      provider: "openai_compatible",
      baseUrl: "https://api.example.com/v1",
      modelId: "main-model",
      hasApiKey: true,
      apiKeyMasked: "sk-m••••cret",
      embedding: {
        mode: "custom",
        baseUrl: "https://embedding.example.com/v1",
        modelId: "embedding-model",
        hasApiKey: true,
        apiKeyMasked: "sk-e••••cret"
      }
    });
    expect(reloaded.memmyMemory.summary).toMatchObject({
      provider: "anthropic",
      baseUrl: "https://memory.example.com/v1",
      modelId: "memory-model",
      hasApiKey: true
    });
    expect(reloaded.memmyMemory.evolution).toMatchObject({
      provider: "qwen",
      baseUrl: "https://skill.example.com/v1",
      modelId: "skill-model",
      hasApiKey: true
    });
    expect(reloaded.asr).toMatchObject({
      provider: "aliyun",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      modelId: "qwen3-asr-flash",
      hasApiKey: true,
      apiKeyMasked: "sk-a••••cret"
    });
  });

  it("stores BYOK config in local scope even when a cloud account is active", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-model-config-"));
    const store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });

    store.repositories.accountSession.upsert({
      profile: accountProfile("user-a", "a@example.com", "Account A"),
      uuid: "cloud-account-a"
    });
    const view = store.repositories.modelConfig.upsert({
      provider: "openai_compatible",
      baseUrl: "https://byok.example.com/v1",
      modelId: "byok-model",
      apiKey: "sk-byok"
    });
    const localRow = store.db.prepare("SELECT * FROM account_model_config WHERE uuid = ?").get(LOCAL_BYOK_ACCOUNT_UUID) as Record<string, unknown>;
    const cloudRow = store.db.prepare("SELECT * FROM account_model_config WHERE uuid = ?").get("cloud-account-a") as Record<string, unknown>;
    const settings = store.db.prepare("SELECT active_uuid FROM app_settings WHERE id = 'default'").get() as { active_uuid: string | null };
    store.close();

    expect(view).toMatchObject({ baseUrl: "https://byok.example.com/v1", modelId: "byok-model", hasApiKey: true });
    expect(localRow).toMatchObject({
      base_url: "https://byok.example.com/v1",
      model_id: "byok-model",
      api_key_ref: `account:${LOCAL_BYOK_ACCOUNT_UUID}:model-api-key`
    });
    expect(cloudRow.base_url).not.toBe("https://byok.example.com/v1");
    expect(settings.active_uuid).toBe("cloud-account-a");
  });

  it("stores memory summary and skill evolver role model configs separately", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-model-config-"));
    const store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });

    const view = store.repositories.modelConfig.upsert({
      provider: "openai_compatible",
      baseUrl: "https://main.example.com/v1",
      modelId: "main-model",
      apiKey: "sk-main",
      memmyMemory: {
        summary: {
          provider: "anthropic",
          baseUrl: "https://memory.example.com/v1",
          modelId: "memory-model",
          apiKey: "sk-memory"
        },
        evolution: {
          provider: "qwen",
          baseUrl: "https://skill.example.com/v1",
          modelId: "skill-model",
          apiKey: "sk-skill"
        }
      }
    });
    const row = store.db.prepare("SELECT * FROM account_model_config WHERE uuid = ?").get(LOCAL_BYOK_ACCOUNT_UUID) as Record<string, unknown>;
    store.close();

    expect(view.memmyMemory.summary).toMatchObject({
      provider: "anthropic",
      baseUrl: "https://memory.example.com/v1",
      modelId: "memory-model",
      hasApiKey: true,
      apiKeyMasked: "sk-m••••mory"
    });
    expect(view.memmyMemory.evolution).toMatchObject({
      provider: "qwen",
      baseUrl: "https://skill.example.com/v1",
      modelId: "skill-model",
      hasApiKey: true,
      apiKeyMasked: "••••"
    });
    expect(row.memory_provider).toBe("anthropic");
    expect(row.memory_api_key_ref).toBe(`account:${LOCAL_BYOK_ACCOUNT_UUID}:memory-summary-api-key`);
    expect(row.skill_provider).toBe("qwen");
    expect(row.skill_api_key_ref).toBe(`account:${LOCAL_BYOK_ACCOUNT_UUID}:memory-evolution-api-key`);
  });

  it("stores ASR model config as a fixed Aliyun model with a separate secret ref", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-model-config-"));
    const store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });

    const view = store.repositories.modelConfig.upsert({
      provider: "openai_compatible",
      baseUrl: "https://main.example.com/v1",
      modelId: "main-model",
      apiKey: "sk-main",
      asr: {
        provider: "aliyun",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        modelId: "qwen3-asr-flash",
        apiKey: "sk-asr"
      }
    });
    const row = store.db.prepare("SELECT * FROM account_model_config WHERE uuid = ?").get(LOCAL_BYOK_ACCOUNT_UUID) as Record<string, unknown>;
    const secret = store.db.prepare("SELECT uuid, purpose FROM secret_store WHERE ref = ?").get(`account:${LOCAL_BYOK_ACCOUNT_UUID}:asr-api-key`) as Record<string, unknown>;
    store.close();

    expect(view.asr).toMatchObject({
      provider: "aliyun",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      modelId: "qwen3-asr-flash",
      hasApiKey: true,
      apiKeyMasked: "••••"
    });
    expect(row.asr_provider).toBe("aliyun");
    expect(row.asr_base_url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(row.asr_model_id).toBe("qwen3-asr-flash");
    expect(row.asr_api_key_ref).toBe(`account:${LOCAL_BYOK_ACCOUNT_UUID}:asr-api-key`);
    expect(secret).toMatchObject({
      uuid: LOCAL_BYOK_ACCOUNT_UUID,
      purpose: "asr_api_key"
    });
  });

  it("stores image generation model config with a separate secret ref", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-model-config-"));
    const store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });

    const view = store.repositories.modelConfig.upsert({
      provider: "openai_compatible",
      baseUrl: "https://main.example.com/v1",
      modelId: "main-model",
      apiKey: "sk-main",
      imageGen: {
        provider: "doubao",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
        modelId: "doubao-seedream-4-0-250828",
        apiKey: "sk-image"
      }
    });
    const row = store.db.prepare("SELECT * FROM account_model_config WHERE uuid = ?").get(LOCAL_BYOK_ACCOUNT_UUID) as Record<string, unknown>;
    const secret = store.db.prepare("SELECT uuid, purpose FROM secret_store WHERE ref = ?").get(`account:${LOCAL_BYOK_ACCOUNT_UUID}:image-gen-api-key`) as Record<string, unknown>;
    const runtime = store.repositories.modelConfig.getImageGenRuntimeConfig();
    store.close();

    expect(view.imageGen).toMatchObject({
      provider: "doubao",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      modelId: "doubao-seedream-4-0-250828",
      hasApiKey: true,
      apiKeyMasked: "••••"
    });
    expect(row.image_provider).toBe("doubao");
    expect(row.image_base_url).toBe("https://ark.cn-beijing.volces.com/api/v3");
    expect(row.image_model_id).toBe("doubao-seedream-4-0-250828");
    expect(row.image_api_key_ref).toBe(`account:${LOCAL_BYOK_ACCOUNT_UUID}:image-gen-api-key`);
    expect(secret).toMatchObject({
      uuid: LOCAL_BYOK_ACCOUNT_UUID,
      purpose: "image_gen_api_key"
    });
    expect(runtime).toMatchObject({
      provider: "doubao",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      modelId: "doubao-seedream-4-0-250828",
      apiKey: "sk-image"
    });
  });

  it("returns null image generation config when not configured", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-model-config-"));
    const store = createAppStateStore({ databasePath: join(tempDir, "app.sqlite") });

    const view = store.repositories.modelConfig.upsert({
      provider: "openai_compatible",
      baseUrl: "https://main.example.com/v1",
      modelId: "main-model",
      apiKey: "sk-main"
    });
    const runtime = store.repositories.modelConfig.getImageGenRuntimeConfig();
    store.close();

    expect(view.imageGen).toBeNull();
    expect(runtime).toBeNull();
  });
});

function accountProfile(userId: string, email: string, nickname: string) {
  return {
    userId,
    email,
    phoneNumber: null,
    nickname,
    avatarUrl: null,
    planType: "free",
    hasFinishedGuide: false,
    region: null,
    registeredAt: "2026-06-08T10:00:00.000Z",
    rawProfile: { id: userId, email, userName: nickname }
  };
}
