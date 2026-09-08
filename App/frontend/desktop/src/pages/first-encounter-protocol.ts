import {
  OnboardingInsightReportInputSchema,
  OnboardingInsightReportResponseSchema,
  OnboardingInsightReportStreamEventSchema,
  type OnboardingInsightDiagnostics,
  type OnboardingInsightReportResponse,
  type OnboardingInsightReportStreamEvent
} from "@memmy/local-api-contracts";
import { requestJson } from "../api/http.js";
import { getRuntimeConfig } from "../api/runtime-config.js";
import { enUSMessages, zhCNMessages, type ResolvedLanguage } from "../i18n/messages.js";
import { buildFirstEncounterRelayPrompt } from "./first-encounter-relay-prompt.js";

export interface DiscoveredAgent {
  sourceId: string;
  name: string;
  conversations: number;
}

export interface FirstEncounterReportRequest {
  agents: DiscoveredAgent[];
  nickname: string;
  language: ResolvedLanguage;
}

export interface FirstEncounterReportPayload {
  body: string;
  agents: DiscoveredAgent[];
  emptyHistory: boolean;
  language: ResolvedLanguage;
  workspacePath: string | null;
  reportPrompt: string;
  relayPrompt: string;
}

export interface FirstEncounterReportStreamDoneMeta {
  streamed: boolean;
}

export interface FirstEncounterReportStreamHandlers {
  onAgents?: (agents: DiscoveredAgent[]) => void;
  onChunk: (delta: string, payload: FirstEncounterReportPayload) => void;
  onDone: (payload: FirstEncounterReportPayload, meta: FirstEncounterReportStreamDoneMeta) => void;
}

export async function loadFirstEncounterReport(request: FirstEncounterReportRequest): Promise<FirstEncounterReportPayload> {
  const config = await getRuntimeConfig();
  const response = await requestJson({
    config,
    path: "/api/onboarding/insight-report",
    schema: OnboardingInsightReportResponseSchema,
    body: OnboardingInsightReportInputSchema.parse({
      locale: request.language,
      detectedAgents: toDetectedAgents(request.agents)
    })
  });
  const payload = toFirstEncounterReportPayload(response, request.language);
  if (!payload) {
    throw new Error("first encounter report response is empty");
  }

  return payload;
}

export async function streamFirstEncounterReport(
  request: FirstEncounterReportRequest,
  handlers: FirstEncounterReportStreamHandlers
): Promise<void> {
  try {
    const config = await getRuntimeConfig();
    const response = await fetch(new URL("/api/onboarding/insight-report/stream", config.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-memmy-local-token": config.localToken
      },
      body: JSON.stringify(OnboardingInsightReportInputSchema.parse({
        locale: request.language,
        stream: true,
        detectedAgents: toDetectedAgents(request.agents)
      }))
    });

    if (!response.ok || !response.body) {
      throw new Error(`first encounter report stream failed: ${response.status}`);
    }

    let streamed = false;
    let streamedBody = "";
    let latestDiagnostics: OnboardingInsightDiagnostics | null = null;
    for await (const event of readInsightReportStreamEvents(response.body)) {
      if (event.type === "sampled") {
        latestDiagnostics = event.diagnostics;
        handlers.onAgents?.(toDiscoveredAgents(event.diagnostics));
      } else if (event.type === "chunk") {
        streamedBody += event.delta;
        const payload = latestDiagnostics
          ? toFirstEncounterReportPayload({
              status: "ready",
              reportMarkdown: streamedBody,
              diagnostics: latestDiagnostics
            }, request.language)
          : null;
        if (!payload) {
          continue;
        }
        streamed = true;
        handlers.onChunk(event.delta, payload);
      } else {
        handlers.onAgents?.(toDiscoveredAgents(event.response.diagnostics));
        const payload = toFirstEncounterReportPayload(event.response, request.language);
        if (!payload) {
          throw new Error("first encounter report response is empty");
        }
        handlers.onDone(payload, { streamed });
        return;
      }
    }

    throw new Error("first encounter report stream ended before done");
  } catch (error) {
    console.warn("stream first encounter report failed", error);
    throw error;
  }
}

function toDetectedAgents(agents: readonly DiscoveredAgent[]) {
  return agents.map((agent) => ({
    sourceId: agent.sourceId,
    displayName: agent.name,
    recentSessionCount: agent.conversations
  }));
}

async function* readInsightReportStreamEvents(body: ReadableStream<Uint8Array>): AsyncIterable<OnboardingInsightReportStreamEvent> {
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
      yield* drainInsightReportStreamBuffer(buffer, (nextBuffer) => {
        buffer = nextBuffer;
      });
    }

    buffer += decoder.decode();
    yield* drainInsightReportStreamBuffer(`${buffer}\n\n`, (nextBuffer) => {
      buffer = nextBuffer;
    });
  } finally {
    reader.releaseLock();
  }
}

function* drainInsightReportStreamBuffer(
  buffer: string,
  updateBuffer: (buffer: string) => void
): Iterable<OnboardingInsightReportStreamEvent> {
  let nextBuffer = buffer;
  while (true) {
    const boundaryIndex = nextBuffer.indexOf("\n\n");
    if (boundaryIndex < 0) {
      break;
    }

    const frame = nextBuffer.slice(0, boundaryIndex);
    nextBuffer = nextBuffer.slice(boundaryIndex + 2);
    const event = parseInsightReportStreamFrame(frame);
    if (event) {
      yield event;
    }
  }
  updateBuffer(nextBuffer);
}

function parseInsightReportStreamFrame(frame: string): OnboardingInsightReportStreamEvent | null {
  const data = frame
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");

  if (!data) {
    return null;
  }

  try {
    return OnboardingInsightReportStreamEventSchema.parse(JSON.parse(data));
  } catch {
    return null;
  }
}

function toFirstEncounterReportPayload(
  response: OnboardingInsightReportResponse,
  fallbackLanguage: ResolvedLanguage
): FirstEncounterReportPayload | null {
  const body = response.reportMarkdown.trim();
  const language = response.diagnostics.reportLanguage ?? fallbackLanguage;
  const workspacePath = response.diagnostics.latestWorkspacePath?.trim() || null;
  const messages = language === "zh-CN" ? zhCNMessages : enUSMessages;

  return body ? {
    body,
    agents: toDiscoveredAgents(response.diagnostics),
    emptyHistory: response.diagnostics.sampledQueryCount === 0,
    language,
    workspacePath,
    reportPrompt: messages["onboarding.report.userPrompt"],
    relayPrompt: buildFirstEncounterRelayPrompt(language, workspacePath)
  } : null;
}

function toDiscoveredAgents(diagnostics: OnboardingInsightDiagnostics): DiscoveredAgent[] {
  return diagnostics.agents.map((agent) => ({
    sourceId: agent.sourceId,
    name: agent.displayName,
    conversations: agent.recentSessionCount
  }));
}
