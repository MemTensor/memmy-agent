/** Model config repo module. */
import {
  ASR_DEFAULT_BASE_URL,
  ASR_PROVIDER,
  ModelConfigViewSchema,
  QWEN_ASR_MODEL_ID,
  type AsrModelConfigInput,
  type AsrModelConfigView,
  type AsrModelId,
  type AsrProvider,
  type EmbeddingConfigView,
  type ImageGenModelConfigView,
  type ImageGenProvider,
  type MemmyMemoryModelConfigInput,
  type ModelConfigInput,
  type ModelConfigTestSecretTarget,
  type ModelConfigView,
  type RoleModelConfigInput,
  type RoleModelConfigView
} from "@memmy/local-api-contracts";
import type { DatabaseSync } from "node:sqlite";
import { ensureLocalByokModelConfigDefaults } from "../account-context.js";
import type { SecretStore } from "../secret-store.js";

export interface ModelConfigRepository {
  get(): ModelConfigView;
  upsert(input: ModelConfigInput): ModelConfigView;
  getAsrRuntimeConfig(): AsrRuntimeConfig;
  getImageGenRuntimeConfig(): ImageGenRuntimeConfig | null;
  getTestApiKey?(target: ModelConfigTestSecretTarget): string | null;
}

export interface ImageGenRuntimeConfig {
  provider: ImageGenProvider;
  baseUrl: string;
  modelId: string;
  apiKey: string;
}

export interface AsrRuntimeConfig {
  provider: AsrProvider;
  baseUrl: string;
  modelId: AsrModelId;
  apiKey: string;
}

interface ModelConfigRow {
  provider: string;
  base_url: string;
  model_id: string;
  api_key_ref: string | null;
  embedding_mode: string;
  embedding_base_url: string | null;
  embedding_model_id: string | null;
  embedding_api_key_ref: string | null;
  memory_provider: string | null;
  memory_base_url: string | null;
  memory_model_id: string | null;
  memory_api_key_ref: string | null;
  skill_provider: string | null;
  skill_base_url: string | null;
  skill_model_id: string | null;
  skill_api_key_ref: string | null;
  asr_provider: string;
  asr_base_url: string;
  asr_model_id: string;
  asr_api_key_ref: string | null;
  image_provider: string | null;
  image_base_url: string | null;
  image_model_id: string | null;
  image_api_key_ref: string | null;
  updated_at: string;
}

/** Creates create model config repository. */
export function createModelConfigRepository(db: DatabaseSync, secretStore: SecretStore): ModelConfigRepository {
  return {
    get() {
      const uuid = ensureLocalByokModelConfigDefaults(db);
      return toView(getRequiredRow(db, uuid), secretStore);
    },

    getAsrRuntimeConfig() {
      const uuid = ensureLocalByokModelConfigDefaults(db);
      return toAsrRuntimeConfig(getRequiredRow(db, uuid), secretStore);
    },

    getImageGenRuntimeConfig() {
      const uuid = ensureLocalByokModelConfigDefaults(db);
      return toImageGenRuntimeConfig(getRequiredRow(db, uuid), secretStore);
    },

    getTestApiKey(target) {
      const uuid = ensureLocalByokModelConfigDefaults(db);
      const row = getRequiredRow(db, uuid);
      const ref = selectTestApiKeyRef(row, target);
      return ref ? secretStore.get(ref) : null;
    },

    upsert(input) {
      const uuid = ensureLocalByokModelConfigDefaults(db);
      const previous = getOptionalRow(db, uuid);
      const memmyMemory = normalizeMemmyMemoryInput(input);
      const asr = normalizeAsrInput(input);
      const apiKeyRef = persistSecret(
        secretStore,
        `account:${uuid}:model-api-key`,
        input.apiKey,
        previous?.api_key_ref,
        uuid,
        "model_api_key"
      );
      const embedding = input.embedding ?? { mode: "local" as const };
      const embeddingApiKeyRef = embedding.mode === "custom"
        ? persistEmbeddingSecret(secretStore, embedding.apiKey, previous?.embedding_api_key_ref, uuid)
        : null;
      const memoryApiKeyRef = persistSecret(
        secretStore,
        `account:${uuid}:memory-summary-api-key`,
        memmyMemory.summary.apiKey,
        previous?.memory_api_key_ref,
        uuid,
        "memory_summary_api_key"
      );
      const skillApiKeyRef = persistSecret(
        secretStore,
        `account:${uuid}:memory-evolution-api-key`,
        memmyMemory.evolution.apiKey,
        previous?.skill_api_key_ref,
        uuid,
        "memory_evolution_api_key"
      );
      const asrApiKeyRef = persistSecret(
        secretStore,
        `account:${uuid}:asr-api-key`,
        asr.apiKey,
        previous?.asr_api_key_ref,
        uuid,
        "asr_api_key"
      );
      const imageGen = input.imageGen ?? null;
      const imageApiKeyRef = imageGen
        ? persistSecret(
            secretStore,
            `account:${uuid}:image-gen-api-key`,
            imageGen.apiKey,
            previous?.image_api_key_ref,
            uuid,
            "image_gen_api_key"
          )
        : null;
      const now = new Date().toISOString();

      db.prepare(
        `INSERT INTO account_model_config (
          uuid,
          provider,
          base_url,
          model_id,
          api_key_ref,
          embedding_mode,
          embedding_base_url,
          embedding_model_id,
          embedding_api_key_ref,
          memory_provider,
          memory_base_url,
          memory_model_id,
          memory_api_key_ref,
          skill_provider,
          skill_base_url,
          skill_model_id,
          skill_api_key_ref,
          asr_provider,
          asr_base_url,
          asr_model_id,
          asr_api_key_ref,
          image_provider,
          image_base_url,
          image_model_id,
          image_api_key_ref,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(uuid) DO UPDATE SET
          provider = excluded.provider,
          base_url = excluded.base_url,
          model_id = excluded.model_id,
          api_key_ref = excluded.api_key_ref,
          embedding_mode = excluded.embedding_mode,
          embedding_base_url = excluded.embedding_base_url,
          embedding_model_id = excluded.embedding_model_id,
          embedding_api_key_ref = excluded.embedding_api_key_ref,
          memory_provider = excluded.memory_provider,
          memory_base_url = excluded.memory_base_url,
          memory_model_id = excluded.memory_model_id,
          memory_api_key_ref = excluded.memory_api_key_ref,
          skill_provider = excluded.skill_provider,
          skill_base_url = excluded.skill_base_url,
          skill_model_id = excluded.skill_model_id,
          skill_api_key_ref = excluded.skill_api_key_ref,
          asr_provider = excluded.asr_provider,
          asr_base_url = excluded.asr_base_url,
          asr_model_id = excluded.asr_model_id,
          asr_api_key_ref = excluded.asr_api_key_ref,
          image_provider = excluded.image_provider,
          image_base_url = excluded.image_base_url,
          image_model_id = excluded.image_model_id,
          image_api_key_ref = excluded.image_api_key_ref,
          updated_at = excluded.updated_at`
      ).run(
        uuid,
        input.provider,
        input.baseUrl,
        input.modelId,
        apiKeyRef,
        embedding.mode,
        embedding.mode === "custom" ? embedding.baseUrl : null,
        embedding.mode === "custom" ? embedding.modelId : null,
        embeddingApiKeyRef,
        memmyMemory.summary.provider,
        memmyMemory.summary.baseUrl,
        memmyMemory.summary.modelId,
        memoryApiKeyRef,
        memmyMemory.evolution.provider,
        memmyMemory.evolution.baseUrl,
        memmyMemory.evolution.modelId,
        skillApiKeyRef,
        asr.provider,
        asr.baseUrl,
        asr.modelId,
        asrApiKeyRef,
        imageGen?.provider ?? null,
        imageGen?.baseUrl ?? null,
        imageGen?.modelId ?? null,
        imageApiKeyRef,
        now,
        now
      );

      return this.get();
    }
  };
}

/**
 * Selects the secret ref in the business table by test target.
 *
 * @param row the current account model-config row.
 * @param target the secret slot the test wants to reuse.
 * @returns the corresponding SecretStore ref; returns null when not configured.
 */
function selectTestApiKeyRef(row: ModelConfigRow, target: ModelConfigTestSecretTarget): string | null {
  switch (target) {
    case "primary":
      return row.api_key_ref;
    case "memory":
      return row.memory_api_key_ref;
    case "skill":
      return row.skill_api_key_ref;
    case "embedding":
      return row.embedding_api_key_ref;
    case "asr":
      return row.asr_api_key_ref;
    case "image":
      return row.image_api_key_ref;
  }

  return null;
}

/**
 * Persists the primary model API Key.
 *
 * @param secretStore the secret store.
 * @param ref the fixed secret ref.
 * @param secret the plaintext secret to write this time.
 * @param previousRef the previously saved ref.
 * @returns the ref the business table should currently save.
 */
function persistSecret(
  secretStore: SecretStore,
  ref: string,
  secret: string | undefined,
  previousRef: string | null | undefined,
  uuid: string,
  purpose: "model_api_key" | "embedding_api_key" | "memory_summary_api_key" | "memory_evolution_api_key" | "asr_api_key" | "image_gen_api_key"
): string | null {
  if (secret) {
    secretStore.set(ref, secret, { uuid, purpose });
    return ref;
  }

  return previousRef ?? null;
}

/**
 * Persists the embedding API Key.
 *
 * @param secretStore the secret store.
 * @param secret the embedding secret to write this time.
 * @param previousRef the previously saved ref.
 * @returns the ref the business table should currently save.
 */
function persistEmbeddingSecret(
  secretStore: SecretStore,
  secret: string | undefined,
  previousRef: string | null | undefined,
  uuid: string
): string | null {
  return persistSecret(
    secretStore,
    `account:${uuid}:embedding-api-key`,
    secret,
    previousRef,
    uuid,
    "embedding_api_key"
  );
}

/**
 * Queries the BYOK local model config.
 *
 * @param db the app-state SQLite connection.
 * @param uuid the BYOK local model-config uuid.
 * @returns the BYOK local model-config row.
 */
function getRequiredRow(db: DatabaseSync, uuid: string): ModelConfigRow {
  const row = getOptionalRow(db, uuid);
  if (!row) {
    throw new Error("Missing account model config row");
  }

  return row;
}

/**
 * Queries the BYOK local model config, allowing it to be missing.
 *
 * @param db the app-state SQLite connection.
 * @param uuid the BYOK local model-config uuid.
 * @returns the BYOK local model-config row or null.
 */
function getOptionalRow(db: DatabaseSync, uuid: string): ModelConfigRow | null {
  return (
    (db
    .prepare(
      `SELECT
        provider,
        base_url,
        model_id,
        api_key_ref,
        embedding_mode,
        embedding_base_url,
        embedding_model_id,
        embedding_api_key_ref,
        memory_provider,
        memory_base_url,
        memory_model_id,
        memory_api_key_ref,
        skill_provider,
        skill_base_url,
        skill_model_id,
        skill_api_key_ref,
        asr_provider,
        asr_base_url,
        asr_model_id,
        asr_api_key_ref,
        image_provider,
        image_base_url,
        image_model_id,
        image_api_key_ref,
        updated_at
      FROM account_model_config
      WHERE uuid = ?`
    )
      .get(uuid) as unknown as ModelConfigRow | undefined) ?? null
  );
}

/**
 * Converts a database row into a safe response view.
 *
 * @param row the model_config row.
 * @param secretStore the secret store.
 * @returns a model-config view without the plaintext key.
 */
function toView(row: ModelConfigRow, secretStore: SecretStore): ModelConfigView {
  const apiKey = row.api_key_ref ? secretStore.get(row.api_key_ref) : null;
  const embedding = toEmbeddingView(row, secretStore);

  return ModelConfigViewSchema.parse({
    provider: row.provider,
    baseUrl: row.base_url,
    modelId: row.model_id,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskSecret(apiKey),
    apiKey: apiKey ?? "",
    embedding,
    memmyMemory: {
      summary: toRoleModelView(
        {
          provider: row.memory_provider ?? row.provider,
          baseUrl: row.memory_base_url ?? row.base_url,
          modelId: row.memory_model_id ?? row.model_id,
          apiKeyRef: row.memory_api_key_ref ?? row.api_key_ref
        },
        secretStore
      ),
      evolution: toRoleModelView(
        {
          provider: row.skill_provider ?? row.provider,
          baseUrl: row.skill_base_url ?? row.base_url,
          modelId: row.skill_model_id ?? row.model_id,
          apiKeyRef: row.skill_api_key_ref ?? row.api_key_ref
        },
        secretStore
      )
    },
    asr: toAsrView(row, secretStore),
    imageGen: toImageGenView(row, secretStore),
    updatedAt: row.updated_at
  });
}

/**
 * Converts the embedding database columns into a safe response view.
 *
 * @param row the model_config row.
 * @param secretStore the secret store.
 * @returns the embedding view.
 */
function toEmbeddingView(row: ModelConfigRow, secretStore: SecretStore): EmbeddingConfigView {
  if (row.embedding_mode !== "custom") {
    return {
      mode: "local",
      baseUrl: null,
      modelId: null,
      hasApiKey: false,
      apiKeyMasked: "",
      apiKey: ""
    };
  }

  const apiKey = row.embedding_api_key_ref ? secretStore.get(row.embedding_api_key_ref) : null;
  return {
    mode: "custom",
    baseUrl: row.embedding_base_url ?? "",
    modelId: row.embedding_model_id ?? "",
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskSecret(apiKey),
    apiKey: apiKey ?? ""
  };
}

/**
 * Converts the role-model database columns into a safe response view.
 *
 * @param row the role-model config columns.
 * @param secretStore the secret store.
 * @returns the role-model view.
 */
function toRoleModelView(
  row: {
    provider: string;
    baseUrl: string;
    modelId: string;
    apiKeyRef: string | null;
  },
  secretStore: SecretStore
): RoleModelConfigView {
  const apiKey = row.apiKeyRef ? secretStore.get(row.apiKeyRef) : null;
  return {
    provider: row.provider as RoleModelConfigView["provider"],
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskSecret(apiKey),
    apiKey: apiKey ?? ""
  };
}

/**
 * Converts the ASR database columns into a safe response view.
 *
 * @param row the model_config row.
 * @param secretStore the secret store.
 * @returns the ASR view, without the plaintext API Key.
 */
function toAsrView(row: ModelConfigRow, secretStore: SecretStore): AsrModelConfigView {
  const apiKey = row.asr_api_key_ref ? secretStore.get(row.asr_api_key_ref) : null;
  return {
    provider: row.asr_provider as AsrModelConfigView["provider"],
    baseUrl: row.asr_base_url,
    modelId: row.asr_model_id as AsrModelConfigView["modelId"],
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskSecret(apiKey),
    apiKey: apiKey ?? ""
  };
}

/**
 * Reads the BYOK ASR runtime config.
 *
 * @param row the model_config row.
 * @param secretStore the secret store.
 * @returns the runtime config containing the plaintext ASR Key.
 */
function toAsrRuntimeConfig(row: ModelConfigRow, secretStore: SecretStore): AsrRuntimeConfig {
  const apiKey = row.asr_api_key_ref ? secretStore.get(row.asr_api_key_ref) : null;
  if (!apiKey) {
    const error = new Error("你没有配置 ASR 密钥，请先配置 ASR 密钥后重试。") as Error & { code?: string };
    error.code = "invalid_argument";
    throw error;
  }

  return {
    provider: row.asr_provider as AsrProvider,
    baseUrl: row.asr_base_url,
    modelId: row.asr_model_id as AsrModelId,
    apiKey
  };
}

/**
 * Converts the image-generation model database columns into a safe response view.
 *
 * @param row the model_config row.
 * @param secretStore the secret store.
 * @returns the image-generation view; returns null when not configured.
 */
function toImageGenView(row: ModelConfigRow, secretStore: SecretStore): ImageGenModelConfigView | null {
  if (!row.image_provider || !row.image_base_url || !row.image_model_id) {
    return null;
  }

  const apiKey = row.image_api_key_ref ? secretStore.get(row.image_api_key_ref) : null;
  return {
    provider: row.image_provider as ImageGenProvider,
    baseUrl: row.image_base_url,
    modelId: row.image_model_id,
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: maskSecret(apiKey),
    apiKey: apiKey ?? ""
  };
}

/**
 * Reads the BYOK image-generation runtime config.
 *
 * @param row the model_config row.
 * @param secretStore the secret store.
 * @returns the runtime config containing the plaintext image-generation Key; returns null when not configured or the key is missing.
 */
function toImageGenRuntimeConfig(row: ModelConfigRow, secretStore: SecretStore): ImageGenRuntimeConfig | null {
  if (!row.image_provider || !row.image_base_url || !row.image_model_id) {
    return null;
  }

  const apiKey = row.image_api_key_ref ? secretStore.get(row.image_api_key_ref) : null;
  if (!apiKey) {
    return null;
  }

  return {
    provider: row.image_provider as ImageGenProvider,
    baseUrl: row.image_base_url,
    modelId: row.image_model_id,
    apiKey
  };
}

/**
 * Copies the primary model config when the Memory role model is absent.
 *
 * @param input the model-config write input.
 * @returns the expanded Memory role-model config.
 */
function normalizeMemmyMemoryInput(input: ModelConfigInput): MemmyMemoryModelConfigInput {
  return input.memmyMemory ?? {
    summary: toRoleModelConfigInput(input),
    evolution: toRoleModelConfigInput(input)
  };
}

/**
 * Uses the fixed Alibaba qwen3-asr-flash defaults when the ASR config is absent.
 *
 * @param input the model-config write input.
 * @returns the expanded ASR model config.
 */
function normalizeAsrInput(input: ModelConfigInput): AsrModelConfigInput {
  return input.asr ?? {
    provider: ASR_PROVIDER,
    baseUrl: ASR_DEFAULT_BASE_URL,
    modelId: QWEN_ASR_MODEL_ID
  };
}

/**
 * Converts the primary model config into a role-model config.
 *
 * @param input the model-config write input.
 * @returns the role-model config.
 */
function toRoleModelConfigInput(input: ModelConfigInput): RoleModelConfigInput {
  return {
    provider: input.provider,
    baseUrl: input.baseUrl,
    modelId: input.modelId,
    apiKey: input.apiKey
  };
}

/**
 * Generates a masked secret for display.
 *
 * @param secret the plaintext secret; returns an empty string when missing.
 * @returns a masked display of the first 4 + last 4 characters.
 */
function maskSecret(secret: string | null): string {
  if (!secret) {
    return "";
  }

  if (secret.length <= 8) {
    return "••••";
  }

  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}
