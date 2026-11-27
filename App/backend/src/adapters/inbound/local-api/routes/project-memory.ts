import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";
import * as contract from "../../../../services/project-memory/contracts.js";
import type { AgentRuntimeRouteDeps } from "./agent-runtime/index.js";

export function registerProjectMemoryRoutes(app: FastifyInstance, deps: AgentRuntimeRouteDeps) {
  const service = deps.services.projectMemory;
  let retry: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval>;
  app.addHook("onReady", async () => {
    timer = setInterval(() => {
      if (!retry && service) retry = service.retryPending().catch(e => app.log.warn(e)).finally(() => { retry = undefined; });
    }, 10_000);
    timer.unref();
  });
  app.addHook("onClose", async () => { clearInterval(timer); await retry; });
  const auth = { preHandler: deps.authenticateRuntimeToken };
  const base = "/api/project-memory/";
  app.get(base + "bindings", auth, withErrorEnvelope(async req =>
    service.scope.bindings(service.account().id, contract.project.parse(req.query).project_id)));
  app.put(base + "bindings", auth, withErrorEnvelope(async req => {
    const b = contract.bindings.parse(req.body);
    return service.scope.replace(service.account().id, b.project_id, b.workspace_ids, b.folder_paths);
  }));
  app.post(base + "sessions/open", auth, withErrorEnvelope(async req => {
    service.scope.open(service.account().id, contract.session.parse(req.body));
    return { ok: true };
  }));
  app.post(base + "sessions/compacted", auth, withErrorEnvelope(async req => {
    service.scope.markIndex(service.account().id, contract.session.parse(req.body), true);
    return { ok: true };
  }));
  app.post(base + "index", auth, withErrorEnvelope(async req => {
    const s = contract.index.parse(req.body);
    return service.index(service.account(), s, s.size);
  }));
  app.post(base + "search", auth, withErrorEnvelope(async req =>
    service.search(service.account(), contract.search.parse(req.body))));
  app.post(base + "add", auth, withErrorEnvelope(async (req, reply) => {
    const result = await service.add(service.account(), contract.add.parse(req.body));
    if (result.submissions.some(s => s.status === "acceptance_unknown")) reply.code(202);
    return result;
  }));
  app.post(base + "import", auth, withErrorEnvelope(async (req, reply) => {
    const result = await service.importHistory(service.account(), contract.historyImport.parse(req.body));
    if (result.submissions.some(s => s.status === "acceptance_unknown")) reply.code(202);
    return result;
  }));
  app.get(base + "topics", auth, withErrorEnvelope(async req => service.topics(service.account(), contract.page.parse(req.query))));
  const params = z.object({ id: contract.id });
  app.get(base + "topics/:id", auth, withErrorEnvelope(async req =>
    service.detail(service.account(), "topics", params.parse(req.params).id, contract.project.parse(req.query).project_id)));
  app.get(base + "status/:id", auth, withErrorEnvelope(async req =>
    service.detail(service.account(), "status", params.parse(req.params).id)));
  app.post(base + "read", auth, withErrorEnvelope(async req => {
    const s = contract.session.extend({ turn_id: contract.id, project_id: contract.id, memory_id: contract.id }).parse(req.body);
    const a = service.account();
    const allowed = () => service.scope.projects(a.id, s, s.turn_id).includes(s.project_id);
    if (allowed()) {
      const item = await service.readTurnItem(a, s);
      if (allowed()) return item;
    }
    throw Object.assign(new Error("Item outside this turn's projects"), { code: "not_found" });
  }));
  app.get(base + "items/:id", auth, withErrorEnvelope(async req => {
    const scope = contract.project.extend({ source_conversation_id: contract.id.optional(),
      kind: z.enum(["message", "turn", "episode"]).optional() }).parse(req.query);
    return service.item(service.account(), scope.project_id, params.parse(req.params).id, scope.source_conversation_id, scope.kind);
  }));
}
