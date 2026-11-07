/** Memmy agent admin client module. */
import type {
  ChannelConnectionsResponse,
  ChannelDefinitionsResponse,
  ChannelStatus
} from "@memmy/local-api-contracts";

export interface MemmyAgentAdminClient {
  /** True for the entire Agent turn, including model thinking and interaction waits. */
  hasActiveTasks?(signal?: AbortSignal): Promise<boolean>;
  getChannelDefinitions(): Promise<ChannelDefinitionsResponse>;
  getChannelConnections(): Promise<ChannelConnectionsResponse>;
  /** Returns the canonical workspace currently bound to a WebUI conversation. */
  getSessionWorkspace?(sessionKey: string): Promise<string | null>;
  configureChannel(runtimeChannel: string): Promise<{ status: ChannelStatus; running: boolean }>;
  stopChannel(runtimeChannel: string): Promise<{ status: ChannelStatus; running: boolean }>;
  startWeixinLogin(): Promise<{ status: ChannelStatus; qrCodeDataUrl?: string; pollToken?: string }>;
  pollWeixinLogin(pollToken: string): Promise<{ status: ChannelStatus; qrCodeDataUrl?: string; pollToken?: string }>;
  startFeishuLogin(): Promise<{ status: ChannelStatus; qrCodeDataUrl?: string; pollToken?: string }>;
  pollFeishuLogin(pollToken: string): Promise<{
    status: ChannelStatus;
    qrCodeDataUrl?: string;
    pollToken?: string;
    appId?: string;
    appSecret?: string;
    domain?: "feishu" | "lark";
  }>;
  reloadMcpConfig(): Promise<{ ok: boolean; message: string; requires_restart: boolean }>;
  /**
   * 成员协助：在本机项目下新建一条 Memmy 任务执行另一位成员的请求；带 `chatId` 时续在同一条任务里。
   * 返回时任务已经建好、消息已经派发，执行在后台继续。
   */
  startAssistRun?(input: AssistRunStartInput): Promise<AssistRunSnapshot>;
  /** 这一轮做到哪一步；运行时不认识这条任务（比如重启过）时返回 null。 */
  readAssistRun?(chatId: string): Promise<AssistRunSnapshot | null>;
  /** 停下这一轮，与在任务里点「停止」一样。 */
  stopAssistRun?(chatId: string): Promise<AssistRunSnapshot | null>;
  /**
   * 把协助结果作为一条消息送回发起方的 Memmy 任务，Memmy 在同一条任务里接着分析。
   * 只续发到已有的任务；任务已经不在时返回 "missing"，不另建任务。
   */
  deliverAssistResult?(input: { chatId: string; content: string }): Promise<"sent" | "missing">;
}

export interface AssistRunStartInput {
  /** 本机 Memmy 项目；没有时建成一条独立任务。 */
  projectId: string | null;
  /** 同一次排查的后续请求：续在这条任务里。 */
  chatId?: string;
  title: string;
  content: string;
  /** 记在任务上的请求信息，界面据此说明这是谁的请求。 */
  assist: {
    requestId: string;
    threadId: string;
    cloudProjectId: string;
    requesterName: string;
    requesterId: string;
    via: string;
    attempt: number;
    title: string;
    /** 交给模型、不在界面上显示的要求（如结果的写法）：运行时把它放进系统提示词。 */
    context?: string;
  };
}

export interface AssistRunSnapshot {
  chatId: string;
  status: "starting" | "queued" | "running" | "done" | "failed" | "stopped";
  steps: Array<{ text: string; output?: string; status: "running" | "done" | "failed" }>;
  /** 完整执行过程：说明文字与工具调用按发生顺序排列；旧运行时为空数组。 */
  transcript: AssistTranscriptItem[];
  reply: string;
  error: string | null;
  /** 隐藏注入的系统提示词段落（格式要求）：只在开始这一轮时给出。 */
  promptContext?: string;
}

/** 完整执行过程里的一项，与运行时、云端同一结构。 */
export type AssistTranscriptItem =
  | { kind: "text"; text: string; truncated?: boolean }
  | { kind: "thinking"; text: string; truncated?: boolean }
  | { kind: "tool"; name: string; input: string; output: string; status: "running" | "done" | "failed"; truncated?: boolean }
  | { kind: "omitted"; count: number };
