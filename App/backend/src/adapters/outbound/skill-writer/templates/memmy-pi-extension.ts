/** Pi Memmy extension template. */

export function renderMemmyPiExtension(): string {
  return String.raw`import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SOURCE = "pi";
const CONFIG_URL = new URL("./memmy-memory-config.json", import.meta.url);
const DEFAULT_MEMMY_CONFIG_PATH = join(homedir(), ".memmy", "config.yaml");
const FETCH_TIMEOUT_MS = 45000;
const SEARCH_LIMIT = 20;
const DISPLAY_LIMIT = 5;
const RESUME_STATE_TTL_MS = 10 * 60 * 1000;
const RESUME_CONTEXT_MAX_CHARS = 24000;

export default function memmyPiExtension(pi: ExtensionAPI): void {
  const pendingTurns = new Map<string, PendingTurn>();
  let pendingResume: PendingResume | null = null;
  let selectedResumeContext = "";
  let captureQueue = Promise.resolve();
  let turnSequence = 0;

  pi.on("before_agent_start", async (event, ctx) => {
    const query = sanitizeText(event.prompt);
    if (!query || isResumeCommand(query)) {
      return;
    }
    let injectedContext = selectedResumeContext;
    selectedResumeContext = "";
    const startParentId = ctx.sessionManager.getLeafId();
    turnSequence += 1;
    const requestedTurnId = "pi-turn-" + hashText([
      ctx.sessionManager.getSessionId(),
      startParentId || "root",
      query,
      String(turnSequence)
    ].join("\u0000"));
    try {
      const memmy = await createMemmyClient();
      const externalSessionId = "pi-memory-" + ctx.sessionManager.getSessionId();
      const opened = await memmy.post("/api/v1/sessions/open", {
        sessionId: externalSessionId,
        source: SOURCE,
        workspacePath: ctx.cwd || undefined
      });
      const sessionId = normalizeText(opened.sessionId) || externalSessionId;
      const turn = await memmy.post("/api/v1/turns/start", {
        adapterId: "memmy-pi-extension",
        requestId: "pi-start:" + requestedTurnId,
        sessionId,
        turnId: requestedTurnId,
        query: redactSecrets(query),
        source: SOURCE
      });
      pendingTurns.set(requestedTurnId, {
        sessionId,
        turnId: normalizeText(turn.turnId) || requestedTurnId,
        episodeId: normalizeText(turn.episodeId) || undefined,
        sourceMemoryIds: Array.isArray(turn.sourceMemoryIds) ? turn.sourceMemoryIds : undefined,
        initialQuery: query,
        startParentId
      });
      const recalled = normalizeText(turn.injectedContext && turn.injectedContext.markdown);
      injectedContext = [injectedContext, recalled].filter(Boolean).join("\n\n");
    } catch {
      pendingTurns.delete(requestedTurnId);
    }

    if (injectedContext) {
      return {
        message: {
          customType: "memmy-memory-context",
          content: renderMemoryContext(injectedContext, query),
          display: true
        }
      };
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const captures = settledCaptures(ctx, pendingTurns);
    if (!captures.length) {
      return;
    }
    for (const capture of captures) {
      pendingTurns.delete(capture.pendingKey);
      if (capture.stopReason === "aborted") {
        markSessionEntriesHandled(pi, capture.entryIds, "aborted");
        continue;
      }
      if (!capture.answer) {
        continue;
      }
      const job = captureQueue.then(async () => {
        await completeTurn(capture.turn, capture.query, capture.answer, capture.status);
        markSessionEntriesHandled(pi, capture.entryIds, capture.status);
      });
      captureQueue = job.catch(() => undefined);
      await job.catch(() => undefined);
    }
  });

  pi.on("session_shutdown", async () => {
    pendingTurns.clear();
    pendingResume = null;
    selectedResumeContext = "";
    await captureQueue;
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !/^[1-5]$/u.test(event.text.trim())) {
      return { action: "continue" };
    }
    const selection = Number(event.text.trim());
    const state = pendingResume;
    if (!state || Date.now() - state.createdAt > RESUME_STATE_TTL_MS) {
      pendingResume = null;
      return { action: "continue" };
    }
    const candidate = state.candidates.find((item) => item.index === selection);
    if (!candidate) {
      return { action: "continue" };
    }
    try {
      const memmy = await createMemmyClient();
      const detail = await memmy.get("/api/v1/memory/" + encodeURIComponent(candidate.episodeId));
      pendingResume = null;
      selectedResumeContext = buildResumeContext(candidate, detail);
      ctx.ui.notify("Resuming Memmy episode " + candidate.episodeId, "info");
      return {
        action: "transform",
        text: "Continue Memmy episode " + candidate.episodeId + ": " + (candidate.title || candidate.episodeId),
        images: event.images
      };
    } catch (error) {
      ctx.ui.notify("Memmy resume failed: " + formatError(error), "warning");
      return { action: "handled" };
    }
  });

  pi.registerCommand("memmy-resume", {
    description: "Find and resume a prior Memmy episode",
    handler: async (args, ctx) => {
      const query = normalizeText(args);
      if (!query) {
        ctx.ui.notify("Usage: /memmy-resume <query>", "warning");
        return;
      }
      if (query === "cancel") {
        pendingResume = null;
        ctx.ui.notify("Memmy resume selection cancelled.", "info");
        return;
      }
      try {
        const memmy = await createMemmyClient();
        const result = await memmy.post("/api/v1/memory/search", {
          query,
          layers: ["L1"],
          limit: SEARCH_LIMIT,
          verbose: true,
          source: SOURCE
        });
        const candidates = await buildEpisodeCandidates(memmy, result);
        pendingResume = { createdAt: Date.now(), candidates };
        ctx.ui.notify(formatResumeCandidates(query, candidates), "info");
      } catch (error) {
        ctx.ui.notify("Memmy resume search failed: " + formatError(error), "warning");
      }
    }
  });
}

interface PendingTurn {
  sessionId: string;
  turnId: string;
  episodeId?: string;
  sourceMemoryIds?: unknown[];
  initialQuery: string;
  startParentId: string | null;
}

interface SettledCapture {
  pendingKey: string;
  turn: PendingTurn;
  query: string;
  answer: string;
  status: "succeeded" | "failed";
  stopReason: string;
  entryIds: string[];
}

interface ResumeCandidate {
  index: number;
  episodeId: string;
  title: string;
  summary: string;
}

interface PendingResume {
  createdAt: number;
  candidates: ResumeCandidate[];
}

async function completeTurn(
  turn: PendingTurn,
  query: string,
  answer: string,
  status: "succeeded" | "failed"
): Promise<void> {
  const memmy = await createMemmyClient();
  await memmy.post("/api/v1/turns/" + encodeURIComponent(turn.turnId) + "/complete", {
    adapterId: "memmy-pi-extension",
    requestId: "pi-complete:" + turn.turnId + ":" + hashText(answer),
    sessionId: turn.sessionId,
    episodeId: turn.episodeId,
    query: redactSecrets(query),
    answer: redactSecrets(answer),
    status,
    source: SOURCE,
    sourceMemoryIds: turn.sourceMemoryIds
  });
}

function settledCaptures(ctx: ExtensionContext, pendingTurns: Map<string, PendingTurn>): SettledCapture[] {
  const branch = ctx.sessionManager.getBranch();
  const claimedUserEntryIds = new Set<string>();
  const located = [...pendingTurns].flatMap(([pendingKey, turn]) => {
    const parentIndex = turn.startParentId ? branch.findIndex((entry) => entry.id === turn.startParentId) : -1;
    const firstUserIndex = branch.findIndex((entry, index) =>
      index > parentIndex &&
      entry.type === "message" &&
      entry.message.role === "user" &&
      !claimedUserEntryIds.has(entry.id) &&
      messageText(entry.message) === turn.initialQuery
    );
    if (firstUserIndex < 0) return [];
    claimedUserEntryIds.add(branch[firstUserIndex]!.id);
    return [{ pendingKey, turn, firstUserIndex }];
  }).sort((left, right) => left.firstUserIndex - right.firstUserIndex);
  const captures: SettledCapture[] = [];
  for (const [index, current] of located.entries()) {
    const nextStartIndex = located[index + 1]?.firstUserIndex ?? branch.length;
    const runEntries = branch.slice(current.firstUserIndex, nextStartIndex).filter((entry) => entry.type === "message");
    const userTexts = runEntries
      .filter((entry) => entry.type === "message" && entry.message.role === "user")
      .map((entry) => entry.type === "message" ? messageText(entry.message) : "")
      .filter(Boolean);
    const assistantEntries = runEntries.filter((entry) =>
      entry.type === "message" && entry.message.role === "assistant"
    );
    const lastAssistant = assistantEntries.at(-1);
    if (!lastAssistant || lastAssistant.type !== "message" || lastAssistant.message.role !== "assistant") {
      continue;
    }
    const stopReason = normalizeText(lastAssistant.message.stopReason);
    const assistantTexts = assistantEntries
      .map((entry) => entry.type === "message" ? messageText(entry.message) : "")
      .filter(Boolean);
    const errorMessage = sanitizeText(lastAssistant.message.errorMessage);
    captures.push({
      pendingKey: current.pendingKey,
      turn: current.turn,
      query: userTexts.join("\n\n"),
      answer: assistantTexts.join("\n\n") || (stopReason === "error" ? errorMessage : ""),
      status: stopReason === "error" ? "failed" : "succeeded",
      stopReason,
      entryIds: runEntries.map((entry) => entry.id)
    });
  }
  return captures;
}

function messageText(message: { content: unknown }): string {
  if (typeof message.content === "string") return sanitizeText(message.content);
  if (!Array.isArray(message.content)) return "";
  return sanitizeText(message.content
    .filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n"));
}

function markSessionEntriesHandled(
  pi: ExtensionAPI,
  entryIds: string[],
  status: "succeeded" | "failed" | "aborted"
): void {
  if (!entryIds.length) return;
  pi.appendEntry("memmy-memory-capture", { entryIds, status });
}

async function buildEpisodeCandidates(memmy: MemmyClient, result: Record<string, unknown>): Promise<ResumeCandidate[]> {
  const hits = extractHits(result).slice(0, SEARCH_LIMIT);
  const candidates = new Map<string, Omit<ResumeCandidate, "index">>();
  for (const hit of hits) {
    const memoryId = normalizeText(hit.id || hit.memoryId || hit.refId);
    if (!memoryId) continue;
    const detail = await memmy.get("/api/v1/memory/" + encodeURIComponent(memoryId)).catch(() => ({}));
    const refs = isRecord(detail.refs) ? detail.refs : {};
    const episode = isRecord(refs.episode) ? refs.episode : {};
    const episodeId = normalizeText(episode.id || detail.episodeId || hit.episodeId) ||
      (memoryId.startsWith("episode_") ? memoryId : "");
    if (!episodeId || candidates.has(episodeId)) continue;
    candidates.set(episodeId, {
      episodeId,
      title: normalizeText(episode.title || detail.title || hit.title) || episodeId,
      summary: normalizeText(episode.summary || detail.summary || hit.summary || hit.body)
    });
    if (candidates.size >= DISPLAY_LIMIT) break;
  }
  return [...candidates.values()].map((candidate, index) => ({ ...candidate, index: index + 1 }));
}

function extractHits(result: Record<string, unknown>): Record<string, unknown>[] {
  const debug = isRecord(result.debug) ? result.debug : {};
  for (const value of [result.hits, debug.hits, result.results, debug.results, result.memories, debug.memories]) {
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function formatResumeCandidates(query: string, candidates: ResumeCandidate[]): string {
  if (!candidates.length) return "No L1 Memmy memories found for: \"" + query + "\"";
  return [
    "Memmy resume candidates for \"" + query + "\":",
    "",
    ...candidates.map((candidate) => candidate.index + ". " + candidate.episodeId +
      "\n   " + truncate(candidate.title, 160) +
      (candidate.summary ? "\n   " + truncate(candidate.summary, 260) : "")),
    "",
    "Enter 1-5 to resume, or /memmy-resume cancel."
  ].join("\n");
}

function buildResumeContext(candidate: ResumeCandidate, detail: Record<string, unknown>): string {
  return truncate([
    "The user selected this prior Memmy episode and wants to continue it.",
    "Episode id: " + candidate.episodeId,
    "Episode title: " + candidate.title,
    normalizeText(detail.body) ? "Episode detail:\n" + normalizeText(detail.body) : "",
    JSON.stringify(detail, null, 2)
  ].filter(Boolean).join("\n\n"), RESUME_CONTEXT_MAX_CHARS);
}

function renderMemoryContext(markdown: string, query: string): string {
  return [
    "<memmy_memory_context source=\"pi\">",
    markdown,
    "</memmy_memory_context>",
    "",
    "<current_user_request>",
    query,
    "</current_user_request>"
  ].join("\n");
}

interface MemmyClient {
  get(path: string): Promise<Record<string, unknown>>;
  post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
}

async function createMemmyClient(): Promise<MemmyClient> {
  const localConfig = await readJsonConfig();
  const configPath = normalizeText(process.env.MEMMY_CONFIG) || normalizeText(localConfig.memmy_config_path) || DEFAULT_MEMMY_CONFIG_PATH;
  const runtimeConfig = await readYamlConfig(configPath).catch(() => ({}));
  const baseUrl = normalizeText(runtimeConfig.endpoint || localConfig.endpoint || "http://127.0.0.1:18960").replace(/\/+$/u, "");
  const token = normalizeText(runtimeConfig.token || localConfig.token);
  return {
    async get(path) {
      return request(new URL(path, baseUrl), { method: "GET", headers: token ? { authorization: "Bearer " + token } : {} });
    },
    async post(path, body) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token) headers.authorization = "Bearer " + token;
      return request(new URL(path, baseUrl), { method: "POST", headers, body: JSON.stringify({ ...body, source: SOURCE }) });
    }
  };
}

async function request(url: URL, init: RequestInit): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(normalizeText(data?.error?.message) || response.statusText || "Memmy HTTP " + response.status);
    return isRecord(data) ? data : {};
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonConfig(): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(CONFIG_URL, "utf8"));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

async function readYamlConfig(path: string): Promise<Record<string, string>> {
  const content = await readFile(path, "utf8");
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s+(endpoint|token):\s*(.*?)\s*$/u);
    if (match && !values[match[1]]) values[match[1]] = match[2].replace(/^['"]|['"]$/gu, "");
  }
  return values;
}

function isResumeCommand(value: string): boolean {
  return /^\/?memmy-resume(?:\s|$)/u.test(value.trim());
}

function sanitizeText(value: unknown): string {
  return normalizeText(value).replace(/\u0000/gu, "").trim();
}

function redactSecrets(input: string): string {
  return redactBase64Runs(input
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "[REDACTED:ssh_private_key]")
    .replace(/\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, "$1[REDACTED:authorization_bearer]")
    .replace(/\bsk-ant-api\d{2}-[A-Za-z0-9_-]{40,}\b/gu, "[REDACTED:anthropic_api_key]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}\b/gu, "[REDACTED:openai_api_key]")
    .replace(/\bAIza[A-Za-z0-9_-]{32,}\b/gu, "[REDACTED:google_api_key]")
    .replace(/\b([A-Za-z0-9_]*password[A-Za-z0-9_]*\s*[:=]\s*)(?:"[^"\n]+"|'[^'\n]+'|[^\s#&]+)/giu, "$1[REDACTED:password]"));
}

function redactBase64Runs(input: string): string {
  return input.replace(/(^|[^A-Za-z0-9_])([A-Za-z0-9+/]{32,}={0,2})(?=$|[^A-Za-z0-9_])/gu, "$1[REDACTED:base64_secret]");
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit - 1) + "…";
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`;
}
