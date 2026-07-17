import {
  OnboardingInsightReportInputSchema,
  OnboardingInsightReportResponseSchema,
  OnboardingInsightReportStreamEventSchema,
  type OnboardingInsightAction,
  type OnboardingInsightDiagnostics,
  type OnboardingInsightReportResponse,
  type OnboardingInsightReportStreamEvent
} from "@memmy/local-api-contracts";
import { requestJson } from "../api/http.js";
import { getRuntimeConfig } from "../api/runtime-config.js";
import type { ResolvedLanguage } from "../i18n/messages.js";

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

export interface FirstEncounterTaskAction {
  buttonLabel: string;
  description: string;
  suggestedPrompt: string;
}

export interface FirstEncounterReportPayload {
  body: string;
  actions: FirstEncounterTaskAction[];
  agents: DiscoveredAgent[];
  emptyHistory: boolean;
}

export interface FirstEncounterReportStreamDoneMeta {
  streamed: boolean;
}

export interface FirstEncounterReportStreamHandlers {
  onAgents?: (agents: DiscoveredAgent[]) => void;
  onChunk: (delta: string) => void;
  onDone: (payload: FirstEncounterReportPayload, meta: FirstEncounterReportStreamDoneMeta) => void;
}

export async function loadFirstEncounterReport(request: FirstEncounterReportRequest): Promise<FirstEncounterReportPayload> {
  const config = await getRuntimeConfig();
  const response = await requestJson({
    config,
    path: "/api/onboarding/insight-report",
    schema: OnboardingInsightReportResponseSchema,
    body: OnboardingInsightReportInputSchema.parse({
      locale: request.language
    })
  });
  const payload = toFirstEncounterReportPayload(response);
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
        stream: true
      }))
    });

    if (!response.ok || !response.body) {
      throw new Error(`first encounter report stream failed: ${response.status}`);
    }

    let streamed = false;
    for await (const event of readInsightReportStreamEvents(response.body)) {
      if (event.type === "sampled") {
        handlers.onAgents?.(toDiscoveredAgents(event.diagnostics));
      } else if (event.type === "chunk") {
        streamed = true;
        handlers.onChunk(event.delta);
      } else {
        handlers.onAgents?.(toDiscoveredAgents(event.response.diagnostics));
        const payload = toFirstEncounterReportPayload(event.response);
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

function toFirstEncounterTaskAction(action: OnboardingInsightAction): FirstEncounterTaskAction {
  return {
    buttonLabel: action.buttonLabel,
    description: action.description,
    suggestedPrompt: action.suggestedPrompt
  };
}

function toFirstEncounterReportPayload(response: OnboardingInsightReportResponse): FirstEncounterReportPayload | null {
  const body = response.reportMarkdown.trim();
  const actions = [
    response.primaryAction,
    ...response.secondaryActions
  ].filter((action): action is OnboardingInsightAction => Boolean(action)).map(toFirstEncounterTaskAction);

  return body ? {
    body,
    actions,
    agents: toDiscoveredAgents(response.diagnostics),
    emptyHistory: response.diagnostics.sampledQueryCount === 0
  } : null;
}

function toDiscoveredAgents(diagnostics: OnboardingInsightDiagnostics): DiscoveredAgent[] {
  return diagnostics.agents.map((agent) => ({
    sourceId: agent.sourceId,
    name: agent.displayName,
    conversations: agent.recentSessionCount
  }));
}
