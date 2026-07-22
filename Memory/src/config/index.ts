import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type LlmProviderName =
  | ""
  | "local_only"
  | "openai_compatible"
  | "gemini"
  | "anthropic"
  | "bedrock"
  | "host";

export type LlmVendorName =
  | ""
  | "openai_compatible"
  | "anthropic"
  | "google"
  | "deepseek"
  | "zhipu"
  | "qwen"
  | "kimi"
  | "minimax"
  | "baidu"
  | "doubao";

export type EmbeddingProviderName =
  | "local"
  | "openai_compatible"
  | "gemini"
  | "cohere"
  | "voyage"
  | "mistral";

export type StorageModeName = "local" | "cloud" | "dev";
export type StorageBackendName = "sqlite" | "openmem-cloud-rest";
export type MemoryProfileName = "account" | "byok";
export type MemoryDomainName = "" | "research";
export type ReadOnlyInjectionProfile =
  | "all"
  | "experience"
  | "skill"
  | "skill_experience";
export type CaptureBatchMode = "windowed";
export type ReflectionContextMode = "none" | "task" | "downstream" | "task_downstream";
export type LongEpisodeReflectMode = "per_step_parallel" | "per_step_downstream";

export interface LlmConfig {
  provider: LlmProviderName;
  vendor?: LlmVendorName;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  enableThinking: boolean;
  thinkingBudget?: number;
  temperature: number;
  maxTokens?: number;
  timeoutMs: number;
  maxRetries: number;
  malformedRetries: number;
}

export interface EmbeddingConfig {
  provider: EmbeddingProviderName;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  batchSize: number;
  timeoutMs: number;
  maxRetries: number;
  cache: boolean;
  normalize: boolean;
}

export interface StorageConfig {
  mode: StorageModeName;
  backend: StorageBackendName;
  sqlitePath?: string;
  endpoint?: string;
  token?: string;
}

export interface AlgorithmConfig {
  enableMemoryAdd: boolean;
  enableMemorySearch: boolean;
  enableQueryRewrite: boolean;
  capture: {
    maxTextChars: number;
    maxToolOutputChars: number;
    synthReflection: boolean;
    embedAfterCapture: boolean;
    alphaScoring: boolean;
    batchMode: CaptureBatchMode;
    batchThreshold: number;
    reflectionContextMode: ReflectionContextMode;
    longEpisodeReflectMode: LongEpisodeReflectMode;
    downstreamStepCount: number;
    taskContextMaxChars: number;
    downstreamContextMaxChars: number;
    downstreamPerStepMaxChars: number;
    synthOutcomeMaxChars: number;
    reflectionBatchWindowSize: number;
    reflectionBatchOverlap: number;
    reflectionBatchDegradedWindowSize: number;
    reflectionBatchDegradedOverlap: number;
    reflectionBatchPrimaryMaxRetries: number;
    reflectionBatchDegradedMaxRetries: number;
    reflectionBatchStepStateChars: number;
    reflectionBatchStepThinkingChars: number;
    reflectionBatchStepActionChars: number;
    reflectionBatchToolInputChars: number;
    reflectionBatchToolOutputChars: number;
    reflectionBatchToolErrorChars: number;
    reflectionBatchOutcomeChars: number;
    reflectionBatchReflectionChars: number;
  };
  reward: {
    llmScoring: boolean;
    gamma: number;
    lambda: number;
    delta: number;
    tauSoftmax: number;
    decayHalfLifeDays: number;
    implicitThreshold: number;
    feedbackWindowSec: number;
    summaryMaxChars: number;
    llmConcurrency: number;
    minExchangesForCompletion: number;
    minContentCharsForCompletion: number;
    toolHeavyRatio: number;
    minAssistantCharsForToolHeavy: number;
  };
  feedback: {
    failureThreshold: number;
    failureWindow: number;
    valueDelta: number;
    minLowValueThreshold: number;
    useLlm: boolean;
    attachToPolicy: boolean;
    cooldownMs: number;
    traceCharCap: number;
    evidenceLimit: number;
  };
  l2Induction: {
    useLlm: boolean;
    minEpisodesForInduction: number;
    minSimilarity: number;
    candidateTtlDays: number;
    minTraceValue: number;
    minGain: number;
    archiveGain: number;
    traceCharCap: number;
    tauSoftmax: number;
    gainEmaAlpha: number;
  };
  l3Abstraction: {
    useLlm: boolean;
    minPolicies: number;
    minPolicyGain: number;
    minPolicySupport: number;
    clusterMinSimilarity: number;
    policyCharCap: number;
    traceCharCap: number;
    traceEvidencePerPolicy: number;
    cooldownDays: number;
    confidenceDelta: number;
    minConfidenceForRetrieval: number;
  };
  skill: {
    useLlm: boolean;
    minEtaForRetrieval: number;
    minSupport: number;
    minGain: number;
    candidateTrials: number;
    cooldownMs: number;
    traceCharCap: number;
    evidenceLimit: number;
    etaDelta: number;
    archiveEta: number;
    repairCandidateMinEta: number;
    outputLanguageMode: "follow_policy" | "zh" | "en";
    outcomeRTaskSuccessThreshold: number;
    outcomeRTaskFailureThreshold: number;
    failureEpisodeScorePenalty: number;
    failureEpisodeMaxRatio: number;
  };
  session: {
    followUpMode: "merge_follow_ups" | "episode_per_turn";
    mergeMaxGapMs: number;
  };
  retrieval: {
    tier1TopK: number;
    tier2TopK: number;
    tier3TopK: number;
    candidatePoolFactor: number;
    weightCosine: number;
    weightPriority: number;
    mmrLambda: number;
    rrfConstant: number;
    relativeThresholdFloor: number;
    minSkillEta: number;
    minTraceSim: number;
    episodeGoalMinSim: number;
    includeLowValue: boolean;
    tagFilter: "auto" | "on" | "off";
    keywordTopK: number;
    skillEtaBlend: number;
    smartSeed: boolean;
    smartSeedRatio: number;
    multiChannelBypass: boolean;
    skillInjectionMode: "summary" | "full";
    skillSummaryChars: number;
    llmFilterEnabled: boolean;
    llmFilterMaxKeep: number;
    llmFilterFallbackMaxKeep: number;
    llmFilterMinCandidates: number;
    llmFilterCandidateBodyChars: number;
    readOnlyInjectionProfile: ReadOnlyInjectionProfile;
  };
}

export interface MemmyConfig {
  version: 1;
  domain: MemoryDomainName;
  activeProfile: MemoryProfileName;
  userId?: string;
  storage: StorageConfig;
  summary: LlmConfig;
  evolution: LlmConfig;
  embedding: EmbeddingConfig;
  algorithm: AlgorithmConfig;
}

const ACCOUNT_EVOLUTION_THINKING_BUDGET = 1_000;
const ASYNC_EVOLUTION_TIMEOUT_MS = 3 * 60_000;
export const MEMORY_SUMMARY_MAX_TOKENS = 512;

export const DEFAULT_MEMMY_CONFIG: MemmyConfig = {
  version: 1,
  domain: "",
  activeProfile: "byok",
  storage: {
    mode: "local",
    backend: "sqlite",
    sqlitePath: join(homedir(), ".memmy", "memory-service", "memory.sqlite"),
    endpoint: "http://127.0.0.1:18960",
    token: undefined
  },
  summary: {
    provider: "",
    vendor: "",
    endpoint: undefined,
    model: "",
    apiKey: undefined,
    enableThinking: false,
    temperature: 0,
    maxTokens: MEMORY_SUMMARY_MAX_TOKENS,
    timeoutMs: 45_000,
    maxRetries: 3,
    malformedRetries: 1
  },
  evolution: {
    provider: "",
    vendor: "",
    endpoint: undefined,
    model: "",
    apiKey: undefined,
    enableThinking: true,
    temperature: 0,
    maxTokens: 4096,
    timeoutMs: ASYNC_EVOLUTION_TIMEOUT_MS,
    maxRetries: 2,
    malformedRetries: 1
  },
  embedding: {
    provider: "local",
    endpoint: undefined,
    model: "Xenova/all-MiniLM-L6-v2",
    apiKey: undefined,
    batchSize: 32,
    timeoutMs: 60_000,
    maxRetries: 2,
    cache: true,
    normalize: false
  },
  algorithm: {
    enableMemoryAdd: true,
    enableMemorySearch: true,
    enableQueryRewrite: false,
    capture: {
      maxTextChars: 4_000,
      maxToolOutputChars: 2_000,
      synthReflection: true,
      embedAfterCapture: true,
      alphaScoring: true,
      batchMode: "windowed",
      batchThreshold: 12,
      reflectionContextMode: "task_downstream",
      longEpisodeReflectMode: "per_step_downstream",
      downstreamStepCount: 3,
      taskContextMaxChars: 800,
      downstreamContextMaxChars: 1_200,
      downstreamPerStepMaxChars: 400,
      synthOutcomeMaxChars: 600,
      reflectionBatchWindowSize: 6,
      reflectionBatchOverlap: 1,
      reflectionBatchDegradedWindowSize: 3,
      reflectionBatchDegradedOverlap: 1,
      reflectionBatchPrimaryMaxRetries: 1,
      reflectionBatchDegradedMaxRetries: 2,
      reflectionBatchStepStateChars: 600,
      reflectionBatchStepThinkingChars: 300,
      reflectionBatchStepActionChars: 600,
      reflectionBatchToolInputChars: 120,
      reflectionBatchToolOutputChars: 160,
      reflectionBatchToolErrorChars: 160,
      reflectionBatchOutcomeChars: 240,
      reflectionBatchReflectionChars: 300
    },
    reward: {
      llmScoring: true,
      gamma: 0.9,
      lambda: 0.5,
      delta: 0.1,
      tauSoftmax: 0.5,
      decayHalfLifeDays: 30,
      implicitThreshold: 0.2,
      feedbackWindowSec: 30,
      summaryMaxChars: 2_000,
      llmConcurrency: 2,
      minExchangesForCompletion: 1,
      minContentCharsForCompletion: 40,
      toolHeavyRatio: 0.7,
      minAssistantCharsForToolHeavy: 80
    },
    feedback: {
      failureThreshold: 3,
      failureWindow: 5,
      valueDelta: 0.5,
      minLowValueThreshold: 0.01,
      useLlm: true,
      attachToPolicy: true,
      cooldownMs: 60_000,
      traceCharCap: 500,
      evidenceLimit: 4
    },
    l2Induction: {
      useLlm: true,
      minEpisodesForInduction: 1,
      minSimilarity: 0.65,
      candidateTtlDays: 30,
      minTraceValue: 0.005,
      minGain: 0.02,
      archiveGain: -0.05,
      traceCharCap: 3_000,
      tauSoftmax: 0.5,
      gainEmaAlpha: 0.4
    },
    l3Abstraction: {
      useLlm: true,
      minPolicies: 1,
      minPolicyGain: 0.02,
      minPolicySupport: 1,
      clusterMinSimilarity: 0.3,
      policyCharCap: 800,
      traceCharCap: 500,
      traceEvidencePerPolicy: 1,
      cooldownDays: 0,
      confidenceDelta: 0.05,
      minConfidenceForRetrieval: 0.2
    },
    skill: {
      useLlm: true,
      minEtaForRetrieval: 0.1,
      minSupport: 1,
      minGain: 0.02,
      candidateTrials: 1,
      cooldownMs: 0,
      traceCharCap: 500,
      evidenceLimit: 6,
      etaDelta: 0.1,
      archiveEta: 0.1,
      repairCandidateMinEta: 0.5,
      outputLanguageMode: "follow_policy",
      outcomeRTaskSuccessThreshold: 0.5,
      outcomeRTaskFailureThreshold: -0.15,
      failureEpisodeScorePenalty: 0,
      failureEpisodeMaxRatio: 0.4
    },
    session: {
      followUpMode: "merge_follow_ups",
      mergeMaxGapMs: 2 * 60 * 60 * 1000
    },
    retrieval: {
      tier1TopK: 3,
      tier2TopK: 5,
      tier3TopK: 2,
      candidatePoolFactor: 4,
      weightCosine: 0.6,
      weightPriority: 0.4,
      mmrLambda: 0.7,
      rrfConstant: 60,
      relativeThresholdFloor: 0.2,
      minSkillEta: 0.1,
      minTraceSim: 0.25,
      episodeGoalMinSim: 0.45,
      includeLowValue: false,
      tagFilter: "auto",
      keywordTopK: 20,
      skillEtaBlend: 0.15,
      smartSeed: true,
      smartSeedRatio: 0.7,
      multiChannelBypass: true,
      skillInjectionMode: "summary",
      skillSummaryChars: 200,
      llmFilterEnabled: true,
      llmFilterMaxKeep: 8,
      llmFilterFallbackMaxKeep: 6,
      llmFilterMinCandidates: 2,
      llmFilterCandidateBodyChars: 500,
      readOnlyInjectionProfile: "all"
    }
  }
};

export function defaultConfigPaths(): string[] {
  return [
    process.env.MEMMY_CONFIG,
    join(homedir(), ".memmy", "config.yaml")
  ].filter((value): value is string => Boolean(value));
}

export function loadMemmyConfig(configPath?: string): {
  config: MemmyConfig;
  path?: string;
} {
  const selectedPath = configPath
    ? resolve(configPath)
    : defaultConfigPaths().find((candidate) => existsSync(candidate));
  const rootConfig = selectedPath && existsSync(selectedPath)
    ? parseConfigFile(selectedPath)
    : {};
  const memmyMemoryConfig = asRecord(rootConfig.memmyMemory);
  const fileConfig = resolveRuntimeMemmyMemoryConfig(memmyMemoryConfig);
  const envConfig = configFromEnv();
  const merged = normalizeConfig(deepMerge(
    DEFAULT_MEMMY_CONFIG as unknown as Record<string, unknown>,
    fileConfig,
    envConfig
  ));
  return {
    config: merged,
    path: selectedPath
  };
}

export function resolveEvolutionConfig(config: MemmyConfig): LlmConfig {
  const evolution = config.evolution;
  if (evolution.provider || evolution.model || evolution.endpoint || evolution.apiKey) {
    return evolution;
  }
  return {
    ...config.summary,
    enableThinking: config.evolution.enableThinking,
    maxTokens: config.evolution.maxTokens ?? config.summary.maxTokens,
    timeoutMs: config.evolution.timeoutMs,
    malformedRetries: config.evolution.malformedRetries ?? config.summary.malformedRetries
  };
}

function parseConfigFile(path: string): Record<string, unknown> {
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function configFromEnv(): Record<string, unknown> {
  return compactRecord({
    domain: process.env.MEMMY_MEMORY_DOMAIN ?? process.env.MEMMY_DOMAIN,
    userId: process.env.MEMMY_MEMORY_USER_ID ?? process.env.MEMMY_USER_ID ?? process.env.MEMORY_SERVICE_USER_ID,
    storage: compactRecord({
      mode: process.env.MEMMY_MEMORY_MODE,
      backend: process.env.MEMMY_MEMORY_BACKEND,
      sqlitePath: process.env.MEMMY_MEMORY_DB ?? process.env.MEMORY_SERVICE_DB,
      endpoint: process.env.MEMMY_MEMORY_URL ?? process.env.MEMORY_SERVICE_URL,
      token: process.env.MEMMY_MEMORY_TOKEN ?? process.env.MEMORY_SERVICE_TOKEN
    }),
    summary: compactRecord({
      provider: process.env.MEMMY_SUMMARY_PROVIDER,
      vendor: process.env.MEMMY_SUMMARY_VENDOR,
      endpoint: process.env.MEMMY_SUMMARY_ENDPOINT,
      model: process.env.MEMMY_SUMMARY_MODEL,
      apiKey: process.env.MEMMY_SUMMARY_API_KEY,
      enableThinking: booleanEnv("MEMMY_SUMMARY_ENABLE_THINKING"),
      temperature: numberEnv("MEMMY_SUMMARY_TEMPERATURE"),
      maxTokens: numberEnv("MEMMY_SUMMARY_MAX_TOKENS"),
      timeoutMs: numberEnv("MEMMY_SUMMARY_TIMEOUT_MS"),
      maxRetries: numberEnv("MEMMY_SUMMARY_MAX_RETRIES")
    }),
    evolution: compactRecord({
      provider: process.env.MEMMY_EVOLUTION_PROVIDER,
      vendor: process.env.MEMMY_EVOLUTION_VENDOR,
      endpoint: process.env.MEMMY_EVOLUTION_ENDPOINT,
      model: process.env.MEMMY_EVOLUTION_MODEL,
      apiKey: process.env.MEMMY_EVOLUTION_API_KEY,
      enableThinking: booleanEnv("MEMMY_EVOLUTION_ENABLE_THINKING"),
      temperature: numberEnv("MEMMY_EVOLUTION_TEMPERATURE"),
      maxTokens: numberEnv("MEMMY_EVOLUTION_MAX_TOKENS"),
      timeoutMs: numberEnv("MEMMY_EVOLUTION_TIMEOUT_MS"),
      maxRetries: numberEnv("MEMMY_EVOLUTION_MAX_RETRIES")
    }),
    embedding: compactRecord({
      provider: process.env.MEMMY_EMBEDDING_PROVIDER,
      endpoint: process.env.MEMMY_EMBEDDING_ENDPOINT,
      model: process.env.MEMMY_EMBEDDING_MODEL,
      apiKey: process.env.MEMMY_EMBEDDING_API_KEY,
      batchSize: numberEnv("MEMMY_EMBEDDING_BATCH_SIZE"),
      timeoutMs: numberEnv("MEMMY_EMBEDDING_TIMEOUT_MS"),
      maxRetries: numberEnv("MEMMY_EMBEDDING_MAX_RETRIES")
    }),
    algorithm: compactRecord({
      enableMemoryAdd: booleanEnv("MEMMY_ENABLE_MEMORY_ADD"),
      enableMemorySearch: booleanEnv("MEMMY_ENABLE_MEMORY_SEARCH"),
      enableQueryRewrite: booleanEnv("MEMMY_ENABLE_QUERY_REWRITE"),
      retrieval: compactRecord({
        readOnlyInjectionProfile:
          process.env.MEMMY_RETRIEVAL_INJECTION_PROFILE ??
          process.env.MEMMY_READONLY_INJECTION_PROFILE
      })
    })
  });
}

function normalizeConfig(input: Record<string, unknown>): MemmyConfig {
  const storage = normalizeStorage(asRecord(input.storage));
  const summary = normalizeLlm(asRecord(input.summary), DEFAULT_MEMMY_CONFIG.summary);
  const activeProfile = memoryProfileName(input.activeProfile, DEFAULT_MEMMY_CONFIG.activeProfile);
  const normalizedEvolution = normalizeLlm(asRecord(input.evolution), DEFAULT_MEMMY_CONFIG.evolution);
  const evolution = activeProfile === "account"
    ? {
        ...normalizedEvolution,
        thinkingBudget: ACCOUNT_EVOLUTION_THINKING_BUDGET,
        timeoutMs: ASYNC_EVOLUTION_TIMEOUT_MS
      }
    : normalizedEvolution;
  const embedding = normalizeEmbedding(asRecord(input.embedding));
  const algorithm = normalizeAlgorithm(asRecord(input.algorithm));
  return {
    version: 1,
    domain: memoryDomainName(input.domain, DEFAULT_MEMMY_CONFIG.domain),
    activeProfile,
    userId: optionalString(input.userId),
    storage,
    summary,
    evolution,
    embedding,
    algorithm
  };
}

function resolveRuntimeMemmyMemoryConfig(input: Record<string, unknown>): Record<string, unknown> {
  const profiles = isRecord(input.profiles) ? input.profiles : undefined;
  if (!profiles) {
    return input;
  }

  const activeProfile = optionalMemoryProfileName(input.activeProfile);
  if (!activeProfile) {
    throw new Error("memmyMemory.activeProfile must be byok or account when memmyMemory.profiles is configured");
  }

  const profile = asRecord(profiles[activeProfile]);
  if (!isRecord(profile)) {
    throw new Error(`memmyMemory.profiles.${activeProfile} is required`);
  }

  const base = omitKeys(input, ["profiles", "summary", "evolution", "embedding", "userId"]);
  const merged = deepMerge(base, profile, { activeProfile });
  if (activeProfile === "account") {
    merged.summary = withForcedLlmProvider(asRecord(merged.summary), "openai_compatible", "qwen");
    merged.evolution = withForcedLlmProvider(asRecord(merged.evolution), "openai_compatible", "qwen");
    merged.embedding = withForcedEmbeddingProvider(asRecord(merged.embedding), "openai_compatible");
  }
  return merged;
}

function withForcedLlmProvider(
  input: Record<string, unknown>,
  provider: LlmProviderName,
  vendor: LlmVendorName
): Record<string, unknown> {
  return {
    ...input,
    provider,
    vendor
  };
}

function withForcedEmbeddingProvider(input: Record<string, unknown>, provider: EmbeddingProviderName): Record<string, unknown> {
  return {
    ...input,
    provider
  };
}

function normalizeStorage(input: Record<string, unknown>): StorageConfig {
  return {
    mode: storageMode(input.mode, DEFAULT_MEMMY_CONFIG.storage.mode),
    backend: storageBackend(input.backend, DEFAULT_MEMMY_CONFIG.storage.backend),
    sqlitePath: optionalPathString(input.sqlitePath),
    endpoint: optionalString(input.endpoint) ?? DEFAULT_MEMMY_CONFIG.storage.endpoint,
    token: optionalString(input.token)
  };
}

function normalizeLlm(input: Record<string, unknown>, defaults: LlmConfig): LlmConfig {
  return {
    provider: llmProvider(input.provider, defaults.provider),
    vendor: llmVendor(input.vendor, defaults.vendor ?? ""),
    endpoint: optionalString(input.endpoint),
    model: optionalString(input.model) ?? defaults.model,
    apiKey: optionalString(input.apiKey),
    enableThinking: booleanValue(input.enableThinking, defaults.enableThinking),
    temperature: numberValue(input.temperature, defaults.temperature),
    maxTokens: numberValue(input.maxTokens, defaults.maxTokens ?? 1200),
    timeoutMs: numberValue(input.timeoutMs, defaults.timeoutMs),
    maxRetries: numberValue(input.maxRetries, defaults.maxRetries),
    malformedRetries: numberValue(input.malformedRetries, defaults.malformedRetries)
  };
}

function normalizeEmbedding(input: Record<string, unknown>): EmbeddingConfig {
  return {
    provider: embeddingProvider(input.provider, DEFAULT_MEMMY_CONFIG.embedding.provider),
    endpoint: optionalString(input.endpoint),
    model: optionalString(input.model) ?? DEFAULT_MEMMY_CONFIG.embedding.model,
    apiKey: optionalString(input.apiKey),
    batchSize: numberValue(input.batchSize, DEFAULT_MEMMY_CONFIG.embedding.batchSize),
    timeoutMs: numberValue(input.timeoutMs, DEFAULT_MEMMY_CONFIG.embedding.timeoutMs),
    maxRetries: numberValue(input.maxRetries, DEFAULT_MEMMY_CONFIG.embedding.maxRetries),
    cache: booleanValue(input.cache, DEFAULT_MEMMY_CONFIG.embedding.cache),
    normalize: booleanValue(input.normalize, DEFAULT_MEMMY_CONFIG.embedding.normalize)
  };
}

function normalizeAlgorithm(input: Record<string, unknown>): AlgorithmConfig {
  const capture = asRecord(input.capture);
  const reward = asRecord(input.reward);
  const feedback = asRecord(input.feedback);
  const l2 = asRecord(input.l2Induction);
  const l3 = asRecord(input.l3Abstraction);
  const skill = asRecord(input.skill);
  const session = asRecord(input.session);
  const retrieval = asRecord(input.retrieval);
  return {
    enableMemoryAdd: booleanValue(input.enableMemoryAdd, DEFAULT_MEMMY_CONFIG.algorithm.enableMemoryAdd),
    enableMemorySearch: booleanValue(input.enableMemorySearch, DEFAULT_MEMMY_CONFIG.algorithm.enableMemorySearch),
    enableQueryRewrite: booleanValue(input.enableQueryRewrite, DEFAULT_MEMMY_CONFIG.algorithm.enableQueryRewrite),
    capture: {
      maxTextChars: numberValue(capture.maxTextChars, DEFAULT_MEMMY_CONFIG.algorithm.capture.maxTextChars),
      maxToolOutputChars: numberValue(capture.maxToolOutputChars, DEFAULT_MEMMY_CONFIG.algorithm.capture.maxToolOutputChars),
      synthReflection: booleanValue(capture.synthReflection, DEFAULT_MEMMY_CONFIG.algorithm.capture.synthReflection),
      embedAfterCapture: booleanValue(capture.embedAfterCapture, DEFAULT_MEMMY_CONFIG.algorithm.capture.embedAfterCapture),
      alphaScoring: booleanValue(capture.alphaScoring, DEFAULT_MEMMY_CONFIG.algorithm.capture.alphaScoring),
      batchMode: captureBatchMode(capture.batchMode, DEFAULT_MEMMY_CONFIG.algorithm.capture.batchMode),
      batchThreshold: numberValue(capture.batchThreshold, DEFAULT_MEMMY_CONFIG.algorithm.capture.batchThreshold),
      reflectionContextMode: reflectionContextMode(capture.reflectionContextMode, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionContextMode),
      longEpisodeReflectMode: longEpisodeReflectMode(capture.longEpisodeReflectMode, DEFAULT_MEMMY_CONFIG.algorithm.capture.longEpisodeReflectMode),
      downstreamStepCount: numberValue(capture.downstreamStepCount, DEFAULT_MEMMY_CONFIG.algorithm.capture.downstreamStepCount),
      taskContextMaxChars: numberValue(capture.taskContextMaxChars, DEFAULT_MEMMY_CONFIG.algorithm.capture.taskContextMaxChars),
      downstreamContextMaxChars: numberValue(capture.downstreamContextMaxChars, DEFAULT_MEMMY_CONFIG.algorithm.capture.downstreamContextMaxChars),
      downstreamPerStepMaxChars: numberValue(capture.downstreamPerStepMaxChars, DEFAULT_MEMMY_CONFIG.algorithm.capture.downstreamPerStepMaxChars),
      synthOutcomeMaxChars: numberValue(capture.synthOutcomeMaxChars, DEFAULT_MEMMY_CONFIG.algorithm.capture.synthOutcomeMaxChars),
      reflectionBatchWindowSize: numberValue(capture.reflectionBatchWindowSize, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionBatchWindowSize),
      reflectionBatchOverlap: numberValue(capture.reflectionBatchOverlap, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionBatchOverlap),
      reflectionBatchDegradedWindowSize: numberValue(capture.reflectionBatchDegradedWindowSize, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionBatchDegradedWindowSize),
      reflectionBatchDegradedOverlap: numberValue(capture.reflectionBatchDegradedOverlap, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionBatchDegradedOverlap),
      reflectionBatchPrimaryMaxRetries: numberValue(capture.reflectionBatchPrimaryMaxRetries, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionBatchPrimaryMaxRetries),
      reflectionBatchDegradedMaxRetries: numberValue(capture.reflectionBatchDegradedMaxRetries, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionBatchDegradedMaxRetries),
      reflectionBatchStepStateChars: numberValue(capture.reflectionBatchStepStateChars, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionBatchStepStateChars),
      reflectionBatchStepThinkingChars: numberValue(capture.reflectionBatchStepThinkingChars, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionBatchStepThinkingChars),
      reflectionBatchStepActionChars: numberValue(capture.reflectionBatchStepActionChars, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionBatchStepActionChars),
      reflectionBatchToolInputChars: numberValue(capture.reflectionBatchToolInputChars, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionBatchToolInputChars),
      reflectionBatchToolOutputChars: numberValue(capture.reflectionBatchToolOutputChars, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionBatchToolOutputChars),
      reflectionBatchToolErrorChars: numberValue(capture.reflectionBatchToolErrorChars, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionBatchToolErrorChars),
      reflectionBatchOutcomeChars: numberValue(capture.reflectionBatchOutcomeChars, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionBatchOutcomeChars),
      reflectionBatchReflectionChars: numberValue(capture.reflectionBatchReflectionChars, DEFAULT_MEMMY_CONFIG.algorithm.capture.reflectionBatchReflectionChars)
    },
    reward: {
      llmScoring: booleanValue(reward.llmScoring, DEFAULT_MEMMY_CONFIG.algorithm.reward.llmScoring),
      gamma: numberValue(reward.gamma, DEFAULT_MEMMY_CONFIG.algorithm.reward.gamma),
      lambda: numberValue(reward.lambda, DEFAULT_MEMMY_CONFIG.algorithm.reward.lambda),
      delta: numberValue(reward.delta, DEFAULT_MEMMY_CONFIG.algorithm.reward.delta),
      tauSoftmax: numberValue(reward.tauSoftmax, DEFAULT_MEMMY_CONFIG.algorithm.reward.tauSoftmax),
      decayHalfLifeDays: numberValue(reward.decayHalfLifeDays, DEFAULT_MEMMY_CONFIG.algorithm.reward.decayHalfLifeDays),
      implicitThreshold: numberValue(reward.implicitThreshold, DEFAULT_MEMMY_CONFIG.algorithm.reward.implicitThreshold),
      feedbackWindowSec: numberValue(reward.feedbackWindowSec, DEFAULT_MEMMY_CONFIG.algorithm.reward.feedbackWindowSec),
      summaryMaxChars: numberValue(reward.summaryMaxChars, DEFAULT_MEMMY_CONFIG.algorithm.reward.summaryMaxChars),
      llmConcurrency: numberValue(reward.llmConcurrency, DEFAULT_MEMMY_CONFIG.algorithm.reward.llmConcurrency),
      minExchangesForCompletion: numberValue(
        reward.minExchangesForCompletion,
        DEFAULT_MEMMY_CONFIG.algorithm.reward.minExchangesForCompletion
      ),
      minContentCharsForCompletion: numberValue(
        reward.minContentCharsForCompletion,
        DEFAULT_MEMMY_CONFIG.algorithm.reward.minContentCharsForCompletion
      ),
      toolHeavyRatio: numberValue(reward.toolHeavyRatio, DEFAULT_MEMMY_CONFIG.algorithm.reward.toolHeavyRatio),
      minAssistantCharsForToolHeavy: numberValue(
        reward.minAssistantCharsForToolHeavy,
        DEFAULT_MEMMY_CONFIG.algorithm.reward.minAssistantCharsForToolHeavy
      )
    },
    feedback: {
      failureThreshold: numberValue(feedback.failureThreshold, DEFAULT_MEMMY_CONFIG.algorithm.feedback.failureThreshold),
      failureWindow: numberValue(feedback.failureWindow, DEFAULT_MEMMY_CONFIG.algorithm.feedback.failureWindow),
      valueDelta: numberValue(feedback.valueDelta, DEFAULT_MEMMY_CONFIG.algorithm.feedback.valueDelta),
      minLowValueThreshold: numberValue(feedback.minLowValueThreshold, DEFAULT_MEMMY_CONFIG.algorithm.feedback.minLowValueThreshold),
      useLlm: booleanValue(feedback.useLlm, DEFAULT_MEMMY_CONFIG.algorithm.feedback.useLlm),
      attachToPolicy: booleanValue(feedback.attachToPolicy, DEFAULT_MEMMY_CONFIG.algorithm.feedback.attachToPolicy),
      cooldownMs: numberValue(feedback.cooldownMs, DEFAULT_MEMMY_CONFIG.algorithm.feedback.cooldownMs),
      traceCharCap: numberValue(feedback.traceCharCap, DEFAULT_MEMMY_CONFIG.algorithm.feedback.traceCharCap),
      evidenceLimit: numberValue(feedback.evidenceLimit, DEFAULT_MEMMY_CONFIG.algorithm.feedback.evidenceLimit)
    },
    l2Induction: {
      useLlm: booleanValue(l2.useLlm, DEFAULT_MEMMY_CONFIG.algorithm.l2Induction.useLlm),
      minEpisodesForInduction: numberValue(l2.minEpisodesForInduction, DEFAULT_MEMMY_CONFIG.algorithm.l2Induction.minEpisodesForInduction),
      minSimilarity: numberValue(l2.minSimilarity, DEFAULT_MEMMY_CONFIG.algorithm.l2Induction.minSimilarity),
      candidateTtlDays: numberValue(l2.candidateTtlDays, DEFAULT_MEMMY_CONFIG.algorithm.l2Induction.candidateTtlDays),
      minTraceValue: numberValue(l2.minTraceValue, DEFAULT_MEMMY_CONFIG.algorithm.l2Induction.minTraceValue),
      minGain: numberValue(l2.minGain, DEFAULT_MEMMY_CONFIG.algorithm.l2Induction.minGain),
      archiveGain: numberValue(l2.archiveGain, DEFAULT_MEMMY_CONFIG.algorithm.l2Induction.archiveGain),
      traceCharCap: numberValue(l2.traceCharCap, DEFAULT_MEMMY_CONFIG.algorithm.l2Induction.traceCharCap),
      tauSoftmax: numberValue(l2.tauSoftmax, DEFAULT_MEMMY_CONFIG.algorithm.l2Induction.tauSoftmax),
      gainEmaAlpha: numberValue(l2.gainEmaAlpha, DEFAULT_MEMMY_CONFIG.algorithm.l2Induction.gainEmaAlpha)
    },
    l3Abstraction: {
      useLlm: booleanValue(l3.useLlm, DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction.useLlm),
      minPolicies: numberValue(l3.minPolicies, DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction.minPolicies),
      minPolicyGain: numberValue(l3.minPolicyGain, DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction.minPolicyGain),
      minPolicySupport: numberValue(l3.minPolicySupport, DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction.minPolicySupport),
      clusterMinSimilarity: numberValue(l3.clusterMinSimilarity, DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction.clusterMinSimilarity),
      policyCharCap: numberValue(l3.policyCharCap, DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction.policyCharCap),
      traceCharCap: numberValue(l3.traceCharCap, DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction.traceCharCap),
      traceEvidencePerPolicy: numberValue(l3.traceEvidencePerPolicy, DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction.traceEvidencePerPolicy),
      cooldownDays: numberValue(l3.cooldownDays, DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction.cooldownDays),
      confidenceDelta: numberValue(l3.confidenceDelta, DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction.confidenceDelta),
      minConfidenceForRetrieval: numberValue(l3.minConfidenceForRetrieval, DEFAULT_MEMMY_CONFIG.algorithm.l3Abstraction.minConfidenceForRetrieval)
    },
    skill: {
      useLlm: booleanValue(skill.useLlm, DEFAULT_MEMMY_CONFIG.algorithm.skill.useLlm),
      minEtaForRetrieval: numberValue(skill.minEtaForRetrieval, DEFAULT_MEMMY_CONFIG.algorithm.skill.minEtaForRetrieval),
      minSupport: numberValue(skill.minSupport, DEFAULT_MEMMY_CONFIG.algorithm.skill.minSupport),
      minGain: numberValue(skill.minGain, DEFAULT_MEMMY_CONFIG.algorithm.skill.minGain),
      candidateTrials: numberValue(skill.candidateTrials, DEFAULT_MEMMY_CONFIG.algorithm.skill.candidateTrials),
      cooldownMs: numberValue(skill.cooldownMs, DEFAULT_MEMMY_CONFIG.algorithm.skill.cooldownMs),
      traceCharCap: numberValue(skill.traceCharCap, DEFAULT_MEMMY_CONFIG.algorithm.skill.traceCharCap),
      evidenceLimit: numberValue(skill.evidenceLimit, DEFAULT_MEMMY_CONFIG.algorithm.skill.evidenceLimit),
      etaDelta: numberValue(skill.etaDelta, DEFAULT_MEMMY_CONFIG.algorithm.skill.etaDelta),
      archiveEta: numberValue(skill.archiveEta, DEFAULT_MEMMY_CONFIG.algorithm.skill.archiveEta),
      repairCandidateMinEta: numberValue(skill.repairCandidateMinEta, DEFAULT_MEMMY_CONFIG.algorithm.skill.repairCandidateMinEta),
      outputLanguageMode: skillOutputLanguageMode(skill.outputLanguageMode, DEFAULT_MEMMY_CONFIG.algorithm.skill.outputLanguageMode),
      outcomeRTaskSuccessThreshold: numberValue(skill.outcomeRTaskSuccessThreshold, DEFAULT_MEMMY_CONFIG.algorithm.skill.outcomeRTaskSuccessThreshold),
      outcomeRTaskFailureThreshold: numberValue(skill.outcomeRTaskFailureThreshold, DEFAULT_MEMMY_CONFIG.algorithm.skill.outcomeRTaskFailureThreshold),
      failureEpisodeScorePenalty: numberValue(skill.failureEpisodeScorePenalty, DEFAULT_MEMMY_CONFIG.algorithm.skill.failureEpisodeScorePenalty),
      failureEpisodeMaxRatio: numberValue(skill.failureEpisodeMaxRatio, DEFAULT_MEMMY_CONFIG.algorithm.skill.failureEpisodeMaxRatio)
    },
    session: {
      followUpMode: "merge_follow_ups",
      mergeMaxGapMs: numberValue(session.mergeMaxGapMs, DEFAULT_MEMMY_CONFIG.algorithm.session.mergeMaxGapMs)
    },
    retrieval: {
      tier1TopK: numberValue(retrieval.tier1TopK, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.tier1TopK),
      tier2TopK: numberValue(retrieval.tier2TopK, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.tier2TopK),
      tier3TopK: numberValue(retrieval.tier3TopK, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.tier3TopK),
      candidatePoolFactor: numberValue(retrieval.candidatePoolFactor, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.candidatePoolFactor),
      weightCosine: numberValue(retrieval.weightCosine, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.weightCosine),
      weightPriority: numberValue(retrieval.weightPriority, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.weightPriority),
      mmrLambda: numberValue(retrieval.mmrLambda, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.mmrLambda),
      rrfConstant: numberValue(retrieval.rrfConstant, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.rrfConstant),
      relativeThresholdFloor: numberValue(retrieval.relativeThresholdFloor, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.relativeThresholdFloor),
      minSkillEta: numberValue(retrieval.minSkillEta, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.minSkillEta),
      minTraceSim: numberValue(retrieval.minTraceSim, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.minTraceSim),
      episodeGoalMinSim: numberValue(retrieval.episodeGoalMinSim, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.episodeGoalMinSim),
      includeLowValue: booleanValue(retrieval.includeLowValue, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.includeLowValue),
      tagFilter: retrievalTagFilter(retrieval.tagFilter, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.tagFilter),
      keywordTopK: numberValue(retrieval.keywordTopK, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.keywordTopK),
      skillEtaBlend: numberValue(retrieval.skillEtaBlend, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.skillEtaBlend),
      smartSeed: booleanValue(retrieval.smartSeed, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.smartSeed),
      smartSeedRatio: numberValue(retrieval.smartSeedRatio, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.smartSeedRatio),
      multiChannelBypass: booleanValue(retrieval.multiChannelBypass, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.multiChannelBypass),
      skillInjectionMode: skillInjectionMode(retrieval.skillInjectionMode, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.skillInjectionMode),
      skillSummaryChars: numberValue(retrieval.skillSummaryChars, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.skillSummaryChars),
      llmFilterEnabled: booleanValue(retrieval.llmFilterEnabled, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.llmFilterEnabled),
      llmFilterMaxKeep: numberValue(retrieval.llmFilterMaxKeep, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.llmFilterMaxKeep),
      llmFilterFallbackMaxKeep: numberValue(retrieval.llmFilterFallbackMaxKeep, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.llmFilterFallbackMaxKeep),
      llmFilterMinCandidates: numberValue(retrieval.llmFilterMinCandidates, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.llmFilterMinCandidates),
      llmFilterCandidateBodyChars: numberValue(retrieval.llmFilterCandidateBodyChars, DEFAULT_MEMMY_CONFIG.algorithm.retrieval.llmFilterCandidateBodyChars),
      readOnlyInjectionProfile: readOnlyInjectionProfile(
        retrieval.readOnlyInjectionProfile,
        DEFAULT_MEMMY_CONFIG.algorithm.retrieval.readOnlyInjectionProfile
      )
    }
  };
}

function memoryDomainName(value: unknown, fallback: MemoryDomainName): MemoryDomainName {
  const domain = optionalString(value);
  if (domain === "" || domain === "research") return domain;
  return fallback;
}

function readOnlyInjectionProfile(
  value: unknown,
  fallback: ReadOnlyInjectionProfile
): ReadOnlyInjectionProfile {
  const profile = optionalString(value);
  if (
    profile === "all" ||
    profile === "experience" ||
    profile === "skill" ||
    profile === "skill_experience"
  ) {
    return profile;
  }
  return fallback;
}

function skillOutputLanguageMode(value: unknown, fallback: "follow_policy" | "zh" | "en"): "follow_policy" | "zh" | "en" {
  const mode = optionalString(value);
  if (mode === "follow_policy" || mode === "zh" || mode === "en") return mode;
  return fallback;
}

function retrievalTagFilter(value: unknown, fallback: "auto" | "on" | "off"): "auto" | "on" | "off" {
  const mode = optionalString(value);
  if (mode === "auto" || mode === "on" || mode === "off") return mode;
  return fallback;
}

function skillInjectionMode(value: unknown, fallback: "summary" | "full"): "summary" | "full" {
  const mode = optionalString(value);
  if (mode === "summary" || mode === "full") return mode;
  return fallback;
}

function llmProvider(value: unknown, fallback: LlmProviderName): LlmProviderName {
  const provider = optionalString(value) as LlmProviderName | undefined;
  if (
    provider === "" ||
    provider === "local_only" ||
    provider === "openai_compatible" ||
    provider === "gemini" ||
    provider === "anthropic" ||
    provider === "bedrock" ||
    provider === "host"
  ) {
    return provider;
  }
  return fallback;
}

function llmVendor(value: unknown, fallback: LlmVendorName): LlmVendorName {
  const vendor = optionalString(value) as LlmVendorName | undefined;
  if (
    vendor === "" ||
    vendor === "openai_compatible" ||
    vendor === "anthropic" ||
    vendor === "google" ||
    vendor === "deepseek" ||
    vendor === "zhipu" ||
    vendor === "qwen" ||
    vendor === "kimi" ||
    vendor === "minimax" ||
    vendor === "baidu" ||
    vendor === "doubao"
  ) {
    return vendor;
  }
  return fallback;
}

function embeddingProvider(value: unknown, fallback: EmbeddingProviderName): EmbeddingProviderName {
  const provider = optionalString(value) as EmbeddingProviderName | undefined;
  if (
    provider === "local" ||
    provider === "openai_compatible" ||
    provider === "gemini" ||
    provider === "cohere" ||
    provider === "voyage" ||
    provider === "mistral"
  ) {
    return provider;
  }
  return fallback;
}

function storageMode(value: unknown, fallback: StorageModeName): StorageModeName {
  const mode = optionalString(value) as StorageModeName | undefined;
  if (mode === "local" || mode === "cloud" || mode === "dev") {
    return mode;
  }
  return fallback;
}

function memoryProfileName(value: unknown, fallback: MemoryProfileName): MemoryProfileName {
  return optionalMemoryProfileName(value) ?? fallback;
}

function optionalMemoryProfileName(value: unknown): MemoryProfileName | undefined {
  const profile = optionalString(value);
  if (profile === "account" || profile === "byok") {
    return profile;
  }
  return undefined;
}

function storageBackend(value: unknown, fallback: StorageBackendName): StorageBackendName {
  const backend = optionalString(value) as StorageBackendName | undefined;
  if (backend === "sqlite" || backend === "openmem-cloud-rest") {
    return backend;
  }
  return fallback;
}

function captureBatchMode(value: unknown, fallback: CaptureBatchMode): CaptureBatchMode {
  const mode = optionalString(value) as CaptureBatchMode | undefined;
  if (mode === "windowed") {
    return mode;
  }
  return fallback;
}

function reflectionContextMode(value: unknown, fallback: ReflectionContextMode): ReflectionContextMode {
  const mode = optionalString(value) as ReflectionContextMode | undefined;
  if (mode === "none" || mode === "task" || mode === "downstream" || mode === "task_downstream") {
    return mode;
  }
  return fallback;
}

function longEpisodeReflectMode(value: unknown, fallback: LongEpisodeReflectMode): LongEpisodeReflectMode {
  const mode = optionalString(value) as LongEpisodeReflectMode | undefined;
  if (mode === "per_step_parallel" || mode === "per_step_downstream") {
    return mode;
  }
  return fallback;
}

function deepMerge(...values: Array<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const value of values) {
    for (const [key, next] of Object.entries(value)) {
      const current = out[key];
      out[key] = isRecord(current) && isRecord(next)
        ? deepMerge(current, next)
        : next;
    }
  }
  return out;
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) =>
      value !== undefined &&
      (!isRecord(value) || Object.keys(value).length > 0)
    )
  );
}

function omitKeys(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const remove = new Set(keys);
  return Object.fromEntries(Object.entries(input).filter(([key]) => !remove.has(key)));
}

function numberEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanEnv(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? expandEnvString(value) : undefined;
}

function optionalPathString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const expanded = expandEnvString(value);
  return expanded === "~" || expanded.startsWith("~/")
    ? join(homedir(), expanded.slice(2))
    : expanded;
}

function expandEnvString(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
