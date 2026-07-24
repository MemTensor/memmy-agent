/** Memmy resume hook template. */

export type MemmyResumeHookMode = "claude-code" | "codex" | "cursor";

export interface RenderMemmyResumeHookScriptOptions {
  source: string;
  mode: MemmyResumeHookMode;
}

/** Renders the Node hook script used by prompt-submit hooks. */
export function renderMemmyResumeHookScript(options: RenderMemmyResumeHookScriptOptions): string {
  return String.raw`#!/usr/bin/env node
import { readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SOURCE = ${JSON.stringify(options.source)};
const MODE = ${JSON.stringify(options.mode)};
const CONFIG_URL = new URL("./memmy-memory-config.json", import.meta.url);
const STATE_URL = new URL("./memmy-resume-state.json", import.meta.url);
const DEFAULT_MEMMY_CONFIG_PATH = join(homedir(), ".memmy", "config.yaml");
const FETCH_TIMEOUT_MS = 45000;
const SEARCH_LIMIT = 20;
const DISPLAY_LIMIT = 5;
const STATE_TTL_MS = 10 * 60 * 1000;
const TURN_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const RESUME_CONTEXT_MAX_CHARS = 24000;

async function main() {
  const input = await readStdin();
  const payload = parseJson(input) || {};
  if (isAgentResponseEvent(payload)) {
    try {
      await rememberAgentResponse(payload);
    } catch {
      // Observation hooks must never interrupt the host agent.
    }
    writeObservationOutput();
    return;
  }
  if (isStopEvent(payload)) {
    try {
      await captureCompletedTurn(payload);
    } catch {
      // Memory capture must not interrupt host turn completion.
    }
    writeStopOutput();
    return;
  }

  const prompt = extractPrompt(payload);
  const selection = parseResumeSelection(prompt);
  if (selection) {
    try {
      const client = await createMemmyClient();
      const state = await readPendingState();
      const selected = resolvePendingSelection(state, selection, sessionStateKey(payload));
      if (selected) {
        const detail = await client.get("/api/v1/memory/" + encodeURIComponent(selected.episodeId));
        await clearPendingState();
        writeResumeContextOutput(buildResumeContext(selected, detail));
        return;
      }
    } catch (error) {
      writeResultOutput("Memmy resume selection failed: " + formatError(error));
      return;
    }
  }

  const query = parseResumeQuery(prompt);
  if (!isResumeCommand(prompt)) {
    try {
      const started = await startCapturedTurn(payload, prompt);
      writeTurnStartOutput(started);
    } catch {
      writeAllowOutput();
    }
    return;
  }

  if (!query) {
    writeResultOutput("Usage: /memmy-resume <query>");
    return;
  }

  if (query === "cancel") {
    await clearPendingState();
    writeResultOutput("Memmy resume selection cancelled.");
    return;
  }

  try {
    const client = await createMemmyClient();
    const result = await client.post("/api/v1/memory/search", {
      query,
      layers: ["L1"],
      limit: SEARCH_LIMIT,
      verbose: true,
      source: SOURCE
    });
    const candidates = await buildEpisodeCandidates(client, query, result);
    await writePendingState({
      createdAt: new Date().toISOString(),
      sessionKey: sessionStateKey(payload),
      query,
      candidates: candidates.map(candidate => ({
        index: candidate.index,
        episodeId: candidate.episodeId,
        title: candidate.title,
        score: candidate.score
      }))
    });
    writeResultOutput(formatResumeSearchResult(query, candidates));
  } catch (error) {
    writeResultOutput("Memmy resume search failed: " + formatError(error));
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(data));
  });
}

function parseJson(value) {
  try {
    return value.trim() ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function isStopEvent(payload) {
  return normalizeText(payload.hook_event_name || payload.hookEventName).toLowerCase() === "stop";
}

function isAgentResponseEvent(payload) {
  return MODE === "cursor" &&
    normalizeText(payload.hook_event_name || payload.hookEventName).toLowerCase() === "afteragentresponse";
}

async function captureCompletedTurn(payload) {
  const pending = await readTurnState(payload);
  const transcriptPath = normalizeText(payload.transcript_path || payload.transcriptPath);
  const transcriptMessages = transcriptPath ? await readTranscriptMessages(transcriptPath) : [];
  const query = sanitizeCaptureText(
    normalizeText(pending && pending.query) ||
    latestMessageText(transcriptMessages, "user") ||
    extractPrompt(payload)
  );
  const answer = sanitizeCaptureText(
    normalizeText(pending && pending.answer) ||
    normalizeText(payload.last_assistant_message || payload.lastAssistantMessage) ||
    latestMessageText(transcriptMessages, "assistant")
  );
  if (!query || !answer || isResumeCommand(query)) {
    return;
  }

  const client = await createMemmyClient();
  const externalSessionId = memoryExternalSessionId(payload);
  const opened = await client.post("/api/v1/sessions/open", {
    sessionId: externalSessionId,
    source: SOURCE,
    workspacePath: workspacePath(payload) || undefined
  });
  const sessionId = normalizeText(opened.sessionId) || externalSessionId;
  const turnId = normalizeText(pending && pending.turnId) || platformTurnId(payload) ||
    SOURCE + "-fallback-" + hashText([sessionId, query, answer].join("\\u0000"));

  await client.post("/api/v1/turns/" + encodeURIComponent(turnId) + "/complete", {
    adapterId: "memmy-" + SOURCE + "-hook",
    requestId: SOURCE + "-complete:" + turnId + ":" + hashText(answer),
    sessionId,
    episodeId: normalizeText(pending && pending.episodeId) || undefined,
    query,
    answer,
    status: completedTurnStatus(payload),
    source: SOURCE,
    sourceMemoryIds: Array.isArray(pending && pending.sourceMemoryIds) ? pending.sourceMemoryIds : undefined
  });
  await writeTurnState(payload, {
    ...(pending || {}),
    createdAt: normalizeText(pending && pending.createdAt) || new Date().toISOString(),
    sessionId,
    turnId,
    episodeId: normalizeText(pending && pending.episodeId) || undefined,
    query,
    answer,
    completedAt: new Date().toISOString()
  });
}

async function startCapturedTurn(payload, prompt) {
  const query = sanitizeCaptureText(prompt);
  if (!query) {
    return null;
  }
  const client = await createMemmyClient();
  const externalSessionId = memoryExternalSessionId(payload);
  const opened = await client.post("/api/v1/sessions/open", {
    sessionId: externalSessionId,
    source: SOURCE,
    workspacePath: workspacePath(payload) || undefined
  });
  const sessionId = normalizeText(opened.sessionId) || externalSessionId;
  const requestedTurnId = platformTurnId(payload) ||
    SOURCE + "-turn-" + hashText([sessionId, query, String(Date.now())].join("\\u0000"));
  const turn = await client.post("/api/v1/turns/start", {
    adapterId: "memmy-" + SOURCE + "-hook",
    requestId: SOURCE + "-start:" + requestedTurnId,
    sessionId,
    turnId: requestedTurnId,
    query
  });
  const state = {
    createdAt: new Date().toISOString(),
    sessionId,
    turnId: normalizeText(turn && turn.turnId) || requestedTurnId,
    episodeId: normalizeText(turn && turn.episodeId) || undefined,
    query,
    sourceMemoryIds: Array.isArray(turn && turn.sourceMemoryIds) ? turn.sourceMemoryIds : undefined,
    answer: ""
  };
  await writeTurnState(payload, state);
  return turn;
}

async function rememberAgentResponse(payload) {
  const pending = await readTurnState(payload);
  if (!pending) {
    return;
  }
  const answer = sanitizeCaptureText(
    normalizeText(payload.text) ||
    normalizeText(payload.last_assistant_message || payload.lastAssistantMessage)
  );
  if (!answer) {
    return;
  }
  await writeTurnState(payload, {
    ...pending,
    answer
  });
}

async function readTranscriptMessages(filePath) {
  const content = await readFile(filePath, "utf8").catch(() => "");
  const messages = [];
  for (const line of content.split(/\r?\n/u)) {
    const item = parseJson(line);
    const extracted = transcriptMessageFromRecord(item);
    if (extracted) {
      messages.push(extracted);
    }
  }
  return messages;
}

function transcriptMessageFromRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }
  const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
  if (record.type === "response_item" && payload.type === "message") {
    const role = normalizeText(payload.role);
    if (role === "user" || role === "assistant") {
      const text = contentText(payload.content);
      return text ? { role, text } : null;
    }
  }
  if (record.type === "event_msg" && payload.type === "user_message") {
    const text = normalizeText(payload.message);
    return text ? { role: "user", text } : null;
  }
  const message = record.message && typeof record.message === "object" ? record.message : {};
  const role = normalizeText(message.role) || normalizeText(record.role) ||
    (record.type === "user" || record.type === "assistant" ? record.type : "");
  if (role === "user" || role === "assistant") {
    const text = contentText(message.content || record.content || record.text);
    return text ? { role, text } : null;
  }
  return null;
}

function latestMessageText(messages, role) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === role && normalizeText(message.text)) {
      return message.text;
    }
  }
  return "";
}

function extractPrompt(payload) {
  const direct = [
    payload.prompt,
    payload.user_prompt,
    payload.userPrompt,
    payload.prompt_text,
    payload.promptText,
    payload.input,
    payload.text,
    payload.message
  ].map(normalizeText).find(Boolean);
  if (direct) {
    return direct;
  }

  if (Array.isArray(payload.messages)) {
    for (let index = payload.messages.length - 1; index >= 0; index -= 1) {
      const message = payload.messages[index];
      if (message && typeof message === "object" && message.role === "user") {
        const text = contentText(message.content);
        if (text) {
          return text;
        }
      }
    }
  }

  return "";
}

function contentText(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(contentText).filter(Boolean).join("\n").trim();
  }
  if (value && typeof value === "object") {
    return normalizeText(value.text) || contentText(value.content);
  }
  return "";
}

function parseResumeQuery(prompt) {
  const text = normalizeText(prompt);
  const commandArguments = parseResumeCommandArguments(text);
  if (commandArguments) {
    return commandArguments;
  }
  for (const prefix of ["/memmy-resume ", "memmy-resume "]) {
    if (text.startsWith(prefix)) {
      return normalizeText(text.slice(prefix.length));
    }
  }
  return "";
}

function isResumeCommand(prompt) {
  const text = normalizeText(prompt);
  return /MEMMY_RESUME_COMMAND_ARGUMENTS:/u.test(text) ||
    text === "/memmy-resume" || text === "memmy-resume" ||
    text.startsWith("/memmy-resume ") || text.startsWith("memmy-resume ");
}

function parseResumeCommandArguments(text) {
  const match = normalizeText(text).match(/MEMMY_RESUME_COMMAND_ARGUMENTS:\s*([\s\S]*?)\s*MEMMY_RESUME_COMMAND_END/u);
  return match ? normalizeText(match[1]) : "";
}

function parseResumeSelection(prompt) {
  const text = normalizeText(prompt);
  const direct = text.match(/^[1-5]$/u);
  if (direct) {
    return Number(text);
  }
  const explicit = text.match(/^\/?memmy-resume\s+(?:select\s+)?([1-5])$/u);
  return explicit ? Number(explicit[1]) : 0;
}

function sessionStateKey(payload) {
  return normalizeText(payload.session_id) ||
    normalizeText(payload.sessionId) ||
    normalizeText(payload.conversation_id) ||
    normalizeText(payload.conversationId) ||
    normalizeText(payload.thread_id) ||
    normalizeText(payload.threadId) ||
    normalizeText(payload.cwd) ||
    "default";
}

function platformTurnId(payload) {
  return normalizeText(payload.turn_id) ||
    normalizeText(payload.turnId) ||
    normalizeText(payload.generation_id) ||
    normalizeText(payload.generationId);
}

function workspacePath(payload) {
  const direct = normalizeText(payload.cwd) || normalizeText(payload.workspace_path || payload.workspacePath);
  if (direct) {
    return direct;
  }
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : payload.workspaceRoots;
  if (!Array.isArray(roots)) {
    return "";
  }
  return roots.map(item => normalizeText(item)).find(Boolean) || "";
}

function completedTurnStatus(payload) {
  const status = normalizeText(payload.status).toLowerCase();
  if (status === "aborted" || status === "cancelled" || status === "canceled") {
    return "cancelled";
  }
  if (status === "error" || status === "failed" || payload.success === false) {
    return "failed";
  }
  return "succeeded";
}

function writeAllowOutput() {
  if (MODE === "cursor") {
    process.stdout.write(JSON.stringify({ continue: true }));
  }
}

function writeObservationOutput() {
  if (MODE === "cursor") {
    process.stdout.write("{}");
  }
}

function writeStopOutput() {
  if (MODE === "cursor") {
    process.stdout.write("{}");
    return;
  }
  process.stdout.write(JSON.stringify({
    continue: true,
    suppressOutput: true
  }));
}

function writeTurnStartOutput(started) {
  if (MODE === "cursor") {
    writeAllowOutput();
    return;
  }
  const injected = started && started.injectedContext && typeof started.injectedContext === "object"
    ? normalizeText(started.injectedContext.markdown)
    : normalizeText(started && started.injectedContext);
  if (!injected) {
    writeAllowOutput();
    return;
  }
  writeResumeContextOutput([
    '<memmy_memory_context source="turn_start">',
    "The following is historical memory context. Use it as supporting context, not as a new user request.",
    "",
    injected,
    "</memmy_memory_context>"
  ].join("\n"));
}

function writeResultOutput(message) {
  if (MODE === "cursor") {
    process.stdout.write(JSON.stringify({
      continue: false,
      user_message: message
    }));
    return;
  }

  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: message
  }));
}

function writeResumeContextOutput(context) {
  if (MODE === "cursor") {
    process.stdout.write(JSON.stringify({
      continue: false,
      user_message: context
    }));
    return;
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context
    }
  }));
}

async function createMemmyClient() {
  const localConfig = await readLocalConfig();
  const memmyConfigPath = normalizeText(process.env.MEMMY_CONFIG) ||
    normalizeText(localConfig.memmy_config_path) ||
    DEFAULT_MEMMY_CONFIG_PATH;
  const resolved = await readMemmyConfig(memmyConfigPath).catch(() => ({}));
  const baseUrl = normalizeText(resolved.endpoint || localConfig.endpoint || "http://127.0.0.1:18960").replace(/\/+$/u, "");
  const token = normalizeText(resolved.token || localConfig.token);
  if (!baseUrl) {
    throw new Error("Invalid Memmy config at " + memmyConfigPath);
  }

  return {
    async get(path) {
      const headers = {};
      if (token) {
        headers.authorization = "Bearer " + token;
      }
      const response = await fetchWithTimeout(new URL(path, baseUrl), {
        method: "GET",
        headers
      }, FETCH_TIMEOUT_MS);
      return parseResponse(response);
    },
    async post(path, body) {
      const headers = { "content-type": "application/json" };
      if (token) {
        headers.authorization = "Bearer " + token;
      }
      const response = await fetchWithTimeout(new URL(path, baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      }, FETCH_TIMEOUT_MS);
      return parseResponse(response);
    }
  };
}

function memoryExternalSessionId(payload) {
  return SOURCE + "-memory-" + (
    normalizeText(payload.session_id) ||
    normalizeText(payload.sessionId) ||
    normalizeText(payload.conversation_id) ||
    normalizeText(payload.conversationId) ||
    normalizeText(payload.thread_id) ||
    normalizeText(payload.threadId) ||
    normalizeText(payload.cwd) ||
    "default"
  );
}

async function readLocalConfig() {
  try {
    const parsed = parseJson(await readFile(CONFIG_URL, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readMemmyConfig(configPath) {
  const content = await readFile(configPath, "utf8");
  const storage = parseStorageBlock(content);
  return {
    endpoint: normalizeText(storage.endpoint) || "http://127.0.0.1:18960",
    token: normalizeText(storage.token)
  };
}

function parseStorageBlock(content) {
  const storages = [];
  let activeStorage = null;
  let storageIndent = 0;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, "").replace(/\s+$/u, "");
    if (!line.trim()) {
      continue;
    }
    const indent = line.match(/^\s*/u)[0].length;
    if (/^\s*storage:\s*$/u.test(line)) {
      activeStorage = {};
      storageIndent = indent;
      storages.push(activeStorage);
      continue;
    }
    if (activeStorage && indent <= storageIndent) {
      activeStorage = null;
    }
    if (!activeStorage) {
      continue;
    }
    const match = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*?)\s*$/u);
    if (match) {
      activeStorage[match[1]] = parseYamlScalar(match[2]);
    }
  }
  return storages.find((storage) => storage.endpoint) || storages[0] || {};
}

function parseYamlScalar(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("Memmy request timed out after " + timeoutMs + "ms");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function parseResponse(response) {
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data && data.error && data.error.message ? data.error.message : response.statusText;
    throw new Error(message || "Memmy HTTP " + response.status);
  }
  return data;
}

function turnStateUrl(payload) {
  const key = sessionStateKey(payload) + "\\u0000" + platformTurnId(payload);
  return new URL("./memmy-turn-state-" + hashText(key) + ".json", import.meta.url);
}

async function readTurnState(payload) {
  try {
    const state = parseJson(await readFile(turnStateUrl(payload), "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return null;
    }
    const createdAt = Date.parse(normalizeText(state.createdAt));
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > TURN_STATE_TTL_MS) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

async function writeTurnState(payload, state) {
  await writeFile(turnStateUrl(payload), JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function readPendingState() {
  try {
    const state = parseJson(await readFile(STATE_URL, "utf8"));
    return state && typeof state === "object" && !Array.isArray(state) ? state : null;
  } catch {
    return null;
  }
}

async function writePendingState(state) {
  await writeFile(STATE_URL, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function clearPendingState() {
  await unlink(STATE_URL).catch(() => undefined);
}

function resolvePendingSelection(state, selection, sessionKey) {
  if (!state || !Array.isArray(state.candidates)) {
    return null;
  }
  if (normalizeText(state.sessionKey) !== sessionKey) {
    return null;
  }
  const createdAt = Date.parse(normalizeText(state.createdAt));
  if (!Number.isFinite(createdAt) || Date.now() - createdAt > STATE_TTL_MS) {
    return null;
  }
  const candidate = state.candidates.find(item => item && Number(item.index) === selection);
  const episodeId = normalizeText(candidate && candidate.episodeId);
  return episodeId ? { ...candidate, episodeId } : null;
}

async function buildEpisodeCandidates(client, query, result) {
  const hits = extractSearchHits(result).slice(0, SEARCH_LIMIT);
  const enriched = [];
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    const memoryId = normalizeText(hit.id) || normalizeText(hit.memoryId) || normalizeText(hit.refId);
    if (!memoryId) {
      continue;
    }
    const detail = await client.get("/api/v1/memory/" + encodeURIComponent(memoryId)).catch(() => null);
    const episodeRef = episodeRefFromDetail(detail);
    if (!episodeRef.id) {
      continue;
    }
    enriched.push({
      hit,
      rank: index + 1,
      score: normalizedScore(hit.score) || normalizedScore(hit.similarity),
      memoryId,
      detail,
      episodeRef
    });
  }

  const groups = new Map();
  for (const item of enriched) {
    const episodeId = item.episodeRef.id;
    const current = groups.get(episodeId) || {
      episodeId,
      hits: [],
      episodeRef: item.episodeRef,
      details: []
    };
    current.hits.push(item);
    current.details.push(item.detail);
    current.episodeRef = mergeEpisodeRef(current.episodeRef, item.episodeRef);
    groups.set(episodeId, current);
  }

  const candidates = [];
  for (const group of groups.values()) {
    const episodeDetail = await client.get("/api/v1/memory/" + encodeURIComponent(group.episodeId)).catch(() => null);
    const display = episodeDisplayFields(group.episodeRef, episodeDetail, group.details);
    candidates.push({
      ...display,
      episodeId: group.episodeId,
      score: episodeScore(group, episodeDetail, hits.length || SEARCH_LIMIT),
      components: episodeScoreComponents(group, episodeDetail, hits.length || SEARCH_LIMIT)
    });
  }

  return candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, DISPLAY_LIMIT)
    .map((candidate, index) => ({ ...candidate, index: index + 1 }));
}

function episodeRefFromDetail(detail) {
  const refs = detail && detail.refs && typeof detail.refs === "object" ? detail.refs : {};
  const episode = refs.episode && typeof refs.episode === "object" ? refs.episode : {};
  return {
    id: normalizeText(episode.id) || normalizeText(detail && detail.episodeId),
    title: normalizeText(episode.title),
    summary: normalizeText(episode.summary),
    status: normalizeText(episode.status),
    startedAt: normalizeText(episode.startedAt),
    endedAt: normalizeText(episode.endedAt),
    updatedAt: normalizeText(episode.updatedAt) || normalizeText(detail && detail.updatedAt),
    turnCount: Number.isFinite(Number(episode.turnCount)) ? Number(episode.turnCount) : undefined
  };
}

function mergeEpisodeRef(left, right) {
  return {
    id: normalizeText(left.id) || normalizeText(right.id),
    title: normalizeText(left.title) || normalizeText(right.title),
    summary: normalizeText(left.summary) || normalizeText(right.summary),
    status: normalizeText(left.status) || normalizeText(right.status),
    startedAt: normalizeText(left.startedAt) || normalizeText(right.startedAt),
    endedAt: normalizeText(left.endedAt) || normalizeText(right.endedAt),
    updatedAt: latestIso(left.updatedAt, right.updatedAt),
    turnCount: Number.isFinite(Number(left.turnCount)) ? Number(left.turnCount) : right.turnCount
  };
}

function episodeScore(group, episodeDetail, searchHitCount) {
  const c = episodeScoreComponents(group, episodeDetail, searchHitCount);
  return 0.55 * c.maxHitScore +
    0.25 * c.weightedTopHitScore +
    0.10 * c.hitCoverage +
    0.07 * c.recencyScore +
    0.03 * c.continuityScore;
}

function episodeScoreComponents(group, episodeDetail, searchHitCount) {
  const scores = group.hits.map(hit => hit.score).filter(score => Number.isFinite(score));
  const sorted = [...scores].sort((left, right) => right - left);
  const weighted = weightedAverage(sorted.slice(0, 3), [1, 0.7, 0.5]);
  return {
    maxHitScore: sorted[0] || 0,
    weightedTopHitScore: weighted,
    hitCoverage: clamp01(group.hits.length / SEARCH_LIMIT),
    recencyScore: recencyScore(episodeDisplayTime(group.episodeRef, episodeDetail)),
    continuityScore: continuityScore(group.episodeRef, episodeDetail)
  };
}

function weightedAverage(values, weights) {
  let total = 0;
  let weightTotal = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const weight = weights[index] || 0;
    total += value * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? clamp01(total / weightTotal) : 0;
}

function recencyScore(value) {
  const time = Date.parse(normalizeText(value));
  if (!Number.isFinite(time)) {
    return 0;
  }
  const ageDays = Math.max(0, (Date.now() - time) / 86400000);
  return clamp01(1 - ageDays / 30);
}

function continuityScore(episodeRef, episodeDetail) {
  const status = normalizeText(episodeRef.status || (episodeDetail && episodeDetail.status)).toLowerCase();
  if (status === "open" || status === "running") {
    return 1;
  }
  if (!normalizeText(episodeRef.endedAt)) {
    return 0.5;
  }
  return 0;
}

function episodeDisplayFields(episodeRef, episodeDetail, details) {
  const rawTurns = episodeRawTurns(episodeDetail);
  const firstTurn = rawTurns[0] || {};
  const fallbackFirstQuery = details.map(detail => {
    const rawTurn = detail && detail.refs && detail.refs.rawTurn && typeof detail.refs.rawTurn === "object" ? detail.refs.rawTurn : {};
    return normalizeText(rawTurn.userText) || normalizeText(rawTurn.query);
  }).find(Boolean);
  return {
    title: normalizeText(episodeDetail && episodeDetail.title) || normalizeText(episodeRef.title) || episodeRef.id,
    time: formatDisplayTime(episodeDisplayTime(episodeRef, episodeDetail)),
    firstQuery: oneLine(normalizeText(firstTurn.userText) || fallbackFirstQuery || normalizeText(episodeRef.title) || "(unknown)"),
    tailSummary: oneLine(
      lastL1MemorySummary(episodeDetail) ||
      normalizeText(episodeDetail && episodeDetail.summary) ||
      normalizeText(episodeRef.summary) ||
      "(no summary)"
    )
  };
}

function episodeDisplayTime(episodeRef, episodeDetail) {
  return normalizeText(episodeRef.updatedAt) ||
    normalizeText(episodeDetail && episodeDetail.updatedAt) ||
    normalizeText(episodeRef.endedAt) ||
    normalizeText(episodeRef.startedAt) ||
    normalizeText(episodeDetail && episodeDetail.createdAt);
}

function episodeRawTurns(episodeDetail) {
  const timeline = episodeDetail && episodeDetail.timeline && typeof episodeDetail.timeline === "object" ? episodeDetail.timeline : {};
  return Array.isArray(timeline.rawTurns) ? timeline.rawTurns.filter(item => item && typeof item === "object") : [];
}

function lastL1MemorySummary(episodeDetail) {
  const items = episodeTimelineItems(episodeDetail)
    .filter(item => normalizeText(item.memoryLayer || item.layer) === "L1");
  const last = items[items.length - 1] || {};
  return normalizeText(last.summary) || normalizeText(last.title) || normalizeText(last.body);
}

function formatResumeSearchResult(query, candidates) {
  if (candidates.length === 0) {
    return 'No L1 Memmy memories found for: "' + query + '"';
  }
  return [
    'Memmy resume candidates for "' + query + '" (top 5 episodes from L1 top20):',
    "",
    candidates.map(formatResumeEpisode).join("\n\n"),
    "",
    "Enter 1-5 to select an episode to resume. Memmy will automatically retrieve the full episode (equivalent to memmy-memory get <episode_id>) and inject continuation context.",
    "Enter /memmy-resume cancel to cancel."
  ].join("\n");
}

function extractSearchHits(result) {
  const debug = result && result.debug && typeof result.debug === "object" ? result.debug : {};
  const candidates = [
    result && result.hits,
    debug.hits,
    result && result.results,
    debug.results,
    result && result.memories,
    debug.memories,
    result && result.items,
    debug.items
  ];
  for (const value of candidates) {
    if (Array.isArray(value) && value.length > 0) {
      return value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
    }
  }
  return [];
}

function formatResumeEpisode(candidate) {
  return [
    String(candidate.index) + ". " + candidate.episodeId,
    "time: " + candidate.time,
    "first_query: " + truncateText(candidate.firstQuery, 220),
    "tail_summary: " + truncateText(candidate.tailSummary, 260)
  ].filter(Boolean).join("\n");
}

function buildResumeContext(selection, detail) {
  const episodeId = normalizeText(detail && detail.id) || selection.episodeId;
  const title = normalizeText(detail && detail.title) || normalizeText(selection.title) || episodeId;
  const body = normalizeText(detail && detail.body);
  const rawTurns = episodeRawTurns(detail);
  const related = episodeTimelineItems(detail);
  const lines = [
    "Memmy resume selection",
    "",
    "The user selected candidate " + selection.index + " from the previous /memmy-resume result.",
    "Treat the current user prompt as a selection, not as a standalone question or task.",
    "Continue the selected task using the episode context below. Do not ask the user to paste it again.",
    "",
    "Episode id: " + episodeId,
    "Episode title: " + title,
    "",
    body ? "Episode detail:\n" + body : "",
    rawTurns.length ? "Raw turns:\n" + rawTurns.map(formatRawTurnForResume).join("\n\n") : "",
    related.length ? "Related memories:\n" + related.map(formatRelatedMemoryForResume).join("\n") : ""
  ].filter(Boolean);
  return truncateText(lines.join("\n\n"), RESUME_CONTEXT_MAX_CHARS);
}

function episodeTimelineItems(detail) {
  const timeline = detail && detail.timeline && typeof detail.timeline === "object" ? detail.timeline : {};
  return Array.isArray(timeline.items) ? timeline.items.filter(item => item && typeof item === "object") : [];
}

function formatRawTurnForResume(turn, index) {
  return [
    String(index + 1) + ". turn " + (normalizeText(turn.turnId) || ""),
    normalizeText(turn.userText) ? "user: " + truncateText(oneLine(turn.userText), 1200) : "",
    normalizeText(turn.assistantText) ? "assistant: " + truncateText(oneLine(turn.assistantText), 1600) : ""
  ].filter(Boolean).join("\n");
}

function formatRelatedMemoryForResume(item, index) {
  return String(index + 1) + ". [" + (normalizeText(item.memoryLayer) || "memory") + "] " +
    (normalizeText(item.id) || "") + " - " +
    truncateText(oneLine(normalizeText(item.title) || normalizeText(item.summary) || normalizeText(item.body)), 400);
}

function normalizedScore(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? clamp01(number) : 0;
}

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function latestIso(left, right) {
  const leftTime = Date.parse(normalizeText(left));
  const rightTime = Date.parse(normalizeText(right));
  if (!Number.isFinite(leftTime)) {
    return normalizeText(right);
  }
  if (!Number.isFinite(rightTime)) {
    return normalizeText(left);
  }
  return rightTime > leftTime ? normalizeText(right) : normalizeText(left);
}

function formatDisplayTime(value) {
  const text = normalizeText(value);
  if (!text) {
    return "(unknown)";
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return text;
  }
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function oneLine(value) {
  return normalizeText(value).replace(/\s+/g, " ");
}

function truncateText(value, maxChars) {
  const text = normalizeText(value);
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, Math.max(0, maxChars - 3)) + "...";
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeCaptureText(value) {
  return normalizeText(value)
    .replace(/<memmy_memory_context\b[\s\S]*?<\/memmy_memory_context>/giu, "")
    .replace(/<current_user_request>[\s\S]*?<\/current_user_request>/giu, "")
    .trim();
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

main().catch((error) => {
  writeResultOutput("Memmy resume search failed: " + formatError(error));
});
`;
}
