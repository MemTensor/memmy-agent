/** Onboarding insight module. */
import {
  OnboardingInsightReportInputSchema,
  OnboardingInsightReportResponseSchema,
  OnboardingInsightReportStreamEventSchema,
  type OnboardingInsightReportStreamEvent
} from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PermissionManager } from "../../../../permission/index.js";
import type { OnboardingInsightService } from "../../../../services/onboarding-insight-service.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

export interface RegisterOnboardingInsightRoutesOptions {
  onboardingInsight: OnboardingInsightService;
  permissionManager: Pick<PermissionManager, "getScanPermission">;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

export function registerOnboardingInsightRoutes(
  app: FastifyInstance,
  options: RegisterOnboardingInsightRoutesOptions
): void {
  app.post(
    "/api/onboarding/insight-report",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = OnboardingInsightReportInputSchema.parse(request.body);
      const permission = await options.permissionManager.getScanPermission();
      if (permission !== "scan_only" && permission !== "scan_and_write_skill") {
        return reply.send(OnboardingInsightReportResponseSchema.parse({
          status: "skipped",
          reportMarkdown: "",
          secondaryActions: [],
          diagnostics: {
            discoveredAgentCount: 0,
            sampledQueryCount: 0,
            usedLlm: false,
            elapsedMs: 0,
            agents: []
          }
        }));
      }

      const response = await options.onboardingInsight.generateReport(input);
      return reply.send(OnboardingInsightReportResponseSchema.parse(response));
    })
  );

  app.post(
    "/api/onboarding/insight-report/stream",
    { preHandler: options.authenticateRuntimeToken },
    async (request, reply) => {
      const input = OnboardingInsightReportInputSchema.parse(request.body);
      const permission = await options.permissionManager.getScanPermission();

      startInsightReportStream(reply, getSingleHeaderValue(request.headers.origin));
      if (permission !== "scan_only" && permission !== "scan_and_write_skill") {
        writeInsightReportStreamEvent(reply, {
          type: "done",
          response: {
            status: "skipped",
            reportMarkdown: "",
            secondaryActions: [],
            diagnostics: {
              discoveredAgentCount: 0,
              sampledQueryCount: 0,
              usedLlm: false,
              elapsedMs: 0,
              agents: []
            }
          }
        });
        reply.raw.end();
        return;
      }

      try {
        for await (const event of options.onboardingInsight.streamReport(input, request.signal)) {
          writeInsightReportStreamEvent(reply, event);
        }
      } finally {
        reply.raw.end();
      }
    }
  );
}

function startInsightReportStream(reply: FastifyReply, origin: string | undefined): void {
  reply.hijack();
  const headers: Record<string, string> = {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }

  reply.raw.writeHead(200, {
    ...headers
  });
  reply.raw.flushHeaders?.();
}

function getSingleHeaderValue(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

function writeInsightReportStreamEvent(reply: FastifyReply, event: OnboardingInsightReportStreamEvent): void {
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    return;
  }
  const parsed = OnboardingInsightReportStreamEventSchema.parse(event);
  reply.raw.write(`event: ${parsed.type}\n`);
  reply.raw.write(`data: ${JSON.stringify(parsed)}\n\n`);
}
