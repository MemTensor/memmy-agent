/**
 * 成员协助的本机接口：执行方（授权、执行、记录）与发起方（请求卡片、等结果）。
 *
 * <p>云端接口不直接暴露给界面与命令行：它们要账号凭据、也要在错误的时机给出能读的中文，
 * 这些都在 {@link CollabAssistService} 里做。这里只做参数校验与转发。</p>
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { CollabAssistService } from "../../../../services/collab-assist-service.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

export interface RegisterCollabAssistRoutesOptions {
  assist: CollabAssistService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,36}$/u, "项目 ID 无效");
const RequestIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,36}$/u, "协助请求 ID 无效");
/** 成员既可以是账号 id，也可以是名字：命令行用名字，界面用 id。 */
const MemberSchema = z.string().trim().min(1).max(100);
const AgentSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u, "执行方无效");
const ItemsSchema = z.array(z.string().trim().min(1).max(500)).min(1).max(10);
const CreateRequestSchema = z.object({
  project: z.string().trim().min(1).max(100),
  member: MemberSchema,
  title: z.string().trim().min(1).max(200),
  reason: z.string().trim().max(500).optional(),
  items: ItemsSchema,
  /** 发起方的 Agent 名称：弹窗里要说明是谁的 Agent 在请求。 */
  via: z.string().trim().max(40).optional(),
  /** 同一次排查的续跑：带上上一次的 thread。 */
  thread: z.string().regex(/^[A-Za-z0-9-]{1,36}$/u).optional()
}).strict();
const DecisionSchema = z.object({
  action: z.enum(["allow", "reject"]),
  agent: AgentSchema.optional(),
  scope: z.enum(["once", "always"]).optional()
}).strict().refine((value) => value.action === "reject" || Boolean(value.agent), "允许时需要指定执行方");
const GrantAgentSchema = z.object({ agent: AgentSchema }).strict();
const AllowAssistSchema = z.object({ allowAssist: z.boolean() }).strict();
const WaitSchema = z.object({ timeoutMs: z.number().int().min(1_000).max(16 * 60 * 1000).optional() }).strict();
const NoteSchema = z.object({ note: z.string().trim().min(1).max(2_000) }).strict();
const EndAssistSchema = z.object({
  project: z.string().trim().min(1).max(100),
  member: MemberSchema.optional()
}).strict();

export function registerCollabAssistRoutes(app: FastifyInstance, options: RegisterCollabAssistRoutesOptions): void {
  const guard = { preHandler: options.authenticateRuntimeToken };

  // 执行方：收件箱。界面每 5 秒轮询它，第一次拿到就在右上角弹一条通知。
  app.get("/api/collab/assist/inbox", guard, withErrorEnvelope(async (_request, reply) =>
    reply.send(await options.assist.inbox())));

  // 发起方：发一条请求，或续跑同一次排查（带 thread）。
  app.post("/api/collab/assist/requests", guard, withErrorEnvelope(async (request, reply) => {
    const input = CreateRequestSchema.parse(request.body ?? {});
    const created = await options.assist.createRequest({
      project: input.project,
      member: input.member,
      title: input.title,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      items: input.items,
      ...(input.via === undefined ? {} : { via: input.via }),
      ...(input.thread === undefined ? {} : { thread: input.thread })
    });
    return reply.send({ request: created.request, threadId: created.threadId, text: created.text });
  }));

  // 一条请求的当前状态：界面刷新卡片、命令行 `assist status` 都用它。
  app.get<{ Params: { requestId: string } }>("/api/collab/assist/requests/:requestId", guard, withErrorEnvelope(async (request, reply) =>
    reply.send({ request: await options.assist.requestStatus(RequestIdSchema.parse((request.params as { requestId: string }).requestId)) })));

  // 发起方等结果：等不到就返回当前状态，不假装完成。
  app.post<{ Params: { requestId: string } }>("/api/collab/assist/requests/:requestId/wait", guard, withErrorEnvelope(async (request, reply) => {
    const requestId = RequestIdSchema.parse((request.params as { requestId: string }).requestId);
    const input = WaitSchema.parse(request.body ?? {});
    return reply.send(await options.assist.waitRequest(requestId, input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }));
  }));

  // 执行方允许或拒绝。允许之后本机立刻开始执行，界面不必等下一个轮询周期。
  app.post<{ Params: { requestId: string } }>("/api/collab/assist/requests/:requestId/decision", guard, withErrorEnvelope(async (request, reply) => {
    const requestId = RequestIdSchema.parse((request.params as { requestId: string }).requestId);
    const input = DecisionSchema.parse(request.body ?? {});
    return reply.send({ request: await options.assist.decide({
      requestId,
      action: input.action,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      ...(input.scope === undefined ? {} : { scope: input.scope })
    }) });
  }));

  // 执行方停止当前执行：发起方会看到「谁停止了这次执行」。
  app.post<{ Params: { requestId: string } }>("/api/collab/assist/requests/:requestId/stop", guard, withErrorEnvelope(async (request, reply) => {
    const requestId = RequestIdSchema.parse((request.params as { requestId: string }).requestId);
    return reply.send({ request: await options.assist.stop(requestId) });
  }));

  // 执行方补充一句说明：作为一条进展发给发起方。
  app.post<{ Params: { requestId: string } }>("/api/collab/assist/requests/:requestId/note", guard, withErrorEnvelope(async (request, reply) => {
    const requestId = RequestIdSchema.parse((request.params as { requestId: string }).requestId);
    const input = NoteSchema.parse(request.body ?? {});
    await options.assist.addNote(requestId, input.note);
    return reply.send({ ok: true });
  }));

  // 发起方撤回：只对还没开始执行的请求有效。
  app.post<{ Params: { requestId: string } }>("/api/collab/assist/requests/:requestId/cancel", guard, withErrorEnvelope(async (request, reply) => {
    const requestId = RequestIdSchema.parse((request.params as { requestId: string }).requestId);
    return reply.send({ request: await options.assist.cancelRequest(requestId) });
  }));

  // 结束协助：结束本人对这个项目里的成员的长期授权；之后的请求重新询问她。
  app.post("/api/collab/assist/end", guard, withErrorEnvelope(async (request, reply) => {
    const input = EndAssistSchema.parse(request.body ?? {});
    return reply.send(await options.assist.endAssist(input));
  }));

  // 执行方：本机正在执行与排队中的请求，界面按它展示每一步。
  app.get("/api/collab/assist/executions", guard, withErrorEnvelope(async (_request, reply) =>
    reply.send({ executions: options.assist.executions() })));

  // 执行方：总开关与当前并发情况。
  app.get("/api/collab/assist/settings", guard, withErrorEnvelope(async (_request, reply) =>
    reply.send(options.assist.settings())));

  app.put("/api/collab/assist/settings", guard, withErrorEnvelope(async (request, reply) => {
    const input = AllowAssistSchema.parse(request.body ?? {});
    return reply.send(await options.assist.setAllowAssist(input.allowAssist));
  }));

  // 授权弹窗里列出的 Agent：已关联到协作项目的，加上 Memmy 本身。
  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/assist/agents", guard, withErrorEnvelope(async (request, reply) =>
    reply.send({ agents: await options.assist.agents(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)) })));

  // 长期授权：设置页列出、更换执行的 Agent、结束授权。
  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/assist/grants", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.assist.grants(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

  app.patch<{ Params: { projectId: string; grantee: string } }>("/api/collab/projects/:projectId/assist/grants/:grantee", guard, withErrorEnvelope(async (request, reply) => {
    const params = request.params as { projectId: string; grantee: string };
    const input = GrantAgentSchema.parse(request.body ?? {});
    return reply.send(await options.assist.setGrantAgent({
      projectId: ProjectIdSchema.parse(params.projectId),
      grantee: MemberSchema.parse(params.grantee),
      agent: input.agent
    }));
  }));

  app.delete<{ Params: { projectId: string; grantee: string } }>("/api/collab/projects/:projectId/assist/grants/:grantee", guard, withErrorEnvelope(async (request, reply) => {
    const params = request.params as { projectId: string; grantee: string };
    return reply.send(await options.assist.revokeGrant({
      projectId: ProjectIdSchema.parse(params.projectId),
      grantee: MemberSchema.parse(params.grantee)
    }));
  }));

  // 协助记录：保留 30 天。
  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/assist/records", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.assist.records(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));
}