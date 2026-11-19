/** Online project routes: projects, associated sessions, and references from other agents. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { MAX_COLLAB_INSTRUCTIONS_CHARS } from "@memmy/local-api-contracts";
import { CollabError, sinceWindowMs, type CollabService, type DemoEndReason } from "../../../../services/collab-service.js";
import type { CollabAgentAccessService } from "../../../../services/collab-agent-access-service.js";
import { connectCollabAgent, removeCollabAgent } from "../../../../services/collab-added-agents.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

export interface RegisterCollabRoutesOptions {
  collab: CollabService;
  /** 「在其他 Agent 中使用协作项目」的授权：设置页与授权弹窗读写它。 */
  agentAccess?: CollabAgentAccessService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  recallProjectKnowledge?: (query: string, projectId: string) => Promise<{ enabled: boolean; evidence: unknown[]; projectOnly?: boolean }>;
}

const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9-]{1,36}$/u, "项目 ID 无效");
/** 知识库 id 是 UUID，和项目 id 同一套字符。 */
const BaseIdSchema = ProjectIdSchema;
const KnowledgeLinkSchema = z.object({ baseId: BaseIdSchema }).strict();
const CreateProjectSchema = z.object({
  name: z.string().trim().min(1, "请填写项目名称").max(20, "项目名称不超过 20 个字"),
  /** The folder the person picked for the project's tasks; a managed folder is used when absent. */
  directory: z.string().trim().min(1).max(4_000).optional(),
  /**
   * 新手引导的演示：只在桌面端认为「本人第一次创建共享项目」时带。是否真的演示由云端判断，
   * 不能演示时照常只建项目。
   */
  demo: z.boolean().optional(),
  /**
   * 发起这次共享的本机项目：同一个本机项目重复共享时复用它已有的在线项目，云端也按它去重。
   * 旧客户端不带这个字段，行为不变。
   */
  localProjectId: z.string().trim().min(1).max(200).optional()
}).strict();
/** 演示的心跳与结束：步骤只用于排查，结束原因按约定取值。 */
const DemoHeartbeatSchema = z.object({ step: z.enum(["1", "2", "3", "finish"]) }).strict();
const DemoEndSchema = z.object({ reason: z.enum(["finished", "exited", "skipped", "left"]) }).strict();
const BindProjectSchema = z.object({ localProjectId: z.string().min(1).max(200) }).strict();
const WorkingDirectorySchema = z.object({
  /** Names the managed folder after the project instead of its generated id. */
  name: z.string().trim().min(1).max(200).optional(),
  directory: z.string().trim().min(1).max(4_000).optional()
}).strict();
const SyncSchema = z.object({
  tasks: z.boolean().optional(),
  /** With `tasks`: only this project, which is what a board opening needs. */
  projectId: ProjectIdSchema.optional()
}).strict();
const SessionListSchema = z.object({
  q: z.string().max(200).optional(),
  member: z.enum(["me", "others"]).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});
const CandidatesSchema = z.object({
  projectId: ProjectIdSchema,
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional()
});
const SourceIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
/** 用户添加的 Agent 的 sourceId 形如 `added-qoder-82ef827e`，与内置来源同一套字符。 */
const AgentSourceSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/u, "Agent ID 无效");
const AgentAccessSchema = z.object({ granted: z.boolean() }).strict();
const AgentAccessInstallSchema = z.object({ sourceIds: z.array(AgentSourceSchema).max(100).optional() }).strict();
const AgentEnabledSchema = z.object({ enabled: z.boolean() }).strict();
const ConversationIdSchema = z.string().min(1).max(200);
const LinksSchema = z.object({
  groups: z.array(z.object({
    sourceId: SourceIdSchema,
    groupId: z.string().min(1).max(1_000),
    excluded: z.array(ConversationIdSchema).max(500)
  }).strict()).max(100),
  sessions: z.array(z.object({ sourceId: SourceIdSchema, conversationId: ConversationIdSchema }).strict()).max(500)
}).strict();
const LocalSessionsSchema = z.object({
  query: z.string().max(200).optional(),
  sourceIds: z.array(z.string().max(32)).max(20).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  fresh: z.boolean().optional()
}).strict();
const SearchSchema = z.object({
  q: z.string().max(200).optional(),
  member: z.string().max(100).optional(),
  project: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
  since: z.string().max(10).optional()
    .refine((value) => value === undefined || sinceWindowMs(value) !== null, "--since 的写法如 7d、24h 或 2w")
});
const TurnNumberSchema = z.number().int().min(1).max(100_000);
/** What `sessions read` prints inline; the CLI always sends one, the @ menu never does. */
const ReadViewSchema = z.object({
  turns: z.object({ from: TurnNumberSchema, to: TurnNumberSchema }).strict().optional(),
  around: TurnNumberSchema.optional(),
  find: z.string().trim().min(1).max(500).optional(),
  all: z.boolean().optional()
}).strict().refine((view) => Object.keys(view).length <= 1, "只能指定一种读取范围");
const ReadSchema = z.object({ reference: z.string().trim().min(1).max(2_000), view: ReadViewSchema.optional() }).strict();
const ConnectAgentSchema = z.object({
  name: z.string().trim().min(1).max(40),
  /** 用户填的技能目录；留空时由添加任务自己去查找，不在这里猜。 */
  skillDirectory: z.string().trim().min(1).max(4_000)
}).strict();
const RemoveAgentSchema = z.object({ name: z.string().trim().min(1).max(40) }).strict();
/** Adds the current local task. The project name is optional so a partial name can be answered with the next command. */
const AddSessionSchema = z.object({
  project: z.string().trim().min(1).max(100).optional(),
  cwd: z.string().trim().min(1).max(4_000).optional(),
  hint: z.string().trim().min(1).max(500).optional(),
  /** Set together: the conversation the command is running inside. */
  sourceId: SourceIdSchema.optional(),
  conversationId: ConversationIdSchema.optional(),
  /** 用户添加的 Agent 交上来的任务：全部轮次，附带来源 Agent 的名称与标题。 */
  submission: z.object({
    agentName: z.string().trim().min(1).max(40),
    title: z.string().trim().min(1).max(200),
    turns: z.array(z.object({
      question: z.string().trim().min(1).max(8_000),
      reply: z.string().trim().min(1).max(20_000),
      at: z.string().trim().min(1).max(40).optional()
    }).strict()).min(1).max(500),
    /** Agent 明确给出的记录文件；不给时由 Memmy 在该 Agent 的配置目录里按原文搜索。 */
    sourcePath: z.string().trim().min(1).max(4_000).optional()
  }).strict().optional()
}).strict();
const SearchKnowledgeSchema = z.object({
  query: z.string().trim().min(1).max(8000),
  project: z.string().trim().min(1).max(100).optional(),
  sourceId: SourceIdSchema.optional(),
  conversationId: ConversationIdSchema.optional()
}).strict().refine((value) => Boolean(value.sourceId) === Boolean(value.conversationId), "会话身份不完整");
const RenameProjectSchema = z.object({
  name: z.string().trim().min(1, "请填写项目名称").max(20, "项目名称不超过 20 个字")
}).strict();
const InstructionsSchema = z.object({
  instructions: z.string().max(MAX_COLLAB_INSTRUCTIONS_CHARS * 4),
  /** 看板带来的本机项目目录，仅用于记下“这个目录属于哪个协作项目”，不是指令的键。 */
  directory: z.string().trim().min(1).max(4_096)
    .refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value), "项目目录需为绝对路径")
    .optional()
}).strict();
const ProjectTasksSchema = z.object({
  /** Conversation ids of the project's Memmy sessions that members may read. */
  included: z.array(ConversationIdSchema).max(500)
}).strict();
/** 一条任务的共享开关。 */
const TaskSharingSchema = z.object({ shared: z.boolean() }).strict();
/** 在 Memmy 的任务里用 `memmy-project session share` 开启/关闭这条任务的共享。 */
const ShareCurrentTaskSchema = z.object({
  conversationId: ConversationIdSchema,
  shared: z.boolean(),
  project: z.string().trim().min(1).max(100).optional()
}).strict();
/**
 * Cloud account IDs are numeric snowflake ids, 19 digits for accounts created by the assignment strategy (`agent_user.id`).
 * The upper bound matches a signed 64-bit column, so real accounts are never rejected by this local check.
 */
const UserIdSchema = z.string().regex(/^[0-9]{1,19}$/u, "成员 ID 无效");
const UpdateProjectSchema = z.object({ joinMode: z.enum(["direct", "approval"]) }).strict();
/** No one is made owner here: there is no ownership transfer. */
const MemberRoleSchema = z.object({ role: z.enum(["admin", "member"]) }).strict();
/** The pasted link, or the whole copied invite text. */
const InviteReferenceSchema = z.string().trim().min(1, "请粘贴邀请链接").max(2_000);
const PreviewInviteSchema = z.object({ reference: InviteReferenceSchema }).strict();
const JoinSchema = z.object({
  reference: InviteReferenceSchema,
  /** The folder the person picked for the project's tasks; a managed folder is used when absent. */
  directory: z.string().trim().min(1).max(4_000).optional(),
  /**
   * 加入时顺手改的昵称，可不填：不填就沿用账号原来的名字。
   * 填了要跟本项目现有成员不重名，由云端判定，这里只卡长度。
   */
  nickname: z.string().trim().max(32, "昵称不超过 32 个字").optional()
}).strict();

export function registerCollabRoutes(app: FastifyInstance, options: RegisterCollabRoutesOptions): void {
  const guard = { preHandler: options.authenticateRuntimeToken };

  app.get("/api/collab/projects", guard, withErrorEnvelope(async (_request, reply) =>
    reply.send(await options.collab.listProjects())));

  // Agents added on this computer, read from its own file: the board names their tasks with these names,
  // and the cloud only knows the generated source id.
  app.get("/api/collab/agents", guard, withErrorEnvelope(async (_request, reply) =>
    reply.send({ agents: await options.collab.listAddedAgents() })));

  // 等自己审核的加入申请，跨项目一次给出：邀请人的 Memmy 轮询它并在屏幕上弹窗。
  app.get("/api/collab/join-requests", guard, withErrorEnvelope(async (_request, reply) =>
    reply.send({ requests: await options.collab.joinRequests() })));

  app.post("/api/collab/projects", guard, withErrorEnvelope(async (request, reply) => {
    const input = CreateProjectSchema.parse(request.body ?? {});
    return reply.send(await options.collab.createProject(
      input.name,
      input.directory,
      input.demo === undefined && input.localProjectId === undefined
        ? undefined
        : { demo: input.demo, localProjectId: input.localProjectId }
    ));
  }));

  // 新手引导的演示：演示期间每 30 秒一次心跳，步骤变化时立即补一次；结束时叫云端把演示成员移出项目。
  app.post<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/demo/heartbeat", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const input = DemoHeartbeatSchema.parse(request.body ?? {});
    return reply.send(await options.collab.demoHeartbeat(projectId, input.step));
  }));

  app.post<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/demo/end", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const input = DemoEndSchema.parse(request.body ?? {});
    return reply.send(await options.collab.demoEnd(projectId, input.reason as DemoEndReason));
  }));

  // Projects created before binding existed, and tasks that lost their local project, get one on demand.
  // The board polls this while an association runs, so sessions appear as they are uploaded.
  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/sync-progress", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.collab.getSyncProgress(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

  app.post<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/working-directory", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const input = WorkingDirectorySchema.parse(request.body ?? {});
    return reply.send(await options.collab.ensureWorkingDirectory(projectId, input.name, input.directory));
  }));

  app.put<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/binding", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const input = BindProjectSchema.parse(request.body ?? {});
    return reply.send(await options.collab.bindLocalProject(projectId, input.localProjectId));
  }));

  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/sessions", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const input = SessionListSchema.parse(request.query ?? {});
    return reply.send(await options.collab.listSessions(projectId, {
      ...(input.q === undefined ? {} : { query: input.q }),
      ...(input.member === undefined ? {} : { member: input.member }),
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      ...(input.limit === undefined ? {} : { limit: input.limit })
    }));
  }));

  // The board's session reader and the @ menu both read one session without downloading a file.
  app.get<{ Params: { sessionId: string } }>("/api/collab/sessions/:sessionId", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.collab.readSessionDetail(ProjectIdSchema.parse((request.params as { sessionId: string }).sessionId)))));

  // The @ menu offers sessions of the project the task belongs to; a reference never leaves that project.
  app.get("/api/collab/sessions/candidates", guard, withErrorEnvelope(async (request, reply) => {
    const input = CandidatesSchema.parse(request.query ?? {});
    return reply.send(await options.collab.candidateSessions(input.projectId, {
      ...(input.q === undefined ? {} : { query: input.q }),
      ...(input.limit === undefined ? {} : { limit: input.limit })
    }));
  }));

  // Sharing a project uploads the Memmy sessions chosen here; the rest stay on this computer.
  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/tasks", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.collab.listProjectTasks(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

  app.put<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/tasks", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const input = ProjectTasksSchema.parse(request.body ?? {});
    return reply.send(await options.collab.saveProjectTasks(projectId, input.included));
  }));

  // 一条 Memmy 任务的共享开关：没有记录时视为不共享，开启才上传，关闭会删掉云端副本。
  // 桌面端在已共享项目里新建任务时默认开启，会话建立时调用这里写入。
  app.get<{ Params: { projectId: string; conversationId: string } }>("/api/collab/projects/:projectId/tasks/:conversationId/sharing", guard, withErrorEnvelope(async (request, reply) => {
    const params = request.params as { projectId: string; conversationId: string };
    return reply.send(await options.collab.getTaskSharing(
      ProjectIdSchema.parse(params.projectId),
      ConversationIdSchema.parse(params.conversationId)
    ));
  }));

  app.put<{ Params: { projectId: string; conversationId: string } }>("/api/collab/projects/:projectId/tasks/:conversationId/sharing", guard, withErrorEnvelope(async (request, reply) => {
    const params = request.params as { projectId: string; conversationId: string };
    const input = TaskSharingSchema.parse(request.body ?? {});
    return reply.send(await options.collab.setTaskSharing(
      ProjectIdSchema.parse(params.projectId),
      ConversationIdSchema.parse(params.conversationId),
      input.shared
    ));
  }));

  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/links", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.collab.getLinks(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

  app.put<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/links", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const input = LinksSchema.parse(request.body ?? {});
    return reply.send(await options.collab.saveLinks(projectId, input));
  }));

  app.delete<{ Params: { projectId: string } }>("/api/collab/projects/:projectId", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.collab.deleteProject(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

  // One PATCH per project: `name` renames it for every member (owner only, enforced by the cloud), `joinMode` says
  // how a link lets people in. Members, invite links, join requests and roles live below.
  app.patch<{ Params: { projectId: string } }>("/api/collab/projects/:projectId", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const body = request.body ?? {};
    if (typeof (body as { name?: unknown }).name === "string") {
      const input = RenameProjectSchema.parse(body);
      return reply.send(await options.collab.renameProject(projectId, input.name));
    }
    // 项目指令由所有者与管理员编辑（云端判定权限），后端把内容缓存到协作侧自己的文件，项目里的任务随即按新指令执行。
    if (typeof (body as { instructions?: unknown }).instructions === "string") {
      const input = InstructionsSchema.parse(body);
      return reply.send(await options.collab.updateInstructions(projectId, input.instructions, input.directory));
    }
    const input = UpdateProjectSchema.parse(body);
    return reply.send(await options.collab.setJoinMode(projectId, input.joinMode));
  }));

  // 项目配置的知识库：关联对本项目全体成员开放，解除由云端判定（关联人自己或所有者、管理员）。
  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/knowledge", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.collab.knowledge(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

  app.post<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/knowledge", guard, withErrorEnvelope(async (request, reply) => {
    const projectId = ProjectIdSchema.parse((request.params as { projectId: string }).projectId);
    const input = KnowledgeLinkSchema.parse(request.body ?? {});
    return reply.send(await options.collab.addKnowledge(projectId, input.baseId));
  }));

  app.delete<{ Params: { projectId: string; baseId: string } }>("/api/collab/projects/:projectId/knowledge/:baseId", guard, withErrorEnvelope(async (request, reply) => {
    const params = request.params as { projectId: string; baseId: string };
    return reply.send(await options.collab.removeKnowledge(
      ProjectIdSchema.parse(params.projectId),
      BaseIdSchema.parse(params.baseId)
    ));
  }));

  app.get<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/members", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.collab.listMembers(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

  app.post<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/invite", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.collab.createInvite(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

  app.post<{ Params: { projectId: string } }>("/api/collab/projects/:projectId/leave", guard, withErrorEnvelope(async (request, reply) =>
    reply.send(await options.collab.leaveProject(ProjectIdSchema.parse((request.params as { projectId: string }).projectId)))));

  app.post<{ Params: { projectId: string; userId: string } }>("/api/collab/projects/:projectId/requests/:userId/approve", guard, withErrorEnvelope(async (request, reply) => {
    const params = request.params as { projectId: string; userId: string };
    return reply.send(await options.collab.approveRequest(ProjectIdSchema.parse(params.projectId), UserIdSchema.parse(params.userId)));
  }));

  app.delete<{ Params: { projectId: string; userId: string } }>("/api/collab/projects/:projectId/requests/:userId", guard, withErrorEnvelope(async (request, reply) => {
    const params = request.params as { projectId: string; userId: string };
    return reply.send(await options.collab.rejectRequest(ProjectIdSchema.parse(params.projectId), UserIdSchema.parse(params.userId)));
  }));

  app.patch<{ Params: { projectId: string; userId: string } }>("/api/collab/projects/:projectId/members/:userId", guard, withErrorEnvelope(async (request, reply) => {
    const params = request.params as { projectId: string; userId: string };
    const input = MemberRoleSchema.parse(request.body ?? {});
    return reply.send(await options.collab.setMemberRole(ProjectIdSchema.parse(params.projectId), UserIdSchema.parse(params.userId), input.role));
  }));

  app.delete<{ Params: { projectId: string; userId: string } }>("/api/collab/projects/:projectId/members/:userId", guard, withErrorEnvelope(async (request, reply) => {
    const params = request.params as { projectId: string; userId: string };
    return reply.send(await options.collab.removeMember(ProjectIdSchema.parse(params.projectId), UserIdSchema.parse(params.userId)));
  }));

  // Joining starts from a pasted link: preview what it opens, then join or apply.
  app.post("/api/collab/invites/preview", guard, withErrorEnvelope(async (request, reply) => {
    const input = PreviewInviteSchema.parse(request.body ?? {});
    return reply.send(await options.collab.previewInvite(input.reference));
  }));

  app.post("/api/collab/invites/join", guard, withErrorEnvelope(async (request, reply) => {
    const input = JoinSchema.parse(request.body ?? {});
    return reply.send(await options.collab.joinProject(input.reference, input.directory, input.nickname));
  }));

  app.delete<{ Params: { projectId: string; sessionId: string } }>("/api/collab/projects/:projectId/sessions/:sessionId", guard, withErrorEnvelope(async (request, reply) => {
    const params = request.params as { projectId: string; sessionId: string };
    return reply.send(await options.collab.removeSession(ProjectIdSchema.parse(params.projectId), ProjectIdSchema.parse(params.sessionId)));
  }));

  // Opening a board syncs first, so a task finished a moment ago is already in its project's session list.
  // `tasks` keeps it to Memmy's own tasks, which needs no agent scan and returns in milliseconds.
  app.post("/api/collab/sync", guard, withErrorEnvelope(async (request, reply) => {
    const input = SyncSchema.parse(request.body ?? {});
    return reply.send(input.tasks
      ? await options.collab.syncProjectTasks(input.projectId)
      : await options.collab.syncLinkedSessions());
  }));

  app.post("/api/collab/local-sessions", guard, withErrorEnvelope(async (request, reply) => {
    const input = LocalSessionsSchema.parse(request.body ?? {});
    return reply.send(await options.collab.listLocalSessions(input));
  }));

  // 在其他 Agent 中使用协作项目的授权：设置页、授权弹窗与看板的询问都读写这一份状态。
  app.get("/api/collab/agent-access", guard, withErrorEnvelope(async (_request, reply) => {
    if (!options.agentAccess) throw new CollabError("not_found", "这个版本不支持协作项目授权");
    return reply.send(await options.agentAccess.view());
  }));

  app.put("/api/collab/agent-access", guard, withErrorEnvelope(async (request, reply) => {
    if (!options.agentAccess) throw new CollabError("not_found", "这个版本不支持协作项目授权");
    const input = AgentAccessSchema.parse(request.body ?? {});
    const result = await options.agentAccess.setGranted(input.granted);
    // 状态与逐个 Agent 的安装结果平铺在同一个回应里：界面一次拿到，失败的可重试。
    return reply.send({ ...result.view, results: result.results });
  }));

  // 已授权但没装上（当时 Agent 不在、或装失败）时重新装一次，可只装指定几个。
  app.post("/api/collab/agent-access/install", guard, withErrorEnvelope(async (request, reply) => {
    if (!options.agentAccess) throw new CollabError("not_found", "这个版本不支持协作项目授权");
    const input = AgentAccessInstallSchema.parse(request.body ?? {});
    const result = await options.agentAccess.install(input.sourceIds);
    return reply.send({ ...result.view, results: result.results });
  }));

  // 记下已经在项目里询问过一次：选「暂不安装」也算，之后不再主动询问。
  app.post("/api/collab/agent-access/asked", guard, withErrorEnvelope(async (_request, reply) => {
    if (!options.agentAccess) throw new CollabError("not_found", "这个版本不支持协作项目授权");
    await options.agentAccess.markAsked();
    return reply.send(await options.agentAccess.view());
  }));

  // 设置里逐个开关：关掉不再读取、卸载组件；打开时若已授权就装回去。
  app.put<{ Params: { sourceId: string } }>("/api/collab/agent-access/agents/:sourceId", guard, withErrorEnvelope(async (request, reply) => {
    if (!options.agentAccess) throw new CollabError("not_found", "这个版本不支持协作项目授权");
    const input = AgentEnabledSchema.parse(request.body ?? {});
    const result = await options.agentAccess.setAgentEnabled(
      AgentSourceSchema.parse((request.params as { sourceId: string }).sourceId),
      input.enabled
    );
    return reply.send({ ...result.view, results: result.results });
  }));

  app.get("/api/collab/sessions/search", guard, withErrorEnvelope(async (request, reply) => {
    const input = SearchSchema.parse(request.query ?? {});
    return reply.send(await options.collab.searchSessions({
      ...(input.q === undefined ? {} : { query: input.q }),
      ...(input.member === undefined ? {} : { member: input.member }),
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.since === undefined ? {} : { since: input.since, sinceMs: sinceWindowMs(input.since) ?? undefined })
    }));
  }));

  app.post("/api/collab/sessions/read", guard, withErrorEnvelope(async (request, reply) => {
    const input = ReadSchema.parse(request.body ?? {});
    return reply.send(await options.collab.readSession(input.reference, input.view));
  }));

  app.post("/api/collab/knowledge/search", guard, withErrorEnvelope(async (request, reply) => {
    const input = SearchKnowledgeSchema.parse(request.body ?? {});
    if (!options.recallProjectKnowledge) throw new CollabError("internal", "知识库服务未就绪");
    if (!input.project && !input.sourceId) throw new CollabError("invalid_argument", "无法识别当前会话，请用 --project 指定项目名称");
    const projects = input.sourceId && input.conversationId
      ? await options.collab.projectsForAgentSession(input.sourceId, input.conversationId)
      : (await options.collab.listProjects()).projects;
    const matches = input.project
      ? matchProject(projects, input.project)
      : projects;
    if (!matches.length) throw new CollabError("not_found", missingProjectMessage(input.project, Boolean(input.sourceId)));
    if (matches.length > 1) {
      throw new CollabError(
        "conflict",
        `当前会话关联多个项目，请用 --project 指定：${matches.map((project) => `${project.name} #${project.id.slice(0, 8)}`).join("、")}`
      );
    }
    const project = matches[0]!;
    const result = await options.recallProjectKnowledge(input.query, project.id);
    return reply.send({ project: { id: project.id, name: project.name }, ...result });
  }));

  // 添加一个用户自己的 Agent：只把 memmy-project 装进它的技能目录，回复就是 `memmy-project agent connect` 打印的文字。
  app.post("/api/collab/agents/connect", guard, withErrorEnvelope(async (request, reply) => {
    const input = ConnectAgentSchema.parse(request.body ?? {});
    try {
      const result = await connectCollabAgent({
        name: input.name,
        skillDirectory: input.skillDirectory
      });
      return reply.send({ text: result.text, sourceId: result.sourceId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "没有添加这个 Agent。";
      return reply.send({ text: message });
    }
  }));

  app.post("/api/collab/agents/remove", guard, withErrorEnvelope(async (request, reply) => {
    const input = RemoveAgentSchema.parse(request.body ?? {});
    return reply.send({ text: await removeCollabAgent(input.name) });
  }));

  app.post("/api/collab/sessions/add", guard, withErrorEnvelope(async (request, reply) => {
    const input = AddSessionSchema.parse(request.body ?? {});
    return reply.send(await options.collab.addCurrentSession({
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.hint === undefined ? {} : { hint: input.hint }),
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.submission === undefined ? {} : { submission: input.submission })
    }));
  }));

  // One Memmy task shares or stops sharing itself with its own project. The reply is the text `session share` prints.
  app.post("/api/collab/sessions/share", guard, withErrorEnvelope(async (request, reply) => {
    const input = ShareCurrentTaskSchema.parse(request.body ?? {});
    return reply.send(await options.collab.shareCurrentTask({
      conversationId: input.conversationId,
      shared: input.shared,
      ...(input.project === undefined ? {} : { project: input.project })
    }));
  }));
}

/** Why a knowledge search found no project: no project was named, or the named one is not linked to this session. */
/**
 * 按 --project 的值找项目：先认 id（含短前缀），再认完整名称，最后才按前缀试一次。
 * 同名项目只能靠 id 分开，所以 id 认得的排在名称前面。
 */
function matchProject<T extends { id: string; name: string }>(projects: readonly T[], want: string): T[] {
  const value = want.trim();
  if (!value) return [...projects];
  const byId = projects.filter((project) => project.id === value);
  if (byId.length) return byId;
  const byName = projects.filter((project) => project.name === value);
  if (byName.length) return byName;
  return projects.filter((project) => project.id.startsWith(value));
}

function missingProjectMessage(project: string | undefined, sessionKnown: boolean): string {
  if (!sessionKnown) return "没有该项目，或你不是项目成员";
  if (project) return `当前会话未关联项目「${project}」`;
  return "当前会话没有关联任何协作项目，检索不到项目知识库；可以先用 memmy-project session add 把当前任务加入项目，或用 --project 指定项目。";
}
