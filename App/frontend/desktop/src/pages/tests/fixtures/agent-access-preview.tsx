/**
 * 临时预览页：把协作项目授权的三处界面用真实组件与样式渲出来，便于对照原型自查。
 * 地址参数 `?view=ask|done|gate|settings|settings-ungranted`，不连接本机接口。
 */
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { CollabAgentAccessView, CollabAgentInstallResult, CollabClient } from "../../../api/collab-client.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { CollabAgentAccessDialog } from "../../collab-agent-access-dialog.js";
import { AssociateSessionsModal } from "../../collab-page.js";
import { CollabAgentAccessSection } from "../../settings-page.js";
import "../../../styles.css";

const AGENTS: CollabAgentAccessView["agents"] = [
  { sourceId: "cursor", name: "Cursor", available: true, enabled: true, installed: true, added: false },
  { sourceId: "claude_code", name: "Claude Code", available: true, enabled: true, installed: true, added: false },
  { sourceId: "codex", name: "Codex", available: true, enabled: true, installed: true, added: false },
  { sourceId: "opencode", name: "Opencode", available: true, enabled: true, installed: true, added: false },
  { sourceId: "openclaw", name: "OpenClaw", available: true, enabled: true, installed: true, added: false },
  { sourceId: "hermes", name: "Hermes", available: true, enabled: true, installed: true, added: false },
  { sourceId: "deepseek_harness", name: "DeepSeek Harness", available: true, enabled: true, installed: true, added: false },
  { sourceId: "workbuddy", name: "WorkBuddy", available: true, enabled: true, installed: true, added: false },
  { sourceId: "pi", name: "Pi", available: true, enabled: true, installed: true, added: false },
  { sourceId: "qwenwork", name: "QwenWork", available: true, enabled: true, installed: true, added: false }
];

const PROJECT = { id: "p1", name: "MemOS", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null, localProjectId: null, instructions: "" };

function fakeClient(options: { granted: boolean; failOne?: boolean }): CollabClient {
  const view: CollabAgentAccessView = { granted: options.granted, askedInProject: false, agents: AGENTS };
  const results: CollabAgentInstallResult[] = AGENTS.map((agent) => ({
    sourceId: agent.sourceId,
    name: agent.name,
    ok: !(options.failOne && agent.sourceId === "cursor"),
    ...(options.failOne && agent.sourceId === "cursor" ? { message: "技能目录不存在" } : {})
  }));
  return {
    getAgentAccess: async () => view,
    setAgentAccess: async (granted: boolean) => ({ view: { ...view, granted }, results: granted ? results : [] }),
    installAgentAccess: async () => ({ view: { ...view, granted: true }, results }),
    markAgentAccessAsked: async () => view,
    setAgentEnabled: async (sourceId: string, enabled: boolean) => ({
      view: { ...view, agents: view.agents.map((agent) => (agent.sourceId === sourceId ? { ...agent, enabled } : agent)) },
      results: []
    }),
    listLocalSessions: async () => ({ sessions: [], refreshing: false }),
    getLinks: async () => ({ groups: [], sessions: [] }),
    saveLinks: async () => ({ uploaded: 0, removed: 0, failed: 0 }),
    listAddedAgents: async () => []
  } as unknown as CollabClient;
}

function Preview() {
  const params = new URLSearchParams(window.location.search);
  const view = params.get("view") ?? "ask";
  // 结果页要真的走一遍安装：弹窗挂上后点一次「授权」，截图时看到的就是真实状态。
  useEffect(() => {
    if (view !== "done") return;
    const timer = window.setTimeout(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "授权");
      button?.click();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [view]);

  if (view === "settings" || view === "settings-ungranted") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--color-canvas-oat, #f4f7f6)", padding: "40px 24px" }}>
        <div style={{ maxWidth: 640, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>协作项目</span>
          </div>
          <div style={{ background: "#fff", borderRadius: 16, border: "1px solid rgba(214,223,220,.6)", padding: 24 }}>
            <CollabAgentAccessSection client={fakeClient({ granted: view === "settings" })} />
          </div>
        </div>
      </div>
    );
  }

  if (view === "gate") {
    return (
      <div style={{ minHeight: "100vh", background: "var(--color-canvas-oat, #f4f7f6)" }}>
        <AssociateSessionsModal
          open
          collab={fakeClient({ granted: false })}
          project={PROJECT}
          accessGranted={false}
          accessAgents={AGENTS}
          onClose={() => undefined}
          onLinked={() => undefined}
          onGrantAccess={async () => false}
        />
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--color-canvas-oat, #f4f7f6)" }}>
      <CollabAgentAccessDialog
        open
        collab={fakeClient({ granted: false, failOne: view === "done" })}
        projectName={PROJECT.name}
        onDecided={() => undefined}
        onClose={() => undefined}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider language="zh-CN">
    <Preview />
  </I18nProvider>
);
