/**
 * 临时预览页：把成员协助的四处界面用真实组件与样式渲出来，便于对照原型自查。
 * 地址参数 `?view=dialog|task|task-ask|card|settings`，不连接本机接口。
 */
import { createRoot } from "react-dom/client";
import type { AssistExecution, AssistGrant, AssistInboxItem, AssistRecord, AssistRequest, CollabClient } from "../../../api/collab-client.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { CollabAssistDialog } from "../../collab-assist-dialog.js";
import { CollabAssistRequestCard } from "../../collab-assist-card.js";
import { CollabAssistTask } from "../../collab-assist-task.js";
import { CollabAssistRecords, CollabAssistSettings } from "../../collab-assist-settings.js";
import "../../../styles.css";

const REQUESTER = { userId: "2102247370314383361", name: "孙起", mine: false };
const EXECUTOR = { userId: "2102247370314383362", name: "王雨", mine: true };

const ITEMS = ["查看 Memmy、Cursor 与系统的版本", "在 Memmy 后台日志里找出与 Cursor 记录相关的最近记录"];

function request(overrides: Partial<AssistRequest> = {}): AssistRequest {
  return {
    id: "a7f3k111-1111-1111-1111-111111111111",
    projectId: "p1",
    projectName: "Memmy 内测反馈",
    threadId: "thread-1",
    attempt: 1,
    via: "Codex",
    title: "收集 Cursor 任务读取相关的信息",
    reason: "关联任务弹窗里看不到 Cursor 的任务",
    items: ITEMS,
    status: "pending",
    agent: "claude_code",
    scope: "once",
    steps: [],
    reply: "",
    resultItems: [],
    files: [],
    failure: null,
    requester: REQUESTER,
    executor: EXECUTOR,
    mine: false,
    createdAt: "2026-11-04T08:41:00Z",
    decidedAt: null,
    finishedAt: null,
    ...overrides
  };
}

const STEPS = [
  { text: "运行 sw_vers", output: "macOS 15.6" },
  { text: "读取 Cursor 版本 defaults read /Applications/Cursor.app/Contents/Info.plist CFBundleShortVersionString", output: "2.1.4" },
  {
    text: "在 ~/.memmy/logs/backend.log 中搜索 Cursor 相关记录",
    output: "最近 24 小时 37 条 cursor composer skipped: empty conversation"
  }
];

const inboxItem: AssistInboxItem = {
  ...request(),
  granted: false,
  grantAgent: null,
  usedToday: 0
};

const DONE_FIELDS: Partial<AssistRequest> = {
  status: "done",
  scope: "always",
  reply: "版本：Memmy 1.2.6、Cursor 2.1.4、macOS 15.6。Memmy 后台日志里，最近 24 小时有 37 条 Cursor 会话被当成空会话跳过（cursor composer skipped: empty conversation），没有其他报错。相关日志已附上。",
  resultItems: [
    { key: "版本", value: "Memmy 1.2.6 · Cursor 2.1.4 · macOS 15.6" },
    { key: "日志", value: "最近 24 小时 37 条 cursor composer skipped: empty conversation，没有其他报错" }
  ],
  files: [{ name: "backend-cursor.log", size: "200 行", content: "" }],
  steps: STEPS,
  decidedAt: "2026-11-04T08:41:30Z",
  finishedAt: "2026-11-04T08:42:38Z"
};

const execution: AssistExecution = {
  requestId: request().id,
  threadId: "thread-1",
  projectId: "p1",
  agent: "claude_code",
  status: "running",
  steps: STEPS,
  startedAt: "2026-11-04T08:41:30Z",
  finishedAt: null,
  failure: null
};

function fakeClient(): CollabClient {
  const grants: AssistGrant[] = [
    {
      projectId: "p1",
      projectName: "Memmy 内测反馈",
      grantee: REQUESTER,
      agent: "claude_code",
      active: true,
      usedToday: 2,
      createdAt: "2026-11-04T08:41:30Z",
      revokedAt: null
    }
  ];
  const records: AssistRecord[] = [
    {
      id: "r1",
      title: "收集 Cursor 任务读取相关的信息",
      memberName: "孙起",
      status: "done",
      agent: "claude_code",
      files: 1,
      createdAt: "2026-11-04T08:41:00Z",
      attempt: 1,
      threadId: "thread-1"
    },
    {
      id: "r2",
      title: "查被跳过会话的会话头存储位置",
      memberName: "孙起",
      status: "done",
      agent: "claude_code",
      files: 0,
      createdAt: "2026-11-04T08:45:00Z",
      attempt: 2,
      threadId: "thread-1"
    }
  ];
  return {
    assistInbox: async () => ({ requests: [inboxItem], dailyLimit: 20 }),
    assistSettings: async () => ({ allowAssist: true, running: 0, queued: 0 }),
    setAssistAllow: async (allowAssist: boolean) => ({ allowAssist, running: 0, queued: 0 }),
    assistAgents: async () => [
      { sourceId: "memmy", name: "Memmy", available: true },
      { sourceId: "claude_code", name: "Claude Code", available: true },
      { sourceId: "cursor", name: "Cursor", available: true },
      { sourceId: "workbuddy", name: "WorkBuddy", available: true },
      { sourceId: "codex", name: "Codex", available: true }
    ],
    assistRequest: async () => request(DONE_FIELDS),
    decideAssist: async () => request(DONE_FIELDS),
    stopAssist: async () => request(DONE_FIELDS),
    noteAssist: async () => undefined,
    cancelAssist: async () => request({ status: "cancelled" }),
    createAssistRequest: async () => ({ request: request(), threadId: "thread-1", text: "" }),
    assistExecutions: async () => [execution],
    assistGrants: async () => ({ grants, dailyLimit: 20 }),
    setAssistGrantAgent: async () => ({ grants, dailyLimit: 20 }),
    revokeAssistGrant: async () => ({ grants: [], dailyLimit: 20 }),
    assistRecords: async () => ({ records, retentionDays: 30 })
  } as unknown as CollabClient;
}

function Preview() {
  const view = new URLSearchParams(window.location.search).get("view") ?? "dialog";
  const client = fakeClient();
  const project = { id: "p1", name: "Memmy 内测反馈" };

  if (view === "settings") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--color-canvas-oat, #f4f7f6)", padding: "40px 24px" }}>
        <div style={{ maxWidth: 680, margin: "0 auto", display: "grid", gap: 22 }}>
          <div style={{ background: "#fff", borderRadius: 16, border: "1px solid rgba(214,223,220,.6)", padding: "6px 22px" }}>
            <CollabAssistSettings client={client} project={project} />
          </div>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 14, fontWeight: 600 }}>
              协助记录
            </div>
            <div style={{ background: "#fff", borderRadius: 16, border: "1px solid rgba(214,223,220,.6)", padding: "6px 22px" }}>
              <CollabAssistRecords client={client} project={project} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view === "card") {
    return (
      <div style={{ minHeight: "100vh", background: "#fff", padding: "32px 24px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <CollabAssistRequestCard request={request(DONE_FIELDS)} collab={client} />
          <CollabAssistRequestCard request={request({ status: "running", steps: STEPS, scope: null })} collab={client} />
          <CollabAssistRequestCard request={request({ status: "confirm", scope: "once" })} collab={client} />
        </div>
      </div>
    );
  }

  if (view === "task" || view === "task-ask") {
    const target = view === "task"
      ? request(DONE_FIELDS)
      : request({ status: "confirm", scope: "once", attempt: 2 });
    return (
      <div style={{ height: "100vh", background: "#fff" }}>
        <CollabAssistTask
          request={target}
          {...(view === "task" ? { execution: { ...execution, status: "running" as const } } : {})}
          collab={client}
          agentKeepsHistory={view === "task"}
          onChanged={() => undefined}
        />
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--color-canvas-oat, #f4f7f6)" }}>
      <CollabAssistDialog open request={inboxItem} collab={client} onDecided={() => undefined} onClose={() => undefined} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider language="zh-CN">
    <Preview />
  </I18nProvider>
);