import { MemoryServiceError } from "../utils/error.js";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import { readRuntimeConfig, resolveDefaultRuntimeConfigPath } from "../model/token-usage.js";
import { countSummaryTokens } from "../model/llm.js";
import type { InjectedContext, RecallHit, SessionOpenRequest, TurnCompleteRequest, SourceTurnIdentity, RequestEnvelope } from "../types.js";
import { createMemoryLogger } from "../logging/logger.js";

type Row = Record<string, unknown>;
const logger = createMemoryLogger("project-memory");
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((r): r is Row => !!r && typeof r === "object") : [];
const string = (value: unknown) => typeof value === "string" ? value : "";
const join = (parts: string[]) => parts.join("\n\n");

export class DesktopProjectMemory {
  async call(path: string, body: Row, required = false): Promise<Row> {
    const runtime = readRuntimeConfig(process.env.MEMMY_RUNTIME_CONFIG_PATH ?? resolveDefaultRuntimeConfigPath());
    if (!runtime) {
      if (required) throw new MemoryServiceError("not_found", "Desktop project memory unavailable");
      return {};
    }
    try {
      const res = await fetch(new URL("/api/project-memory/" + path, runtime.baseUrl), {
        method: "POST", headers: { "x-memmy-local-token": runtime.localToken, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(3500)
      });
      if (required && !res.ok) {
        if (res.status === 404 || res.status === 403) throw new MemoryServiceError("not_found", "Project memory unavailable");
        if (res.status === 401) throw new MemoryServiceError("unauthorized", "Sign in to use project memory");
        throw new MemoryServiceError("internal", "Desktop project memory request failed");
      }
      if (res.status === 401) return {};
      if (!res.ok) throw new Error(String(res.status));
      return await res.json() as Row;
    } catch (error) {
      if (required) throw error;
      logger.warn("project_memory.unavailable", { operation: path });
      return { degraded: ["desktop_unavailable"] };
    }
  }

  session(request: RequestEnvelope, sessionId: string) {
    return { source: request.source ?? request.namespace?.source, conversation_id: sessionId };
  }

  open(request: SessionOpenRequest, sessionId: string) {
    let cwd = request.workspacePath ?? string(request.meta?.launchFolder ?? request.namespace?.workspacePath);
    if (!cwd && request.workspaceUri) {
      try { cwd = fileURLToPath(request.workspaceUri); } catch { /* Non-file workspace. */ }
    }
    return this.call("sessions/open", {
      ...this.session(request, sessionId), cwd: isAbsolute(cwd) ? cwd : undefined,
      workspace_id: request.meta?.launchWorkspaceId ?? request.workspaceId ?? request.namespace?.workspaceId
    });
  }

  capture(request: TurnCompleteRequest, turnId: string, native?: SourceTurnIdentity) {
    return this.call("add", {
      ...this.session(request, request.sessionId), turn_id: turnId, submission_id: native?.turnId ?? turnId,
      messages: [
        { role: "user", content: request.query, chat_time: native?.startedAt },
        { role: "assistant", content: request.answer, chat_time: native?.completedAt }
      ]
    });
  }
}

// When the gateway has usable evidence, a slow local retriever must not consume the host's whole recall budget.
export async function awaitLocalRecall<T>(local: Promise<T>, cloud: Promise<Row> | undefined) {
  const settled = local.then(value => ({ value }), error => ({ error }));
  const found = await cloud;
  const canFallback = rows(found?.topics).length > 0 || rows(found?.projects).some(p => rows(p.topics).length > 0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = canFallback ? await Promise.race([settled, new Promise<{ error: Error }>(resolve => {
      timer = setTimeout(() => resolve({ error: new Error("local_timeout") }), 1500);
    })]) : await settled;
    if ("value" in result) return { local: result.value, found };
    if (!canFallback || (result.error instanceof MemoryServiceError && result.error.status < 500)) throw result.error;
    return { local: undefined, found: { ...found, degraded: [...(Array.isArray(found?.degraded) ? found.degraded : []), "local_unavailable"] } };
  } finally { clearTimeout(timer); }
}

export function limitTrajectories(response: Row) {
  let used = 0;
  const trajectories: Row[] = [];
  for (const row of rows(response.trajectories).slice(0, 5)) {
    let content = Array.from(string(row.content)).slice(0, 600).join("");
    const label = [row.project_id, row.source_task_id, row.turn_id, ""].join(" / ");
    while (content && used + countSummaryTokens(label + content + "\n") > 1500) {
      content = Array.from(content).slice(0, Math.floor(Array.from(content).length * 0.8)).join("");
    }
    if (!content) continue;
    used += countSummaryTokens(label + content + "\n");
    trajectories.push({ ...row, content });
  }
  return { ...response, trajectories };
}

type Section = InjectedContext["sections"][number];
type Ranked = { key: string; parts: () => Iterable<string>; rank: number; project: boolean; exact: boolean; section?: Section };

function* topicRenderings(topic: Row, key: string) {
  const history = rows(topic.decisions).map(d => ({ ...d, ...(Array.isArray(d.history) ? { history: [...d.history] } : {}) }));
  const experiences = [...(Array.isArray(topic.experiences) ? topic.experiences : [])];
  const timeline = [...(Array.isArray(topic.timeline) ? topic.timeline : [])];
  const heading = [key, string(topic.topic_name), string(topic.topic_summary), string(topic.topic_description)].filter(Boolean);
  for (;;) {
    yield [...heading, ...[history, experiences, timeline].filter(a => a.length).map(a => JSON.stringify(a))].join("\n");
    if (timeline.length) timeline.pop();
    else if (experiences.length) experiences.pop();
    else {
      const oldest = history.filter(d => Array.isArray(d.history) && d.history.length)
        .sort((a, b) => String(a.history?.[0]?.time ?? "").localeCompare(String(b.history?.[0]?.time ?? "")))[0];
      if (!oldest) return;
      oldest.history!.shift();
    }
  }
}

// Local retrieval's hits establish rank. Sections are the indivisible pieces actually shown to the model.
export function mixProjectRecall(local: { injectedContext: InjectedContext; hits: RecallHit[]; sourceMemoryIds: string[] }, cloud: Row, query: string, budget = 3000) {
  const topics = rows(cloud.topics);
  const indices: Row[] = rows(cloud.projects).flatMap(p => rows(p.topics).map(t => ({
    ...t, project_id: p.project_id, topic_description: t.latest_progress ?? t.topic_description
  })));
  const seen = new Set<string>();
  const anchors = [...query.matchAll(/`([^`]+)`|\b(\d{3})\b|\b([A-Za-z_][\w]*[._/][\w./]+)\b/g)]
    .map(m => ({ text: m[1] ?? m[2] ?? m[3]!, numeric: !!m[2] }));
  const exact = (text: string) => anchors.some(a => a.numeric ? new RegExp("\\b" + a.text + "\\b").test(text) : text.includes(a.text));
  const candidates: Ranked[] = [];
  for (const topic of [...topics, ...indices]) {
    const project = string(topic.project_id), id = string(topic.id ?? topic.topic_id);
    if (!project || !id) continue;
    const key = "project:" + encodeURIComponent(project) + ":" + encodeURIComponent(id);
    if (seen.has(key)) continue;
    seen.add(key);
    const parts = () => topicRenderings(topic, key);
    candidates.push({ key, rank: candidates.length + 1, exact: exact(parts().next().value ?? ""), project: true, parts });
  }
  if (!candidates.length) return { injectedContext: local.injectedContext, sourceMemoryIds: local.sourceMemoryIds, degraded: cloud.degraded ?? [] };
  const ranks = new Map<string, number>();
  local.hits.forEach((hit, i) => [hit.id, ...(hit.memberMemoryIds ?? [])].forEach(id => { if (!ranks.has(id)) ranks.set(id, i); }));
  const sections = [...local.injectedContext.sections].sort((a, b) =>
    Math.min(...a.memoryIds.map(id => ranks.get(id) ?? Infinity)) - Math.min(...b.memoryIds.map(id => ranks.get(id) ?? Infinity)));
  for (const [i, section] of sections.entries()) {
    if (!section.content || seen.has(section.id)) continue;
    seen.add(section.id);
    candidates.push({ key: section.id, rank: i + 1, project: false, exact: exact(section.content), section, parts: () => [section.content] });
  }
  // With independent source IDs, equal-weight reciprocal rank orders each branch by its rank.
  candidates.sort((a,b) => Number(b.exact) - Number(a.exact) || a.rank - b.rank || Number(b.project) - Number(a.project) || a.key.localeCompare(b.key));
  const selected: Ranked[] = [], blocks: string[] = [];
  for (const candidate of candidates) {
    if (selected.length === 5) break;
    for (const block of candidate.parts()) {
      if (countSummaryTokens(join([...blocks, block])) > Math.min(3000, budget)) continue;
      blocks.push(block);
      selected.push(candidate);
      break;
    }
  }
  const retained = selected.flatMap(x => x.section ? [x.section] : []);
  const localIds = [...new Set(retained.flatMap(s => s.memoryIds))];
  return {
    injectedContext: { markdown: join(blocks), sections: retained, tokenEstimate: countSummaryTokens(join(blocks)) },
    sourceMemoryIds: localIds, degraded: cloud.degraded ?? [],
    projectMemory: { selectedIds: selected.map(c => c.key), blocks, tokenEstimate: countSummaryTokens(join(blocks)) }
  };
}
