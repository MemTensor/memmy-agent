/**
 * 执行方那次审查的模型调用。
 *
 * <p>用的是这台电脑当前账号的「Agent 任务模型」（与协作、引导报告同一套解析），也就是谁的 Memmy 在跑就用谁的额度。
 * 模型不可用、超时（默认 30 秒）、返回解析不了，都当作「没能检查」——请求改成要她看过再决定。</p>
 *
 * <p>账号默认的模型是推理模型：不关掉思考时额度可能全用在思考上，正文为空，审查就被当成没完成。
 * 所以三种接口都按 onboarding 报告同一套写法关掉思考。</p>
 */
import {
  anthropicMessagesUrl,
  chatCompletionsUrl,
  openAiCompatibleTemperatureFields,
  openAiCompatibleThinkingControlFields
} from "../onboarding-insight-service.js";
import type { AssistReviewContent, ExecutorReviewRaw } from "./safety.js";
import { EXECUTOR_REVIEW_SYSTEM_PROMPT, executorReviewPrompt, parseExecutorReview } from "./safety.js";

/** 一次审查给模型的配置：provider、模型、地址与密钥，都由账号的 Agent 任务模型解析出。 */
export interface AssistReviewModel {
  providerName: string;
  model: string;
  apiBase: string;
  apiKey: string;
  apiType?: "auto" | "chatCompletions" | "responses";
  extraHeaders?: Readonly<Record<string, string>>;
  extraBody?: Readonly<Record<string, unknown>>;
}

export interface AssistReviewer {
  /** 执行方的那次：替执行人判断风险。返回 null 表示没能检查。 */
  reviewExecutor(content: AssistReviewContent): Promise<ExecutorReviewRaw | null>;
}

export interface AssistReviewerOptions {
  /** 解析当前的 Agent 任务模型；取不到时视为没能检查。 */
  resolveModel: () => Promise<AssistReviewModel | null | undefined>;
  /** 单次审查的上限，默认 30 秒。 */
  timeoutMs?: number;
  /** 回答长度上限：结论是一段短 JSON。 */
  maxTokens?: number;
  fetch?: typeof globalThis.fetch;
}

/** 审查的超时：30 秒。请求还在等她处理，再长就不值得让她等。 */
export const ASSIST_REVIEW_TIMEOUT_MS = 30_000;
/**
 * 回答长度上限 4096：这是上限、不是预留，模型回答多长就占多少额度。
 * 关闭思考的字段不是每家模型都认，关不掉的那些也要留出写正文的余量，否则正文为空、审查白跑。
 */
const REVIEW_MAX_TOKENS = 4_096;

export function createAssistReviewer(options: AssistReviewerOptions): AssistReviewer {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? ASSIST_REVIEW_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? REVIEW_MAX_TOKENS;

  async function ask(system: string, user: string): Promise<string | null> {
    let model: AssistReviewModel | null | undefined;
    try {
      model = await options.resolveModel();
    } catch {
      return null;
    }
    if (!model?.apiBase || !model.model) return null;
    try {
      return await callModel(fetchImpl, model, system, user, { timeoutMs, maxTokens });
    } catch {
      return null;
    }
  }

  return {
    async reviewExecutor(content) {
      const answer = await ask(EXECUTOR_REVIEW_SYSTEM_PROMPT, executorReviewPrompt(content));
      return answer ? parseExecutorReview(answer) : null;
    }
  };
}

/** 按 provider 走三种写法，返回模型回答的正文；失败时抛错，由调用方当成没能检查。 */
async function callModel(
  fetchImpl: typeof globalThis.fetch,
  model: AssistReviewModel,
  system: string,
  user: string,
  options: { timeoutMs: number; maxTokens: number }
): Promise<string | null> {
  const provider = model.providerName.toLowerCase();
  const signal = AbortSignal.timeout(options.timeoutMs);
  if (provider === "anthropic") {
    const response = await fetchImpl(anthropicMessagesUrl(model.apiBase), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": model.apiKey,
        "anthropic-version": "2023-06-01",
        ...(model.extraHeaders ?? {})
      },
      body: JSON.stringify({
        model: model.model,
        system,
        max_tokens: options.maxTokens,
        messages: [{ role: "user", content: user }],
        ...(model.extraBody ?? {})
      }),
      signal
    });
    if (!response.ok) return null;
    const data = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    return (data.content ?? []).map((item) => item.text ?? "").join("").trim() || null;
  }
  if (provider === "gemini" || provider === "google") {
    const base = model.apiBase.replace(/\/+$/u, "");
    const url = `${base}${base.endsWith("/v1beta") ? "" : "/v1beta"}`
      + `/models/${encodeURIComponent(model.model)}:generateContent`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": model.apiKey,
        ...(model.extraHeaders ?? {})
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: options.maxTokens,
          temperature: 0.1,
          thinkingConfig: { thinkingBudget: 0 }
        },
        ...(model.extraBody ?? {})
      }),
      signal
    });
    if (!response.ok) return null;
    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? "").join("");
    return text.trim() || null;
  }
  // 其余按 OpenAI 兼容的 chat completions 处理（账号直连与各家兼容接口都是这一套）。
  const response = await fetchImpl(chatCompletionsUrl(model.apiBase), {
    method: "POST",
    headers: {
      "authorization": `Bearer ${model.apiKey}`,
      "content-type": "application/json",
      ...(model.extraHeaders ?? {})
    },
    body: JSON.stringify({
      model: model.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      max_tokens: options.maxTokens,
      ...openAiCompatibleTemperatureFields({ providerName: model.providerName, baseUrl: model.apiBase, model: model.model }, 0.1),
      stream: false,
      ...openAiCompatibleThinkingControlFields({ providerName: model.providerName, baseUrl: model.apiBase, model: model.model }),
      ...(model.extraBody ?? {})
    }),
    signal
  });
  if (!response.ok) return null;
  const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : ""))
      .join("");
    return text.trim() || null;
  }
  return null;
}
