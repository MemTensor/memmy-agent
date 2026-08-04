#!/usr/bin/env node
import { existsSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { env, pipeline } from "@huggingface/transformers";

const outputRoot = resolve(process.argv[2] ?? "");
const model = process.env.MEMMY_EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
const modelRoot = join(outputRoot, model);
const fallbackRemoteHost = "https://hf-mirror.com/";
const requiredFiles = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/model_quantized.onnx"
];

if (!process.argv[2]) {
  console.error("Usage: prepare-embedding-model.mjs <output-dir>");
  process.exit(1);
}

await rm(modelRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const sourceRoot = resolveSourceModelRoot();
if (sourceRoot) {
  console.log(`Copying bundled embedding model ${model} from ${sourceRoot}`);
  await cp(sourceRoot, modelRoot, { recursive: true });
  verifyModelFiles();
  console.log(`Bundled embedding model is ready: ${modelRoot}`);
  process.exit(0);
}

env.cacheDir = outputRoot;
env.localModelPath = outputRoot;
env.allowLocalModels = true;
env.allowRemoteModels = true;

console.log(`Preparing bundled embedding model ${model} at ${modelRoot}`);
await downloadModelWithRetries(resolveRemoteHosts());
verifyModelFiles();

console.log(`Bundled embedding model is ready: ${modelRoot}`);

function resolveSourceModelRoot() {
  const sourceDir = process.env.MEMMY_EMBEDDING_MODEL_SOURCE_DIR?.trim();
  if (!sourceDir) return null;

  const sourceModelRoot = resolve(sourceDir, model);
  if (existsSync(join(sourceModelRoot, "config.json"))) {
    return sourceModelRoot;
  }
  const sourceRoot = resolve(sourceDir);
  if (existsSync(join(sourceRoot, "config.json"))) {
    return sourceRoot;
  }

  console.error(`MEMMY_EMBEDDING_MODEL_SOURCE_DIR does not contain ${model}`);
  console.error(`Tried:`);
  console.error(`  ${sourceModelRoot}`);
  console.error(`  ${sourceRoot}`);
  process.exit(1);
}

function normalizedConfiguredRemoteHost() {
  const raw = process.env.MEMMY_EMBEDDING_MODEL_REMOTE_HOST?.trim() || process.env.HF_ENDPOINT?.trim();
  if (!raw) return null;
  return normalizeRemoteHost(raw);
}

function normalizeRemoteHost(raw) {
  return `${raw.replace(/\/+$/, "")}/`;
}

function resolveRemoteHosts() {
  const configured = normalizedConfiguredRemoteHost();
  if (configured) {
    return [configured];
  }
  return unique([env.remoteHost, fallbackRemoteHost].filter(Boolean).map(normalizeRemoteHost));
}

function unique(values) {
  return [...new Set(values)];
}

async function downloadModelWithRetries(remoteHosts) {
  const configuredAttempts = Number.parseInt(process.env.MEMMY_EMBEDDING_MODEL_DOWNLOAD_ATTEMPTS ?? "3", 10);
  const maxAttempts = Number.isFinite(configuredAttempts) && configuredAttempts > 0 ? configuredAttempts : 3;
  let lastError;
  for (const remoteHost of remoteHosts) {
    env.remoteHost = remoteHost;
    await rm(modelRoot, { recursive: true, force: true });
    await mkdir(outputRoot, { recursive: true });
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const extractor = await pipeline("feature-extraction", model, {
          cache_dir: outputRoot,
          dtype: "q8",
          device: "cpu"
        });
        await extractor("memmy embedding model warmup", {
          pooling: "mean",
          normalize: false
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          console.warn(`Embedding model download failed from ${remoteHost}; retrying (${attempt + 1}/${maxAttempts})`);
          await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 3_000));
        } else {
          console.warn(`Embedding model download failed from ${remoteHost}`);
        }
      }
    }
  }

  console.error(`Failed to prepare bundled embedding model ${model}.`);
  console.error(`Tried remote hosts: ${remoteHosts.join(", ")}`);
  console.error(`Set MEMMY_EMBEDDING_MODEL_SOURCE_DIR to a local model directory, or set HF_ENDPOINT/MEMMY_EMBEDDING_MODEL_REMOTE_HOST to a reachable Hugging Face host.`);
  throw lastError;
}

function verifyModelFiles() {
  const missing = requiredFiles.filter((file) => !existsSync(join(modelRoot, file)));
  if (missing.length > 0) {
    console.error(`Bundled embedding model is incomplete: ${model}`);
    for (const file of missing) {
      console.error(`  missing ${join(modelRoot, file)}`);
    }
    process.exit(1);
  }
}
