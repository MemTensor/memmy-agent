import { createDecipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";
import type { LegacyByokCatalog, LegacyCatalogConnection } from "./0001-normalize-runtime-model-catalog.js";
import { canonicalProviderId } from "./0001-normalize-runtime-model-catalog.js";

const DEFAULT_KEY_MATERIAL = "Memmy local SecretStore v1";
const LOCAL_BYOK_UUID = "local-byok-onboarding";

type LegacyRow = Readonly<Record<string, unknown>>;
type LegacySourceResult =
  | { status: "ignored" }
  | { status: "found"; catalog: LegacyByokCatalog };

function stringValue(row: LegacyRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set();
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

function selectedModelRow(db: Database.Database): LegacyRow | null {
  const accountColumns = tableColumns(db, "account_model_config");
  if (accountColumns.has("uuid")) {
    const local = db
      .prepare("SELECT * FROM account_model_config WHERE uuid = ? LIMIT 1")
      .get(LOCAL_BYOK_UUID) as LegacyRow | undefined;
    if (local) return local;
  }
  const legacyColumns = tableColumns(db, "model_config");
  if (legacyColumns.has("id")) {
    return (db.prepare("SELECT * FROM model_config WHERE id = 'default' LIMIT 1").get() as LegacyRow | undefined) ?? null;
  }
  return null;
}

function secretError(): Error {
  return Object.assign(new Error("Unable to decrypt selected legacy BYOK credential"), {
    code: "legacy_byok_secret_unavailable" as const,
  });
}

function decryptSecret(db: Database.Database, ref: string | null): string | null {
  if (!ref) return null;
  const columns = tableColumns(db, "secret_store");
  if (!["ref", "ciphertext", "iv", "auth_tag"].every((column) => columns.has(column))) {
    throw secretError();
  }
  const row = db
    .prepare("SELECT ciphertext, iv, auth_tag FROM secret_store WHERE ref = ? LIMIT 1")
    .get(ref) as { ciphertext: string; iv: string; auth_tag: string } | undefined;
  if (!row) throw secretError();
  try {
    const keyMaterial = process.env.MEMMY_SECRET_KEY ?? DEFAULT_KEY_MATERIAL;
    const key = createHash("sha256").update(keyMaterial).digest();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
    decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw secretError();
  }
}

function connection(
  row: LegacyRow,
  input: {
    provider: string;
    apiBase: string;
    model: string;
    secretRef: string;
    fallback?: LegacyCatalogConnection;
    defaultProvider?: string;
  },
  readSecret: (ref: string | null) => string | null,
): LegacyCatalogConnection | null {
  const provider = stringValue(row, input.provider)
    ?? input.defaultProvider
    ?? input.fallback?.provider
    ?? null;
  const apiBase = stringValue(row, input.apiBase) ?? input.fallback?.apiBase ?? null;
  const model = stringValue(row, input.model) ?? input.fallback?.model ?? null;
  if (!provider || !apiBase || !model) return null;
  const ref = stringValue(row, input.secretRef);
  const apiKey = ref ? readSecret(ref) : input.fallback?.apiKey;
  return {
    provider: canonicalProviderId(provider),
    apiBase,
    model,
    ...(apiKey ? { apiKey } : {}),
  };
}

function catalogFromRow(db: Database.Database, row: LegacyRow): LegacyByokCatalog | null {
  const primaryRef = stringValue(row, "api_key_ref");
  if (!primaryRef) return null;
  const secretCache = new Map<string, string>();
  const readSecret = (ref: string | null): string | null => {
    if (!ref) return null;
    const cached = secretCache.get(ref);
    if (cached) return cached;
    const secret = decryptSecret(db, ref);
    if (!secret) throw secretError();
    secretCache.set(ref, secret);
    return secret;
  };
  const primary = connection(
    row,
    {
      provider: "provider",
      apiBase: "base_url",
      model: "model_id",
      secretRef: "api_key_ref",
    },
    readSecret,
  );
  if (!primary?.apiKey) return null;
  const catalog: LegacyByokCatalog = { agent: primary };

  catalog.memory_summary = connection(
    row,
    {
      provider: "memory_provider",
      apiBase: "memory_base_url",
      model: "memory_model_id",
      secretRef: "memory_api_key_ref",
      fallback: primary,
    },
    readSecret,
  ) ?? primary;
  catalog.memory_evolution = connection(
    row,
    {
      provider: "skill_provider",
      apiBase: "skill_base_url",
      model: "skill_model_id",
      secretRef: "skill_api_key_ref",
      fallback: primary,
    },
    readSecret,
  ) ?? primary;

  const embeddingMode = stringValue(row, "embedding_mode");
  if (embeddingMode === "custom" || embeddingMode === "separate") {
    const embedding = connection(
      row,
      {
        provider: "embedding_provider",
        apiBase: "embedding_base_url",
        model: "embedding_model_id",
        secretRef: "embedding_api_key_ref",
        defaultProvider: "openai",
      },
      readSecret,
    );
    if (embedding) catalog.embedding = embedding;
  }

  const asrRef = stringValue(row, "asr_api_key_ref");
  if (asrRef) {
    const asr = connection(
      row,
      {
        provider: "asr_provider",
        apiBase: "asr_base_url",
        model: "asr_model_id",
        secretRef: "asr_api_key_ref",
        defaultProvider: "dashscope",
      },
      readSecret,
    );
    if (asr) catalog.asr = asr;
  }

  const imageRef = stringValue(row, "image_api_key_ref");
  if (imageRef) {
    const image = connection(
      row,
      {
        provider: "image_provider",
        apiBase: "image_base_url",
        model: "image_model_id",
        secretRef: "image_api_key_ref",
      },
      readSecret,
    );
    if (image) catalog.image_generation = image;
  }
  return catalog;
}

export function readLegacyAppStateModelConfig(databaseFile: string): LegacySourceResult {
  if (!fs.existsSync(databaseFile)) return { status: "ignored" };
  const db = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const row = selectedModelRow(db);
    if (!row) return { status: "ignored" };
    const catalog = catalogFromRow(db, row);
    return catalog ? { status: "found", catalog } : { status: "ignored" };
  } finally {
    db.close();
  }
}
