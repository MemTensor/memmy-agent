import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPanelRoutes } from "../routes/agent-runtime/panel.js";
import type { AgentRuntimeRouteDeps } from "../routes/agent-runtime/index.js";
import type { RuntimeContext } from "../../../../services/runtime-context.js";

let app: FastifyInstance;
afterEach(async () => { await app?.close(); });
describe("experience recovery renderer lifecycle", () => {
  it("forwards an abortable GET subscription but keeps an accepted POST independent", async () => {
    const contexts: RuntimeContext[] = [];
    const panel = {
      taskExperienceProcessing: async (_id: string, context: RuntimeContext) => { contexts.push(context); return {state:"failed"}; },
      retryTaskExperienceProcessing: async (_id: string, context: RuntimeContext) => { contexts.push(context); return {accepted:true}; }
    };
    app = Fastify();
    registerPanelRoutes(app, { services: {panel}, authenticateRuntimeToken: async (req, reply) => {
      if (req.headers.authorization !== "Bearer renderer") return reply.code(401).send({error:"unauthorized"});
    } } as unknown as AgentRuntimeRouteDeps);
    const headers = {authorization:"Bearer renderer"};
    expect((await app.inject({method:"GET",url:"/api/v1/panel/tasks/e/experience-processing",headers})).statusCode).toBe(200);
    expect(contexts[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(contexts[0]?.signal?.aborted).toBe(false);
    expect((await app.inject({method:"POST",url:"/api/v1/panel/tasks/e/experience-processing/retry",headers,payload:{}})).statusCode).toBe(200);
    expect(contexts[1]?.signal).toBeUndefined();
    for (const [method,suffix] of [["GET",""],["POST","/retry"]] as const)
      expect((await app.inject({method,url:"/api/v1/panel/tasks/e/experience-processing"+suffix})).statusCode).toBe(401);
    expect(contexts).toHaveLength(2);
  });
  it("releases the GET subscription when the renderer disconnects", async () => {
    let context: RuntimeContext | undefined;
    let disconnect: (() => void) | undefined;
    const panel = { taskExperienceProcessing: async (_id: string, ctx: RuntimeContext) => {
      context = ctx;
      await new Promise<void>(resolve => ctx.signal!.addEventListener("abort", () => resolve(), {once:true}));
      return {state:"failed"};
    } };
    app = Fastify();
    registerPanelRoutes(app, {services:{panel},authenticateRuntimeToken: async req => {disconnect = () => req.raw.emit("aborted");}} as unknown as AgentRuntimeRouteDeps);
    const result = app.inject({method:"GET",url:"/api/v1/panel/tasks/e/experience-processing"});
    await vi.waitFor(() => expect(context?.signal).toBeDefined());
    disconnect!();
    expect(context?.signal?.aborted).toBe(true);
    await result;
  });
});
