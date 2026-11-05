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
  /**
   * 本人在这台电脑上用 Memmy 建的这条任务的对话 id；别人的、或别的 Agent 的任务为 null。
   * 看板据此把点开落到会话页。
   */
  conversationId: z.string().nullish().transform((value) => value ?? null),
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
  decisions: z.array(DecisionSchema).optional(),
  /** 每个账号可创建的在线项目数上限；旧后端不返回，桌面端就不提前提示额度。 */
  maxOwnedProjects: z.number().optional()
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
const LocalSessionsResponseSchema = z.object({
  sessions: z.array(LocalAgentSessionSchema),
  refreshing: z.boolean()
});
const AddedAgentSchema = z.object({
  sourceId: z.string(),
  name: z.string(),
  /** 添加时装进技能的那个目录，界面上用来确认是不是同一个 Agent。 */
  skillDirectory: z.string()
});
/** An agent the person added: Memmy installs memmy-project for it and never reads its task records. */
export type AddedAgent = z.infer<typeof AddedAgentSchema>;
const AddedAgentsResponseSchema = z.object({ agents: z.array(AddedAgentSchema) });
const RemoveAgentResponseSchema = z.object({ text: z.string() });
/** 「在其他 Agent 中使用协作项目」：设置里列出的一个 Agent。 */
const CollabAgentAccessAgentSchema = z.object({
  sourceId: z.string(),
  name: z.string(),
  available: z.boolean(),
  enabled: z.boolean(),
  installed: z.boolean(),
  added: z.boolean().nullish().transform((value) => value ?? false)
});
const CollabAgentInstallResultSchema = z.object({
  sourceId: z.string(),
  name: z.string(),
  ok: z.boolean(),
  message: z.string().optional()
});
/**
 * 授权状态与 Agent 清单。`results` 只在授权或重新安装的回应里有：
 * 失败的几个可以在界面上重试，其余当已装好。
 */
const CollabAgentAccessViewSchema = z.object({
  granted: z.boolean(),
  askedInProject: z.boolean(),
  agents: z.array(CollabAgentAccessAgentSchema)
});
const CollabAgentAccessResponseSchema = CollabAgentAccessViewSchema.extend({
  results: z.array(CollabAgentInstallResultSchema).nullish().transform((value) => value ?? [])
});
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
/** 一条 Memmy 任务的共享状态；`started` 是这次排进上传队列的任务数。 */
const TaskSharingSchema = z.object({
  shared: z.boolean(),
  synced: z.boolean(),
  started: z.number().nullish().transform((value) => value ?? 0)
});
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

/**
 * 停止共享时背景与规范的落点：`saved` 已写成本机项目的背景与规范（以云端为准，覆盖本机旧内容），
 * `none` 没有可写回的内容或目录。
 */
export type CollabInstructionsHandover = "saved" | "none";
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
export type CollabTaskSharing = z.infer<typeof TaskSharingSchema>;
export type CollabRole = z.infer<typeof RoleSchema>;
export type CollabJoinMode = z.infer<typeof JoinModeSchema>;
export type CollabMember = z.infer<typeof MemberSchema>;
export type CollabJoinRequest = z.infer<typeof JoinRequestSchema>;
export type CollabMembers = z.infer<typeof MembersResponseSchema>;
export type CollabInvite = z.infer<typeof InviteSchema>;
export type CollabInvitePreview = z.infer<typeof InvitePreviewSchema>;
export type CollabJoinResult = z.infer<typeof JoinResultSchema>;
export type CollabKnowledgeView = z.infer<typeof KnowledgeViewSchema>;
/** 授权状态与设置里列出的 Agent。 */
export type CollabAgentAccessView = z.infer<typeof CollabAgentAccessViewSchema>;
export type CollabAgentAccessAgent = z.infer<typeof CollabAgentAccessAgentSchema>;
export type CollabAgentInstallResult = z.infer<typeof CollabAgentInstallResultSchema>;

/** 一条协助请求里的一位成员。 */
const AssistMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  mine: z.boolean()
});

const AssistStepSchema = z.object({
  text: z.string(),
  output: z.string().nullish().transform((value) => value ?? "")
});

const AssistResultItemSchema = z.object({
  key: z.string(),
  value: z.string()
});

const AssistFileSchema = z.object({
  name: z.string(),
  size: z.string(),
  /** 只有发起方读详情时带正文：执行方那边自己就有这些日志。 */
  content: z.string().nullish().transform((value) => value ?? null)
});

/** 请求的状态：与云端一致，界面按它选徽标与说明。 */
const AssistStatusSchema = z.enum([
  "pending", "running", "confirm", "done", "rejected", "cancelled", "expired", "failed", "stopped"
]);

/** 授权方式：仅这一次或限时；认不出的旧值（已取消的 always）按没有授权方式处理。 */
const AssistScopeSchema = z.string().nullish().transform((value): "once" | "timed" | null =>
  value === "timed" ? "timed" : value === "once" ? "once" : null);

/** 限时授权：时长（分钟）、到期时间、是否仍然有效。 */
const AssistGrantInfoSchema = z.object({
  minutes: z.number().nullish().transform((value) => value ?? null),
  expiresAt: z.string(),
  active: z.boolean(),
  /** 还在等待、按限时授权会直接执行的请求：由哪个 Agent 执行。 */
  agent: z.string().nullish().transform((value) => value ?? null)
});

/**
 * 完整执行过程里的一项：Agent 的说明文字、思考、一次工具调用，或「中间省略了几步」。发起方记录另有用户说的话（user），
 * 「拿到结果的那一步」带 delivery。
 */
const AssistTranscriptItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string(), truncated: z.boolean().optional() }),
  z.object({ kind: z.literal("thinking"), text: z.string(), truncated: z.boolean().optional() }),
  z.object({ kind: z.literal("user"), text: z.string(), truncated: z.boolean().optional(), delivery: z.boolean().optional() }),
  z.object({
    kind: z.literal("tool"),
    name: z.string(),
    input: z.string().default(""),
    output: z.string().default(""),
    status: z.enum(["running", "done", "failed"]),
    truncated: z.boolean().optional(),
    delivery: z.boolean().optional()
  }),
  z.object({ kind: z.literal("omitted"), count: z.number() })
]);

/** 执行过程与发起方记录：不认识的条目（更新的版本加的）丢掉，不让整次协助读不出来。 */
const AssistTranscriptSchema = z.array(z.unknown()).transform((items) => items.flatMap((item) => {
  const parsed = AssistTranscriptItemSchema.safeParse(item);
  return parsed.success ? [parsed.data] : [];
}));

const AssistRequestSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  threadId: z.string(),
  attempt: z.number(),
  /** 发起方的 Agent 名称（如 Codex、Memmy）。 */
  via: z.string(),
  title: z.string(),
  /** 起因：一句话说明为什么请对方协助，弹窗与通知里会引用它。 */
  reason: z.string(),
  items: z.array(z.string()),
  status: AssistStatusSchema,
  agent: z.string().nullable(),
  scope: AssistScopeSchema,
  /** 这次用的是限时授权时的时长与到期时间；仅这一次、或旧后端时为 null。 */
  grant: AssistGrantInfoSchema.nullish().transform((value) => value ?? null),
  steps: z.array(AssistStepSchema),
  reply: z.string(),
  resultItems: z.array(AssistResultItemSchema),
  files: z.array(AssistFileSchema),
  failure: z.string().nullable(),
  requester: AssistMemberSchema,
  executor: AssistMemberSchema,
  mine: z.boolean(),
  createdAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** 发起方在 Memmy 的哪条任务里发出这次请求：只回给发起人本人；外部 Agent 发起、或旧后端时为 null。 */
  sourceTask: z.string().nullish().transform((value) => value ?? null),
  /** 还在等待、但执行方的限时授权仍然有效：她的 Memmy 会直接执行，不写「等待授权」。 */
  autoRun: z.boolean().nullish().transform((value) => value ?? false),
  /** 这一次新给出的限时授权时长；仅这一次、或按已有限时授权直接执行时为 null。 */
  decidedMinutes: z.number().nullish().transform((value) => value ?? null),
  /** 发起方第一次收到结果的时间。 */
  deliveredAt: z.string().nullish().transform((value) => value ?? null),
  // 以下是会话内容，只在打开一次协助时返回；旧请求没有时为 undefined / null，界面按已有内容显示。
  /** 执行方 Agent 收到的提示词。 */
  prompt: z.string().nullish(),
  /** Memmy 执行时隐藏注入的格式要求。 */
  promptContext: z.string().nullish(),
  /** 完整执行过程。 */
  transcript: AssistTranscriptSchema.optional(),
  /** 发起方 Agent 实际收到的内容。 */
  delivery: z.string().nullish(),
  /** 发起方 Agent 收到后的回复。 */
  deliveryReply: z.string().nullish(),
  /**
   * 发起方一侧的记录：发起前（origin）与收到后（followup）。只有 Memmy 与 DeepSeek Harness 发起时有；
   * 旧请求、其他 Agent 发起或记录读不到时为 null，界面退回原来的显示。
   */
  origin: AssistTranscriptSchema.nullish(),
  followup: AssistTranscriptSchema.nullish()
});

const AssistInboxItemSchema = AssistRequestSchema.extend({
  /** 有生效中的限时授权：执行方的 Memmy 直接开始执行，不再弹授权。 */
  granted: z.boolean(),
  grantAgent: z.string().nullable(),
  grantExpiresAt: z.string().nullish().transform((value) => value ?? null),
  /** 同一次排查上一次由哪个 Agent 执行：等待确认的请求还没选 Agent，通知与确认卡片据此说明。 */
  lastAgent: z.string().nullish().transform((value) => value ?? null),
  /** 上一次由 Memmy 执行时，这次排查在这台电脑上对应的任务：确认就在那条任务里进行。 */
  conversationId: z.string().nullish().transform((value) => value ?? null)
});

/** 项目里的一次排查（看板上的一行协助）：只有发起人和执行人看得到。 */
const AssistThreadSchema = z.object({
  threadId: z.string(),
  projectId: z.string(),
  title: z.string(),
  via: z.string(),
  agent: z.string().nullable(),
  scope: AssistScopeSchema,
  grant: AssistGrantInfoSchema.nullish().transform((value) => value ?? null),
  status: AssistStatusSchema,
  attempt: z.number(),
  requester: AssistMemberSchema,
  executor: AssistMemberSchema,
  mine: z.boolean(),
  createdAt: z.string().nullable(),
  lastActiveAt: z.string().nullable(),
  /** 各次请求，按新到旧：第一条就是最近一次。 */
  requests: z.array(AssistRequestSchema),
  /** 执行方本人、由 Memmy 执行时这台电脑上对应的任务：看板点开直接进入它。 */
  conversationId: z.string().nullish().transform((value) => value ?? null)
});

const AssistGrantSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  grantee: AssistMemberSchema,
  agent: z.string(),
  active: z.boolean(),
  /** 授权时长与到期时间：项目设置里显示剩余时间。 */
  minutes: z.number().nullish().transform((value) => value ?? null),
  expiresAt: z.string().nullish().transform((value) => value ?? null),
  createdAt: z.string().nullable(),
  revokedAt: z.string().nullable()
});

/** 一条 Memmy 任务上的协助：它本身是一次协助的执行，或在它里面发出过请求。 */
const AssistTaskViewSchema = z.object({
  executing: z.object({
    thread: AssistThreadSchema,
    confirm: AssistInboxItemSchema.nullable()
  }).nullable(),
  requested: z.array(AssistRequestSchema.extend({ delivered: z.boolean() }))
});

const AssistExecutionSchema = z.object({
  requestId: z.string(),
  threadId: z.string(),
  projectId: z.string(),
  agent: z.string(),
  status: z.enum(["queued", "running", "done", "failed"]),
  steps: z.array(AssistStepSchema),
  /** 由 Memmy 执行时，这次执行所在的那条 Memmy 任务；外部 Agent 执行、或旧后端不返回时为 null。 */
  conversationId: z.string().nullable().optional().transform((value) => value ?? null),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  failure: z.string().nullable()
});

const AssistAgentSchema = z.object({
  sourceId: z.string(),
  name: z.string(),
  available: z.boolean(),
  /** `used`：这个项目里用过（Memmy 固定在这一层）；`other`：能运行但没用过，弹窗里默认收起。 */
  group: z.enum(["used", "other"]).nullish().transform((value) => value ?? "used"),
  lastActiveAt: z.string().nullish().transform((value) => value ?? null)
});

/** 本人在一个项目里是否接收协助请求。 */
const AssistReceivingSchema = z.object({
  projectId: z.string(),
  enabled: z.boolean(),
  /** 关闭时结束了几条还在等待的请求。 */
  closed: z.number().optional()
});

export type AssistStatus = z.infer<typeof AssistStatusSchema>;
export type AssistMember = z.infer<typeof AssistMemberSchema>;
export type AssistStep = z.infer<typeof AssistStepSchema>;
export type AssistResultItem = z.infer<typeof AssistResultItemSchema>;
export type AssistRequest = z.infer<typeof AssistRequestSchema>;
export type AssistInboxItem = z.infer<typeof AssistInboxItemSchema>;
export type AssistGrant = z.infer<typeof AssistGrantSchema>;
export type AssistThread = z.infer<typeof AssistThreadSchema>;
export type AssistTaskView = z.infer<typeof AssistTaskViewSchema>;
export type AssistExecution = z.infer<typeof AssistExecutionSchema>;
export type AssistAgent = z.infer<typeof AssistAgentSchema>;
export type AssistGrantInfo = z.infer<typeof AssistGrantInfoSchema>;
export type AssistReceiving = z.infer<typeof AssistReceivingSchema>;
export type AssistTranscriptItem = z.infer<typeof AssistTranscriptItemSchema>;

/** 打开一次协助：完整会话，加上双方在这台电脑上能打开的任务。 */
const AssistThreadDetailSchema = z.object({
  thread: AssistThreadSchema.extend({
    /** 发起方由 Memmy 发起时，发起的那条任务（只给发起人本人）。 */
    sourceTask: z.string().nullish().transform((value) => value ?? null)
  }),
  /** 云端数据库的当前时间：与本机时钟的差用来把会话里的时间换成本机时间。 */
  serverTime: z.string().nullish().transform((value) => value ?? null)
});
export type AssistThreadDetail = z.infer<typeof AssistThreadDetailSchema>;
/** 授权弹窗、任务内确认与项目设置里「换用」共用的候选，以及默认选中的那一个。 */
export interface AssistAgentChoice {
  agents: AssistAgent[];
  defaultAgent: string | null;
}
/** 执行方这次授权到什么程度：仅这一次，还是一段时间内直接执行。 */
export type AssistScope = "once" | "timed";
/** 限时授权的四档时长（分钟），默认 1 小时。 */
export type AssistGrantMinutes = 30 | 60 | 120 | 240;

export interface CollabClient {
  listProjects(): Promise<{
    projects: CollabProject[];
    applications?: CollabApplication[];
    /** 后台没实现审核结果（旧版本）时不填字段，申请人侧就不提示。 */
    decisions?: CollabApplicationDecision[];
    /** 本人还能创建多少个在线项目，由后端给出上限；旧后端不返回。 */
    maxOwnedProjects?: number;
  }>;
  /** Creates the cloud project and returns the directory its tasks run in, absent on a backend without it. */
  createProject(name: string, directory?: string): Promise<{ project: CollabProject; localDirectory?: string }>;
  /** Records which local Memmy project runs this online project's tasks. */
  bindLocalProject(projectId: string, localProjectId: string): Promise<void>;
  /**
   * Deletes the shared project and keeps the local project, so its tasks stay on this computer.
   * `instructions` 说背景与规范去了哪里：`saved` 已写成本机项目的，`none` 没有可写回的内容。
   */
  deleteProject(projectId: string): Promise<{ instructions: CollabInstructionsHandover }>;
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
  listLocalSessions(input: { query?: string; sourceIds?: string[]; limit?: number; fresh?: boolean }): Promise<{
    sessions: LocalAgentSession[];
    refreshing: boolean;
  }>;
  getLinks(projectId: string): Promise<CollabLinks>;
  /**
   * Agents the person added: their name and the skills folder memmy-project was installed into.
   * The add dialog lists them so one can be removed again.
   */
  listAddedAgents(): Promise<AddedAgent[]>;
  /** Removes the agent's memmy-project skill and forgets it; tasks it already joined stay in the project. */
  removeAddedAgent(name: string): Promise<{ text: string }>;
  /** 在其他 Agent 中使用协作项目的授权状态：看板、授权弹窗与设置页都读它。 */
  getAgentAccess(): Promise<CollabAgentAccessView>;
  /** 授权并安装（`true`）或撤销并移除组件（`false`）。 */
  setAgentAccess(granted: boolean): Promise<{ view: CollabAgentAccessView; results: CollabAgentInstallResult[] }>;
  /** 已授权但没装上的重新装一次；不传 `sourceIds` 时只补没装的。 */
  installAgentAccess(sourceIds?: readonly string[]): Promise<{ view: CollabAgentAccessView; results: CollabAgentInstallResult[] }>;
  /** 记下已经在项目里询问过一次：选「暂不安装」也算，之后不再主动询问。 */
  markAgentAccessAsked(): Promise<CollabAgentAccessView>;
  /** 设置里逐个开关某个 Agent：关掉不再读取并卸载组件，打开时若已授权就装回去。 */
  setAgentEnabled(sourceId: string, enabled: boolean): Promise<{ view: CollabAgentAccessView; results: CollabAgentInstallResult[] }>;
  /** Saves the selection and queues the upload; it returns before the sessions arrive. */
  saveLinks(projectId: string, links: CollabLinks): Promise<CollabSyncResult>;
  /** The Memmy sessions of the project's local folder, each saying whether the project includes it. */
  listProjectTasks(projectId: string): Promise<CollabProjectTask[]>;
  /** Keeps only the listed sessions in the project and queues what is missing. */
  saveProjectTasks(projectId: string, included: readonly string[]): Promise<CollabSyncResult>;
  /** 一条 Memmy 任务在这个项目里是否共享；输入框旁的开关据此显示当前状态。 */
  taskSharing(projectId: string, conversationId: string): Promise<CollabTaskSharing>;
  /** 开关共享：开启后排队上传，关闭会把云端副本一并删掉，本机任务保留。 */
  setTaskSharing(projectId: string, conversationId: string, shared: boolean): Promise<CollabTaskSharing>;
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

  // ---------- 成员协助 ----------

  /** 执行方收件箱：等着她授权或确认的请求，以及正在执行的请求。 */
  assistInbox(): Promise<{ requests: AssistInboxItem[] }>;
  /** 本人在这个项目里是否接收协助请求（项目设置里的开关）。 */
  assistReceiving(projectId: string): Promise<AssistReceiving>;
  /** 打开或关闭「接收协助请求」；关闭时她给出的限时授权结束，等待中的请求以明确原因结束。 */
  setAssistReceiving(projectId: string, enabled: boolean): Promise<AssistReceiving>;
  /**
   * 执行方的候选：这台电脑上能运行的 Agent，分「本项目用过」与「其他」两层。
   * 给出 `requester` 时，默认项是她给这位成员选过的 Agent，没有就是 Memmy。
   */
  assistAgents(projectId: string, requester?: string): Promise<AssistAgentChoice>;
  assistRequest(requestId: string): Promise<AssistRequest>;
  /** 允许或拒绝。允许时要写清由哪个 Agent 执行、这次授权到什么程度；限时授权带时长。 */
  decideAssist(requestId: string, decision: {
    action: "allow" | "reject";
    agent?: string;
    scope?: AssistScope;
    minutes?: AssistGrantMinutes;
  }): Promise<AssistRequest>;
  /** 执行方停止当前执行，发起方会看到「谁停止了这次执行」。 */
  stopAssist(requestId: string): Promise<AssistRequest>;
  /** 执行方在任务页补充一句说明：作为一条进展发给发起方。 */
  noteAssist(requestId: string, note: string): Promise<void>;
  /** 发起方撤回还没被执行的请求。 */
  cancelAssist(requestId: string): Promise<AssistRequest>;
  /** 发起一次协助请求；同一次排查的后续请求带 `thread`。 */
  createAssistRequest(input: {
    project: string;
    member: string;
    title: string;
    reason?: string;
    items: string[];
    thread?: string;
  }): Promise<{ request: AssistRequest; threadId: string; text: string }>;
  /** 本机正在执行与排队中的请求。 */
  assistExecutions(): Promise<AssistExecution[]>;
  assistGrants(projectId: string): Promise<{ grants: AssistGrant[] }>;
  /** 本人在这个项目里仍然有效的限时授权。更换某位成员的执行 Agent：一位成员只对应一个。 */
  setAssistGrantAgent(projectId: string, grantee: string, agent: string): Promise<{ grants: AssistGrant[] }>;
  /** 结束对某位成员的授权；之后的请求重新问她。 */
  revokeAssistGrant(projectId: string, grantee: string): Promise<{ grants: AssistGrant[] }>;
  /** 协助记录，保留 30 天。 */
  /** 项目里的协助：本人作为发起人或执行人的排查，按一次排查一行，保留 30 天。 */
  assistThreads(projectId: string): Promise<{ threads: AssistThread[]; open: number; retentionDays: number }>;
  /** 打开一次协助：各次请求的提示词、执行过程、回复与发起方收到的内容。只有发起人和执行人能读。 */
  assistThread(projectId: string, threadId: string): Promise<AssistThreadDetail>;
  /** 一条 Memmy 任务上的协助：任务页据此显示协助条、请求卡片与确认卡片。 */
  assistTask(chatId: string): Promise<AssistTaskView>;
}

/** 只取状态部分：安装结果与状态同一个回应，界面把它们分开用。 */
function toAgentAccessView(result: { granted: boolean; askedInProject: boolean; agents: CollabAgentAccessAgent[] }): CollabAgentAccessView {
  return { granted: result.granted, askedInProject: result.askedInProject, agents: result.agents };
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
      // 旧后端没有申请列表时也就不带额度，两个字段都不填。
      if (!result.applications) {
        return { projects: result.projects, ...(decisions ? { decisions } : {}) };
      }
      return {
        projects: result.projects,
        applications: result.applications.map((item) => ({ projectId: item.projectId, projectName: item.projectName })),
        ...(decisions ? { decisions } : {}),
        ...(result.maxOwnedProjects === undefined ? {} : { maxOwnedProjects: result.maxOwnedProjects })
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
      const result = await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}`,
        // 旧版本后端不带这个字段：当成没有写回处理，界面就不提这件事。
        schema: z.object({ ok: z.literal(true), instructions: z.enum(["saved", "none"]).optional() }),
        init: { method: "DELETE" }
      });
      return { instructions: result.instructions ?? "none" };
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

    async listAddedAgents() {
      const result = await requestJson({ config, path: "/api/collab/agents", schema: AddedAgentsResponseSchema });
      return result.agents;
    },

    async removeAddedAgent(name) {
      return requestJson({ config, path: "/api/collab/agents/remove", schema: RemoveAgentResponseSchema, body: { name } });
    },

    async getAgentAccess() {
      return requestJson({ config, path: "/api/collab/agent-access", schema: CollabAgentAccessViewSchema });
    },

    async setAgentAccess(granted) {
      const result = await requestJson({
        config,
        path: "/api/collab/agent-access",
        schema: CollabAgentAccessResponseSchema,
        body: { granted },
        init: { method: "PUT" }
      });
      return { view: toAgentAccessView(result), results: result.results };
    },

    async installAgentAccess(sourceIds) {
      const result = await requestJson({
        config,
        path: "/api/collab/agent-access/install",
        schema: CollabAgentAccessResponseSchema,
        body: sourceIds && sourceIds.length ? { sourceIds: [...sourceIds] } : {}
      });
      return { view: toAgentAccessView(result), results: result.results };
    },

    async markAgentAccessAsked() {
      return requestJson({ config, path: "/api/collab/agent-access/asked", schema: CollabAgentAccessViewSchema });
    },

    async setAgentEnabled(sourceId, enabled) {
      const result = await requestJson({
        config,
        path: `/api/collab/agent-access/agents/${encodeURIComponent(sourceId)}`,
        schema: CollabAgentAccessResponseSchema,
        body: { enabled },
        init: { method: "PUT" }
      });
      return { view: toAgentAccessView(result), results: result.results };
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

    async taskSharing(projectId, conversationId) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(conversationId)}/sharing`,
        schema: TaskSharingSchema
      });
    },

    async setTaskSharing(projectId, conversationId, shared) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(conversationId)}/sharing`,
        schema: TaskSharingSchema,
        body: { shared },
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
    },

    async assistInbox() {
      return requestJson({
        config,
        path: "/api/collab/assist/inbox",
        schema: z.object({ requests: z.array(AssistInboxItemSchema) })
      });
    },

    async assistReceiving(projectId) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/assist/receiving`,
        schema: AssistReceivingSchema
      });
    },

    async setAssistReceiving(projectId, enabled) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/assist/receiving`,
        schema: AssistReceivingSchema,
        body: { enabled },
        init: { method: "PUT" }
      });
    },

    async assistAgents(projectId, requester) {
      const query = requester ? `?requester=${encodeURIComponent(requester)}` : "";
      const result = await requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/assist/agents${query}`,
        schema: z.object({
          agents: z.array(AssistAgentSchema),
          defaultAgent: z.string().nullish().transform((value) => value ?? null)
        })
      });
      return { agents: result.agents.filter((agent) => agent.available), defaultAgent: result.defaultAgent };
    },

    async assistRequest(requestId) {
      return (await requestJson({
        config,
        path: `/api/collab/assist/requests/${encodeURIComponent(requestId)}`,
        schema: z.object({ request: AssistRequestSchema })
      })).request;
    },

    async decideAssist(requestId, decision) {
      return (await requestJson({
        config,
        path: `/api/collab/assist/requests/${encodeURIComponent(requestId)}/decision`,
        schema: z.object({ request: AssistRequestSchema }),
        body: {
          action: decision.action,
          ...(decision.agent ? { agent: decision.agent } : {}),
          ...(decision.scope ? { scope: decision.scope } : {}),
          ...(decision.scope === "timed" && decision.minutes ? { minutes: decision.minutes } : {})
        }
      })).request;
    },

    async noteAssist(requestId, note) {
      await requestJson({
        config,
        path: `/api/collab/assist/requests/${encodeURIComponent(requestId)}/note`,
        schema: OkResponseSchema,
        body: { note }
      });
    },

    async stopAssist(requestId) {
      return (await requestJson({
        config,
        path: `/api/collab/assist/requests/${encodeURIComponent(requestId)}/stop`,
        schema: z.object({ request: AssistRequestSchema }),
        body: {}
      })).request;
    },

    async cancelAssist(requestId) {
      return (await requestJson({
        config,
        path: `/api/collab/assist/requests/${encodeURIComponent(requestId)}/cancel`,
        schema: z.object({ request: AssistRequestSchema }),
        body: {}
      })).request;
    },

    async createAssistRequest(input) {
      return requestJson({
        config,
        path: "/api/collab/assist/requests",
        schema: z.object({ request: AssistRequestSchema, threadId: z.string(), text: z.string() }),
        body: input
      });
    },

    async assistExecutions() {
      const result = await requestJson({
        config,
        path: "/api/collab/assist/executions",
        schema: z.object({ executions: z.array(AssistExecutionSchema) })
      });
      return result.executions;
    },

    async assistGrants(projectId) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/assist/grants`,
        schema: z.object({ grants: z.array(AssistGrantSchema) })
      });
    },

    async setAssistGrantAgent(projectId, grantee, agent) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/assist/grants/${encodeURIComponent(grantee)}`,
        schema: z.object({ grants: z.array(AssistGrantSchema) }),
        body: { agent },
        init: { method: "PATCH" }
      });
    },

    async revokeAssistGrant(projectId, grantee) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/assist/grants/${encodeURIComponent(grantee)}`,
        schema: z.object({ grants: z.array(AssistGrantSchema) }),
        init: { method: "DELETE" }
      });
    },

    async assistThreads(projectId) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/assist/threads`,
        schema: z.object({ threads: z.array(AssistThreadSchema), open: z.number(), retentionDays: z.number() })
      });
    },

    async assistThread(projectId, threadId) {
      return requestJson({
        config,
        path: `/api/collab/projects/${encodeURIComponent(projectId)}/assist/threads/${encodeURIComponent(threadId)}`,
        schema: AssistThreadDetailSchema
      });
    },

    async assistTask(chatId) {
      return requestJson({
        config,
        path: `/api/collab/assist/tasks/${encodeURIComponent(chatId)}`,
        schema: AssistTaskViewSchema
      });
    }
  };
}
