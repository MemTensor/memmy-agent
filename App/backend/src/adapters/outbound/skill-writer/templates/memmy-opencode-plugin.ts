/** OpenCode Memmy plugin templates. */

/** Renders the self-contained OpenCode plugin installed into the global plugin directory. */
export function renderMemmyOpencodePlugin(): string {
  return String.raw`import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";

const SOURCE = "opencode";
const CONFIG_URL = new URL("./memmy-memory-config.json", import.meta.url);
const DEFAULT_MEMMY_CONFIG_PATH = join(homedir(), ".memmy", "config.yaml");
const FETCH_TIMEOUT_MS = 45000;
const SEARCH_LIMIT = 20;
const DISPLAY_LIMIT = 5;
const RESUME_STATE_TTL_MS = 10 * 60 * 1000;
const RESUME_CONTEXT_MAX_CHARS = 24000;
const TOOL_OUTPUT_MAX_CHARS = 12000;

export const MemmyMemoryPlugin = async ({ client, directory, worktree }) => {
  const sessionCache = new Map();
  const pendingTurns = new Map();
  const pendingResumeSelections = new Map();
  const latestRequests = new Map();
  const captureJobs = new Set();

  function log(level, message, extra = {}) {
    try {
      const request = client && client.app && typeof client.app.log === "function"
        ? client.app.log({
            body: {
              service: "memmy-memory",
              level,
              message,
              extra
            }
          })
        : null;
      if (request && typeof request.catch === "function") {
        void request.catch(() => undefined);
      }
    } catch {
      // Logging must never interrupt an OpenCode turn.
    }
  }

  async function ensureSession(memmy, externalSessionId, agent) {
    const cached = sessionCache.get(externalSessionId);
    if (cached) {
      return cached;
    }
    const opened = await memmy.post("/api/v1/sessions/open", {
      sessionId: "opencode-memory-" + externalSessionId,
      source: SOURCE,
      workspacePath: worktree || directory || undefined,
      profileId: normalizeText(agent) || "main"
    });
    const sessionId = normalizeText(opened && opened.sessionId) || "opencode-memory-" + externalSessionId;
    sessionCache.set(externalSessionId, sessionId);
    return sessionId;
  }

  async function beginTurn(input, output, query, selectedContext = "") {
    const cleanQuery = sanitizeUserText(query);
    if (!cleanQuery) {
      return;
    }

    latestRequests.set(input.sessionID, cleanQuery);
    let recalledContext = "";
    try {
      const memmy = await createMemmyClient();
      const sessionId = await ensureSession(memmy, input.sessionID, input.agent);
      const requestedTurnId = normalizeText(input.messageID) || normalizeText(output && output.message && output.message.id);
      const turn = await memmy.post("/api/v1/turns/start", {
        sessionId,
        source: SOURCE,
        query: cleanQuery,
        turnId: requestedTurnId || undefined,
        contextHints: {
          agent: normalizeText(input.agent) || undefined,
          model: input.model || undefined,
          directory: directory || undefined,
          worktree: worktree || undefined
        }
      }, FETCH_TIMEOUT_MS);
      const turnId = normalizeText(turn && turn.turnId) || requestedTurnId || "opencode-fallback-" + hashText([
        sessionId,
        cleanQuery
      ].join("\u0000"));
      pendingTurns.set(input.sessionID, {
        sessionId,
        turnId,
        episodeId: normalizeText(turn && turn.episodeId) || undefined,
        sourceMemoryIds: Array.isArray(turn && turn.sourceMemoryIds) ? turn.sourceMemoryIds : undefined,
        query: cleanQuery,
        userMessageId: normalizeText(output && output.message && output.message.id) || requestedTurnId,
        answerParts: new Map(),
        toolCalls: [],
        toolResults: [],
        status: "succeeded",
        error: ""
      });
      recalledContext = normalizeText(turn && turn.injectedContext && turn.injectedContext.markdown);
    } catch (error) {
      log("warn", "Memmy recall failed", { error: formatError(error), sessionID: input.sessionID });
    }

    const context = [
      selectedContext ? "Selected episode context:\n" + selectedContext : "",
      recalledContext ? "Additional relevant memory:\n" + recalledContext : ""
    ].filter(Boolean).join("\n\n");
    if (context) {
      replaceUserTextParts(
        output.parts,
        renderMemmyContextPacket(context, selectedContext ? "resume" : "turn_start", cleanQuery)
      );
    }
  }

  function queueTurnCompletion(sessionID) {
    const pending = pendingTurns.get(sessionID);
    if (!pending) {
      return;
    }
    pendingTurns.delete(sessionID);
    const job = completeTurn(pending)
      .catch((error) => {
        log("warn", "Memmy turn capture failed", { error: formatError(error), sessionID });
      })
      .finally(() => {
        captureJobs.delete(job);
      });
    captureJobs.add(job);
  }

  async function completeTurn(pending) {
    const answer = sanitizeCaptureText([...pending.answerParts.values()].filter(Boolean).join("\n\n")) ||
      sanitizeCaptureText(pending.error) ||
      "Turn ended without assistant text.";
    const memmy = await createMemmyClient();
    await memmy.post("/api/v1/turns/" + encodeURIComponent(pending.turnId) + "/complete", {
      adapterId: "memmy-opencode-plugin",
      requestId: "opencode-plugin:" + pending.turnId,
      sessionId: pending.sessionId,
      episodeId: pending.episodeId,
      source: SOURCE,
      query: pending.query,
      answer,
      status: pending.status,
      toolCalls: pending.toolCalls.length ? pending.toolCalls : undefined,
      toolResults: pending.toolResults.length ? pending.toolResults : undefined,
      sourceMemoryIds: pending.sourceMemoryIds
    });
  }

  async function handleResumeSearch(sessionID, query, parts) {
    if (!query) {
      replaceUserTextParts(parts, renderCommandResult("Usage: /memmy-resume <query>"));
      return;
    }
    if (query === "cancel") {
      pendingResumeSelections.delete(sessionID);
      replaceUserTextParts(parts, renderCommandResult("Memmy resume selection cancelled."));
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
      pendingResumeSelections.set(sessionID, {
        createdAt: Date.now(),
        candidates
      });
      replaceUserTextParts(parts, renderCommandResult(formatResumeSearchResult(query, candidates)));
    } catch (error) {
      replaceUserTextParts(parts, renderCommandResult("Memmy resume search failed: " + formatError(error)));
    }
  }

  async function handleResumeSelection(input, output, selection) {
    const selected = resolveResumeSelection(pendingResumeSelections.get(input.sessionID), selection);
    if (!selected) {
      replaceUserTextParts(
        output.parts,
        renderCommandResult("No active Memmy resume selection. Run /memmy-resume <query> first.")
      );
      return;
    }

    try {
      const memmy = await createMemmyClient();
      const detail = await memmy.get("/api/v1/memory/" + encodeURIComponent(selected.episodeId));
      pendingResumeSelections.delete(input.sessionID);
      const context = buildResumeContext(selected, detail);
      const title = normalizeText(detail && detail.title) || normalizeText(selected.title) || selected.episodeId;
      await beginTurn(input, output, "Continue Memmy episode " + selected.episodeId + ": " + title, context);
    } catch (error) {
      replaceUserTextParts(partsFromOutput(output), renderCommandResult("Memmy resume selection failed: " + formatError(error)));
    }
  }

  return {
    tool: {
      memmy_memory_search: tool({
        description: "Search Memmy local memory for relevant facts, preferences, decisions, procedures, and prior tasks.",
        args: {
          query: tool.schema.string(),
          layers: tool.schema.array(tool.schema.enum(["L1", "L2", "L3", "Skill"])).optional()
        },
        async execute(args, context) {
          const memmy = await createMemmyClient();
          const result = await memmy.post("/api/v1/memory/search", {
            query: normalizeText(args.query),
            layers: Array.isArray(args.layers) ? args.layers : undefined,
            source: SOURCE
          });
          return renderMemmyContextPacket(
            formatSearchResult(result),
            "tool_search",
            latestRequests.get(context.sessionID) || normalizeText(args.query)
          );
        }
      }),
      memmy_memory_get: tool({
        description: "Read one Memmy memory detail by id.",
        args: {
          id: tool.schema.string()
        },
        async execute(args, context) {
          const id = normalizeText(args.id);
          if (!id) {
            throw new Error("Missing required parameter: id");
          }
          const memmy = await createMemmyClient();
          const result = await memmy.get("/api/v1/memory/" + encodeURIComponent(id));
          return renderMemmyContextPacket(
            formatMemoryDetail(result),
            "tool_get",
            latestRequests.get(context.sessionID) || "Read Memmy memory " + id
          );
        }
      }),
      memmy_memory_add: tool({
        description: "Write an important durable fact, preference, decision, reusable procedure, or unresolved follow-up into Memmy.",
        args: {
          content: tool.schema.string(),
          title: tool.schema.string().optional(),
          tags: tool.schema.array(tool.schema.string()).optional(),
          layer: tool.schema.enum(["L1", "L2", "L3", "Skill"]).optional()
        },
        async execute(args, context) {
          const content = sanitizeCaptureText(args.content);
          if (!content) {
            throw new Error("Missing required parameter: content");
          }
          const memmy = await createMemmyClient();
          const sessionId = await ensureSession(memmy, context.sessionID, context.agent);
          const result = await memmy.post("/api/v1/memory/add", {
            content,
            title: normalizeText(args.title) || undefined,
            tags: Array.isArray(args.tags) ? args.tags.filter((item) => typeof item === "string") : undefined,
            layer: normalizeText(args.layer) || "L1",
            source: SOURCE,
            sessionId
          });
          return "Stored Memmy memory " + normalizeText(result && result.id) + ": " +
            (normalizeText(result && result.summary) || content);
        }
      })
    },

    "chat.message": async (input, output) => {
      const rawPrompt = extractUserText(output.parts);
      const commandArguments = parseResumeCommandArguments(rawPrompt);
      const selection = parseResumeSelection(commandArguments === null ? rawPrompt : commandArguments);
      const hasPendingSelection = Boolean(resolveResumeSelection(pendingResumeSelections.get(input.sessionID), selection));
      if (selection && (commandArguments !== null || hasPendingSelection)) {
        await handleResumeSelection(input, output, selection);
        return;
      }
      if (commandArguments !== null) {
        await handleResumeSearch(input.sessionID, normalizeText(commandArguments), output.parts);
        return;
      }
      await beginTurn(input, output, rawPrompt);
    },

    "tool.execute.before": async (input, output) => {
      if (isMemmyTool(input.tool)) {
        return;
      }
      const pending = pendingTurns.get(input.sessionID);
      if (!pending) {
        return;
      }
      const call = {
        id: input.callID,
        name: input.tool
      };
      const args = cloneJsonValue(output && output.args);
      if (args !== undefined) {
        call.arguments = args;
      }
      pending.toolCalls.push(call);
    },

    "tool.execute.after": async (input, output) => {
      if (isMemmyTool(input.tool)) {
        return;
      }
      const pending = pendingTurns.get(input.sessionID);
      if (!pending) {
        return;
      }
      const text = truncateText(sanitizeCaptureText(toDisplayText(output && output.output)), TOOL_OUTPUT_MAX_CHARS);
      pending.toolResults.push({
        tool_call_id: input.callID,
        content: text,
        output: text
      });
    },

    "experimental.text.complete": async (input, output) => {
      const pending = pendingTurns.get(input.sessionID);
      if (!pending || normalizeText(input.messageID) === normalizeText(pending.userMessageId)) {
        return;
      }
      pending.answerParts.set(input.partID, normalizeText(output.text));
    },

    event: async ({ event }) => {
      const properties = event && event.properties && typeof event.properties === "object" ? event.properties : {};
      if (event && event.type === "message.part.updated") {
        const part = properties.part && typeof properties.part === "object" ? properties.part : {};
        const pending = pendingTurns.get(normalizeText(part.sessionID));
        if (
          pending &&
          part.type === "text" &&
          normalizeText(part.messageID) !== normalizeText(pending.userMessageId)
        ) {
          pending.answerParts.set(normalizeText(part.id) || "text", normalizeText(part.text));
        }
        return;
      }
      if (event && event.type === "session.error") {
        const pending = pendingTurns.get(normalizeText(properties.sessionID));
        if (pending) {
          pending.status = "failed";
          pending.error = errorText(properties.error);
        }
        return;
      }
      if (event && event.type === "session.idle") {
        queueTurnCompletion(normalizeText(properties.sessionID));
      }
    },

    dispose: async () => {
      for (const sessionID of [...pendingTurns.keys()]) {
        queueTurnCompletion(sessionID);
      }
      await Promise.allSettled([...captureJobs]);
    }
  };
};

function partsFromOutput(output) {
  return output && Array.isArray(output.parts) ? output.parts : [];
}

function extractUserText(parts) {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .filter((part) => part && part.type === "text" && part.synthetic !== true)
    .map((part) => normalizeText(part.text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function replaceUserTextParts(parts, text) {
  if (!Array.isArray(parts)) {
    return;
  }
  const indexes = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part && part.type === "text" && part.synthetic !== true) {
      indexes.push(index);
    }
  }
  if (indexes.length === 0) {
    return;
  }
  parts[indexes[0]].text = text;
  for (let index = indexes.length - 1; index > 0; index -= 1) {
    parts.splice(indexes[index], 1);
  }
}

function parseResumeCommandArguments(value) {
  const text = normalizeText(value);
  const sentinel = text.match(/MEMMY_RESUME_COMMAND_ARGUMENTS:\s*([\s\S]*?)\s*MEMMY_RESUME_COMMAND_END/u);
  if (sentinel) {
    return normalizeText(sentinel[1]);
  }
  if (text === "/memmy-resume" || text === "memmy-resume") {
    return "";
  }
  const direct = text.match(/^\/?memmy-resume\s+([\s\S]+)$/u);
  return direct ? normalizeText(direct[1]) : null;
}

function parseResumeSelection(value) {
  const text = normalizeText(value);
  const direct = text.match(/^[1-5]$/u);
  if (direct) {
    return Number(text);
  }
  const explicit = text.match(/^\/?memmy-resume\s+(?:select\s+)?([1-5])$/u);
  return explicit ? Number(explicit[1]) : 0;
}

function resolveResumeSelection(state, selection) {
  if (!state || !Array.isArray(state.candidates) || Date.now() - Number(state.createdAt) > RESUME_STATE_TTL_MS) {
    return null;
  }
  const candidate = state.candidates.find((item) => item && Number(item.index) === selection);
  const episodeId = normalizeText(candidate && candidate.episodeId);
  return episodeId ? { ...candidate, episodeId } : null;
}

function renderCommandResult(value) {
  return [
    "This is a Memmy command result. Reply with exactly the content inside <memmy_command_result> and nothing else.",
    "",
    "<memmy_command_result>",
    normalizeText(value),
    "</memmy_command_result>"
  ].join("\n");
}

function renderMemmyContextPacket(markdown, source, currentUserRequest) {
  return [
    "<memmy_memory_context source=\"" + escapeXmlAttribute(source) + "\">",
    normalizeText(markdown) || "No relevant Memmy memories found.",
    "</memmy_memory_context>",
    "",
    "<current_user_request>",
    sanitizeUserText(currentUserRequest),
    "</current_user_request>"
  ].join("\n");
}

async function createMemmyClient() {
  const localConfig = await readLocalConfig();
  const memmyConfigPath = normalizeText(process.env.MEMMY_CONFIG) ||
    normalizeText(localConfig.memmy_config_path) ||
    DEFAULT_MEMMY_CONFIG_PATH;
  const runtimeConfig = await readMemmyConfig(memmyConfigPath).catch(() => ({}));
  const baseUrl = normalizeText(runtimeConfig.endpoint || localConfig.endpoint || "http://127.0.0.1:18960").replace(/\/+$/u, "");
  const token = normalizeText(runtimeConfig.token || localConfig.token);
  if (!baseUrl) {
    throw new Error("Invalid Memmy config at " + memmyConfigPath);
  }

  return {
    async get(path) {
      const headers = token ? { authorization: "Bearer " + token } : {};
      const response = await fetchWithTimeout(new URL(path, baseUrl), { method: "GET", headers }, FETCH_TIMEOUT_MS);
      return parseResponse(response);
    },
    async post(path, body, timeoutMs = FETCH_TIMEOUT_MS) {
      const headers = { "content-type": "application/json" };
      if (token) {
        headers.authorization = "Bearer " + token;
      }
      const payload = body && typeof body === "object" && !Array.isArray(body) ? { ...body, source: SOURCE } : { source: SOURCE };
      const response = await fetchWithTimeout(new URL(path, baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      }, timeoutMs);
      return parseResponse(response);
    }
  };
}

async function readLocalConfig() {
  try {
    const parsed = JSON.parse(await readFile(CONFIG_URL, "utf8"));
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
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
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
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    const message = data && data.error && data.error.message ? data.error.message : response.statusText;
    throw new Error(message || "Memmy HTTP " + response.status);
  }
  return data;
}

async function buildEpisodeCandidates(memmy, result) {
  const hits = extractSearchHits(result).slice(0, SEARCH_LIMIT);
  const enriched = (await Promise.all(hits.map(async (hit, index) => {
    const memoryId = normalizeText(hit.id) || normalizeText(hit.memoryId) || normalizeText(hit.refId);
    if (!memoryId) {
      return null;
    }
    const detail = await memmy.get("/api/v1/memory/" + encodeURIComponent(memoryId)).catch(() => null);
    const episodeRef = episodeRefFromDetail(detail, hit, memoryId);
    if (!episodeRef.id) {
      return null;
    }
    return {
      rank: index + 1,
      score: normalizedScore(hit.score) || normalizedScore(hit.similarity),
      detail,
      episodeRef
    };
  }))).filter(Boolean);

  const groups = new Map();
  for (const item of enriched) {
    const current = groups.get(item.episodeRef.id) || {
      episodeId: item.episodeRef.id,
      hits: [],
      episodeRef: item.episodeRef,
      details: []
    };
    current.hits.push(item);
    current.details.push(item.detail);
    current.episodeRef = mergeEpisodeRef(current.episodeRef, item.episodeRef);
    groups.set(item.episodeRef.id, current);
  }

  const candidates = await Promise.all([...groups.values()].map(async (group) => {
    const episodeDetail = await memmy.get("/api/v1/memory/" + encodeURIComponent(group.episodeId)).catch(() => null);
    return {
      ...episodeDisplayFields(group.episodeRef, episodeDetail, group.details),
      episodeId: group.episodeId,
      score: episodeScore(group, episodeDetail)
    };
  }));
  return candidates
    .sort((left, right) => right.score - left.score)
    .slice(0, DISPLAY_LIMIT)
    .map((candidate, index) => ({ ...candidate, index: index + 1 }));
}

function extractSearchHits(result) {
  const debug = result && result.debug && typeof result.debug === "object" ? result.debug : {};
  for (const value of [
    result && result.hits,
    debug.hits,
    result && result.results,
    debug.results,
    result && result.memories,
    debug.memories,
    result && result.items,
    debug.items
  ]) {
    if (Array.isArray(value) && value.length) {
      return value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
    }
  }
  return [];
}

function episodeRefFromDetail(detail, hit, memoryId) {
  const refs = detail && detail.refs && typeof detail.refs === "object" ? detail.refs : {};
  const episode = refs.episode && typeof refs.episode === "object" ? refs.episode : {};
  const directId = memoryId.startsWith("episode_") ? memoryId : "";
  return {
    id: normalizeText(episode.id) || normalizeText(detail && detail.episodeId) || normalizeText(hit && hit.episodeId) || directId,
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

function episodeScore(group, episodeDetail) {
  const scores = group.hits.map((hit) => hit.score).filter(Number.isFinite).sort((left, right) => right - left);
  return 0.55 * (scores[0] || 0) +
    0.25 * weightedAverage(scores.slice(0, 3), [1, 0.7, 0.5]) +
    0.10 * clamp01(group.hits.length / SEARCH_LIMIT) +
    0.07 * recencyScore(episodeDisplayTime(group.episodeRef, episodeDetail)) +
    0.03 * continuityScore(group.episodeRef, episodeDetail);
}

function weightedAverage(values, weights) {
  let total = 0;
  let weightTotal = 0;
  for (let index = 0; index < values.length; index += 1) {
    const weight = weights[index] || 0;
    total += values[index] * weight;
    weightTotal += weight;
  }
  return weightTotal ? clamp01(total / weightTotal) : 0;
}

function recencyScore(value) {
  const time = Date.parse(normalizeText(value));
  if (!Number.isFinite(time)) {
    return 0;
  }
  return clamp01(1 - Math.max(0, (Date.now() - time) / 86400000) / 30);
}

function continuityScore(episodeRef, episodeDetail) {
  const status = normalizeText(episodeRef.status || (episodeDetail && episodeDetail.status)).toLowerCase();
  if (status === "open" || status === "running") {
    return 1;
  }
  return normalizeText(episodeRef.endedAt) ? 0 : 0.5;
}

function episodeDisplayFields(episodeRef, episodeDetail, details) {
  const rawTurns = episodeRawTurns(episodeDetail);
  const firstTurn = rawTurns[0] || {};
  const fallbackFirstQuery = details.map((detail) => {
    const rawTurn = detail && detail.refs && detail.refs.rawTurn && typeof detail.refs.rawTurn === "object"
      ? detail.refs.rawTurn
      : {};
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

function episodeRawTurns(detail) {
  const timeline = detail && detail.timeline && typeof detail.timeline === "object" ? detail.timeline : {};
  return Array.isArray(timeline.rawTurns) ? timeline.rawTurns.filter((item) => item && typeof item === "object") : [];
}

function episodeTimelineItems(detail) {
  const timeline = detail && detail.timeline && typeof detail.timeline === "object" ? detail.timeline : {};
  return Array.isArray(timeline.items) ? timeline.items.filter((item) => item && typeof item === "object") : [];
}

function lastL1MemorySummary(detail) {
  const items = episodeTimelineItems(detail).filter((item) => normalizeText(item.memoryLayer || item.layer) === "L1");
  const last = items[items.length - 1] || {};
  return normalizeText(last.summary) || normalizeText(last.title) || normalizeText(last.body);
}

function formatResumeSearchResult(query, candidates) {
  if (!candidates.length) {
    return "No L1 Memmy memories found for: \"" + query + "\"";
  }
  return [
    "Memmy resume candidates for \"" + query + "\" (top 5 episodes from L1 top20):",
    "",
    candidates.map(formatResumeEpisode).join("\n\n"),
    "",
    "输入 1-5 选择要接续的 episode；Memmy 会自动读取完整 episode 并注入接续上下文。",
    "输入 /memmy-resume cancel 取消。"
  ].join("\n");
}

function formatResumeEpisode(candidate) {
  return [
    String(candidate.index) + ". " + candidate.episodeId,
    "time: " + candidate.time,
    "first_query: " + truncateText(candidate.firstQuery, 220),
    "tail_summary: " + truncateText(candidate.tailSummary, 260)
  ].join("\n");
}

function buildResumeContext(selection, detail) {
  const episodeId = normalizeText(detail && detail.id) || selection.episodeId;
  const title = normalizeText(detail && detail.title) || normalizeText(selection.title) || episodeId;
  const body = normalizeText(detail && detail.body);
  const rawTurns = episodeRawTurns(detail);
  const related = episodeTimelineItems(detail);
  return truncateText([
    "Memmy resume selection",
    "",
    "The user selected candidate " + selection.index + " from the previous /memmy-resume result.",
    "Continue the selected task using the episode context below. Do not ask the user to paste it again.",
    "",
    "Episode id: " + episodeId,
    "Episode title: " + title,
    body ? "Episode detail:\n" + body : "",
    rawTurns.length ? "Raw turns:\n" + rawTurns.map(formatRawTurnForResume).join("\n\n") : "",
    related.length ? "Related memories:\n" + related.map(formatRelatedMemoryForResume).join("\n") : ""
  ].filter(Boolean).join("\n\n"), RESUME_CONTEXT_MAX_CHARS);
}

function formatRawTurnForResume(turn, index) {
  return [
    String(index + 1) + ". turn " + normalizeText(turn.turnId),
    normalizeText(turn.userText) ? "user: " + truncateText(oneLine(turn.userText), 1200) : "",
    normalizeText(turn.assistantText) ? "assistant: " + truncateText(oneLine(turn.assistantText), 1600) : ""
  ].filter(Boolean).join("\n");
}

function formatRelatedMemoryForResume(item, index) {
  return String(index + 1) + ". [" + (normalizeText(item.memoryLayer) || "memory") + "] " +
    normalizeText(item.id) + " - " +
    truncateText(oneLine(normalizeText(item.title) || normalizeText(item.summary) || normalizeText(item.body)), 400);
}

function formatSearchResult(result) {
  const hits = extractSearchHits(result).slice(0, 10);
  if (!hits.length) {
    return "No relevant Memmy memories found.";
  }
  return hits.map((hit, index) => {
    const id = normalizeText(hit.id) || normalizeText(hit.memoryId) || normalizeText(hit.refId);
    const layer = normalizeText(hit.memoryLayer || hit.layer) || "memory";
    const title = normalizeText(hit.title) || id || "Memory " + String(index + 1);
    const summary = normalizeText(hit.summary) || normalizeText(hit.body) || normalizeText(hit.content);
    return String(index + 1) + ". [" + layer + "] " + title + (id ? " (" + id + ")" : "") +
      (summary ? "\n" + truncateText(summary, 1200) : "");
  }).join("\n\n");
}

function formatMemoryDetail(result) {
  try {
    return truncateText(JSON.stringify(result, null, 2), RESUME_CONTEXT_MAX_CHARS);
  } catch {
    return truncateText(String(result), RESUME_CONTEXT_MAX_CHARS);
  }
}

function isMemmyTool(value) {
  return normalizeText(value).startsWith("memmy_memory_");
}

function cloneJsonValue(value) {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return toDisplayText(value);
  }
}

function toDisplayText(value) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function errorText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    return normalizeText(value.message) || normalizeText(value.name) || toDisplayText(value);
  }
  return "";
}

function sanitizeUserText(value) {
  return normalizeText(value)
    .replace(/<memmy_memory_context\b[^>]*>[\s\S]*?<\/memmy_memory_context>/giu, "")
    .replace(/<current_user_request>([\s\S]*?)<\/current_user_request>/giu, "$1")
    .trim();
}

function sanitizeCaptureText(value) {
  return normalizeText(value)
    .replace(/<memmy_memory_context\b[^>]*>[\s\S]*?<\/memmy_memory_context>/giu, "")
    .replace(/<current_user_request>[\s\S]*?<\/current_user_request>/giu, "")
    .replace(/<memmy_command_result>[\s\S]*?<\/memmy_command_result>/giu, "")
    .trim();
}

function normalizedScore(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? clamp01(number) : 0;
}

function clamp01(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
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
  return Number.isNaN(date.getTime()) ? text : date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function oneLine(value) {
  return normalizeText(value).replace(/\s+/gu, " ");
}

function truncateText(value, maxChars) {
  const text = normalizeText(value);
  return text.length <= maxChars ? text : text.slice(0, Math.max(0, maxChars - 3)) + "...";
}

function escapeXmlAttribute(value) {
  return normalizeText(value).replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
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
`;
}

/** Renders the global OpenCode command that forwards resume arguments to the plugin. */
export function renderMemmyOpencodeResumeCommand(): string {
  return [
    "---",
    "description: Search Memmy L1 episodes and continue a selected task.",
    "---",
    "",
    "MEMMY_RESUME_COMMAND_ARGUMENTS:",
    "$ARGUMENTS",
    "MEMMY_RESUME_COMMAND_END",
    "",
    "The installed Memmy OpenCode plugin handles this command before normal task execution.",
    ""
  ].join("\n");
}
