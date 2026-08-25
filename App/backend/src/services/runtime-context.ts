/** Runtime context module. */
import type { FastifyRequest } from "fastify";
import { normalizeTimeZoneOffset } from "../utils/time-zone.js";

/** Contract for runtime context. */
export interface RuntimeContext {
  adapterId: string;
  requestId?: string;
  signal?: AbortSignal;
  timeZone?: string;
  userId?: string;
}

/** Builds runtime context from renderer request headers. */
export function runtimeContextFromRequest(request: FastifyRequest, configuredTimeZone?: string): RuntimeContext {
  const header = request.headers["x-memmy-time-zone"];
  const requestTimeZone = Array.isArray(header) ? header[0] : header;
  const timeZone = normalizeTimeZoneOffset(configuredTimeZone?.trim() || requestTimeZone);
  return {
    adapterId: "runtime",
    timeZone
  };
}
