import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { z } from "zod";
import { requestJson } from "./http.js";

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  memberCount: z.number(),
  sessionCount: z.number(),
  createdAt: z.string().nullable(),
  /**
   * The local Memmy project this online project runs tasks in, or null until it is bound. A backend that predates
   * the binding omits it, which must not fail the whole list.
   */
  localProjectId: z.string().nullish().transform((value) => value ?? null),
  /**
   * 项目指令全文，成员只读。早于该字段的后端不返回，按空指令处理，避免整份列表因此读不出来。
   */
  instructions: z.string().nullish().transform((value) => value ?? "")
});

/** 项目配置里的知识库：只有引用，名字与「是不是本人关联的」由云端给。 */
const KnowledgeViewSchema = z.object({
  canManage: z.boolean().nullish().transform((value) => value ?? false),
  maxBases: z.number().nullish().transform((value) => value ?? 10),
  bases: z.array(z.object({
    id: z.string(),
    name: z.string(),
    mine: z.boolean().nullish().transform((value) => value ?? false)
  })).nullish().transform((value) => value ?? [])
});

const ProjectSessionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  lastQuestion: z.string(),
  memberName: z.string(),
  mine: z.boolean(),
  source: z.string(),
  turnCount: z.number(),
  lastActiveAt: z.string().nullable(),
  /** 单任务超出容量上限时只保留最近轮次，只有详情接口带这个标记。 */
  trimmed: z.boolean().nullish().transform((value) => value ?? false),
  link: z.string(),
  shareText: z.string()
});

const LocalSessionGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  path: z.string().nullable()
});

const LocalAgentSessionSchema = z.object({
  sourceId: z.string(),
  agentName: z.string(),
  conversationId: z.string(),
  title: z.string(),
  lastQuestion: z.string(),
  workspacePath: z.string().nullable(),
  group: LocalSessionGroupSchema.nullable(),
  updatedAt: z.string(),
  turnCount: z.number()
});

const LinksSchema = z.object({
  groups: z.array(z.object({ sourceId: z.string(), groupId: z.string(), excluded: z.array(z.string()) })),
  sessions: z.array(z.object({ sourceId: z.string(), conversationId: z.string() }))
});

const ApplicationSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  createdAt: z.string().nullable().optional()
});
/** 已审完的加入申请：通过或未通过。旧后端没有这一列，所以整字段可缺省。 */
const DecisionSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  status: z.enum(["approved", "rejected"]),
  decidedAt: z.string().nullable().optional()
});
const ProjectsResponseSchema = z.object({
  projects: z.array(ProjectSchema),
  /** 旧后端没有待审核列表时省略；空数组表示当前没有申请。 */
  applications: z.array(ApplicationSchema).optional(),
  decisions: z.array(DecisionSchema).optional()
});
const CreateProjectResponseSchema = z.object({ project: ProjectSchema, localDirectory: z.string().optional() });
const ProjectSessionsResponseSchema = z.object({
  project: ProjectSchema,
  sessions: z.array(ProjectSessionSchema),
  /** Every session matching the query, which may be more than this page. */
  total: z.number().optional()
});
const SessionTurnSchema = z.object({
  question: z.string(),
  reply: z.string(),
  steps: z.array(z.string()),
  startedAt: z.string()
});
const SessionDetailResponseSchema = z.object({ session: ProjectSessionSchema, turns: z.array(SessionTurnSchema) });
const LocalSessionsResponseSchema = z.object({ sessions: z.array(LocalAgentSessionSchema), refreshing: z.boolean() });
const SyncResponseSchema = z.object({
  uploaded: z.number(),
  removed: z.number(),
  failed: z.number(),
  /** Sessions queued for upload; absent when nothing was queued. */
  started: z.number().optional()
});
const SyncProgressSchema = z.object({
  running: z.boolean(),
  total: z.number(),
  completed: z.number(),
  failed: z.number()
});
/** One Memmy session of the project's local folder, as the sync picker lists it. */
const ProjectTaskSchema = z.object({
  conversationId: z.string(),
  title: z.string(),
  lastQuestion: z.string(),
  updatedAt: z.string(),
  turnCount: z.number(),
  included: z.boolean(),
  synced: z.boolean()
});
const ProjectTasksResponseSchema = z.object({ tasks: z.array(ProjectTaskSchema) });
const OkResponseSchema = z.object({ ok: z.literal(true) });
const RoleSchema = z.enum(["owner", "admin", "member"]);
const JoinModeSchema = z.enum(["direct", "approval"]);
const MemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  role: RoleSchema,
  /** The signed-in person, labelled「（你）」. */
  mine: z.boolean(),
  joinedAt: z.string().nullable()
});
const JoinRequestSchema = z.object({
  userId: z.string(),
  name: z.string(),
  /** Whose invite link the person applied through. */
  inviterName: z.string(),
  createdAt: z.string().nullable()
});
const MembersResponseSchema = z.object({
  project: ProjectSchema,
  joinMode: JoinModeSchema,
  /** Owners and admins set the join mode, review requests, and change or remove other members. */
  canManage: z.boolean(),
  members: z.array(MemberSchema),
  requests: z.array(JoinRequestSchema)
});
const InviteSchema = z.object({ code: z.string(), link: z.string(), shareText: z.string() });
const InvitePreviewSchema = z.object({
  code: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  inviterName: z.string(),
  memberCount: z.number(),
  memberNames: z.array(z.string()),
  joinMode: JoinModeSchema,
  status: z.enum(["none", "pending", "member"])
});
const JoinResultSchema = z.object({
  status: z.enum(["joined", "pending", "member"]),
  projectId: z.string(),
  /** Null while the request waits for review. */
  project: ProjectSchema.nullable()
});

export type CollabProject = z.infer<typeof ProjectSchema>;
/** 已提交、还在等审核的加入申请。还不是本机项目，侧边栏只展示名称和状态。 */
export interface CollabApplication {
  projectId: string;
  projectName: string;
}
/** 审核结果：桌面端据此给一次明确提示，而不是让「申请中」默默消失。 */
export interface CollabApplicationDecision {
  projectId: string;
  projectName: string;
  status: "approved" | "rejected";
  decidedAt: string | null;
}
export type CollabProjectSession = z.infer<typeof ProjectSessionSchema>;
export type LocalAgentSession = z.infer<typeof LocalAgentSessionSchema>;
export type LocalSessionGroup = z.infer<typeof LocalSessionGroupSchema>;
/** What this computer associates with a project: whole groups (new sessions included) and single sessions. */
export type CollabLinks = z.infer<typeof LinksSchema>;
export type CollabSyncResult = z.infer<typeof SyncResponseSchema>;
export type CollabSessionTurn = z.infer<typeof SessionTurnSchema>;
export interface CollabSessionPage {
  project: CollabProject;
  sessions: CollabProjectSession[];
  total: number;
}
export type CollabSyncProgress = z.infer<typeof SyncProgressSchema>;
/** A Memmy session of this project's local folder, and whether the project includes it. */
export type CollabProjectTask = z.infer<typeof ProjectTaskSchema>;
export type CollabRole = z.infer<typeof RoleSchema>;
export type CollabJoinMode = z.infer<typeof JoinModeSchema>;
export type CollabMember = z.infer<typeof MemberSchema>;
export type CollabJoinRequest = z.infer<typeof JoinRequestSchema>;
export type CollabMembers = z.infer<typeof MembersResponseSchema>;
export type CollabInvite = z.infer<typeof InviteSchema>;
export type CollabInvitePreview = z.infer<typeof InvitePreviewSchema>;
export type CollabJoinResult = z.infer<typeof JoinResultSchema>;
export type CollabKnowledgeView = z.infer<typeof KnowledgeViewSchema>;

export interface CollabClient {
  listProjects(): Promise<{
    projects: CollabProject[];
    applications?: CollabApplication[];
    /** 后台没实现审核结果（旧版本）时不填字段，申请人侧就不提示。 */
    decisions?: CollabApplicationDecision[];
  }>;
  /** Creates the cloud project and returns the directory its tasks run in, absent on a backend without it. */
  createProject(name: string, directory?: string): Promise<{ project: CollabProject; localDirectory?: string }>;
  /** Records which local Memmy project runs this online project's tasks. */
  bindLocalProject(projectId: string, localProjectId: string): Promise<void>;
  /** Deletes the shared project and keeps the local project, so its tasks stay on this computer. */
  deleteProject(projectId: string): Promise<void>;
  /** Renames the project for every member; only the owner may do it, and the cloud enforces that. */
  renameProject(projectId: string, name: string): Promise<CollabProject>;
  /**
   * Saves the project instructions (owners and admins). The cloud is the source of truth; the backend caches the
   * text for its own store and the tasks read it from there.
   */
  setInstructions(projectId: string, text: string): Promise<CollabProject>;
  /**
   * The folder this project's tasks run in, created on demand for a project that predates binding or was just
   * joined. `name` names the managed folder after the project, since that folder is what a task page shows.
   * `chosen` means the person picked the folder, which may already hold their own files and projects.
   */
  ensureWorkingDirectory(projectId: string, name?: string): Promise<{ localDirectory: string; chosen: boolean }>;
  /** One page of a project's sessions, newest activity first; `total` counts every match. */
  listSessions(projectId: string, options?: { query?: string; member?: "me" | "others"; offset?: number; limit?: number }): Promise<CollabSessionPage>;
  /** A session and its turns, for reading it in the app. */
  readSessionDetail(sessionId: string): Promise<{ session: CollabProjectSession; turns: CollabSessionTurn[] }>;
  /**
   * Sessions the person can reference from a message, limited to one project and most recent first.
   * No query returns the latest few.
   */
  listCandidateSessions(input: { projectId: string; query?: string; limit?: number }): Promise<CollabProjectSession[]>;
  /** Downloads one session and returns the text a message carries so an agent reads it. */
  readReference(reference: string): Promise<{ session: CollabProjectSession; text: string }>;
  /** Answers from the last scan at once; `refreshing` means asking again with `fresh` returns a newer list. */
  listLocalSessions(input: { query?: string; sourceIds?: string[]; limit?: number; fresh?: boolean }): Promise<{ sessions: LocalAgentSession[]; refreshing: boolean }>;
  getLinks(projectId: string): Promise<CollabLinks>;
  /** Saves the selection and queues the upload; it returns before the sessions arrive. */
  saveLinks(projectId: string, links: CollabLinks): Promise<CollabSyncResult>;
  /** The Memmy sessions of the project's local folder, each saying whether the project includes it. */
  listProjectTasks(projectId: string): Promise<CollabProjectTask[]>;
  /** Keeps only the listed sessions in the project and queues what is missing. */
  saveProjectTasks(projectId: string, included: readonly string[]): Promise<CollabSyncResult>;
  getSyncProgress(projectId: string): Promise<CollabSyncProgress>;
  removeSession(projectId: string, sessionId: string): Promise<void>;
  /**
   * Uploads newly finished Memmy tasks. `tasks` keeps it to those, which needs no agent scan and is what a board
   * opening can afford; the full sync also covers sessions associated from other agents. `projectId` limits the
   * task sync to one project, so opening a board never waits for the others.
   */
  syncSessions(options?: { tasksOnly?: boolean; projectId?: string }): Promise<CollabSyncResult>;
  /** Who is in the project; owners and admins also get the join mode's pending requests. */
  listMembers(projectId: string): Promise<CollabMembers>;
  /** 项目关联的知识库：只读列表，附「能不能管理」。 */
  knowledge(projectId: string): Promise<CollabKnowledgeView>;
  /** 关联一个知识库；云端只接受调用者本来就能访问的库。 */
  addKnowledge(projectId: string, baseId: string): Promise<CollabKnowledgeView>;
  /** 解除关联；云端判定权限（关联人自己或所有者、管理员）。 */
  removeKnowledge(projectId: string, baseId: string): Promise<CollabKnowledgeView>;
  /** The person's own invite link to the project. */
  createInvite(projectId: string): Promise<CollabInvite>;
  setJoinMode(projectId: string, joinMode: CollabJoinMode): Promise<CollabJoinMode>;
  approveRequest(projectId: string, userId: string): Promise<CollabMember>;
  rejectRequest(projectId: string, userId: string): Promise<void>;
  setMemberRole(projectId: string, userId: string, role: Exclude<CollabRole, "owner">): Promise<CollabMember>;
  removeMember(projectId: string, userId: string): Promise<void>;
  /** Leaves the project; the local project and this person's tasks stay. */
  leaveProject(projectId: string): Promise<void>;
  /** What a pasted invite link opens. */
  previewInvite(reference: string): Promise<CollabInvitePreview>;
  /** Joins at once or applies, as the project's join mode says; `directory` is where its tasks will run. */
  joinProject(reference: string, directory?: string): Promise<CollabJoinResult>;
}

/** Online projects through the desktop's local API, which signs cloud requests with the person's account. */
export function createHttpCollabClient(config: RuntimeConfig): CollabClient {
  return {
    async listProjects() {
      const result = await requestJson({ config, path: "/api/collab/projects", schema: ProjectsResponseSchema });
      const decisions = result.decisions?.map((item) => ({
        projectId: item.projectId,
        projectName: item.projectName,
        status: item.status,
        decidedAt: item.decidedAt ?? null
      }));
      if (!result.applications) return { projects: result.projects, ...(decisions ? { decisions } : {}) };
      return {
        projects: result.projects,
        applications: result.applications.map((item) => ({ projectId: item.projectId, projectName: item.projectName })),
        ...(decisions ? { decisions } : {})
      };
    },

    async createProject(name, directory) {
      return requestJson({
        config,
        path: "/api/collab/projects",
        schema: CreateProjectResponseSchema,
        body: { name, ...(directory ? { directory } : {}) }
      });
    },

    async ensureWorkingDirectory(projectId, name) {
      const result = await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/working-directory`,
        // A backend from before joining existed does not say; its folders were never chosen at join time.
        schema: z.object({ localDirectory: z.string(), chosen: z.boolean().optional() }),
        body: name ? { name } : {},
        init: { method: "POST" }
      });
      return { localDirectory: result.localDirectory, chosen: result.chosen === true };
    },

    async renameProject(projectId, name) {
      const result = await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}`,
        schema: z.object({ project: ProjectSchema }),
        body: { name },
        init: { method: "PATCH" }
      });
      return result.project;
    },

    async setInstructions(projectId, text) {
      const result = await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}`,
        schema: z.object({ project: ProjectSchema }),
        body: { instructions: text },
        init: { method: "PATCH" }
      });
      return result.project;
    },

    async deleteProject(projectId) {
      await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}`,
        schema: OkResponseSchema,
        init: { method: "DELETE" }
      });
    },

    async bindLocalProject(projectId, localProjectId) {
      await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/binding`,
        schema: OkResponseSchema,
        body: { localProjectId },
        init: { method: "PUT" }
      });
    },

    async listSessions(projectId, options) {
      const query = new URLSearchParams();
      if (options?.query) query.set("q", options.query);
      if (options?.member) query.set("member", options.member);
      if (options?.offset !== undefined) query.set("offset", String(options.offset));
      if (options?.limit !== undefined) query.set("limit", String(options.limit));
      const suffix = query.toString();
      const result = await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/sessions${suffix ? `?${suffix}` : ""}`,
        schema: ProjectSessionsResponseSchema
      });
      // A backend that predates paging sends every session and no total; treat that as one full page.
      return { ...result, total: result.total ?? result.sessions.length };
    },

    async readSessionDetail(sessionId) {
      return requestJson({
        config,
        path: `/api/collab/sessions/${encodeURIComponent(sessionId)}`,
        schema: SessionDetailResponseSchema
      });
    },

    async readReference(reference) {
      return requestJson({
        config,
        path: "/api/collab/sessions/read",
        schema: z.object({ session: ProjectSessionSchema, text: z.string() }),
        body: { reference }
      });
    },

    async listCandidateSessions(input) {
      const query = new URLSearchParams({ projectId: input.projectId });
      if (input.query) query.set("q", input.query);
      if (input.limit !== undefined) query.set("limit", String(input.limit));
      const suffix = query.toString();
      const result = await requestJson({
        config,
        path: `/api/collab/sessions/candidates${suffix ? `?${suffix}` : ""}`,
        schema: z.object({ sessions: z.array(ProjectSessionSchema) })
      });
      return result.sessions;
    },

    async listLocalSessions(input) {
      return requestJson({ config, path: "/api/collab/local-sessions", schema: LocalSessionsResponseSchema, body: input });
    },

    async getLinks(projectId) {
      return requestJson({ config, path: `/api/collab/projects/${encodeURIComponent(projectId)}/links`, schema: LinksSchema });
    },

    async saveLinks(projectId, links) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/links`,
        schema: SyncResponseSchema,
        body: links,
        init: { method: "PUT" }
      });
    },

    async listProjectTasks(projectId) {
      return (await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/tasks`,
        schema: ProjectTasksResponseSchema
      })).tasks;
    },

    async saveProjectTasks(projectId, included) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/tasks`,
        schema: SyncResponseSchema,
        body: { included },
        init: { method: "PUT" }
      });
    },

    async syncSessions(options) {
      return requestJson({
        config,
        path: "/api/collab/sync",
        schema: SyncResponseSchema,
        body: options?.tasksOnly
          ? { tasks: true, ...(options.projectId ? { projectId: options.projectId } : {}) }
          : {},
        init: { method: "POST" }
      });
    },

    async getSyncProgress(projectId) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/sync-progress`,
        schema: SyncProgressSchema
      });
    },

    async removeSession(projectId, sessionId) {
      await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
        schema: OkResponseSchema,
        init: { method: "DELETE" }
      });
    },

    async listMembers(projectId) {
      return requestJson({ config, path: `/api/collab/projects/${encodeURIComponent(projectId)}/members`, schema: MembersResponseSchema });
    },

    async knowledge(projectId) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/knowledge`,
        schema: KnowledgeViewSchema
      });
    },

    async addKnowledge(projectId, baseId) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/knowledge`,
        schema: KnowledgeViewSchema,
        body: { baseId }
      });
    },

    async removeKnowledge(projectId, baseId) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/knowledge/${encodeURIComponent(baseId)}`,
        schema: KnowledgeViewSchema,
        init: { method: "DELETE" }
      });
    },

    async createInvite(projectId) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/invite`,
        schema: InviteSchema,
        init: { method: "POST" }
      });
    },

    async setJoinMode(projectId, joinMode) {
      return (await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}`,
        schema: z.object({ joinMode: JoinModeSchema }),
        body: { joinMode },
        init: { method: "PATCH" }
      })).joinMode;
    },

    async approveRequest(projectId, userId) {
      return (await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(userId)}/approve`,
        schema: z.object({ member: MemberSchema }),
        init: { method: "POST" }
      })).member;
    },

    async rejectRequest(projectId, userId) {
      await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(userId)}`,
        schema: OkResponseSchema,
        init: { method: "DELETE" }
      });
    },

    async setMemberRole(projectId, userId, role) {
      return (await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
        schema: z.object({ member: MemberSchema }),
        body: { role },
        init: { method: "PATCH" }
      })).member;
    },

    async removeMember(projectId, userId) {
      await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
        schema: OkResponseSchema,
        init: { method: "DELETE" }
      });
    },

    async leaveProject(projectId) {
      await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/leave`,
        schema: OkResponseSchema,
        init: { method: "POST" }
      });
    },

    async previewInvite(reference) {
      return (await requestJson({
        config,
        path: "/api/collab/invites/preview",
        schema: z.object({ invite: InvitePreviewSchema }),
        body: { reference }
      })).invite;
    },

    async joinProject(reference, directory) {
      return requestJson({
        config,
        path: "/api/collab/invites/join",
        schema: JoinResultSchema,
        body: { reference, ...(directory ? { directory } : {}) }
      });
    }
  };
}
