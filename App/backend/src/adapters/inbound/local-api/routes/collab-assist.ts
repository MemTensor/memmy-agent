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
/** 发起方在哪个 Agent 的哪一条会话里发起：本机据此读出发起方一侧的记录。路径只接受记录文件本身（服务里再校验文件名）。 */
const RequesterSessionSchema = z.object({
  sourceId: z.enum(["memmy", "deepseek_harness"]),
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/u, "会话 ID 无效"),
  recordPath: z.string().min(1).max(1024).optional()
}).strict();
const CreateRequestSchema = z.object({
  project: z.string().trim().min(1).max(100),
  member: MemberSchema,
  title: z.string().trim().min(1).max(200),
  reason: z.string().trim().max(500).optional(),
  items: ItemsSchema,
  /** 发起方的 Agent 名称：弹窗里要说明是谁的 Agent 在请求。 */
  via: z.string().trim().max(40).optional(),
  /** 同一次排查的续跑：带上上一次请求的 id（完整或 6 位短 id）。 */
  thread: z.string().regex(/^[A-Za-z0-9-]{1,36}$/u).optional(),
  /** 在 Memmy 的哪条任务里发起：结果回来后送回这条任务。 */
  sourceTask: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u).optional(),
  requesterSession: RequesterSessionSchema.optional()
}).strict();
const ChatIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u, "任务 ID 无效");
/** 限时授权只有四档：30 分钟、1 小时、2 小时、4 小时。 */
const GrantMinutesSchema = z.union([z.literal(30), z.literal(60), z.literal(120), z.literal(240)]);
const DecisionSchema = z.object({
  action: z.enum(["allow", "reject"]),
  agent: AgentSchema.optional(),
  scope: z.enum(["once", "timed"]).optional(),
  minutes: GrantMinutesSchema.optional()
}).strict()
  .refine((value) => value.action === "reject" || Boolean(value.agent), "允许时需要指定执行方")
  .refine((value) => value.minutes === undefined || value.scope === "timed", "只有限时授权需要时长");
const GrantAgentSchema = z.object({ agent: AgentSchema }).strict();
const ReceivingSchema = z.object({ enabled: z.boolean() }).strict();
const UserIdQuerySchema = z.object({ requester: z.string().regex(/^[0-9]{1,19}$/u).optional() }).passthrough();
const WaitSchema = z.object({
  timeoutMs: z.number().int().min(1_000).max(16 * 60 * 1000).optional(),
  requesterSession: RequesterSessionSchema.optional()
}).strict();
const StatusSchema = z.object({ requesterSession: RequesterSessionSchema.optional() }).strict();
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

  // 发起方：外部 Agent 发出的请求有了结果、Agent 还没取走时，界面据此弹通知；通知过就删掉。
  app.get("/api/collab/assist/outcomes", guard, withErrorEnvelope(async (_request, reply) =>
    reply.send({ outcomes: await options.assist.outcomes() })));
  app.delete<{ Params: { requestId: string } }>("/api/collab/assist/outcomes/:requestId", guard, withErrorEnvelope(async (request, reply) => {
    await options.assist.dismissOutcome(RequestIdSchema.parse((request.params as { requestId: string }).requestId));
    return reply.send({ ok: true });
  }));

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
      ...(input.thread === undefined ? {} : { thread: input.thread }),
      ...(input.sourceTask === undefined ? {} : { sourceTask: input.sourceTask }),
      ...(input.requesterSession === undefined ? {} : { requesterSession: input.requesterSession })
    });
    return reply.send({ request: created.request, threadId: created.threadId, text: created.text, activeGrant: created.activeGrant });
  }));

  // 一条请求的当前状态：界面刷新卡片、命令行 `assist status` 都用它。
  app.get<{ Params: { requestId: string } }>("/api/collab/assist/requests/:requestId", guard, withErrorEnvelope(async (request, reply) =>
    reply.send({ request: await options.assist.requestStatus(RequestIdSchema.parse((request.params as { requestId: string }).requestId)) })));

  // 命令行 `assist status`：当前状态的一段文字；第一次读到终态时把这段文字记为发起方收到的内容。
  // 界面刷新卡片用上面的 GET，不经过这里，免得把界面的读取当成 Agent 收到了结果。
  app.post<{ Params: { requestId: string } }>("/api/collab/assist/requests/:requestId/status", guard, withErrorEnvelope(async (request, reply) => {
    const input = StatusSchema.parse(request.body ?? {});
    return reply.send(await options.assist.agentStatus(
      RequestIdSchema.parse((request.params as { requestId: string }).requestId),
      input.requesterSession === undefined ? {} : { requesterSession: input.requesterSession }
    ));
  }));

  // 发起方等结果：等不到就返回当前状态，不假装完成。
  app.post<{ Params: { requestId: string } }>("/api/collab/assist/requests/:requestId/wait", guard, withErrorEnvelope(async (request, reply) => {
    const requestId = RequestIdSchema.parse((request.params as { requestId: string }).requestId);
    const input = WaitSchema.parse(request.body ?? {});
    return reply.send(await options.assist.waitRequest(requestId, {
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.requesterSession === undefined ? {} : { requesterSession: input.requesterSession })
    }));
  }));

  // 执行方允许或拒绝。允许之后本机立刻开始执行，界面不必等下一个轮询周期。
  app.post<{ Params: { requestId: string } }>("/api/collab/assist/requests/:requestId/decision", guard, withErrorEnvelope(async (request, reply) => {
    const requestId = RequestIdSchema.parse((request.params as { requestId: string }).requestId);
    const input = DecisionSchema.parse(request.body ?? {});
    return reply.send({ request: await options.assist.decide({
      requestId,
      action: input.action,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.minutes === undefined ? {} : { minutes: input.minutes })
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

  // 结束协助：结束本人对这个项目里的成员的限时授权；之后的请求重新询问她。
  app.post("/api/collab/assist/end", guard, withErrorEnvelope(async (request, reply) => {
    const input = EndAssistSchema.parse(request.body ?? {});
    return reply.send(await options.assist.endAssist(input));
  }));

  // 执行方：本机正在执行与排队中的请求，界面按它展示每一步。
  app.get("/api/collab/assist/executions", guard, withErrorEnvelope(async (_request, reply) =>
    reply.send({ executions: options.assist.executions() })));

  // 执行方：当前并发情况（同一时间只执行一个，其余排队）。
  app.get("/api/collab/assist/settings", guard, withErrorEnvelope(async (_request, reply) =>
    reply.send(options.assist.settings())));

  // 本人在这个项目里是否接收协助请求：项目设置里的开关。默认关闭，只能改自己的。
  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/assist/receiving", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.assist.receiving(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

  app.put<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/assist/receiving", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const input = ReceivingSchema.parse(request.body ?? {});
    return reply.send(await options.assist.setReceiving(projectId, input.enabled));
  }));

  // 执行方的候选：这台电脑上能运行的 Agent，分「本项目用过」与「其他」两层，带默认选中项。
  // 授权弹窗、任务内确认与项目设置里的「换用」都用这一份；`requester` 给出时按她对这位发起人的选择定默认项。
  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/assist/agents", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const query = UserIdQuerySchema.parse(request.query ?? {});
    return reply.send(await options.assist.agents(projectId, query.requester));
  }));

  // 限时授权：项目设置列出剩余时间、更换执行的 Agent、结束授权。
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

  // 项目里的协助：本人作为发起人或执行人的排查，按一次排查一行，保留 30 天。看板上的协助条目用它。
  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/assist/threads", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.assist.threads(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

  // 打开一次协助：各次请求的提示词、执行过程、回复与发起方收到的内容，只有发起人和执行人能读。
  app.get<{ Params: { projectId: string; threadId: string } }>("/api/collab/projects/:projectId/assist/threads/:threadId", guard, withErrorEnvelope(async (request, reply) => {
    const params = request.params as { projectId: string; threadId: string };
    return reply.send(await options.assist.thread(ProjectIdSchema.parse(params.projectId), RequestIdSchema.parse(params.threadId)));
  }));

  // 从本人的列表中移除一次已经结束的协助：只对自己隐藏，双方都移除后云端删除。所有者与管理员不能删别人的协助。
  app.delete<{ Params: { projectId: string; threadId: string } }>("/api/collab/projects/:projectId/assist/threads/:threadId", guard, withErrorEnvelope(async (request, reply) => {
    const params = request.params as { projectId: string; threadId: string };
    return reply.send(await options.assist.hideThread(ProjectIdSchema.parse(params.projectId), RequestIdSchema.parse(params.threadId)));
  }));

  // 一条 Memmy 任务上的协助：它是执行方的一次协助，或者在它里面发出过请求。任务页据此显示协助条与卡片。
  app.get<{ Params: { chatId: string } }>("/api/collab/assist/tasks/:chatId", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.assist.taskAssist(ChatIdSchema.parse((request.params as { chatId: string }).chatId)))));
}