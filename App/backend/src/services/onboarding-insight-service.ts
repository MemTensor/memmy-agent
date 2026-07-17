import { basename } from "node:path";
import { homedir, userInfo } from "node:os";
import {
  OnboardingInsightActionSchema,
  OnboardingInsightReportResponseSchema,
  type OnboardingInsightAction,
  type OnboardingInsightActionType,
  type OnboardingInsightReportInput,
  type OnboardingInsightReportResponse,
  type OnboardingInsightReportStreamEvent
} from "@memmy/local-api-contracts";
import type {
  OnboardingInsightSampler,
  OnboardingSampleResult,
  OnboardingSampledQuery
} from "../adapters/outbound/agent-source/insight-sampler-types.js";
import { stripInlineMediaPayloads } from "../shared/inline-media-sanitizer.js";

const DEFAULT_SAMPLE_OPTIONS = {
  maxSessionFiles: 12,
  maxQueries: 24,
  maxQueryChars: 600,
  maxBytesPerFile: 768 * 1024,
  deadlineMs: 10_000
} as const;

const FIRST_LOGIN_SCAN_DEADLINE_MS = DEFAULT_SAMPLE_OPTIONS.deadlineMs;
const MAX_REPORT_QUERY_CHARS = DEFAULT_SAMPLE_OPTIONS.maxQueryChars;
const MAX_BALANCED_QUERIES = 96;
const MAX_RECENT_LLM_QUERIES = 10;
const MAX_BALANCED_LLM_QUERIES = 50;
const MAX_LLM_QUERIES = MAX_RECENT_LLM_QUERIES + MAX_BALANCED_LLM_QUERIES;
const DEFAULT_LLM_TIMEOUT_MS = 90_000;
const DEFAULT_LLM_MAX_TOKENS = 2_000;
const MEMMY_ACCOUNT_AGENT_CHAT_THINKING_BUDGET = 500;
const GENERATED_ACTIONS_MARKER = "[MEMMY_ACTIONS_JSON]";
const MAX_GENERATED_OUTPUT_CHARS = 12_000;

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
  reportGenerator?: OnboardingInsightReportGenerator | null;
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

interface GeneratedReportResult {
  reportMarkdown: string;
  actions: OnboardingInsightAction[] | null;
}

export interface OnboardingInsightGenerationInput {
  locale: "zh-CN" | "en-US";
  profile: OnboardingInsightProfileSignals;
  sample: OnboardingInsightSampleSummary;
  primaryAction: OnboardingInsightAction;
  secondaryActions: OnboardingInsightAction[];
  signal?: AbortSignal;
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
  actionType: OnboardingInsightActionType;
}

interface SampleBundle {
  discovered: OnboardingSampleResult[];
  queries: OnboardingSampledQuery[];
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
      const sample = await sampleRecentQueries(options.samplers, signal, now);
      const locale = input.locale ?? inferLocale(sample.queries);
      const profile = buildProfileSignals(sample);
      const elapsedMs = Math.max(0, now() - startedAt);
      const response = await buildReportResponse({
        profile,
        sample,
        locale,
        elapsedMs,
        reportGenerator,
        signal
      });
      return OnboardingInsightReportResponseSchema.parse(response);
    },
    async *streamReport(input = {}, signal) {
      const startedAt = now();
      const sample = await sampleRecentQueries(options.samplers, signal, now);
      yield {
        type: "sampled",
        diagnostics: diagnostics(sample, false, Math.max(0, now() - startedAt))
      };
      const locale = input.locale ?? inferLocale(sample.queries);
      const profile = buildProfileSignals(sample);
      const elapsedMs = Math.max(0, now() - startedAt);
      yield* streamReportResponse({
        profile,
        sample,
        locale,
        elapsedMs,
        reportGenerator,
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
            "content-type": "application/json"
          },
          body: JSON.stringify(useResponsesApi ? buildResponsesRequestBody(input, options, maxTokens, false) : {
            model: options.model,
            messages: buildLlmMessages(input),
            ...openAiCompatibleTemperatureFields(options, 0.2),
            max_tokens: maxTokens,
            stream: false,
            ...openAiCompatibleThinkingControlFields(options)
          }),
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
          "content-type": "application/json"
        },
        body: JSON.stringify(useResponsesApi ? buildResponsesRequestBody(input, options, maxTokens, true) : {
          model: options.model,
          messages: buildLlmMessages(input),
          ...openAiCompatibleTemperatureFields(options, 0.2),
          max_tokens: maxTokens,
          stream: true,
          ...openAiCompatibleThinkingControlFields(options)
        }),
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
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify(buildAnthropicRequestBody(input, options.model, maxTokens, false)),
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
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(buildAnthropicRequestBody(input, options.model, maxTokens, true)),
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
            "x-goog-api-key": options.apiKey
          },
          body: JSON.stringify(buildGoogleRequestBody(input, maxTokens)),
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

async function sampleRecentQueries(
  samplers: readonly OnboardingInsightSampler[],
  signal: AbortSignal | undefined,
  now: () => number
): Promise<SampleBundle> {
  const startedAt = now();
  const deadlineSignal = AbortSignal.timeout(FIRST_LOGIN_SCAN_DEADLINE_MS);
  const sampleSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
  const results = await Promise.all(samplers.map((sampler) => sampleSamplerWithinDeadline(sampler, sampleSignal)));
  const discovered = results.filter((result): result is OnboardingSampleResult => Boolean(result));
  const queries = selectBalancedQueries(discovered, MAX_BALANCED_QUERIES);

  return {
    discovered,
    queries,
    elapsedMs: Math.max(0, now() - startedAt)
  };
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
  const topKeywords = extractTopKeywords(sample.queries);
  const topProjects = extractTopProjects(sample.queries);
  const userInsights = extractUserInsights(sample.queries);
  const taskCandidates = extractTaskCandidates(sample.queries, sample.discovered);
  const taskLikeQuery = taskCandidates[0]?.latestQuery ?? findTaskLikeQuery(sample.queries);
  const highSignalQueries = sortQueriesRecent(sample.queries.filter((query) => HIGH_SIGNAL_PATTERN.test(query.text))).slice(0, 30);
  const allText = sample.queries.map((query) => query.text).join("\n");
  const sharedSignalCount = countSharedSignals(sample.discovered, topKeywords);

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
    taskLikeQuery,
    actionType: decideActionType({ sharedSignalCount, allText, taskLikeQuery })
  };
}

async function buildReportResponse(input: {
  profile: OnboardingInsightProfileSignals;
  sample: SampleBundle;
  locale: "zh-CN" | "en-US";
  elapsedMs: number;
  reportGenerator: OnboardingInsightReportGenerator | null | undefined;
  signal: AbortSignal | undefined;
}): Promise<OnboardingInsightReportResponse> {
  if (input.sample.queries.length === 0) {
    return {
      status: "ready",
      reportMarkdown: renderEmptyHistoryReport(input.locale),
      secondaryActions: [],
      diagnostics: diagnostics(input.sample, false, input.elapsedMs)
    };
  }

  const { primaryAction, secondaryActions } = buildReportActions(input.profile, input.sample, input.locale);
  const fallbackActions = [primaryAction, ...secondaryActions];
  const generatedReport = await generateReportSafely(input.reportGenerator, {
    locale: input.locale,
    profile: input.profile,
    sample: toSampleSummary(input.sample),
    primaryAction,
    secondaryActions,
    signal: input.signal
  }, fallbackActions);
  const actions = generatedReport?.actions ?? fallbackActions;

  return {
    status: "ready",
    reportMarkdown: generatedReport?.reportMarkdown ?? renderFallbackReport(input.profile, input.locale),
    primaryAction: actions[0],
    secondaryActions: actions.slice(1),
    diagnostics: diagnostics(input.sample, Boolean(generatedReport), input.elapsedMs)
  };
}

async function* streamReportResponse(input: {
  profile: OnboardingInsightProfileSignals;
  sample: SampleBundle;
  locale: "zh-CN" | "en-US";
  elapsedMs: number;
  reportGenerator: OnboardingInsightReportGenerator | null | undefined;
  signal: AbortSignal | undefined;
  startedAt: number;
  now: () => number;
}): AsyncIterable<OnboardingInsightReportStreamEvent> {
  if (input.sample.queries.length === 0) {
    yield {
      type: "done",
      response: {
        status: "ready",
        reportMarkdown: renderEmptyHistoryReport(input.locale),
        secondaryActions: [],
        diagnostics: diagnostics(input.sample, false, input.elapsedMs)
      }
    };
    return;
  }

  const { primaryAction, secondaryActions } = buildReportActions(input.profile, input.sample, input.locale);
  const fallbackActions = [primaryAction, ...secondaryActions];
  const generationInput: OnboardingInsightGenerationInput = {
    locale: input.locale,
    profile: input.profile,
    sample: toSampleSummary(input.sample),
    primaryAction,
    secondaryActions,
    signal: input.signal
  };
  let rawOutput = "";
  let pendingReport = "";
  let reachedActions = false;

  if (input.reportGenerator?.streamReport) {
    try {
      for await (const delta of input.reportGenerator.streamReport(generationInput)) {
        if (!delta) {
          continue;
        }
        rawOutput += delta;
        if (reachedActions) {
          continue;
        }

        pendingReport += delta;
        const markerIndex = pendingReport.indexOf(GENERATED_ACTIONS_MARKER);
        if (markerIndex >= 0) {
          const reportDelta = pendingReport.slice(0, markerIndex);
          if (reportDelta) {
            yield { type: "chunk", delta: reportDelta };
          }
          pendingReport = "";
          reachedActions = true;
          continue;
        }

        const heldLength = longestMarkerPrefixSuffixLength(pendingReport);
        const reportDelta = pendingReport.slice(0, pendingReport.length - heldLength);
        if (reportDelta) {
          yield { type: "chunk", delta: reportDelta };
        }
        pendingReport = pendingReport.slice(pendingReport.length - heldLength);
      }
      if (!reachedActions && pendingReport) {
        yield { type: "chunk", delta: pendingReport };
      }
    } catch {
      rawOutput = "";
    }
  }

  const generatedReport = parseGeneratedReportOutput(rawOutput, fallbackActions);
  const actions = generatedReport?.actions ?? fallbackActions;

  yield {
    type: "done",
    response: {
      status: "ready",
      reportMarkdown: generatedReport?.reportMarkdown ?? renderFallbackReport(input.profile, input.locale),
      primaryAction: actions[0],
      secondaryActions: actions.slice(1),
      diagnostics: diagnostics(input.sample, Boolean(generatedReport), Math.max(input.elapsedMs, input.now() - input.startedAt))
    }
  };
}

function buildReportActions(
  profile: OnboardingInsightProfileSignals,
  sample: SampleBundle,
  locale: "zh-CN" | "en-US"
): { primaryAction: OnboardingInsightAction; secondaryActions: OnboardingInsightAction[] } {
  const primaryAction = buildAction(profile.actionType, profile, sample.queries, locale);
  return {
    primaryAction,
    secondaryActions: buildSecondaryActions(primaryAction.type, profile, sample.queries, locale)
  };
}

function renderFallbackReport(profile: OnboardingInsightProfileSignals, locale: "zh-CN" | "en-US"): string {
  return locale === "en-US" ? renderEnglishReport(profile) : renderChineseReport(profile);
}

function renderEmptyHistoryReport(locale: "zh-CN" | "en-US"): string {
  return locale === "en-US" ? [
    "There are no records on this device that Memmy can read yet. From now on, though, Memmy will keep capturing the experience, decisions, and context that emerge from your conversations with Agents. The next time you start a new conversation or switch Agents, Memmy can inject the relevant memories directly, so you do not have to explain the background all over again.",
    "That includes project naming conventions, your preferred implementation style, pitfalls you have already encountered, and the root cause uncovered by a debugging session—things that recur in daily work but should not need to be explained repeatedly. They will become reusable long-term memory.",
    "If you switch between Agents such as Cursor and Codex, Memmy can also connect the context scattered across them. What moves is not merely a chat log, but a working task state that can be continued. Starting with this conversation, Memmy is officially on the job."
  ].join("\n\n") : [
    "这台设备上还没有 Memmy 可以读取的记录，不过从现在开始，你和 Agent 对话中产生的经验、决策和上下文，Memmy 会帮你持续沉淀下来。下一次开新对话或者切换 Agent 时，Memmy 可以直接注入相关记忆，不用你每次重新解释背景。",
    "比如项目里的命名约定、你偏好的实现方式、某个问题踩过的坑、一次排查最终定位到的原因——这些在日常工作中反复出现却不该反复解释的东西，之后都会变成可复用的长期记忆。",
    "如果你在 Cursor、Codex 等不同 Agent 之间切换工作，Memmy 也能把分散的上下文串起来——迁移的不是聊天记录，而是可以继续执行的任务现场。从这次对话开始，Memmy 就正式上班了。"
  ].join("\n\n");
}

async function generateReportSafely(
  reportGenerator: OnboardingInsightReportGenerator | null | undefined,
  input: OnboardingInsightGenerationInput,
  fallbackActions: readonly OnboardingInsightAction[]
): Promise<GeneratedReportResult | null> {
  try {
    return parseGeneratedReportOutput(await reportGenerator?.generateReport(input) ?? null, fallbackActions);
  } catch {
    return null;
  }
}

function parseGeneratedReportOutput(
  output: string | null,
  fallbackActions: readonly OnboardingInsightAction[]
): GeneratedReportResult | null {
  const normalized = normalizeGeneratedOutput(output);
  if (!normalized) {
    return null;
  }

  const markerIndex = normalized.indexOf(GENERATED_ACTIONS_MARKER);
  const reportMarkdown = sanitizeGeneratedReport(markerIndex >= 0 ? normalized.slice(0, markerIndex) : normalized);
  if (!reportMarkdown) {
    return null;
  }

  return {
    reportMarkdown,
    actions: markerIndex >= 0
      ? parseGeneratedActions(normalized.slice(markerIndex + GENERATED_ACTIONS_MARKER.length), fallbackActions)
      : null
  };
}

function parseGeneratedActions(
  rawJson: string,
  fallbackActions: readonly OnboardingInsightAction[]
): OnboardingInsightAction[] | null {
  try {
    const parsed = JSON.parse(rawJson) as { actions?: unknown };
    if (!Array.isArray(parsed.actions) || parsed.actions.length !== fallbackActions.length) {
      return null;
    }
    const generatedActions = parsed.actions;

    const actions = fallbackActions.map((fallback, index) => {
      const candidate = generatedActions[index];
      if (!candidate || typeof candidate !== "object") {
        return null;
      }
      const fields = candidate as Record<string, unknown>;
      if (fields.type !== fallback.type) {
        return null;
      }

      const buttonLabel = generatedActionText(fields.buttonLabel, 1, 40, false);
      const description = generatedActionText(fields.description, 1, 160, false);
      const suggestedPrompt = generatedActionText(fields.suggestedPrompt, 24, 2_000, true);
      if (!buttonLabel || !description || !suggestedPrompt) {
        return null;
      }

      const result = OnboardingInsightActionSchema.safeParse({
        ...fallback,
        buttonLabel,
        description,
        suggestedPrompt
      });
      return result.success ? result.data : null;
    });

    if (actions.some((action) => !action)) {
      return null;
    }
    const validActions = actions as OnboardingInsightAction[];
    if (
      new Set(validActions.map((action) => action.buttonLabel)).size !== validActions.length ||
      new Set(validActions.map((action) => action.suggestedPrompt)).size !== validActions.length
    ) {
      return null;
    }
    return validActions;
  } catch {
    return null;
  }
}

function generatedActionText(value: unknown, minLength: number, maxLength: number, allowLineBreaks: boolean): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (
    text.length < minLength ||
    text.length > maxLength ||
    text.includes(GENERATED_ACTIONS_MARKER) ||
    (!allowLineBreaks && /[\r\n]/.test(text))
  ) {
    return null;
  }
  return text;
}

function normalizeGeneratedOutput(output: string | null): string | null {
  const trimmed = (output ?? "").trim();
  return trimmed ? trimmed.slice(0, MAX_GENERATED_OUTPUT_CHARS) : null;
}

function longestMarkerPrefixSuffixLength(value: string): number {
  const maxLength = Math.min(value.length, GENERATED_ACTIONS_MARKER.length - 1);
  for (let length = maxLength; length > 0; length -= 1) {
    if (GENERATED_ACTIONS_MARKER.startsWith(value.slice(-length))) {
      return length;
    }
  }
  return 0;
}

function renderChineseReport(profile: OnboardingInsightProfileSignals): string {
  const lines: string[] = [];
  const nameLine = renderChineseNameLine(profile.nameHints);
  if (nameLine) {
    lines.push(nameLine);
  }

  const primaryTask = profile.taskCandidates[0] ?? null;
  if (primaryTask) {
    lines.push(`我看你最近主要在推进 ${primaryTask.title}。${renderChineseTaskSummary(primaryTask)}`);
  } else if (profile.topProjects.length > 0 || profile.topKeywords.length > 0) {
    lines.push(`我先捕捉到的重点是 ${[...profile.topProjects.slice(0, 2), ...profile.topKeywords.slice(0, 4)].join("、")}。`);
  }

  if (profile.userInsights.length > 0) {
    lines.push(`你的工作方式也有几个稳定信号：${profile.userInsights.slice(0, 3).map((insight) => insight.textZh).join("")}`);
  }

  const relatedAgents = profile.taskCandidates[0]?.relatedAgents.length
    ? profile.taskCandidates[0].relatedAgents
    : profile.activeAgentNames.slice(0, 3);
  if (relatedAgents.length > 1) {
    lines.push(`这些线索分散在 ${relatedAgents.join("、")} 里，我可以先帮你合成一段可继续执行的上下文。`);
  } else {
    lines.push("我可以先把最近任务整理成一段可继续执行的上下文。");
  }

  return lines.join("\n\n");
}

function renderEnglishReport(profile: OnboardingInsightProfileSignals): string {
  const lines: string[] = [];
  const nameLine = renderEnglishNameLine(profile.nameHints);
  if (nameLine) {
    lines.push(nameLine);
  }

  const primaryTask = profile.taskCandidates[0] ?? null;
  if (primaryTask) {
    lines.push(`You seem to be focused on ${renderEnglishTaskTitle(primaryTask)}. ${renderEnglishTaskSummary(primaryTask)}`);
  } else if (profile.topProjects.length > 0 || profile.topKeywords.length > 0) {
    lines.push(`The strongest signals I see are ${[...profile.topProjects.slice(0, 2), ...profile.topKeywords.slice(0, 4)].join(", ")}.`);
  }

  if (profile.userInsights.length > 0) {
    lines.push(`Your working style has a few stable signals: ${profile.userInsights.slice(0, 3).map((insight) => insight.textEn).join(" ")}`);
  }

  const relatedAgents = profile.taskCandidates[0]?.relatedAgents.length
    ? profile.taskCandidates[0].relatedAgents
    : profile.activeAgentNames.slice(0, 3);
  if (relatedAgents.length > 1) {
    lines.push(`These clues are spread across ${relatedAgents.join(", ")}. I can turn them into a compact context for the next step.`);
  } else {
    lines.push("I can turn the recent task clues into a compact context for the next step.");
  }

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

function renderChineseTaskSummary(task: TaskCandidate): string {
  if (/mindock-agent|记忆扫描|首次登录/.test(task.title)) {
    return "这条线索集中在记忆扫描边界、首次登录报告、跨 Agent 接续和 token 成本控制。";
  }
  if (/bitrade/i.test(task.title)) {
    return "这条线索集中在参考既有项目架构，补齐 TUI、日志、运行方式和错误处理等稳定性能力。";
  }
  if (isDocumentDump(task.summary)) {
    return "这条线索已经有多个相关上下文，可以继续整理成执行计划。";
  }
  return trimSentence(task.summary, 120);
}

function renderEnglishTaskSummary(task: TaskCandidate): string {
  if (/mindock-agent|memory scan|onboarding|记忆扫描|首次登录/i.test(task.title)) {
    return "The thread centers on scan boundaries, first-login reporting, cross-agent continuation, and token cost control.";
  }
  if (/bitrade/i.test(task.title)) {
    return "The thread centers on borrowing the existing project architecture and adding TUI, logging, runtime flow, and error handling.";
  }
  if (isDocumentDump(task.summary)) {
    return "There is enough related context to turn it into an execution plan.";
  }
  return trimSentence(task.summary, 120);
}

function renderEnglishTaskTitle(task: TaskCandidate): string {
  const project = task.project;
  if (project) {
    if (/mindock-agent|memmy/i.test(project) || /onboarding|扫描|记忆|memory/i.test(task.title)) {
      return `${project} memory scanning and first-login experience`;
    }
    if (/bitrade/i.test(project)) {
      return `${project} engineering architecture and stability work`;
    }
    return `${project} current task`;
  }
  if (/首次登录|onboarding/i.test(task.title)) {
    return "first-login lightweight scan experience";
  }
  if (/扫描|记忆|memory/i.test(task.title)) {
    return "memory scanning and cross-agent synthesis";
  }
  if (/排错|debug|problem/i.test(task.title)) {
    return "recent debugging task";
  }
  return "recent continuing task";
}

function renderChineseContextTask(task: TaskCandidate): string {
  if (!isGenericChineseTaskTitle(task.title)) {
    return task.title;
  }
  return trimSentence(task.summary || task.latestQuery.text, 120) || task.title;
}

function isGenericChineseTaskTitle(title: string): boolean {
  return title === "最近的连续任务" || /的当前任务$/.test(title);
}

function renderEnglishContextTask(task: TaskCandidate): string {
  const title = renderEnglishTaskTitle(task);
  if (!isGenericEnglishTaskTitle(title)) {
    return title;
  }
  return trimSentence(task.summary || task.latestQuery.text, 140) || title;
}

function isGenericEnglishTaskTitle(title: string): boolean {
  return title === "recent continuing task" || / current task$/.test(title);
}

function buildAction(
  type: OnboardingInsightActionType,
  profile: OnboardingInsightProfileSignals,
  queries: readonly OnboardingSampledQuery[],
  locale: "zh-CN" | "en-US"
): OnboardingInsightAction {
  const agents = (profile.taskCandidates[0]?.relatedAgents.length
    ? profile.taskCandidates[0].relatedAgents
    : profile.activeAgentNames
  ).slice(0, 3);
  const keywords = profile.topKeywords.slice(0, 5);
  const contextSummary = summarizeContext(profile, queries, locale);

  if (locale === "en-US") {
    if (type === "cross_agent_synthesis") {
      return {
        type,
        buttonLabel: "Alright, pull it together",
        description: agents.length > 1 ? `Merge related threads from ${agents.join(", ")}` : "Merge recent related threads",
        contextSummary,
        relatedAgents: agents,
        topicKeywords: keywords,
        suggestedPrompt: `Use these recent cross-Agent conversation signals to organize the task background, key decisions, unfinished items, and next execution plan.\n\n${contextSummary}`
      };
    }

    if (type === "problem_diagnosis") {
      return {
        type,
        buttonLabel: "Continue debugging",
        description: "Pick up the recent error, build, or debugging context",
        contextSummary,
        relatedAgents: agents,
        topicKeywords: keywords,
        suggestedPrompt: `Continue debugging this issue. First recap what has already been tried, then give the smallest verification steps.\n\n${contextSummary}`
      };
    }

    if (type === "decision_doc") {
      return {
        type,
        buttonLabel: "Summarize the decisions",
        description: "Turn recent tradeoffs into a clean decision record",
        contextSummary,
        relatedAgents: agents,
        topicKeywords: keywords,
        suggestedPrompt: `Turn these discussions into a technical decision record covering background, options, tradeoffs, conclusions, and open validation questions.\n\n${contextSummary}`
      };
    }

    return {
      type: "continue_task",
      buttonLabel: "Continue this task",
      description: "Pick up the current work from recent conversations",
      contextSummary,
      relatedAgents: agents,
      topicKeywords: keywords,
      suggestedPrompt: `Use these recent conversation signals to continue the current task.\n\n${contextSummary}`
    };
  }

  if (type === "cross_agent_synthesis") {
    return {
      type,
      buttonLabel: "好，帮我整合",
      description: agents.length > 1 ? `整合 ${agents.join("、")} 中的相关讨论` : "整合最近的相关讨论",
      contextSummary,
      relatedAgents: agents,
      topicKeywords: keywords,
      suggestedPrompt: `请根据这些最近的跨 Agent 对话线索，帮我整理当前任务背景、关键决策、未完成事项和下一步执行计划。\n\n${contextSummary}`
    };
  }

  if (type === "problem_diagnosis") {
    return {
      type,
      buttonLabel: "继续排查问题",
      description: "接续最近的报错、构建或调试上下文",
      contextSummary,
      relatedAgents: agents,
      topicKeywords: keywords,
      suggestedPrompt: `请接着排查这个问题，先复盘已尝试内容，再给出最小验证步骤。\n\n${contextSummary}`
    };
  }

  if (type === "decision_doc") {
    return {
      type,
      buttonLabel: "整理技术决策",
      description: "把最近讨论过的方案和取舍整理成决策记录",
      contextSummary,
      relatedAgents: agents,
      topicKeywords: keywords,
      suggestedPrompt: `请把这些讨论整理成技术决策记录，包含背景、选项、取舍、结论和待验证问题。\n\n${contextSummary}`
    };
  }

  return {
    type: "continue_task",
    buttonLabel: "继续这个任务",
    description: "基于最近对话接续当前工作",
    contextSummary,
    relatedAgents: agents,
    topicKeywords: keywords,
    suggestedPrompt: `请基于这些最近对话线索，帮我继续推进当前任务。\n\n${contextSummary}`
  };
}

function buildSecondaryActions(
  primaryType: OnboardingInsightActionType,
  profile: OnboardingInsightProfileSignals,
  queries: readonly OnboardingSampledQuery[],
  locale: "zh-CN" | "en-US"
): OnboardingInsightAction[] {
  const candidates: OnboardingInsightActionType[] = ["continue_task", "decision_doc", "problem_diagnosis", "cross_agent_synthesis"];
  return candidates
    .filter((type) => type !== primaryType)
    .slice(0, 2)
    .map((type) => buildAction(type, profile, queries, locale));
}

function summarizeContext(
  profile: OnboardingInsightProfileSignals,
  queries: readonly OnboardingSampledQuery[],
  locale: "zh-CN" | "en-US"
): string {
  if (locale === "en-US") {
    const pieces = [
      profile.topProjects.length > 0 ? `Projects: ${profile.topProjects.slice(0, 3).join(", ")}` : null,
      profile.topKeywords.length > 0 ? `Topics: ${profile.topKeywords.slice(0, 6).join(", ")}` : null,
      profile.userInsights.length > 0 ? `User preferences: ${profile.userInsights.slice(0, 3).map((insight) => insight.textEn).join(" ")}` : null,
      renderContextLanguagePreference(profile, locale),
      profile.taskCandidates.length > 0
        ? `Recent tasks: ${profile.taskCandidates.slice(0, 2).map(renderEnglishContextTask).join("; ")}`
        : `Recent task: ${trimSentence(queries[0]?.text ?? "", 180)}`
    ].filter((piece): piece is string => Boolean(piece));
    return pieces.join("; ");
  }

  const pieces = [
    profile.topProjects.length > 0 ? `项目：${profile.topProjects.slice(0, 3).join("、")}` : null,
    profile.topKeywords.length > 0 ? `主题：${profile.topKeywords.slice(0, 6).join("、")}` : null,
    profile.userInsights.length > 0 ? `用户偏好：${profile.userInsights.slice(0, 3).map((insight) => insight.textZh).join("")}` : null,
    renderContextLanguagePreference(profile, locale),
    profile.taskCandidates.length > 0
      ? `最近任务：${profile.taskCandidates.slice(0, 2).map(renderChineseContextTask).join("；")}`
      : `最近任务：${trimSentence(queries[0]?.text ?? "", 180)}`
  ].filter((piece): piece is string => Boolean(piece));
  return pieces.join("；");
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

function countSharedSignals(results: readonly OnboardingSampleResult[], keywords: readonly string[]): number {
  return keywords.filter((keyword) => {
    const pattern = TOPIC_PATTERNS.find((topic) => topic.keyword === keyword)?.pattern;
    if (!pattern) {
      return false;
    }
    return results.filter((result) => result.queries.some((query) => pattern.test(query.text))).length > 1;
  }).length;
}

function decideActionType(input: {
  sharedSignalCount: number;
  allText: string;
  taskLikeQuery: OnboardingSampledQuery | null;
}): OnboardingInsightActionType {
  if (input.sharedSignalCount > 0) {
    return "cross_agent_synthesis";
  }
  if (PROBLEM_PATTERN.test(input.allText)) {
    return "problem_diagnosis";
  }
  if (DECISION_PATTERN.test(input.allText)) {
    return "decision_doc";
  }
  return input.taskLikeQuery ? "continue_task" : "open_ended";
}

function inferLocale(queries: readonly OnboardingSampledQuery[]): "zh-CN" | "en-US" {
  return inferPreferredResponseLanguage(queries) ?? "en-US";
}

function inferPreferredResponseLanguage(queries: readonly OnboardingSampledQuery[]): "zh-CN" | "en-US" | null {
  let chineseCount = 0;
  let englishCount = 0;

  for (const query of queries.slice(0, 90)) {
    const language = classifyQueryLanguage(query.text);
    if (language === "zh-CN") {
      chineseCount += 1;
    } else if (language === "en-US") {
      englishCount += 1;
    }
  }

  const total = chineseCount + englishCount;
  if (total === 0) {
    return null;
  }
  if (chineseCount / total >= 0.55) {
    return "zh-CN";
  }
  if (englishCount / total >= 0.55) {
    return "en-US";
  }
  return null;
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
  const reportQueries = selectLlmReportQueries(sample.discovered);
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
    }))
  };
}

function selectLlmReportQueries(results: readonly OnboardingSampleResult[]): OnboardingSampledQuery[] {
  const recent = sortQueriesRecent(results.flatMap((result) => result.queries)).slice(0, MAX_RECENT_LLM_QUERIES);
  const seen = new Set(recent.map(queryKey));
  const balanced = selectBalancedQueries(results, MAX_LLM_QUERIES)
    .filter((query) => {
      const key = queryKey(query);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, MAX_BALANCED_LLM_QUERIES);

  return [...recent, ...balanced].slice(0, MAX_LLM_QUERIES);
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
        "你是 Memmy 首次登录初见卡片撰写者，风格接近年度总结/Spotify Wrapped 的私人化开场，不是技术报告。",
        "只依据输入里的明确证据，不要编造。",
        "不要把 diagnostics 写给用户，不要出现“轻量样本、采样、query 数、discoveredAgentCount”等实现细节。",
        "你必须根据 user.profile.nameHints 综合判断用户可能希望被怎么称呼。nameHints.selfDeclaredNames 来自扫描到的用户自称，homePathName 是 home 路径最后一段，computerUserName 是电脑用户名，homeAndComputerMatch 表示 home 路径名和电脑用户名一致。",
        "名字判断默认优先使用 homePathName，因为用户一定有 home 路径；不要因为 selfDeclaredNames 为空就省略称呼。只有当 homePathName 是 admin、administrator、root、ubuntu、user、test、guest、default、runner、ec2-user 这类泛化账号名，或明显不是可称呼名字时，才降低它的优先级。",
        "selfDeclaredNames 和 computerUserName 是辅助判断线索：如果 selfDeclaredNames 有明确人名，可以结合它修正称呼；如果 homePathName 与 computerUserName 一致，说明本机线索更可信。",
        "第一句必须包含你判断出的具体称呼：中文报告以“Hi <称呼>，”开头，英文报告以“Hi <name>, ”开头。不得省略名字，不得把名字替换成“这个线索”“这个称呼”“X”等占位词。",
        "严禁出现“本机账号显示为”“本机用户名/路径名显示为”“local username/path shows”“我检测到你的用户名”这类工程口径。",
        "不要向用户暴露 nameHints、homePathName、computerUserName 这些字段名或来源；如果本机线索只是临时称呼，要用柔和语气表达“如果不对，告诉我就好”。中英文混合名不要使用。",
        "输出中文或英文由 locale 决定。中文时语气要像产品首登卡片：具体、克制、懂用户、有一点年度总结感，不要像调试日志或分析报告。",
        "profile.preferredResponseLanguage 来自最近用户 query 的主语言统计，不要求用户明确说“请用中文/英文”。如果有值，可以自然理解为后续回复语言偏好。",
        "用户偏好/习惯段必须明确写出用户更习惯用中文还是英文交流。如果 profile.preferredResponseLanguage 是 zh-CN，写用户最近更常用中文；如果是 en-US，写用户最近更常用英文。",
        "这份报告的第一目标是任务接续，不是泛泛画像。优先回答：用户最近正在做什么任务、任务散落在哪些 Agent、哪些上下文可以迁到 Memmy Agent 继续完成。",
        "必须重点阅读 recentTaskSignals。它代表按时间倒序排列的最近 10 条任务线索；请按任务聚类，提炼主任务、未完成事项、下一步可执行动作。",
        "必须覆盖：对用户的了解、偏好/习惯、最近正在推进的任务、可跨 Agent 整合或接续的任务。",
        "正文长度是硬约束：中文 600-800 字，英文 400-600 words。低于或高于这个范围都视为失败；不要输出短卡片，也不要写成长报告。",
        "正文结构是硬约束：写 5-7 个自然段，每段 2-4 句。段落顺序依次覆盖：开场称呼与总体判断、最近最主要任务、最近 10 条任务线索如何聚类、任务分别来自哪些 Agent、用户工作偏好/协作习惯、当前最适合接续到 Memmy Agent 的事项、下一步执行计划与温和收束。",
        "每段都必须包含至少一个明确线索、偏好判断或可执行下一步。证据不足时写“我只能先按这些线索判断”，但仍然按上述结构展开。",
        "要自然引导用户从 Claude Code、Codex、Cursor、Hermes 等 Agent 的上下文切到 Memmy Agent 里继续做事，强调任务接续、上下文整合、决策整理和下一步执行，不要贬低其他工具，不要写营销口号。",
        "除了报告正文，你还必须为 actionCandidates 中的 3 个行动类型分别生成按钮文案和点击后可直接发送给 Agent 的完整请求。类型和顺序必须与 actionCandidates 完全一致。",
        "三个按钮必须指向三个不同且具体的后续动作。buttonLabel 要简短；description 要说明点击后会做什么；suggestedPrompt 必须写清具体任务背景、目标和预期产出，不能只写“继续当前任务”“整理最近讨论”之类的泛化句子。",
        "suggestedPrompt 要把输入中的事实自然组织成通顺请求，不要机械罗列“项目：...；主题：...；用户偏好：...；最近任务：...”等字段，也不要编造输入中不存在的项目、结论或进度。",
        "中文 buttonLabel 建议 4-12 字、description 不超过 40 字、suggestedPrompt 80-240 字；英文保持同等信息密度。",
        `输出格式是硬约束：先输出报告正文，然后紧接一行 ${GENERATED_ACTIONS_MARKER}，再输出一行 JSON。JSON 结构必须是 {"actions":[{"type":"...","buttonLabel":"...","description":"...","suggestedPrompt":"..."}]}，包含且只包含 3 个 action。`,
        "报告正文里严禁出现 Main button、Also available、主按钮、次级按钮、CTA、button label、keep moving 或任何按钮说明。内部标记和 JSON 只能出现在正文之后，不要使用 markdown 代码块，不要输出 markdown 表格，不暴露任何密钥。"
      ].join("\n")
    },
    {
      role: "user",
      content: JSON.stringify({
        locale: input.locale,
        reportGoal: {
          primary: "task_continuation",
          lengthConstraint: input.locale === "zh-CN"
            ? "600-800 Chinese characters, 5-7 natural paragraphs, 2-4 sentences per paragraph"
            : "400-600 English words, 5-7 natural paragraphs, 2-4 sentences per paragraph",
          mustNotBeShort: true,
          requiredParagraphPlan: [
            "opening_with_name_or_safe_greeting",
            "main_recent_task",
            "cluster_recent_10_task_signals",
            "agent_context_sources",
            "user_working_preferences",
            "best_tasks_to_continue_in_memmy_agent",
            "next_execution_plan",
            "warm_closing"
          ],
          focus: [
            "最近任务是什么",
            "这些任务分别来自哪些 Agent 上下文",
            "哪些任务最适合接续到 Memmy Agent",
            "如何把跨 Agent 讨论整合成下一步执行计划"
          ]
        },
        recentTaskSignals: selectRecentTaskSignals(input.sample.queries),
        profile: toLlmProfile(input.profile, input.sample.activeAgents),
        nameDecisionRequirement: buildNameDecisionRequirement(input.profile, input.locale),
        sample: input.sample,
        actionCandidates: [input.primaryAction, ...input.secondaryActions].map((action, index) => ({
          priority: index === 0 ? "primary" : "secondary",
          type: action.type,
          objective: renderActionObjective(action.type, input.locale),
          contextSummary: action.contextSummary,
          relatedAgents: action.relatedAgents,
          topicKeywords: action.topicKeywords
        }))
      }, null, 2)
    }
  ];
}

function renderActionObjective(type: OnboardingInsightActionType, locale: "zh-CN" | "en-US"): string {
  const objectives: Record<OnboardingInsightActionType, { zh: string; en: string }> = {
    continue_task: {
      zh: "选择最具体、最适合立即执行的近期任务并继续推进",
      en: "Continue the most concrete recent task with an immediately executable next step"
    },
    cross_agent_synthesis: {
      zh: "整合不同 Agent 中属于同一任务的背景、决策、未完成事项和下一步",
      en: "Merge background, decisions, unfinished work, and next steps for one task across agents"
    },
    decision_doc: {
      zh: "把近期讨论中的方案、取舍、结论和待验证问题整理成决策记录",
      en: "Turn recent options, tradeoffs, conclusions, and open questions into a decision record"
    },
    problem_diagnosis: {
      zh: "接续一个有明确证据的问题，复盘已尝试内容并给出最小验证步骤",
      en: "Resume a supported issue, recap prior attempts, and propose the smallest verification steps"
    },
    open_ended: {
      zh: "基于近期线索提出一个具体、可执行的后续动作",
      en: "Propose one concrete and executable follow-up based on recent evidence"
    }
  };
  return locale === "zh-CN" ? objectives[type].zh : objectives[type].en;
}

function selectRecentTaskSignals(queries: OnboardingInsightSampleSummary["queries"]): OnboardingInsightSampleSummary["queries"] {
  return [...queries]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, 10);
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
    return {
      enable_thinking: true,
      thinking_budget: MEMMY_ACCOUNT_AGENT_CHAT_THINKING_BUDGET
    };
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
  const trimmed = stripActionCopyFromReport(report ?? "").trim();
  return trimmed ? trimmed.slice(0, 4_000) : null;
}

function stripActionCopyFromReport(report: string): string {
  const paragraphs = report
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
    /^(好，帮我整合|继续这个任务|整理技术决策)\s*[:：-]?\s*$/.test(normalized);
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

function diagnostics(sample: SampleBundle, usedLlm: boolean, elapsedMs: number): OnboardingInsightReportResponse["diagnostics"] {
  return {
    discoveredAgentCount: sample.discovered.length,
    sampledQueryCount: sample.queries.length,
    usedLlm,
    elapsedMs: Math.max(elapsedMs, sample.elapsedMs),
    agents: sample.discovered.map((result) => ({
      sourceId: result.sourceId,
      displayName: result.displayName,
      recentSessionCount: result.recentSessionCount,
      queryCount: result.queries.length,
      latestActivityAt: result.latestActivityAt
    }))
  };
}
