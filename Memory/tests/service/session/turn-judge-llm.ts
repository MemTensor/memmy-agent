import {
  DEFAULT_MEMMY_CONFIG,
  type LlmClient,
  type LlmCompletionOptions,
  type LlmMessage
} from "../../../src/index.js";
import {
  isTurnJudgeCall,
  turnJudgeUserText,
  type createMemoryServiceFixture
} from "../../fixtures/memory-service-fixture.js";

type TestService = ReturnType<ReturnType<typeof createMemoryServiceFixture>["createTestService"]>;

export type JudgeAnswer = Record<string, unknown> | Error;

export interface JudgeCall {
  messages: LlmMessage[];
  options: LlmCompletionOptions;
  user: string;
}

export function turnJudgeConfig(enabled = true): typeof DEFAULT_MEMMY_CONFIG {
  return {
    ...DEFAULT_MEMMY_CONFIG,
    algorithm: {
      ...DEFAULT_MEMMY_CONFIG.algorithm,
      session: { ...DEFAULT_MEMMY_CONFIG.algorithm.session, turnJudge: enabled }
    }
  };
}

export function l1For(user: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: `记录 ${user.slice(0, 10)}`,
    summary: `用户要求：${user.slice(0, 40)}`,
    evidence: [{ quote: user.slice(0, 12), role: "user", kind: "task_request" }],
    unverified_answer: false,
    ...overrides
  };
}

// Answers the per-turn judgment by the USER it is asked about; anything else
// gets a minimal valid answer for its operation.
export function createTurnJudgeLlm(answers: Record<string, JudgeAnswer[] | ((call: JudgeCall) => JudgeAnswer)> = {}): {
  llm: LlmClient;
  judgeCalls: JudgeCall[];
  otherCalls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }>;
} {
  const judgeCalls: JudgeCall[] = [];
  const otherCalls: Array<{ messages: LlmMessage[]; options: LlmCompletionOptions }> = [];
  const llm: LlmClient = {
    config: { ...DEFAULT_MEMMY_CONFIG.summary, provider: "host", endpoint: "http://127.0.0.1/turn-judge", model: "turn-judge" },
    isConfigured: () => true,
    async complete(_messages, options) {
      return options.operation.startsWith("episode_title")
        ? JSON.stringify({ title: "测试任务标题", summary: "测试任务摘要。" })
        : "unused";
    },
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> {
      if (options.operation === "episode.select.v1") return { episodeId: null, title: "测试任务标题", summary: "测试任务摘要。" } as unknown as T;
      if (options.operation === "capture.summarize" && isTurnJudgeCall(messages)) {
        const user = turnJudgeUserText(messages);
        const call = { messages, options, user };
        judgeCalls.push(call);
        const scripted = Object.entries(answers).find(([prefix]) => user.startsWith(prefix))?.[1];
        const answer = typeof scripted === "function"
          ? scripted(call)
          : scripted?.length ? scripted.shift()! : undefined;
        if (answer instanceof Error) throw answer;
        const taskEmpty = messages.at(-1)!.content.includes("<first_user_message></first_user_message>");
        return (answer ?? {
          relation: taskEmpty ? null : "follow_up",
          feedback: taskEmpty ? null : "neutral",
          reason: "default",
          l1: l1For(user),
          user: null
        }) as T;
      }
      otherCalls.push({ messages, options });
      if (options.operation === "capture.summarize") {
        return { l1: { title: "旧版标题", summary: "旧版概要", evidence: [] }, user: null } as unknown as T;
      }
      if (options.operation.startsWith("capture.reflection.batch")) return { scores: [] } as unknown as T;
      return { summary: "", reflection: "", alpha: 0.5, usable: false, tags: [] } as unknown as T;
    },
    status: () => ({ provider: "host", model: "turn-judge", configured: true, remote: true })
  };
  return { llm, judgeCalls, otherCalls };
}

export function openSession(service: TestService["service"], userId: string) {
  return service.openSession({ namespace: { source: "codex", profileId: "default", userId } });
}

export function rawTurnPayload(db: TestService["db"], rawTurnId: string): Record<string, any> {
  const row = db.db.prepare("SELECT message_payload_json FROM raw_turns WHERE id = ?").get(rawTurnId) as { message_payload_json: string };
  return JSON.parse(row.message_payload_json) as Record<string, any>;
}

export function memoryProperties(db: TestService["db"], memoryId: string): Record<string, any> {
  const row = db.db.prepare("SELECT info_json, properties_json FROM memories WHERE id = ?").get(memoryId) as {
    info_json: string;
    properties_json: string;
  };
  return { info: JSON.parse(row.info_json), ...JSON.parse(row.properties_json) } as Record<string, any>;
}

export function captureJob(db: TestService["db"], memoryId: string): Record<string, unknown> {
  const row = db.db.prepare(
    "SELECT payload_json FROM evolution_jobs WHERE job_type = 'trace_summary' AND target_memory_id = ? ORDER BY created_at LIMIT 1"
  ).get(memoryId) as { payload_json: string };
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}
