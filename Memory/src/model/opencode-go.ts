import { createHash } from "node:crypto";
import type { LlmConfig } from "../config/index.js";

/** Only Go connections need these defaults; custom headers are case-insensitive. */
export function openCodeGoHeaders(config: LlmConfig, sessionId: string): Record<string, string> {
  const explicit = config.extraHeaders ?? {};
  if (!isOpenCodeGo(config)) return explicit;
  const names = new Set(Object.keys(explicit).map(name => name.toLowerCase()));
  return {
    ...(!names.has("x-opencode-session") ? {
      "x-opencode-session": `ses_memmy_${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`
    } : {}),
    ...(!names.has("user-agent") ? { "user-agent": "memmy-memory" } : {}),
    ...explicit
  };
}

function isOpenCodeGo(config: LlmConfig): boolean {
  if (config.sourceProvider?.toLowerCase().replace(/[_-]/g, "") === "opencodego") return true;
  try {
    const endpoint = new URL(config.endpoint ?? "");
    return endpoint.hostname === "opencode.ai" && /^\/(?:zen|inference)\/go(?:\/|$)/.test(endpoint.pathname);
  } catch {
    return false;
  }
}
