import { basename } from "node:path";
import { homedir, userInfo } from "node:os";
import {
  OnboardingInsightReportResponseSchema,
  type OnboardingInsightReportInput,
  type OnboardingInsightReportResponse,
  type OnboardingInsightReportStreamEvent
} from "@memmy/local-api-contracts";
import type {
  OnboardingConversationReference,
  OnboardingConversationWindow,
  OnboardingConversationWindowReader,
  OnboardingInsightSampler,
  OnboardingSampleResult,
  OnboardingSampledQuery
} from "../adapters/outbound/agent-source/insight-sampler-types.js";
import { stripInlineMediaPayloads } from "../shared/inline-media-sanitizer.js";
import type { OnboardingFirstReportMemoryWriter } from "./onboarding-first-report-memory-writer.js";
import type { OnboardingTaskContextSummary, OnboardingTaskStatus } from "./onboarding-task-context.js";

const DEFAULT_SAMPLE_OPTIONS = {
  maxSessionFiles: 6,
  maxQueries: 12,
  maxQueryChars: 600,
  maxBytesPerFile: 768 * 1024,
  deadlineMs: 3_000
} as const;

const FIRST_LOGIN_SCAN_DEADLINE_MS = DEFAULT_SAMPLE_OPTIONS.deadlineMs;
const MAX_REPORT_QUERY_CHARS = DEFAULT_SAMPLE_OPTIONS.maxQueryChars;
const MAX_BALANCED_QUERIES = 84;
const MAX_PREFERENCE_LLM_QUERIES = 24;
const DEFAULT_LLM_TIMEOUT_MS = 90_000;
const DEFAULT_LLM_MAX_TOKENS = 2_000;
const MAX_GENERATED_OUTPUT_CHARS = 12_000;
const GENERATED_REPORT_OPEN = "<memmy_report>";
const GENERATED_REPORT_CLOSE = "</memmy_report>";
const GENERATED_TASK_CONTEXT_OPEN = "<memmy_task_context>";
const GENERATED_TASK_CONTEXT_CLOSE = "</memmy_task_context>";
const GENERATED_REPORT_ALIAS_OPEN = "<report>";
const GENERATED_REPORT_ALIAS_CLOSE = "</report>";
const GENERATED_TASK_CONTEXT_ALIAS_OPEN = "<taskContext>";
const GENERATED_TASK_CONTEXT_ALIAS_CLOSE = "</taskContext>";
const GENERATED_REPORT_OPEN_MARKERS = [GENERATED_REPORT_OPEN, GENERATED_REPORT_ALIAS_OPEN] as const;
const GENERATED_REPORT_CLOSE_MARKERS = [GENERATED_REPORT_CLOSE, GENERATED_REPORT_ALIAS_CLOSE] as const;
const GENERATED_NAKED_JSON_OPEN = "\n{";
const GENERATED_JSON_FENCE_OPEN = "\n```json";

const TOPIC_PATTERNS: ReadonlyArray<{ keyword: string; pattern: RegExp }> = [
  { keyword: "TypeScript", pattern: /\btypescript\b|\bts\b/i },
  { keyword: "React", pattern: /\breact\b/i },
  { keyword: "Tauri", pattern: /\btauri\b/i },
  { keyword: "pnpm", pattern: /\bpnpm\b/i },
  { keyword: "monorepo", pattern: /\bmonorepo\b|workspace/i },
  { keyword: "SQLite", pattern: /\bsqlite\b/i },
  { keyword: "Memory", pattern: /\bmemory\b|记忆|记忆底座/i },
  { keyword: "Agent", pattern: /\bagent\b|智能体/i },
  { keyword: "onboarding", pattern: /\bonboarding\b|首次登录|首次登陆|引导/i },
  { keyword: "scan", pattern: /\bscan\b|扫描/i },
  { keyword: "token", pattern: /\btoken\b/i },
  { keyword: "build", pattern: /\bbuild\b|构建|编译/i },
  { keyword: "test", pattern: /\btest\b|测试/i },
  { keyword: "Claude Code", pattern: /\bclaude code\b/i },
  { keyword: "Cursor", pattern: /\bcursor\b/i },
  { keyword: "Codex", pattern: /\bcodex\b/i }
];

const PROBLEM_PATTERN = /\berror\b|\bfail(?:ed|ing)?\b|\bbug\b|\bfix\b|报错|失败|修复|问题|构建|编译/i;
const DECISION_PATTERN = /方案|设计|取舍|决策|PRD|\bplan\b|\bdesign\b|\bdecision\b/i;
const ACTION_PATTERN = /实现|修改|重启|测试|验证|push|排查|检查|补充|更新|落地|继续|接续|整理|整合|rewrite|refactor|verify|restart/i;
const HIGH_SIGNAL_PATTERN = /不要|不能|必须|应该|先|后续|可落地|细节|完整|快速|轻量|token|耗时|并行|水位|清除|假数据|隐私|权限|重启|测试|验证|push|don't|must|should|first|fast|lightweight/i;
const LOW_VALUE_TASK_PATTERN = /\/tmp\/|memos_missing_demo|请先尝试读取|失败后不要放弃|read\s+\/tmp|smoke|fixture|mock/i;
const GENERIC_ACCOUNT_NAMES = [
  "admin",
  "administrator",
  "root",
  "ubuntu",
  "user",
  "test",
  "guest",
  "default",
  "runner",
  "ec2-user"
] as const;

const USER_INSIGHT_RULES: ReadonlyArray<{
  key: string;
  zh: string;
  en: string;
  pattern: RegExp;
}> = [
  {
    key: "plan_before_code",
    zh: "你倾向先把方案、边界和实现细节确认清楚，再进入代码修改。",
    en: "You tend to settle the plan, boundaries, and implementation details before code changes.",
    pattern: /先讨论|不修改代码|完整.?plan|方案|实现的细节|可落地|plan|design/i
  },
  {
    key: "token_and_latency",
    zh: "你很在意扫描和模型链路要轻量、快速，不能为了首登体验过度消耗 token。",
    en: "You care about keeping scanning and model calls lightweight and fast instead of spending excessive tokens.",
    pattern: /快速|轻量|token|耗时|几万|十万|并行|首字|流式|latency|stream/i
  },
  {
    key: "local_data_correctness",
    zh: "你会追本地数据边界，例如清除本地数据时水位、假数据和真实模式必须一致。",
    en: "You pay attention to local data boundaries, including watermarks, fake data, and real-mode behavior.",
    pattern: /本地数据|水位|清除|假记忆|假数据|真实模式|权限|隐私|local data|watermark/i
  },
  {
    key: "engineering_closure",
    zh: "你做工程闭环很强，通常会要求实现、重启、验证、排错，最后再 push 到目标分支。",
    en: "You push for engineering closure: implement, restart, verify, debug, and then push to the target branch.",
    pattern: /实现|重启|测试|验证|报错|检查|push|分支|restart|verify|test/i
  },
  {
    key: "cross_agent_context",
    zh: "你希望不同 Agent 里的讨论能被自动整合，而不是每次重新解释上下文。",
    en: "You want discussions across agents to be merged automatically instead of restating context.",
    pattern: /跨.?Agent|整合|接续|继续|上下文|任务|agent/i
  }
];

export interface CreateOnboardingInsightServiceOptions {
  samplers: readonly OnboardingInsightSampler[];
  conversationWindowReader?: OnboardingConversationWindowReader | null;
  reportGenerator?: OnboardingInsightReportGenerator | null;
  memoryWriter?: OnboardingFirstReportMemoryWriter | null;
  agentModelResolver?: OnboardingInsightAgentTaskModelResolver | null;
  now?: () => number;
}

export interface OnboardingInsightService {
  generateReport(input?: OnboardingInsightReportInput, signal?: AbortSignal): Promise<OnboardingInsightReportResponse>;
  streamReport(input?: OnboardingInsightReportInput, signal?: AbortSignal): AsyncIterable<OnboardingInsightReportStreamEvent>;
}

export interface OnboardingInsightReportGenerator {
  generateReport(input: OnboardingInsightGenerationInput): Promise<string | null>;
  streamReport?(input: OnboardingInsightGenerationInput): AsyncIterable<string>;
}

export interface OnboardingInsightGenerationInput {
  locale: "zh-CN" | "en-US";
  profile: OnboardingInsightProfileSignals;
  sample: OnboardingInsightSampleSummary;
  signal?: AbortSignal;
}

interface GeneratedFirstReport {
  reportMarkdown: string;
  taskContext: OnboardingTaskContextSummary;
}

export interface OnboardingInsightSampleSummary {
  discoveredAgentCount: number;
  sampledQueryCount: number;
  activeAgents: Array<{ sourceId: string; displayName: string; queryCount: number; latestActivityAt: string | null }>;
  queries: Array<{
    agentSource: string;
    createdAt: string;
    workspacePath: string | null;
    text: string;
  }>;
  latestConversation: {
    agentSource: string;
    conversationId: string;
    latestActivityAt: string;
    workspacePath: string | null;
    messages: Array<{
      role: "user" | "assistant" | "tool";
      createdAt: string;
      text: string;
    }>;
  } | null;
}

export interface OnboardingInsightProfileSignals {
  nameHints: NameHints;
  preferredResponseLanguage: "zh-CN" | "en-US" | null;
  activeAgentNames: string[];
  topAgents: Array<{ sourceId: string; displayName: string; queryCount: number; latestActivityAt: string | null }>;
  topKeywords: string[];
  topProjects: string[];
  userInsights: UserInsight[];
  taskCandidates: TaskCandidate[];
  highSignalQueries: OnboardingSampledQuery[];
  taskLikeQuery: OnboardingSampledQuery | null;
}

interface SampleBundle {
  discovered: OnboardingSampleResult[];
  queries: OnboardingSampledQuery[];
  latestConversation: OnboardingConversationWindow | null;
  elapsedMs: number;
}

export interface NameHints {
  selfDeclaredNames: string[];
  homePathName: string | null;
  computerUserName: string | null;
  homeAndComputerMatch: boolean;
  genericAccountNames: string[];
}

interface NameSignal {
  value: string;
  source: string;
  kind: "self_declared" | "local_account";
}

export interface UserInsight {
  key: string;
  textZh: string;
  textEn: string;
  evidenceCount: number;
}

export interface TaskCandidate {
  title: string;
  summary: string;
  project: string | null;
  relatedAgents: string[];
  latestQuery: OnboardingSampledQuery;
  score: number;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OpenAiCompatibleOnboardingInsightGeneratorOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName?: string;
  apiType?: "auto" | "chatCompletions" | "responses";
  extraHeaders?: Readonly<Record<string, string>>;
  extraBody?: Readonly<Record<string, unknown>>;
  timeoutMs?: number;
  maxTokens?: number;
  fetch?: FetchLike;
}

export interface OnboardingInsightAgentTaskModelConfig {
  providerName: string;
  model: string;
  apiBase: string;
  apiKey: string;
  apiType?: "auto" | "chatCompletions" | "responses";
  extraHeaders?: Readonly<Record<string, string>>;
  extraBody?: Readonly<Record<string, unknown>>;
}

export interface OnboardingInsightAgentTaskModelResolver {
  getAgentTaskModel(): OnboardingInsightAgentTaskModelConfig | null | Promise<OnboardingInsightAgentTaskModelConfig | null>;
}

export interface AgentTaskModelOnboardingInsightGeneratorOptions {
  resolver?: OnboardingInsightAgentTaskModelResolver | null;
  timeoutMs?: number;
  maxTokens?: number;
  fetch?: FetchLike;
}

export function createOnboardingInsightService(options: CreateOnboardingInsightServiceOptions): OnboardingInsightService {
  const now = options.now ?? Date.now;
  const reportGenerator = options.reportGenerator === undefined
    ? createAgentTaskModelOnboardingInsightReportGenerator({
        resolver: options.agentModelResolver
      })
    : options.reportGenerator;

  return {
    async generateReport(input = {}, signal) {
      const startedAt = now();
      const sample = mergeDetectedAgents(
        await sampleRecentQueries(options.samplers, options.conversationWindowReader, signal, now),
        input.detectedAgents
      );
      const profile = buildProfileSignals(sample);
      const locale = profile.preferredResponseLanguage ?? input.locale ?? inferLocale(sample.queries);
      const response = await buildReportResponse({
        profile,
        sample,
        locale,
        reportGenerator,
        memoryWriter: options.memoryWriter,
        signal,
        startedAt,
        now
      });
      return OnboardingInsightReportResponseSchema.parse(response);
    },
    async *streamReport(input = {}, signal) {
      const startedAt = now();
      const sample = mergeDetectedAgents(
        await sampleRecentQueries(options.samplers, options.conversationWindowReader, signal, now),
        input.detectedAgents
      );
      const profile = buildProfileSignals(sample);
      const locale = profile.preferredResponseLanguage ?? input.locale ?? inferLocale(sample.queries);
      yield {
        type: "sampled",
        diagnostics: diagnostics(sample, false, Math.max(0, now() - startedAt), locale)
      };
      const elapsedMs = Math.max(0, now() - startedAt);
      yield* streamReportResponse({
        profile,
        sample,
        locale,
        elapsedMs,
        reportGenerator,
        memoryWriter: options.memoryWriter,
        signal,
        startedAt,
        now
      });
    }
  };
}

export function createAgentTaskModelOnboardingInsightReportGenerator(
  options: AgentTaskModelOnboardingInsightGeneratorOptions = {}
): OnboardingInsightReportGenerator {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function resolveGenerator(): Promise<OnboardingInsightReportGenerator | null> {
    const config = await options.resolver?.getAgentTaskModel();
    return config ? createAgentTaskRuntimeGenerator(config, {
      fetch: fetchImpl,
      timeoutMs: options.timeoutMs,
      maxTokens: options.maxTokens
    }) : null;
  }

  return {
    async generateReport(input) {
      return await (await resolveGenerator())?.generateReport(input) ?? null;
    },
    async *streamReport(input) {
      const generator = await resolveGenerator();
      if (!generator?.streamReport) {
        return;
      }
      yield* generator.streamReport(input);
    }
  };
}

function createAgentTaskRuntimeGenerator(
  config: OnboardingInsightAgentTaskModelConfig,
  options: Pick<OpenAiCompatibleOnboardingInsightGeneratorOptions, "fetch" | "timeoutMs" | "maxTokens">
): OnboardingInsightReportGenerator {
  const base = {
    providerName: config.providerName,
    baseUrl: config.apiBase,
    apiKey: config.apiKey,
    model: config.model,
    extraHeaders: config.extraHeaders,
    extraBody: config.extraBody,
    timeoutMs: options.timeoutMs,
    maxTokens: options.maxTokens,
    fetch: options.fetch
  };

  if (config.providerName === "anthropic") {
    return createAnthropicOnboardingInsightReportGenerator(base);
  }

  if (config.providerName === "gemini") {
    return createGoogleOnboardingInsightReportGenerator(base);
  }

  return createOpenAiCompatibleOnboardingInsightReportGenerator({
    ...base,
    apiType: config.apiType
  });
}

export function createOpenAiCompatibleOnboardingInsightReportGenerator(
  options: OpenAiCompatibleOnboardingInsightGeneratorOptions
): OnboardingInsightReportGenerator {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_LLM_MAX_TOKENS;
  const useResponsesApi = options.apiType === "responses";

  return {
    async generateReport(input) {
      try {
        const response = await fetchImpl(useResponsesApi ? responsesUrl(options.baseUrl) : chatCompletionsUrl(options.baseUrl), {
          method: "POST",
          headers: {
            "authorization": `Bearer ${options.apiKey}`,
            "content-type": "application/json",
            ...(options.extraHeaders ?? {})
          },
          body: JSON.stringify(withExtraBody(useResponsesApi ? buildResponsesRequestBody(input, options, maxTokens, false) : {
            model: options.model,
            messages: buildLlmMessages(input),
            ...openAiCompatibleTemperatureFields(options, 0.2),
            max_tokens: maxTokens,
            stream: false,
            ...openAiCompatibleThinkingControlFields(options)
          }, options.extraBody)),
          signal: timeoutSignal(timeoutMs, input.signal)
        });

        if (!response.ok) {
          return null;
        }

        return extractLlmReport(await response.json());
      } catch {
        return null;
      }
    },
    async *streamReport(input) {
      const response = await fetchImpl(useResponsesApi ? responsesUrl(options.baseUrl) : chatCompletionsUrl(options.baseUrl), {
        method: "POST",
        headers: {
          "authorization": `Bearer ${options.apiKey}`,
          "content-type": "application/json",
          ...(options.extraHeaders ?? {})
        },
        body: JSON.stringify(withExtraBody(useResponsesApi ? buildResponsesRequestBody(input, options, maxTokens, true) : {
          model: options.model,
          messages: buildLlmMessages(input),
          ...openAiCompatibleTemperatureFields(options, 0.2),
          max_tokens: maxTokens,
          stream: true,
          ...openAiCompatibleThinkingControlFields(options)
        }, options.extraBody)),
        signal: timeoutSignal(timeoutMs, input.signal)
      });

      if (!response.ok || !response.body) {
        throw new Error(`onboarding insight stream failed: ${response.status}`);
      }

      yield* parseOpenAiCompatibleStream(response.body);
    }
  };
}

function createAnthropicOnboardingInsightReportGenerator(
  options: OpenAiCompatibleOnboardingInsightGeneratorOptions
): OnboardingInsightReportGenerator {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_LLM_MAX_TOKENS;

  return {
    async generateReport(input) {
      try {
        const response = await fetchImpl(anthropicMessagesUrl(options.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": "2023-06-01",
            ...(options.extraHeaders ?? {})
          },
          body: JSON.stringify(withExtraBody(
            buildAnthropicRequestBody(input, options.model, maxTokens, false),
            options.extraBody
          )),
          signal: timeoutSignal(timeoutMs, input.signal)
        });

        if (!response.ok) {
          return null;
        }

        return extractAnthropicReport(await response.json());
      } catch {
        return null;
      }
    },
    async *streamReport(input) {
      const response = await fetchImpl(anthropicMessagesUrl(options.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
          ...(options.extraHeaders ?? {})
        },
        body: JSON.stringify(withExtraBody(
          buildAnthropicRequestBody(input, options.model, maxTokens, true),
          options.extraBody
        )),
        signal: timeoutSignal(timeoutMs, input.signal)
      });

      if (!response.ok || !response.body) {
        throw new Error(`onboarding insight stream failed: ${response.status}`);
      }

      yield* parseAnthropicStream(response.body);
    }
  };
}

function createGoogleOnboardingInsightReportGenerator(
  options: OpenAiCompatibleOnboardingInsightGeneratorOptions
): OnboardingInsightReportGenerator {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_LLM_MAX_TOKENS;

  return {
    async generateReport(input) {
      try {
        const response = await fetchImpl(googleGenerateContentUrl(options.baseUrl, options.model), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": options.apiKey,
            ...(options.extraHeaders ?? {})
          },
          body: JSON.stringify(withExtraBody(buildGoogleRequestBody(input, maxTokens), options.extraBody)),
          signal: timeoutSignal(timeoutMs, input.signal)
        });

        if (!response.ok) {
          return null;
        }

        return extractGoogleReport(await response.json());
      } catch {
        return null;
      }
    }
  };
}

function withExtraBody(
  body: Record<string, unknown>,
  extraBody: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> {
  return { ...body, ...(extraBody ?? {}) };
}

async function sampleRecentQueries(
  samplers: readonly OnboardingInsightSampler[],
  conversationWindowReader: OnboardingConversationWindowReader | null | undefined,
  signal: AbortSignal | undefined,
  now: () => number
): Promise<SampleBundle> {
  const startedAt = now();
  const deadlineSignal = AbortSignal.timeout(FIRST_LOGIN_SCAN_DEADLINE_MS);
  const sampleSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
  const results = await Promise.all(samplers.map((sampler) => sampleSamplerWithinDeadline(sampler, sampleSignal)));
  const discovered = results.filter((result): result is OnboardingSampleResult => Boolean(result));
  const queries = selectBalancedQueries(discovered, MAX_BALANCED_QUERIES);
  const latestReference = resolveLatestConversationReference(discovered);
  const latestConversation = latestReference
    ? await loadLatestConversation(latestReference, discovered, conversationWindowReader, sampleSignal)
    : null;

  return {
    discovered,
    queries,
    latestConversation,
    elapsedMs: Math.max(0, now() - startedAt)
  };
}

function mergeDetectedAgents(
  sample: SampleBundle,
  detectedAgents: OnboardingInsightReportInput["detectedAgents"]
): SampleBundle {
  if (!detectedAgents?.length) {
    return sample;
  }

  const detectedBySource = new Map(detectedAgents.map((agent) => [agent.sourceId, agent]));
  const discovered = sample.discovered.map((result) => {
    const detected = detectedBySource.get(result.sourceId);
    detectedBySource.delete(result.sourceId);
    return detected
      ? { ...result, recentSessionCount: Math.max(result.recentSessionCount, detected.recentSessionCount) }
      : result;
  });

  for (const detected of detectedBySource.values()) {
    discovered.push({
      sourceId: detected.sourceId,
      displayName: detected.displayName,
      recentSessionCount: detected.recentSessionCount,
      latestActivityAt: null,
      queries: [],
      recentMessages: [],
      errors: []
    });
  }

  return { ...sample, discovered };
}

function resolveLatestConversationReference(
  results: readonly OnboardingSampleResult[]
): OnboardingConversationReference | null {
  const candidates = results.flatMap((result) => {
    const messages = result.recentMessages ?? result.queries.map((query) => ({ ...query, role: "user" as const }));
    return messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ result, message }));
  }).sort((left, right) =>
    Date.parse(right.message.createdAt) - Date.parse(left.message.createdAt) ||
    left.result.sourceId.localeCompare(right.result.sourceId) ||
    left.message.conversationId.localeCompare(right.message.conversationId)
  );
  const latest = candidates[0];
  if (!latest) {
    return null;
  }
  return {
    sourceId: latest.result.sourceId,
    displayName: latest.result.displayName,
    conversationId: latest.message.conversationId,
    latestActivityAt: latest.message.createdAt,
    workspacePath: latest.message.workspacePath
  };
}

async function loadLatestConversation(
  reference: OnboardingConversationReference,
  results: readonly OnboardingSampleResult[],
  reader: OnboardingConversationWindowReader | null | undefined,
  signal: AbortSignal
): Promise<OnboardingConversationWindow | null> {
  if (reader) {
    try {
      const loaded = await reader.readConversation(reference, {
        maxQueryChars: MAX_REPORT_QUERY_CHARS,
        deadlineMs: FIRST_LOGIN_SCAN_DEADLINE_MS,
        signal
      });
      if (loaded?.messages.length) {
        return loaded;
      }
    } catch {
      // The shallow probe below still preserves the latest visible conversation.
    }
  }

  const source = results.find((result) => result.sourceId === reference.sourceId);
  const messages = (source?.recentMessages ?? source?.queries.map((query) => ({ ...query, role: "user" as const })) ?? [])
    .filter((message) => message.conversationId === reference.conversationId)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  return messages.length > 0 ? { ...reference, messages } : null;
}

async function sampleSamplerWithinDeadline(
  sampler: OnboardingInsightSampler,
  signal: AbortSignal
): Promise<OnboardingSampleResult | null> {
  if (signal.aborted) {
    return null;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeout = new Promise<null>((resolve) => {
    const finish = () => resolve(null);
    abortHandler = finish;
    timeoutId = setTimeout(finish, FIRST_LOGIN_SCAN_DEADLINE_MS);
    signal.addEventListener("abort", finish, { once: true });
  });

  try {
    return await Promise.race([
      sampleSampler(sampler, signal),
      timeout
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

async function sampleSampler(
  sampler: OnboardingInsightSampler,
  signal: AbortSignal
): Promise<OnboardingSampleResult | null> {
  try {
    if (signal.aborted || !(await sampler.detect())) {
      return null;
    }
    if (signal.aborted) {
      return null;
    }
    return await sampler.sampleRecentUserQueries({
      ...DEFAULT_SAMPLE_OPTIONS,
      signal
    });
  } catch (error) {
    if (signal.aborted) {
      return null;
    }
    return {
      sourceId: sampler.sourceId,
      displayName: sampler.displayName,
      recentSessionCount: 0,
      latestActivityAt: null,
      queries: [],
      errors: [{ target: sampler.sourceId, reason: error instanceof Error ? error.message : "sample failed" }]
    };
  }
}

function buildProfileSignals(sample: SampleBundle): OnboardingInsightProfileSignals {
  const taskQueries = latestConversationUserQueries(sample.latestConversation);
  const taskSignals = taskQueries.length > 0 ? taskQueries : sample.queries;
  const nameHints = resolveNameHints(sample.queries);
  const preferredResponseLanguage = inferPreferredResponseLanguage(sample.queries);
  const topAgents = sample.discovered
    .map((result) => ({
      sourceId: result.sourceId,
      displayName: result.displayName,
      queryCount: result.queries.length,
      latestActivityAt: result.latestActivityAt
    }))
    .filter((agent) => agent.queryCount > 0)
    .sort((left, right) => right.queryCount - left.queryCount || left.displayName.localeCompare(right.displayName));
  const topKeywords = extractTopKeywords(taskSignals);
  const topProjects = extractTopProjects(taskSignals);
  const userInsights = extractUserInsights(sample.queries);
  const taskCandidates = extractTaskCandidates(taskSignals, sample.discovered);
  const taskLikeQuery = taskCandidates[0]?.latestQuery ?? findTaskLikeQuery(taskSignals);
  const highSignalQueries = sortQueriesRecent(taskSignals.filter((query) => HIGH_SIGNAL_PATTERN.test(query.text))).slice(0, 30);

  return {
    nameHints,
    preferredResponseLanguage,
    activeAgentNames: topAgents.map((agent) => agent.displayName),
    topAgents,
    topKeywords,
    topProjects,
    userInsights,
    taskCandidates,
    highSignalQueries,
    taskLikeQuery
  };
}

function latestConversationUserQueries(conversation: OnboardingConversationWindow | null): OnboardingSampledQuery[] {
  return conversation?.messages.flatMap((message) => message.role === "user" ? [{
    sourceId: message.sourceId,
    conversationId: message.conversationId,
    messageId: message.messageId,
    createdAt: message.createdAt,
    text: message.text,
    workspacePath: message.workspacePath
  }] : []) ?? [];
}

async function buildReportResponse(input: {
  profile: OnboardingInsightProfileSignals;
  sample: SampleBundle;
  locale: "zh-CN" | "en-US";
  reportGenerator: OnboardingInsightReportGenerator | null | undefined;
  memoryWriter: OnboardingFirstReportMemoryWriter | null | undefined;
  signal: AbortSignal | undefined;
  startedAt: number;
  now: () => number;
}): Promise<OnboardingInsightReportResponse> {
  if (input.sample.queries.length === 0) {
    return {
      status: "ready",
      reportMarkdown: renderEmptyHistoryReport(input.locale, input.sample),
      diagnostics: diagnostics(input.sample, false, Math.max(0, input.now() - input.startedAt), input.locale)
    };
  }

  const generationInput: OnboardingInsightGenerationInput = {
    locale: input.locale,
    profile: input.profile,
    sample: toSampleSummary(input.sample),
    signal: input.signal
  };
  const generatedReport = await generateReportSafely(input.reportGenerator, generationInput);
  const reportMarkdown = generatedReport?.reportMarkdown ?? renderFallbackReport(input.profile, input.sample, input.locale);
  const taskContext = generatedReport?.taskContext ?? buildFallbackTaskContext(generationInput);
  persistFirstReportMemoryInBackground(
    input.memoryWriter,
    input.sample,
    input.locale,
    reportMarkdown,
    taskContext
  );

  return {
    status: "ready",
    reportMarkdown,
    diagnostics: diagnostics(input.sample, Boolean(generatedReport), Math.max(0, input.now() - input.startedAt), input.locale)
  };
}

async function* streamReportResponse(input: {
  profile: OnboardingInsightProfileSignals;
  sample: SampleBundle;
  locale: "zh-CN" | "en-US";
  elapsedMs: number;
  reportGenerator: OnboardingInsightReportGenerator | null | undefined;
  memoryWriter: OnboardingFirstReportMemoryWriter | null | undefined;
  signal: AbortSignal | undefined;
  startedAt: number;
  now: () => number;
}): AsyncIterable<OnboardingInsightReportStreamEvent> {
  if (input.sample.queries.length === 0) {
    yield {
      type: "done",
      response: {
        status: "ready",
        reportMarkdown: renderEmptyHistoryReport(input.locale, input.sample),
        diagnostics: diagnostics(input.sample, false, input.elapsedMs, input.locale)
      }
    };
    return;
  }

  const generationInput: OnboardingInsightGenerationInput = {
    locale: input.locale,
    profile: input.profile,
    sample: toSampleSummary(input.sample),
    signal: input.signal
  };
  let rawOutput = "";
  const streamParser = new FirstReportStreamParser();

  if (input.reportGenerator?.streamReport) {
    try {
      for await (const delta of input.reportGenerator.streamReport(generationInput)) {
        if (!delta) {
          continue;
        }
        rawOutput += delta;
        for (const reportDelta of streamParser.push(delta)) {
          if (reportDelta) {
            yield { type: "chunk", delta: reportDelta };
          }
        }
      }
      for (const reportDelta of streamParser.finish()) {
        if (reportDelta) {
          yield { type: "chunk", delta: reportDelta };
        }
      }
    } catch {
      rawOutput = "";
    }
  }

  const generatedReport = input.reportGenerator?.streamReport
    ? parseGeneratedFirstReport(rawOutput, generationInput)
    : await generateReportSafely(input.reportGenerator, generationInput);
  const reportMarkdown = generatedReport?.reportMarkdown ?? renderFallbackReport(input.profile, input.sample, input.locale);
  const taskContext = generatedReport?.taskContext ?? buildFallbackTaskContext(generationInput);
  persistFirstReportMemoryInBackground(
    input.memoryWriter,
    input.sample,
    input.locale,
    reportMarkdown,
    taskContext
  );

  yield {
    type: "done",
    response: {
      status: "ready",
      reportMarkdown,
      diagnostics: diagnostics(input.sample, Boolean(generatedReport), Math.max(input.elapsedMs, input.now() - input.startedAt), input.locale)
    }
  };
}

function renderFallbackReport(
  profile: OnboardingInsightProfileSignals,
  sample: SampleBundle,
  locale: "zh-CN" | "en-US"
): string {
  return locale === "en-US" ? renderEnglishReport(profile, sample) : renderChineseReport(profile, sample);
}

function renderEmptyHistoryReport(locale: "zh-CN" | "en-US", sample: SampleBundle): string {
  const agentNames = sample.discovered.map((agent) => agent.displayName);
  if (agentNames.length > 0) {
    const names = agentNames.join(", ");
    return locale === "en-US" ? [
      `Memmy found ${names} on this device, but the quick first scan did not return readable conversation history.`,
      "Once you use Memmy with a real task, it will preserve the useful background, decisions, and next step for future conversations and other Agents."
    ].join("\n\n") : [
      `Memmy 已识别到这台设备上的 ${names}，但首次轻量扫描暂时没有读到可用的对话历史。`,
      "之后用 Memmy 处理真实任务时，它会记住有用的背景、决策和下一步，方便新对话或其他 Agent 继续。"
    ].join("\n\n");
  }

  return locale === "en-US" ? [
    "There is no readable Agent history on this device yet, so there is nothing useful to pretend I already know.",
    "Tell Memmy about one real task. It will preserve the useful background, decisions, and next step so a new conversation—or another Agent such as Cursor or Codex—can continue without making you explain it again."
  ].join("\n\n") : [
    "这台设备上还没有可读取的 Agent 历史，所以我不会假装已经了解你。",
    "先告诉 Memmy 一件你正在做的真实任务。它会记住有用的背景、决策和下一步；之后新开对话，或换到 Cursor、Codex，也不用再从头解释。"
  ].join("\n\n");
}

async function generateReportSafely(
  reportGenerator: OnboardingInsightReportGenerator | null | undefined,
  input: OnboardingInsightGenerationInput
): Promise<GeneratedFirstReport | null> {
  try {
    return parseGeneratedFirstReport(await reportGenerator?.generateReport(input) ?? null, input);
  } catch {
    return null;
  }
}

async function persistFirstReportMemory(
  memoryWriter: OnboardingFirstReportMemoryWriter | null | undefined,
  sample: SampleBundle,
  locale: "zh-CN" | "en-US",
  reportMarkdown: string,
  taskContext: OnboardingTaskContextSummary
): Promise<void> {
  const latestConversation = toSampleSummary(sample).latestConversation;
  if (!memoryWriter || !latestConversation) {
    return;
  }
  await memoryWriter.write({
    locale,
    reportMarkdown,
    projects: latestConversation.workspacePath
      ? [basename(latestConversation.workspacePath)]
      : taskContext.topic ? [taskContext.topic] : [],
    keywords: extractTaskContextKeywords(taskContext),
    taskContext,
    latestConversation: {
      agentSource: latestConversation.agentSource,
      conversationId: latestConversation.conversationId,
      workspacePath: latestConversation.workspacePath
    }
  });
}

function persistFirstReportMemoryInBackground(
  memoryWriter: OnboardingFirstReportMemoryWriter | null | undefined,
  sample: SampleBundle,
  locale: "zh-CN" | "en-US",
  reportMarkdown: string,
  taskContext: OnboardingTaskContextSummary
): void {
  void persistFirstReportMemory(memoryWriter, sample, locale, reportMarkdown, taskContext)
    .catch((error) => {
      console.warn(
        `[onboarding-insight] First-report memory persistence failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
}

function normalizeGeneratedOutput(output: string | null): string | null {
  const trimmed = (output ?? "").trim();
  return trimmed ? trimmed.slice(0, MAX_GENERATED_OUTPUT_CHARS) : null;
}

function parseGeneratedFirstReport(
  output: string | null,
  input: OnboardingInsightGenerationInput
): GeneratedFirstReport | null {
  const normalized = normalizeGeneratedOutput(output);
  if (!normalized) {
    return null;
  }

  const reportOpen = findGeneratedReportOpen(normalized);
  const reportContentStart = reportOpen ? reportOpen.index + reportOpen.marker.length : 0;
  const reportClose = findFirstGeneratedMarker(normalized, GENERATED_REPORT_CLOSE_MARKERS, reportContentStart);
  const contextSection = findGeneratedTaskContext(
    normalized,
    reportClose ? reportClose.index + reportClose.marker.length : reportContentStart
  );
  const reportEnd = [reportClose?.index ?? -1, contextSection?.start ?? -1]
    .filter((index) => index >= reportContentStart)
    .sort((left, right) => left - right)[0] ?? normalized.length;

  const reportMarkdown = sanitizeGeneratedReport(normalized.slice(
    reportContentStart,
    reportEnd
  ));
  if (!reportMarkdown) {
    return null;
  }

  const taskContext = contextSection?.taskContext ?? buildFallbackTaskContext(input);

  return { reportMarkdown, taskContext };
}

function findGeneratedReportOpen(output: string): { index: number; marker: string } | null {
  let first: { index: number; marker: string } | null = null;
  for (const marker of GENERATED_REPORT_OPEN_MARKERS) {
    let index = output.indexOf(marker);
    while (index >= 0) {
      const lineStart = output.lastIndexOf("\n", index - 1) + 1;
      if (!output.slice(lineStart, index).trim() && (!first || index < first.index)) {
        first = { index, marker };
        break;
      }
      index = output.indexOf(marker, index + marker.length);
    }
  }
  return first;
}

function findGeneratedTaskContext(
  output: string,
  aliasSearchStart: number
): { start: number; taskContext: OnboardingTaskContextSummary | null } | null {
  const canonical = findFirstGeneratedMarker(output, [GENERATED_TASK_CONTEXT_OPEN]);
  const alias = findGeneratedTaskContextAlias(output, aliasSearchStart);
  if (alias && (!canonical || alias.start < canonical.index)) {
    return alias;
  }
  if (canonical) {
    const contentStart = canonical.index + canonical.marker.length;
    const taggedEnd = findFirstGeneratedMarker(output, [GENERATED_TASK_CONTEXT_CLOSE], contentStart);
    return {
      start: canonical.index,
      taskContext: parseGeneratedTaskContext(output.slice(contentStart, taggedEnd?.index ?? output.length))
    };
  }

  const candidates = [GENERATED_JSON_FENCE_OPEN, GENERATED_NAKED_JSON_OPEN]
    .flatMap((marker) => {
      const indexes: number[] = [];
      let index = output.indexOf(marker);
      while (index >= 0) {
        indexes.push(index);
        index = output.indexOf(marker, index + marker.length);
      }
      return indexes;
    })
    .sort((left, right) => left - right);
  for (const start of candidates) {
    const taskContext = parseGeneratedTaskContext(output.slice(start + 1));
    if (taskContext) {
      return { start, taskContext };
    }
  }
  return null;
}

function findGeneratedTaskContextAlias(
  output: string,
  start: number
): { start: number; taskContext: OnboardingTaskContextSummary } | null {
  let taggedStart = output.indexOf(GENERATED_TASK_CONTEXT_ALIAS_OPEN, start);
  while (taggedStart >= 0) {
    const contentStart = taggedStart + GENERATED_TASK_CONTEXT_ALIAS_OPEN.length;
    const taggedEnd = output.indexOf(GENERATED_TASK_CONTEXT_ALIAS_CLOSE, contentStart);
    const taskContext = parseGeneratedTaskContext(output.slice(
      contentStart,
      taggedEnd >= 0 ? taggedEnd : output.length
    ));
    if (taskContext) {
      return { start: taggedStart, taskContext };
    }
    taggedStart = output.indexOf(GENERATED_TASK_CONTEXT_ALIAS_OPEN, contentStart);
  }
  return null;
}

function parseGeneratedTaskContext(rawContext: string): OnboardingTaskContextSummary | null {
  const json = rawContext.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return normalizeGeneratedTaskContext(JSON.parse(json));
  } catch {
    return null;
  }
}

function normalizeGeneratedTaskContext(value: unknown): OnboardingTaskContextSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const normalized: OnboardingTaskContextSummary = {
    topic: contextString(record.topic, 160),
    userGoal: contextString(record.userGoal, 320),
    latestRequest: contextString(record.latestRequest, 320),
    status: normalizeTaskStatus(record.status),
    currentState: contextString(record.currentState, 400),
    agentActions: contextStringList(record.agentActions, 3, 260),
    verifiedResults: contextStringList(record.verifiedResults, 3, 260),
    unresolvedItems: contextStringList(record.unresolvedItems, 3, 260),
    continuationPoint: contextString(record.continuationPoint, 320),
    trajectorySummary: contextString(record.trajectorySummary, 800)
  };
  return normalized.topic || normalized.userGoal || normalized.latestRequest || normalized.currentState ||
    normalized.trajectorySummary ? normalized : null;
}

function normalizeTaskStatus(value: unknown): OnboardingTaskStatus {
  return value === "pending" || value === "active" || value === "waiting" ||
    value === "completed" || value === "uncertain" ? value : "uncertain";
}

function contextString(value: unknown, maxChars: number): string {
  if (typeof value !== "string") {
    return "";
  }
  return stripInlineMediaPayloads(value).replace(/\s+/g, " ").trim().slice(0, maxChars);
}

function contextStringList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.map((item) => contextString(item, maxChars))).slice(0, maxItems);
}

function extractTaskContextKeywords(context: OnboardingTaskContextSummary): string[] {
  const text = [
    context.topic,
    context.userGoal,
    context.latestRequest,
    context.currentState,
    context.continuationPoint,
    context.trajectorySummary
  ].join(" ");
  return TOPIC_PATTERNS.filter((topic) => topic.pattern.test(text)).map((topic) => topic.keyword).slice(0, 8);
}

function buildFallbackTaskContext(input: OnboardingInsightGenerationInput): OnboardingTaskContextSummary {
  const conversation = input.sample.latestConversation;
  const messages = conversation?.messages ?? [];
  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const toolMessages = messages.filter((message) => message.role === "tool");
  const firstUser = userMessages[0]?.text ?? "";
  const latestUser = userMessages.at(-1)?.text ?? "";
  const latestAssistant = assistantMessages.at(-1)?.text ?? "";
  const latestTool = toolMessages.at(-1)?.text ?? "";
  const topic = conversation?.workspacePath
    ? basename(conversation.workspacePath)
    : input.profile.taskCandidates[0]?.project ?? input.profile.topProjects[0] ?? input.profile.topKeywords.slice(0, 3).join(", ");
  const latestRequest = summarizeContextMessage(latestUser, 240);
  const userGoal = summarizeContextMessage(input.profile.taskCandidates[0]?.summary || firstUser || latestUser, 280);
  const agentAction = summarizeContextMessage(latestAssistant, 220);
  const verifiedResult = summarizeContextMessage(latestTool, 220);
  const status = inferFallbackTaskStatus(messages);
  const currentState = verifiedResult || agentAction || latestRequest;
  const continuationPoint = status === "pending" || status === "active"
    ? (input.locale === "zh-CN" ? `从最近请求继续：${latestRequest}` : `Continue from the latest request: ${latestRequest}`)
    : status === "waiting"
      ? (input.locale === "zh-CN" ? "先确认当前等待用户决定的事项，再继续任务。" : "Resolve the item awaiting the user's decision, then continue the task.")
      : "";

  return {
    topic,
    userGoal,
    latestRequest,
    status,
    currentState,
    agentActions: agentAction ? [agentAction] : [],
    verifiedResults: verifiedResult ? [verifiedResult] : [],
    unresolvedItems: [],
    continuationPoint,
    trajectorySummary: renderFallbackTrajectory({
      locale: input.locale,
      firstUser: summarizeContextMessage(firstUser, 180),
      latestRequest,
      agentAction,
      verifiedResult
    })
  };
}

function summarizeContextMessage(text: string, maxChars: number): string {
  const normalized = stripInlineMediaPayloads(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const sentence = normalized.slice(0, maxChars).replace(/[，,；;：:\s]+\S*$/, "").trim();
  return `${sentence || normalized.slice(0, maxChars).trim()}…`;
}

function inferFallbackTaskStatus(
  messages: ReadonlyArray<{ role: "user" | "assistant" | "tool"; text: string }>
): OnboardingTaskStatus {
  let latestUserIndex = -1;
  let latestAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role;
    if (latestUserIndex < 0 && role === "user") latestUserIndex = index;
    if (latestAssistantIndex < 0 && role === "assistant") latestAssistantIndex = index;
    if (latestUserIndex >= 0 && latestAssistantIndex >= 0) break;
  }
  if (latestUserIndex < 0) {
    return "uncertain";
  }
  if (latestUserIndex > latestAssistantIndex) {
    return "pending";
  }
  const latestAssistant = latestAssistantIndex >= 0 ? messages[latestAssistantIndex]?.text ?? "" : "";
  if (/等待|待用户|需要你|请确认|waiting|need your|please confirm/i.test(latestAssistant)) {
    return "waiting";
  }
  if (/已完成|已实现|测试通过|验证通过|已推送|\bdone\b|\bcompleted\b|\bimplemented\b|\btests? passed\b|\bpushed\b/i.test(latestAssistant) &&
    !/未完成|失败|没有通过|not completed|failed|did not pass/i.test(latestAssistant)) {
    return "completed";
  }
  return "active";
}

function renderFallbackTrajectory(input: {
  locale: "zh-CN" | "en-US";
  firstUser: string;
  latestRequest: string;
  agentAction: string;
  verifiedResult: string;
}): string {
  const parts = input.locale === "zh-CN"
    ? [
      input.firstUser && input.firstUser !== input.latestRequest ? `任务起点：${input.firstUser}` : "",
      input.latestRequest ? `最近要求：${input.latestRequest}` : "",
      input.agentAction ? `Agent 最近反馈：${input.agentAction}` : "",
      input.verifiedResult ? `最近验证：${input.verifiedResult}` : ""
    ]
    : [
      input.firstUser && input.firstUser !== input.latestRequest ? `Starting point: ${input.firstUser}` : "",
      input.latestRequest ? `Latest request: ${input.latestRequest}` : "",
      input.agentAction ? `Latest Agent update: ${input.agentAction}` : "",
      input.verifiedResult ? `Latest verification: ${input.verifiedResult}` : ""
    ];
  return parts.filter(Boolean).join(input.locale === "zh-CN" ? "；" : "; ");
}

class FirstReportStreamParser {
  private mode: "prefix" | "report" | "hidden" = "prefix";
  private buffer = "";
  private visibleSource = "";
  private emittedVisibleChars = 0;

  push(delta: string): string[] {
    if (this.mode === "hidden") {
      return [];
    }
    this.buffer += delta;
    if (this.mode === "prefix") {
      const candidate = this.buffer.trimStart();
      if (!candidate) {
        return [];
      }
      const reportOpen = findGeneratedReportOpen(candidate);
      if (!reportOpen) {
        return [];
      }
      this.mode = "report";
      this.buffer = candidate.slice(reportOpen.index + reportOpen.marker.length);
    }
    return this.drainVisibleText([
      ...GENERATED_REPORT_CLOSE_MARKERS,
      GENERATED_TASK_CONTEXT_OPEN,
      GENERATED_JSON_FENCE_OPEN,
      GENERATED_NAKED_JSON_OPEN
    ]);
  }

  finish(): string[] {
    if (this.mode === "prefix") {
      this.buffer = "";
      this.visibleSource = "";
      return [];
    }
    if (this.mode === "report") {
      const remainder = this.buffer;
      this.buffer = "";
      const aliasBoundary = findGeneratedTaskContextAliasBoundary(remainder);
      if (aliasBoundary) {
        const report = remainder.slice(0, aliasBoundary.index);
        return this.visibleText(report, true);
      }
      const internalMarkers = [
        ...GENERATED_REPORT_CLOSE_MARKERS,
        GENERATED_TASK_CONTEXT_OPEN,
        GENERATED_TASK_CONTEXT_ALIAS_OPEN,
        GENERATED_JSON_FENCE_OPEN,
        GENERATED_NAKED_JSON_OPEN
      ];
      const isPartialInternalMarker = isGeneratedMarkerPrefix(remainder, internalMarkers);
      return remainder && !isPartialInternalMarker ? this.visibleText(remainder, true) : [];
    }
    return [];
  }

  private drainVisibleText(delimiters: readonly string[]): string[] {
    const delimiter = findFirstGeneratedMarker(this.buffer, delimiters);
    const aliasBoundary = findGeneratedTaskContextAliasBoundary(this.buffer);
    const boundary = [
      delimiter ? { index: delimiter.index, pending: false } : null,
      aliasBoundary
    ]
      .filter((item): item is { index: number; pending: boolean } => Boolean(item))
      .sort((left, right) => left.index - right.index)[0];
    if (boundary && !boundary.pending) {
      const report = this.buffer.slice(0, boundary.index);
      this.buffer = "";
      this.mode = "hidden";
      return this.visibleText(report, true);
    }
    if (boundary) {
      const report = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index);
      return this.visibleText(report);
    }
    const retainedMarkers = [...delimiters, GENERATED_TASK_CONTEXT_ALIAS_OPEN];
    const retainedChars = Math.max(...retainedMarkers.map((marker) => matchingDelimiterSuffixLength(this.buffer, marker)));
    const report = this.buffer.slice(0, this.buffer.length - retainedChars);
    this.buffer = this.buffer.slice(this.buffer.length - retainedChars);
    return this.visibleText(report);
  }

  private visibleText(text: string, finished = false): string[] {
    this.visibleSource += text;
    const sanitized = stripRawHtmlTags(this.visibleSource, true);
    const delta = sanitized.slice(this.emittedVisibleChars);
    this.emittedVisibleChars = sanitized.length;
    if (finished) {
      this.visibleSource = "";
    }
    return delta ? [delta] : [];
  }
}

function findGeneratedTaskContextAliasBoundary(
  value: string
): { index: number; pending: boolean } | null {
  let index = value.indexOf(GENERATED_TASK_CONTEXT_ALIAS_OPEN);
  while (index >= 0) {
    const content = value.slice(index + GENERATED_TASK_CONTEXT_ALIAS_OPEN.length).trimStart();
    if (content.startsWith("{") || content.startsWith("```json")) {
      return { index, pending: false };
    }
    if (!content || "```json".startsWith(content)) {
      return { index, pending: true };
    }
    index = value.indexOf(GENERATED_TASK_CONTEXT_ALIAS_OPEN, index + GENERATED_TASK_CONTEXT_ALIAS_OPEN.length);
  }
  return null;
}

function matchingDelimiterSuffixLength(value: string, delimiter: string): number {
  const maxLength = Math.min(value.length, delimiter.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (value.endsWith(delimiter.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function findFirstGeneratedMarker(
  value: string,
  markers: readonly string[],
  start = 0
): { index: number; marker: string } | null {
  let first: { index: number; marker: string } | null = null;
  for (const marker of markers) {
    const index = value.indexOf(marker, start);
    if (index >= 0 && (!first || index < first.index)) {
      first = { index, marker };
    }
  }
  return first;
}

function isGeneratedMarkerPrefix(value: string, markers: readonly string[]): boolean {
  return markers.some((marker) => marker.startsWith(value));
}

function renderChineseReport(profile: OnboardingInsightProfileSignals, sample: SampleBundle): string {
  const lines: string[] = [];
  const nameLine = renderChineseNameLine(profile.nameHints);
  if (nameLine) {
    lines.push(nameLine);
  }

  const preferenceLines = [
    renderContextLanguagePreference(profile, "zh-CN"),
    ...profile.userInsights.slice(0, 4).map((insight) => insight.textZh)
  ].filter((line): line is string => Boolean(line));
  lines.push(`## 你的偏好\n${preferenceLines.length > 0 ? preferenceLines.map((line) => `- ${line}`).join("\n") : "目前只有少量用户表达，我还不会替你下偏好结论。"}`);

  const conversation = sample.latestConversation;
  const context = buildFallbackTaskContext({ locale: "zh-CN", profile, sample: toSampleSummary(sample) });
  const memoryLines = [
    conversation ? `最近一次会话来自 ${conversation.displayName}${conversation.workspacePath ? `，项目路径是 ${conversation.workspacePath}` : ""}。` : null,
    context.userGoal ? `用户目标：${context.userGoal}` : null,
    context.currentState ? `当前状态：${context.currentState}` : null,
    context.agentActions.length > 0 ? `Agent 已做：${context.agentActions.join("；")}` : null,
    context.verifiedResults.length > 0 ? `已验证结果：${context.verifiedResults.join("；")}` : "目前没有明确的验证结果。",
    context.unresolvedItems.length > 0 ? `仍待处理：${context.unresolvedItems.join("；")}` : null
  ].filter((line): line is string => Boolean(line));
  lines.push(`## 最近项目记忆\n${memoryLines.join("\n\n")}`);

  lines.push(`## 接下来可以做\n${context.continuationPoint ? `1. ${context.continuationPoint}` : "当前记录中没有明确的未完成待办。"}`);

  return lines.join("\n\n");
}

function renderEnglishReport(profile: OnboardingInsightProfileSignals, sample: SampleBundle): string {
  const lines: string[] = [];
  const nameLine = renderEnglishNameLine(profile.nameHints);
  if (nameLine) {
    lines.push(nameLine);
  }

  const preferenceLines = [
    renderContextLanguagePreference(profile, "en-US"),
    ...profile.userInsights.slice(0, 4).map((insight) => insight.textEn)
  ].filter((line): line is string => Boolean(line));
  lines.push(`## Your preferences\n${preferenceLines.length > 0 ? preferenceLines.map((line) => `- ${line}`).join("\n") : "I only have a few user-authored signals, so I will not overstate your preferences yet."}`);

  const conversation = sample.latestConversation;
  const context = buildFallbackTaskContext({ locale: "en-US", profile, sample: toSampleSummary(sample) });
  const memoryLines = [
    conversation ? `Your newest conversation is from ${conversation.displayName}${conversation.workspacePath ? `, at ${conversation.workspacePath}` : ""}.` : null,
    context.userGoal ? `User goal: ${context.userGoal}` : null,
    context.currentState ? `Current state: ${context.currentState}` : null,
    context.agentActions.length > 0 ? `Agent actions: ${context.agentActions.join("; ")}` : null,
    context.verifiedResults.length > 0 ? `Verified results: ${context.verifiedResults.join("; ")}` : "There is no explicit verified result yet.",
    context.unresolvedItems.length > 0 ? `Still unresolved: ${context.unresolvedItems.join("; ")}` : null
  ].filter((line): line is string => Boolean(line));
  lines.push(`## Latest project memory\n${memoryLines.join("\n\n")}`);

  lines.push(`## What to do next\n${context.continuationPoint ? `1. ${context.continuationPoint}` : "There is no explicit unfinished action in the current record."}`);

  return lines.join("\n\n");
}

function renderChineseNameLine(hints: NameHints): string | null {
  const name = selectFallbackNameSignal(hints);
  if (!name) {
    return "Hi，我还没看到你明确提过名字，所以先不乱称呼你。";
  }
  const displayName = formatNameForGreeting(name.value);
  if (name.kind === "self_declared") {
    return `Hi ${displayName}，我从对话里看到你这样介绍过自己。`;
  }
  return `Hi ${displayName}，我先按本机线索这样称呼你；如果不对，告诉我就好。`;
}

function renderEnglishNameLine(hints: NameHints): string | null {
  const name = selectFallbackNameSignal(hints);
  if (!name) {
    return "Hi, I have not seen a clear name from you yet, so I will not guess one.";
  }
  const displayName = formatNameForGreeting(name.value);
  if (name.kind === "self_declared") {
    return `Hi ${displayName}, I saw you introduce yourself this way in the conversation.`;
  }
  return `Hi ${displayName}, I am using the local account hint for now; tell me if I should call you something else.`;
}

function selectFallbackNameSignal(hints: NameHints): NameSignal | null {
  if (hints.homePathName && !isGenericAccountName(hints.homePathName)) {
    return {
      value: hints.homePathName,
      source: hints.homeAndComputerMatch ? "~ 路径与电脑用户名一致" : "~ 路径",
      kind: "local_account"
    };
  }

  const selfDeclaredName = hints.selfDeclaredNames.find((name) => !isGenericAccountName(name))
    ?? hints.selfDeclaredNames[0];
  if (selfDeclaredName) {
    return { value: selfDeclaredName, source: "query 自称", kind: "self_declared" };
  }

  if (hints.computerUserName && !isGenericAccountName(hints.computerUserName)) {
    return { value: hints.computerUserName, source: "电脑用户名", kind: "local_account" };
  }

  return null;
}

function buildNameDecisionRequirement(profile: OnboardingInsightProfileSignals, locale: "zh-CN" | "en-US") {
  return {
    mustInferDisplayName: true,
    mustIncludeDisplayNameInFirstSentence: true,
    defaultPriority: "homePathName",
    genericAccountNames: profile.nameHints.genericAccountNames,
    locale,
    openingPattern: locale === "en-US"
      ? "Hi <displayName>, ..."
      : "Hi <displayName>，..."
  };
}

function formatNameForGreeting(value: string): string {
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9_.-]*$/i.test(trimmed) && !/\p{Script=Han}/u.test(trimmed)) {
    return `${trimmed.charAt(0).toLocaleUpperCase()}${trimmed.slice(1)}`;
  }
  return trimmed;
}

function renderContextLanguagePreference(
  profile: Pick<OnboardingInsightProfileSignals, "preferredResponseLanguage">,
  locale: "zh-CN" | "en-US"
): string | null {
  if (!profile.preferredResponseLanguage) {
    return null;
  }
  if (locale === "en-US") {
    return profile.preferredResponseLanguage === "zh-CN"
      ? "Language preference: recent conversations lean Chinese"
      : "Language preference: recent conversations lean English";
  }
  return profile.preferredResponseLanguage === "zh-CN"
    ? "语言偏好：最近对话更常使用中文"
    : "语言偏好：最近对话更常使用英文";
}

function resolveNameHints(queries: readonly OnboardingSampledQuery[]): NameHints {
  const selfDeclaredNames = uniqueStrings(queries
    .map((query) => extractSelfDeclaredName(query.text))
    .filter((name): name is string => Boolean(name)))
    .slice(0, 5);
  const homeName = sanitizeNameCandidate(basename(homedir()));
  const computerName = sanitizeNameCandidate(userInfo().username);

  return {
    selfDeclaredNames,
    homePathName: homeName,
    computerUserName: computerName,
    homeAndComputerMatch: Boolean(homeName && computerName && homeName === computerName),
    genericAccountNames: [...GENERIC_ACCOUNT_NAMES]
  };
}

function extractSelfDeclaredName(text: string): string | null {
  const patterns = [
    /(?:我叫|我的名字是)\s*([A-Za-z][A-Za-z0-9_.-]{0,31}|[\p{Script=Han}]{1,6})(?=$|[\s,，。:：;；!！?？、])/u,
    /我是\s*([A-Za-z][A-Za-z0-9_.-]{0,31})(?=$|[\s,，。:：;；!！?？、])/u,
    /\b(?:my name is|i am|i'm)\s+([A-Za-z][A-Za-z0-9_.-]{0,31})\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = sanitizeNameCandidate(match?.[1] ?? "");
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function sanitizeNameCandidate(value: string): string | null {
  const trimmed = value.trim().replace(/^["'“”‘’]+|["'“”‘’.,，。:：;；!！?？]+$/g, "");
  if (!trimmed || trimmed.length > 32 || hasMixedChineseAndLatin(trimmed)) {
    return null;
  }
  return trimmed;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isGenericAccountName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return GENERIC_ACCOUNT_NAMES.includes(normalized as typeof GENERIC_ACCOUNT_NAMES[number]);
}

function hasMixedChineseAndLatin(value: string): boolean {
  return /\p{Script=Han}/u.test(value) && /[A-Za-z]/.test(value);
}

function extractTopKeywords(queries: readonly OnboardingSampledQuery[]): string[] {
  const counts = new Map<string, number>();
  for (const query of queries) {
    for (const topic of TOPIC_PATTERNS) {
      if (topic.pattern.test(query.text)) {
        counts.set(topic.keyword, (counts.get(topic.keyword) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([keyword]) => keyword)
    .slice(0, 8);
}

function extractTopProjects(queries: readonly OnboardingSampledQuery[]): string[] {
  const counts = new Map<string, number>();
  for (const query of queries) {
    const project = query.workspacePath ? basename(query.workspacePath) : extractLikelyProjectName(query.text);
    if (!project || project === "." || project === "/") {
      continue;
    }
    counts.set(project, (counts.get(project) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([project]) => project)
    .slice(0, 5);
}

function extractLikelyProjectName(text: string): string | null {
  const pathMatch = text.match(/\/Users\/[^/\s]+\/(?:MyProject|Projects)\/([A-Za-z0-9][A-Za-z0-9_-]{2,60})/);
  const explicitMatch = text.match(/\b([A-Za-z0-9][A-Za-z0-9_-]{2,60})\s+(?:project|项目)\b/i)
    ?? text.match(/(?:项目|叫|called)\s+([A-Za-z0-9][A-Za-z0-9_-]{2,60})/i);
  return pathMatch?.[1] ?? explicitMatch?.[1] ?? null;
}

function extractUserInsights(queries: readonly OnboardingSampledQuery[]): UserInsight[] {
  return USER_INSIGHT_RULES
    .map((rule) => ({
      key: rule.key,
      textZh: rule.zh,
      textEn: rule.en,
      evidenceCount: queries.filter((query) => rule.pattern.test(query.text)).length
    }))
    .filter((insight) => insight.evidenceCount > 0)
    .sort((left, right) => right.evidenceCount - left.evidenceCount || left.key.localeCompare(right.key))
    .slice(0, 5);
}

function extractTaskCandidates(
  queries: readonly OnboardingSampledQuery[],
  results: readonly OnboardingSampleResult[]
): TaskCandidate[] {
  const agentNames = new Map(results.map((result) => [result.sourceId, result.displayName]));
  const groups = new Map<string, {
    project: string | null;
    queries: OnboardingSampledQuery[];
    agents: Set<string>;
    score: number;
  }>();

  for (const query of sortQueriesRecent(queries)) {
    if (LOW_VALUE_TASK_PATTERN.test(query.text)) {
      continue;
    }
    const project = query.workspacePath ? basename(query.workspacePath) : extractLikelyProjectName(query.text);
    const keyword = firstMatchingTopic(query.text) ?? "recent";
    const key = project ? `project:${project}` : `topic:${keyword}`;
    const group = groups.get(key) ?? { project, queries: [], agents: new Set<string>(), score: 0 };
    group.queries.push(query);
    group.agents.add(agentNames.get(query.sourceId) ?? query.sourceId);
    group.score = Math.max(group.score, scoreTaskQuery(query));
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((group) => Boolean(group.project) || group.score >= 3)
    .map((group) => {
      const latestQuery = group.queries[0];
      return latestQuery ? {
        title: buildTaskTitle(group.project, latestQuery),
        summary: summarizeTask(group.queries),
        project: group.project,
        relatedAgents: [...group.agents].slice(0, 4),
        latestQuery,
        score: group.score + Math.min(group.queries.length, 3)
      } : null;
    })
    .filter((task): task is TaskCandidate => Boolean(task))
    .sort((left, right) => right.score - left.score || Date.parse(right.latestQuery.createdAt) - Date.parse(left.latestQuery.createdAt))
    .slice(0, 4);
}

function firstMatchingTopic(text: string): string | null {
  return TOPIC_PATTERNS.find((topic) => topic.pattern.test(text))?.keyword ?? null;
}

function scoreTaskQuery(query: OnboardingSampledQuery): number {
  let score = 0;
  if (PROBLEM_PATTERN.test(query.text)) {
    score += 3;
  }
  if (DECISION_PATTERN.test(query.text)) {
    score += 2;
  }
  if (ACTION_PATTERN.test(query.text)) {
    score += 2;
  }
  if (HIGH_SIGNAL_PATTERN.test(query.text)) {
    score += 1;
  }
  if (query.workspacePath || extractLikelyProjectName(query.text)) {
    score += 1;
  }
  return score;
}

function buildTaskTitle(project: string | null, query: OnboardingSampledQuery): string {
  if (project) {
    if (/mindock-agent|memmy/i.test(project) || /onboarding|扫描|记忆|memory/i.test(query.text)) {
      return `${project} 的记忆扫描和首次登录体验`;
    }
    if (/bitrade/i.test(project)) {
      return `${project} 的工程架构和稳定性改造`;
    }
    return `${project} 的当前任务`;
  }
  if (/onboarding|首次登录|首次登陆/i.test(query.text)) {
    return "首次登录轻量扫描体验";
  }
  if (/扫描|记忆|memory/i.test(query.text)) {
    return "记忆扫描和跨 Agent 整合";
  }
  if (PROBLEM_PATTERN.test(query.text)) {
    return "最近的排错任务";
  }
  return "最近的连续任务";
}

function summarizeTask(queries: readonly OnboardingSampledQuery[]): string {
  const strongest = [...queries]
    .filter((query) => !isDocumentDump(query.text))
    .sort((left, right) => scoreTaskQuery(right) - scoreTaskQuery(left))[0] ?? queries[0];
  return strongest ? trimSentence(strongest.text, 180) : "";
}

function isDocumentDump(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  return /^\d+\s+#/.test(normalized) ||
    /##\s|更新日期|HTTP API|CLI|目录|Table of Contents|```/.test(normalized) ||
    normalized.length > 500;
}

function findTaskLikeQuery(queries: readonly OnboardingSampledQuery[]): OnboardingSampledQuery | null {
  return queries.find((query) => PROBLEM_PATTERN.test(query.text) || DECISION_PATTERN.test(query.text)) ?? queries[0] ?? null;
}

function inferLocale(queries: readonly OnboardingSampledQuery[]): "zh-CN" | "en-US" {
  return inferPreferredResponseLanguage(queries) ?? "en-US";
}

function inferPreferredResponseLanguage(queries: readonly OnboardingSampledQuery[]): "zh-CN" | "en-US" | null {
  let chineseCount = 0;
  let classifiedCount = 0;

  for (const query of queries.slice(0, 90)) {
    const language = classifyQueryLanguage(query.text);
    if (language === "zh-CN") {
      chineseCount += 1;
    }
    if (language) {
      classifiedCount += 1;
    }
  }

  if (classifiedCount === 0) {
    return null;
  }
  return chineseCount / classifiedCount >= 0.2 ? "zh-CN" : "en-US";
}

function classifyQueryLanguage(text: string): "zh-CN" | "en-US" | null {
  const hanChars = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latinWords = text.match(/[A-Za-z][A-Za-z'-]{2,}/g)?.length ?? 0;
  const hasChineseSyntax = /请|帮我|为什么|怎么|是否|如果|应该|需要|这个|那个|用户|扫描|记忆|首次|登录|登陆|页面|按钮|报告|报错|检查|修改|实现|重启|测试|验证|不是|没有|可以|什么/u.test(text);

  if (hanChars >= 8 || (hanChars >= 3 && hasChineseSyntax)) {
    return "zh-CN";
  }
  if (latinWords >= 5 && hanChars === 0) {
    return "en-US";
  }
  if (latinWords >= 8 && hanChars < 3) {
    return "en-US";
  }
  return null;
}

function selectBalancedQueries(results: readonly OnboardingSampleResult[], limit: number): OnboardingSampledQuery[] {
  const sortedBySource = results
    .map((result) => sortQueriesRecent(result.queries))
    .filter((queries) => queries.length > 0);
  const selected: OnboardingSampledQuery[] = [];
  const seen = new Set<string>();

  for (let index = 0; selected.length < limit; index += 1) {
    let added = false;
    for (const sourceQueries of sortedBySource) {
      const query = sourceQueries[index];
      if (!query) {
        continue;
      }
      const key = queryKey(query);
      if (!seen.has(key)) {
        selected.push(query);
        seen.add(key);
        added = true;
      }
      if (selected.length >= limit) {
        break;
      }
    }
    if (!added) {
      break;
    }
  }

  const highSignal = sortQueriesRecent(results.flatMap((result) => result.queries).filter((query) => HIGH_SIGNAL_PATTERN.test(query.text)));
  for (const query of highSignal) {
    if (selected.length >= limit) {
      break;
    }
    const key = queryKey(query);
    if (!seen.has(key)) {
      selected.push(query);
      seen.add(key);
    }
  }

  return selected;
}

function queryKey(query: OnboardingSampledQuery): string {
  return `${query.sourceId}:${query.conversationId}:${query.messageId}`;
}

function sortQueriesRecent(queries: readonly OnboardingSampledQuery[]): OnboardingSampledQuery[] {
  return [...queries].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.conversationId.localeCompare(right.conversationId) ||
    left.messageId.localeCompare(right.messageId)
  );
}

function toSampleSummary(sample: SampleBundle): OnboardingInsightSampleSummary {
  const agentNames = new Map(sample.discovered.map((result) => [result.sourceId, result.displayName]));
  const reportQueries = selectPreferenceReportQueries(sample.discovered);
  return {
    discoveredAgentCount: sample.discovered.length,
    sampledQueryCount: sample.queries.length,
    activeAgents: sample.discovered
      .filter((result) => result.queries.length > 0)
      .map((result) => ({
        sourceId: result.sourceId,
        displayName: result.displayName,
        queryCount: result.queries.length,
        latestActivityAt: result.latestActivityAt
      })),
    queries: reportQueries.map((query) => ({
      agentSource: agentNames.get(query.sourceId) ?? query.sourceId,
      createdAt: query.createdAt,
      workspacePath: query.workspacePath,
      text: clipReportQueryText(query.text)
    })),
    latestConversation: sample.latestConversation ? {
      agentSource: agentNames.get(sample.latestConversation.sourceId) ?? sample.latestConversation.displayName,
      conversationId: sample.latestConversation.conversationId,
      latestActivityAt: sample.latestConversation.latestActivityAt,
      workspacePath: sample.latestConversation.workspacePath,
      messages: sample.latestConversation.messages.map((message) => ({
        role: message.role,
        createdAt: message.createdAt,
        text: message.text
      }))
    } : null
  };
}

function selectPreferenceReportQueries(results: readonly OnboardingSampleResult[]): OnboardingSampledQuery[] {
  const queues = results.map((result) => [...result.queries].sort((left, right) =>
    scorePreferenceEvidence(right.text) - scorePreferenceEvidence(left.text) ||
    Date.parse(right.createdAt) - Date.parse(left.createdAt)
  ));
  const selected: OnboardingSampledQuery[] = [];
  for (let index = 0; selected.length < MAX_PREFERENCE_LLM_QUERIES; index += 1) {
    let added = false;
    for (const queue of queues) {
      const query = queue[index];
      if (!query) {
        continue;
      }
      selected.push(query);
      added = true;
      if (selected.length >= MAX_PREFERENCE_LLM_QUERIES) {
        break;
      }
    }
    if (!added) {
      break;
    }
  }
  return selected;
}

function scorePreferenceEvidence(text: string): number {
  const explicitPreference = /偏好|习惯|喜欢|不喜欢|不要|必须|希望|倾向|更常|简洁|详细|中文|英文|prefer|usually|always|never|don't|must|concise|detailed/i;
  return USER_INSIGHT_RULES.reduce((score, rule) => score + (rule.pattern.test(text) ? 2 : 0), explicitPreference.test(text) ? 3 : 0);
}

function clipReportQueryText(text: string): string {
  const trimmed = stripInlineMediaPayloads(text).trim();
  return trimmed.length <= MAX_REPORT_QUERY_CHARS ? trimmed : `${trimmed.slice(0, MAX_REPORT_QUERY_CHARS)}...`;
}

function buildLlmMessages(input: OnboardingInsightGenerationInput): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "你是 Memmy 首次登录初见报告撰写者。报告要像一位刚接手工作的可靠搭档：私人化、具体、克制，不是技术日志，也不是营销文案。",
        "只依据输入里的明确证据，不要编造项目、完成情况、错误原因或用户偏好。证据不足时直接说明尚不能确认。",
        "不要把 diagnostics 写给用户，不要出现“轻量样本、采样、query 数、discoveredAgentCount”等实现细节。",
        "你必须根据 profile.nameHints 综合判断用户可能希望被怎么称呼。nameHints.selfDeclaredNames 来自扫描到的用户自称，homePathName 是 home 路径最后一段，computerUserName 是电脑用户名，homeAndComputerMatch 表示 home 路径名和电脑用户名一致。",
        "名字判断默认优先使用 homePathName，因为用户一定有 home 路径；不要因为 selfDeclaredNames 为空就省略称呼。只有当 homePathName 是 admin、administrator、root、ubuntu、user、test、guest、default、runner、ec2-user 这类泛化账号名，或明显不是可称呼名字时，才降低它的优先级。",
        "selfDeclaredNames 和 computerUserName 是辅助判断线索：如果 selfDeclaredNames 有明确人名，可以结合它修正称呼；如果 homePathName 与 computerUserName 一致，说明本机线索更可信。",
        "第一句必须包含你判断出的具体称呼：中文报告以“Hi <称呼>，”开头，英文报告以“Hi <name>, ”开头。不得省略名字，不得把名字替换成“这个线索”“这个称呼”“X”等占位词。",
        "严禁出现“本机账号显示为”“本机用户名/路径名显示为”“local username/path shows”“我检测到你的用户名”这类工程口径。",
        "不要向用户暴露 nameHints、homePathName、computerUserName 这些字段名或来源；如果本机线索只是临时称呼，要用柔和语气表达“如果不对，告诉我就好”。中英文混合名不要使用。",
        "输出中文或英文由 locale 决定。profile.preferredResponseLanguage 来自近期用户请求的主语言统计；有值时要自然说明用户最近更常用中文还是英文。",
        "偏好结论的唯一原始证据是 preferenceEvidence 中由用户本人发送的消息，profile 里的偏好字段也只是这些用户消息的结构化归纳。仅总结用户明确表达或在多个请求中稳定体现的偏好；不要把旧任务内容本身当成偏好，也严禁使用 assistant、tool 或 latestConversation 推断偏好。",
        "latestConversation 是所有已扫描 Agent 中时间最新的一个会话，只允许依据这个会话总结最近项目、任务、Bug 或关键词及其当前进度。",
        "latestConversation.messages 已按首 2 个和尾 12 个对话轮次截取。user 是用户请求，assistant 是 Agent 回复，tool 是脱敏后的简短工具执行信息。",
        "区分三类进度证据：用户要求做什么、Agent 表示做了什么、工具结果实际验证了什么。只有明确成功的 tool 结果才能写成已验证；只有 assistant 自述时应写成“Agent 表示/对话中提到”，不能当成确定事实。",
        "把 latestConversation 看作一条随时间演进的任务轨迹：合并重复要求，保留关键转折，并让较新的决定、修复和验证覆盖较早的猜测、失败或阻塞。不要逐条复述消息，不要照抄工具日志。",
        "正文必须包含三个 Markdown 小节：『你的偏好』『最近项目记忆』『接下来可以做』。可以使用短段落和列表，不要使用表格或代码块。",
        "『你的偏好』只总结用户本人有证据支持的语言、沟通方式、输出形式、方案取舍、实现约束或验证要求，最多 3-5 条；不要混入项目进度、Agent 行为、工具结果或空泛性格标签。",
        "『最近项目记忆』说明最新会话来自哪个 Agent、用户目标、已做事项、已验证结果、当前状态、仍待处理内容。workspacePath 有值时必须写清项目具体路径。只写当前有效结论，不展开冗长历史。",
        "『接下来可以做』只列证据支持且尚未完成的 0-3 条待办，按执行顺序排列。第一条应是当前最小且可立即执行的下一步；任务已完成或没有明确待办时，直接说明暂时没有明确待办，不要补通用建议。",
        "正文长度要求：中文 300-500 字，英文 180-300 words。重点是准确提炼最近一个项目现场，不要扩展成跨项目年度总结。",
        "报告正文只允许使用 Markdown，不得包含任何原始 HTML 标签或样式。不要输出思考过程、执行计划、要求确认、Prompt 复述或起草说明。",
        "你必须一次输出两个区块，严格使用以下顺序和标签；标签前后不要添加其他文字：",
        `${GENERATED_REPORT_OPEN}\n这里放给用户看的 Markdown 报告正文\n${GENERATED_REPORT_CLOSE}`,
        `${GENERATED_TASK_CONTEXT_OPEN}\n这里放一个合法 JSON 对象\n${GENERATED_TASK_CONTEXT_CLOSE}`,
        "任务上下文 JSON 必须包含且只需包含：topic、userGoal、latestRequest、status、currentState、agentActions、verifiedResults、unresolvedItems、continuationPoint、trajectorySummary。status 只能是 pending、active、waiting、completed、uncertain；后三个集合字段必须是字符串数组。",
        "任务上下文使用 locale 对应语言，面向任意类型任务，不要使用仅适合 Coding 的固定分类。它只总结最新任务，不得包含用户偏好，也不得复制原始 query、assistant 回复或工具流水。agentActions 写 Agent 已采取的动作，verifiedResults 只写有结果证据支持的结论，unresolvedItems 只写仍然有效的问题，continuationPoint 写其他 Agent 接手时应从哪里继续。",
        "trajectorySummary 用一个紧凑段落总结：用户目标如何演进、Agent 做了什么、得到什么结果、现在停在哪里。最终状态优先；已经被后续解决的问题不能继续写成当前阻塞。",
        "任务上下文要短：JSON 必须单行输出、不要缩进、不要代码块；每个普通字段最多一句，三个数组各最多 3 项，trajectorySummary 中文 80-160 字或英文 60-100 words；不要为了填满字段而重复同一事实。",
        "报告正文不要生成按钮、行动卡片、CTA、JSON、Markdown 代码块或表格；任务上下文区块只放 JSON 对象。不要暴露任何密钥。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        locale: input.locale,
        reportGoal: {
          primary: "user_preferences_latest_project_memory_and_actionable_todos",
          lengthConstraint: input.locale === "zh-CN"
            ? "300-500 Chinese characters"
            : "180-300 English words",
          requiredSections: [
            "opening_with_name_or_safe_greeting",
            "user_preferences",
            "latest_project_memory",
            "ordered_actionable_todos"
          ],
          focus: [
            "用户有哪些有证据支持的稳定偏好",
            "全局最新会话对应什么项目、任务、Bug 或关键词",
            "用户要求、Agent 自述和工具验证分别说明了什么进度",
            "接下来尚未完成且最可行的 0-3 个待办是什么"
          ],
          outputEnvelope: {
            reportTag: GENERATED_REPORT_OPEN,
            taskContextTag: GENERATED_TASK_CONTEXT_OPEN,
            taskContextFields: [
              "topic",
              "userGoal",
              "latestRequest",
              "status",
              "currentState",
              "agentActions",
              "verifiedResults",
              "unresolvedItems",
              "continuationPoint",
              "trajectorySummary"
            ]
          }
        },
        profile: toLlmProfile(input.profile, input.sample.activeAgents),
        nameDecisionRequirement: buildNameDecisionRequirement(input.profile, input.locale),
        activeAgents: input.sample.activeAgents,
        preferenceEvidence: input.sample.queries,
        latestConversation: input.sample.latestConversation
      }, null, 2)
    }
  ];
}

function toLlmProfile(
  profile: OnboardingInsightProfileSignals,
  activeAgents: OnboardingInsightSampleSummary["activeAgents"]
) {
  const agentNames = new Map(activeAgents.map((agent) => [agent.sourceId, agent.displayName]));
  return {
    ...profile,
    taskCandidates: profile.taskCandidates.map((task) => ({
      title: task.title,
      summary: task.summary,
      project: task.project,
      relatedAgents: task.relatedAgents,
      score: task.score,
      latestQuery: toLlmQuerySignal(task.latestQuery, agentNames)
    })),
    highSignalQueries: profile.highSignalQueries.map((query) => toLlmQuerySignal(query, agentNames)),
    taskLikeQuery: profile.taskLikeQuery ? toLlmQuerySignal(profile.taskLikeQuery, agentNames) : null
  };
}

function toLlmQuerySignal(query: OnboardingSampledQuery, agentNames: ReadonlyMap<string, string>) {
  return {
    agentSource: agentNames.get(query.sourceId) ?? query.sourceId,
    createdAt: query.createdAt,
    workspacePath: query.workspacePath,
    text: clipReportQueryText(query.text)
  };
}

function splitLlmMessages(input: OnboardingInsightGenerationInput): { system: string; user: string } {
  const messages = buildLlmMessages(input);
  return {
    system: messages[0]?.content ?? "",
    user: messages[1]?.content ?? ""
  };
}

function buildResponsesRequestBody(
  input: OnboardingInsightGenerationInput,
  options: Pick<OpenAiCompatibleOnboardingInsightGeneratorOptions, "providerName" | "baseUrl" | "model">,
  maxTokens: number,
  stream: boolean
): Record<string, unknown> {
  const messages = splitLlmMessages(input);
  return {
    model: options.model,
    instructions: messages.system,
    input: messages.user,
    ...openAiCompatibleTemperatureFields(options, 0.2),
    max_output_tokens: maxTokens,
    stream,
    ...openAiCompatibleThinkingControlFields(options)
  };
}

function buildAnthropicRequestBody(
  input: OnboardingInsightGenerationInput,
  model: string,
  maxTokens: number,
  stream: boolean
): Record<string, unknown> {
  const messages = splitLlmMessages(input);
  return {
    model,
    system: messages.system,
    messages: [{ role: "user", content: messages.user }],
    temperature: 0.2,
    max_tokens: maxTokens,
    stream
  };
}

function buildGoogleRequestBody(input: OnboardingInsightGenerationInput, maxTokens: number): Record<string, unknown> {
  const messages = splitLlmMessages(input);
  return {
    systemInstruction: {
      parts: [{ text: messages.system }]
    },
    contents: [{
      role: "user",
      parts: [{ text: messages.user }]
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: maxTokens,
      thinkingConfig: {
        thinkingBudget: 0
      }
    }
  };
}

function openAiCompatibleThinkingControlFields(
  options: Pick<OpenAiCompatibleOnboardingInsightGeneratorOptions, "providerName" | "baseUrl" | "model">
): Record<string, unknown> {
  const model = options.model.toLowerCase();
  const provider = (options.providerName ?? "").toLowerCase();
  const baseUrl = options.baseUrl.toLowerCase();

  if (
    provider === "memmy_account" &&
    model.includes("agent_chat")
  ) {
    return { enable_thinking: false };
  }

  if (provider === "dashscope" || baseUrl.includes("dashscope") || model.includes("qwen")) {
    return { enable_thinking: false };
  }

  if (
    model.includes("deepseek") ||
    model.includes("glm") ||
    model.includes("kimi") ||
    model.includes("minimax") ||
    model.includes("mimo")
  ) {
    return { thinking: { type: "disabled" } };
  }

  return {};
}

function openAiCompatibleTemperatureFields(
  options: Pick<OpenAiCompatibleOnboardingInsightGeneratorOptions, "providerName" | "baseUrl" | "model">,
  temperature: number
): Record<string, number> {
  if (isMoonshotKimiImmutableTemperatureModel(options)) return {};
  return { temperature };
}

function isMoonshotKimiImmutableTemperatureModel(
  options: Pick<OpenAiCompatibleOnboardingInsightGeneratorOptions, "providerName" | "baseUrl" | "model">
): boolean {
  const model = options.model.toLowerCase();
  const provider = (options.providerName ?? "").toLowerCase();
  const baseUrl = options.baseUrl.toLowerCase();
  return (
    (provider === "moonshot" || provider === "kimi" || baseUrl.includes("moonshot")) &&
    (
      model.includes("kimi-k2.5") ||
      model.includes("kimi-k2.6") ||
      model.includes("k2.6-code-preview") ||
      model.startsWith("kimi-k2.7-code")
    )
  );
}

function extractLlmReport(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const choices = (body as { choices?: unknown }).choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as { message?: { content?: unknown }; text?: unknown } | undefined;
    const content = typeof first?.message?.content === "string"
      ? first.message.content
      : typeof first?.text === "string" ? first.text : null;
    return normalizeGeneratedOutput(content);
  }
  const outputText = (body as { output_text?: unknown }).output_text;
  return normalizeGeneratedOutput(typeof outputText === "string" ? outputText : null);
}

function extractAnthropicReport(body: unknown): string | null {
  const content = body && typeof body === "object" ? (body as { content?: unknown }).content : null;
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .filter((part): part is { text?: unknown } => typeof part === "object" && part !== null)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
  return normalizeGeneratedOutput(text);
}

function extractGoogleReport(body: unknown): string | null {
  const candidates = body && typeof body === "object" ? (body as { candidates?: unknown }).candidates : null;
  if (!Array.isArray(candidates)) {
    return null;
  }
  const first = candidates[0] as { content?: { parts?: unknown } } | undefined;
  const parts = first?.content?.parts;
  if (!Array.isArray(parts)) {
    return null;
  }
  const text = parts
    .filter((part): part is { text?: unknown } => typeof part === "object" && part !== null)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
  return normalizeGeneratedOutput(text);
}

async function* parseOpenAiCompatibleStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      yield* drainOpenAiStreamBuffer(buffer, (nextBuffer) => {
        buffer = nextBuffer;
      });
    }

    buffer += decoder.decode();
    yield* drainOpenAiStreamBuffer(`${buffer}\n\n`, (nextBuffer) => {
      buffer = nextBuffer;
    });
  } finally {
    reader.releaseLock();
  }
}

async function* parseAnthropicStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      yield* drainSseStreamBuffer(buffer, extractAnthropicStreamFrameDelta, (nextBuffer) => {
        buffer = nextBuffer;
      });
    }

    buffer += decoder.decode();
    yield* drainSseStreamBuffer(`${buffer}\n\n`, extractAnthropicStreamFrameDelta, (nextBuffer) => {
      buffer = nextBuffer;
    });
  } finally {
    reader.releaseLock();
  }
}

function* drainOpenAiStreamBuffer(
  buffer: string,
  updateBuffer: (buffer: string) => void
): Iterable<string> {
  yield* drainSseStreamBuffer(buffer, extractOpenAiStreamFrameDelta, updateBuffer);
}

function* drainSseStreamBuffer(
  buffer: string,
  extractDelta: (frame: string) => string | null,
  updateBuffer: (buffer: string) => void
): Iterable<string> {
  let nextBuffer = buffer;
  while (true) {
    const boundaryIndex = nextBuffer.indexOf("\n\n");
    if (boundaryIndex < 0) {
      break;
    }

    const frame = nextBuffer.slice(0, boundaryIndex);
    nextBuffer = nextBuffer.slice(boundaryIndex + 2);
    const delta = extractDelta(frame);
    if (delta) {
      yield delta;
    }
  }
  updateBuffer(nextBuffer);
}

function extractOpenAiStreamFrameDelta(frame: string): string | null {
  const data = frame
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");

  if (!data || data === "[DONE]") {
    return null;
  }

  try {
    return extractLlmDelta(JSON.parse(data));
  } catch {
    return null;
  }
}

function extractAnthropicStreamFrameDelta(frame: string): string | null {
  const data = frame
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");

  if (!data || data === "[DONE]") {
    return null;
  }

  try {
    const body = JSON.parse(data) as { type?: unknown; delta?: { text?: unknown } };
    return body.type === "content_block_delta" && typeof body.delta?.text === "string" ? body.delta.text : null;
  } catch {
    return null;
  }
}

function extractLlmDelta(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  if ((body as { type?: unknown }).type === "response.output_text.delta") {
    const delta = (body as { delta?: unknown }).delta;
    return typeof delta === "string" ? delta : null;
  }
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) {
    return null;
  }

  const first = choices[0] as { delta?: { content?: unknown }; text?: unknown } | undefined;
  if (typeof first?.delta?.content === "string") {
    return first.delta.content;
  }
  return typeof first?.text === "string" ? first.text : null;
}

function sanitizeGeneratedReport(report: string | null): string | null {
  const trimmed = stripActionCopyFromReport(stripRawHtmlTags(report ?? "")).trim();
  return trimmed ? trimmed.slice(0, 4_000) : null;
}

function stripRawHtmlTags(value: string, dropTrailingPartial = false): string {
  let output = "";
  let codeTicks = 0;
  for (let index = 0; index < value.length;) {
    if (value[index] === "`") {
      let end = index + 1;
      while (value[end] === "`") {
        end += 1;
      }
      const ticks = end - index;
      if (!codeTicks) {
        codeTicks = ticks;
      } else if (ticks >= codeTicks) {
        codeTicks = 0;
      }
      output += value.slice(index, end);
      index = end;
      continue;
    }
    if (codeTicks || value[index] !== "<") {
      output += value[index];
      index += 1;
      continue;
    }
    if (value.startsWith("<!--", index)) {
      const commentEnd = value.indexOf("-->", index + 4);
      if (commentEnd < 0) {
        return dropTrailingPartial ? output : `${output}${value.slice(index)}`;
      }
      index = commentEnd + 3;
      continue;
    }
    const tag = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>\n]*|\/?)>/.exec(value.slice(index));
    if (tag) {
      index += tag[0].length;
      continue;
    }
    const remainder = value.slice(index);
    if (dropTrailingPartial && (
      remainder === "<" || remainder === "</" || remainder === "<!" || remainder === "<!-" ||
      /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>\n]*)?$/.test(remainder)
    )) {
      return output;
    }
    output += "<";
    index += 1;
  }
  return output;
}

function stripActionCopyFromReport(report: string): string {
  const reportBody = report.split(/\[\s*MEMMY_ACTIONS_JSON\s*\]/i, 1)[0] ?? report;
  const paragraphs = reportBody
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return paragraphs
    .filter((paragraph) => !isActionCopyParagraph(paragraph))
    .join("\n\n");
}

function isActionCopyParagraph(paragraph: string): boolean {
  const normalized = paragraph
    .replace(/[*_`>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
  return /^(main button|primary button|also available|other options|secondary buttons?|cta)\b/.test(normalized) ||
    /^(主按钮|主要按钮|次级按钮|备选按钮|也可以|其他选项|可选项|行动按钮|按钮文案)\b/.test(normalized) ||
    /\b(main button|also available|button label|keep moving)\b/.test(normalized) ||
    /(?:主按钮|次级按钮|按钮文案)/.test(normalized) ||
    /^(好，帮我整合|继续这个任务|整理技术决策|找回并合并这项任务|继续最近未完成的任务|找回之前的关键决策|复盘上次怎么解决)\s*[:：-]?\s*$/.test(normalized);
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/g, "");
  return normalized.endsWith("/chat/completions") ? normalized : versionedEndpoint(normalized, "/v1/chat/completions");
}

function responsesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/g, "");
  return normalized.endsWith("/responses") ? normalized : versionedEndpoint(normalized, "/v1/responses");
}

function anthropicMessagesUrl(baseUrl: string): string {
  return versionedEndpoint(baseUrl, "/v1/messages");
}

function googleGenerateContentUrl(baseUrl: string, model: string): string {
  return versionedEndpoint(baseUrl, `/v1beta/models/${encodeURIComponent(model)}:generateContent`);
}

function versionedEndpoint(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/g, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (base.endsWith(normalizedPath)) {
    return base;
  }
  if (base.endsWith("/v1") && normalizedPath.startsWith("/v1/")) {
    return `${base}${normalizedPath.slice(3)}`;
  }
  if (base.endsWith("/v1beta") && normalizedPath.startsWith("/v1beta/")) {
    return `${base}${normalizedPath.slice(7)}`;
  }
  return `${base}${normalizedPath}`;
}

function timeoutSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function trimSentence(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...`;
}

function diagnostics(
  sample: SampleBundle,
  usedLlm: boolean,
  elapsedMs: number,
  reportLanguage?: "zh-CN" | "en-US"
): OnboardingInsightReportResponse["diagnostics"] {
  return {
    discoveredAgentCount: sample.discovered.length,
    sampledQueryCount: sample.queries.length,
    usedLlm,
    elapsedMs: Math.max(elapsedMs, sample.elapsedMs),
    ...(reportLanguage ? { reportLanguage } : {}),
    latestWorkspacePath: sample.latestConversation?.workspacePath ?? null,
    agents: sample.discovered.map((result) => ({
      sourceId: result.sourceId,
      displayName: result.displayName,
      recentSessionCount: result.recentSessionCount,
      queryCount: result.queries.length,
      latestActivityAt: result.latestActivityAt
    }))
  };
}
