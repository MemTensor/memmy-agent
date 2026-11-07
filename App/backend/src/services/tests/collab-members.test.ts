import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalSessionReader } from "../../adapters/outbound/agent-source/session-reference/local-session-reader.js";
import { createCollabService, parseInviteReference } from "../collab-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CODE = "AbCdEfGhIjKlMnOpQrStUv";
const project = { id: "p-1", name: "Memmy 开发", role: "MEMBER", memberCount: 2, sessionCount: 1, createdAt: null };

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Answers cloud requests from a route table keyed by "METHOD /path", and records each call. */
function cloud(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", path: new URL(String(input)).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    if (!handler) return new Response(JSON.stringify({ code: 404, message: "no route", data: null }), { status: 404 });
    return new Response(JSON.stringify({ code: 0, message: "ok", data: await handler(call) }), { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

function setup(routes: Record<string, (call: Call) => unknown>, localSessions: LocalSessionReader | null = null) {
  const root = mkdtempSync(join(tmpdir(), "memmy-collab-members-"));
  roots.push(root);
  const { fetcher, calls } = cloud(routes);
  const projectsDir = join(root, "projects");
  const svc = createCollabService({
    cloudBaseUrl: "https://cloud.test.invalid",
    getAccount: () => ({ accountId: "u-b", credential: "uuid-b" }),
    localSessions,
    projectsDir,
    agentSessionsDir: join(root, "sessions"),
    fetcher
  });
  return { svc, calls, root, projectsDir };
}

function links(projectsDir: string, projectId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(projectsDir, projectId, "links.json"), "utf8")) as Record<string, unknown>;
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("collab members", () => {
  it("reads an invite from the link, the copied text, or the bare code", () => {
    expect(parseInviteReference(`https://memmy.example/i/${CODE}`)).toBe(CODE);
    expect(parseInviteReference(`【Memmy】邀请你加入协作项目「Memmy 开发」 https://memmy.example/i/${CODE}`)).toBe(CODE);
    expect(parseInviteReference(CODE)).toBe(CODE);
    // A session link is not an invite.
    expect(parseInviteReference("https://memmy.example/s/5c1b2d3e-0000-4000-8000-000000000409")).toBeNull();
    expect(parseInviteReference("../../etc/passwd")).toBeNull();
  });

  it("lists members with roles in lower case and the project's binding on this computer", async () => {
    const { svc } = setup({
      "GET /api/collab/projects/p-1/members": () => ({
        project,
        joinMode: "APPROVAL",
        canManage: true,
        members: [{ userId: "7", name: "用户A", role: "OWNER", mine: false, joinedAt: "2026-10-24T01:00:00Z" }, { userId: "8", name: "用户B", role: "member", mine: true, joinedAt: null }],
        requests: [{ userId: "10", name: "用户D", inviterName: "用户B", createdAt: "2026-10-24T02:00:00Z" }]
      })
    });
    const view = await svc.listMembers("p-1");
    expect(view.project).toMatchObject({ id: "p-1", role: "member", localProjectId: null });
    expect(view.joinMode).toBe("approval");
    expect(view.members.map((member) => [member.name, member.role, member.mine])).toEqual([["用户A", "owner", false], ["用户B", "member", true]]);
    expect(view.requests[0]).toEqual({ userId: "10", name: "用户D", inviterName: "用户B", createdAt: "2026-10-24T02:00:00Z" });
  });

  it("turns the cloud's code into a link on the same origin as session links", async () => {
    const { svc, calls } = setup({ "POST /api/collab/projects/p-1/invite": () => ({ code: CODE, projectName: "Memmy 开发" }) });
    expect(await svc.createInvite("p-1")).toEqual({
      code: CODE,
      link: `https://cloud.test.invalid/i/${CODE}`,
      shareText: `【Memmy】邀请你加入协作项目「Memmy 开发」 https://cloud.test.invalid/i/${CODE}`
    });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/collab/projects/p-1/invite" });
  });

  it("keeps the folder chosen when applying, so the project made after approval runs there on its own record", async () => {
    let status = "pending";
    const { svc, root, projectsDir } = setup({
      "POST /api/collab/invites/AbCdEfGhIjKlMnOpQrStUv/join": () => (status === "pending" ? { status, projectId: "p-1" } : { status, project })
    });
    const chosen = join(root, "我的代码");
    mkdirSync(chosen);
    writeFileSync(join(chosen, "README.md"), "already here");

    expect(await svc.joinProject(`https://cloud.test.invalid/i/${CODE}`, chosen)).toEqual({ status: "pending", projectId: "p-1", project: null });
    expect(links(projectsDir, "p-1")).toMatchObject({ workingDirectory: chosen, directoryChosen: true, localProjectId: null });
    // Approved later: the binding step reads the chosen folder back and knows not to treat it as empty.
    expect(await svc.ensureWorkingDirectory("p-1", "Memmy 开发")).toEqual({ localDirectory: chosen, chosen: true });

    // Applying again without a folder means a managed one.
    status = "joined";
    const joined = await svc.joinProject(CODE);
    expect(joined).toMatchObject({ status: "joined", projectId: "p-1", project: { id: "p-1", localProjectId: null } });
    expect(links(projectsDir, "p-1")).toMatchObject({ workingDirectory: null, directoryChosen: false });
    const managed = await svc.ensureWorkingDirectory("p-1", "Memmy 开发");
    expect(managed.chosen).toBe(false);
    expect(managed.localDirectory).not.toBe(chosen);
  });

  it("refuses text that holds no invite before calling the cloud", async () => {
    const { svc, calls } = setup({});
    await expect(svc.previewInvite("https://cloud.test.invalid/s/abc")).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(svc.joinProject("随便一段话")).rejects.toMatchObject({ code: "invalid_argument" });
    expect(calls).toEqual([]);
  });

  it("leaving drops the binding and the downloaded sessions, and keeps the folder for rejoining", async () => {
    const { svc, calls, projectsDir } = setup({ "POST /api/collab/projects/p-1/leave": () => ({ ok: true }) });
    mkdirSync(join(projectsDir, "p-1", "sessions"), { recursive: true });
    writeFileSync(join(projectsDir, "p-1", "sessions", "s1.md"), "# 会话");
    writeFileSync(join(projectsDir, "p-1", "links.json"), JSON.stringify({
      projectId: "p-1",
      accountId: "u-b",
      localProjectId: "local-1",
      removedSessions: [],
      workingDirectory: "/work/memmy",
      groups: [{ sourceId: "claude_code", groupId: "/repo", excluded: [] }],
      sessions: [],
      synced: {}
    }));

    expect(await svc.leaveProject("p-1")).toEqual({ ok: true });
    expect(calls).toEqual([{ method: "POST", path: "/api/collab/projects/p-1/leave", body: {} }]);
    expect(existsSync(join(projectsDir, "p-1", "sessions"))).toBe(false);
    await until(() => links(projectsDir, "p-1").localProjectId === null);
    expect(links(projectsDir, "p-1")).toMatchObject({ localProjectId: null, groups: [], workingDirectory: "/work/memmy" });
  });

  it("stops syncing a project the person was removed from, but syncs as before when the cloud cannot say", async () => {
    const local: LocalSessionReader = {
      available: async () => ({ sessions: [{ sourceId: "codex", agentName: "Codex", conversationId: "c1", title: "会话", lastQuestion: "", workspacePath: "/repo", group: null, updatedAt: "2026-10-24T01:00:00Z", turnCount: 1 }], refreshing: false }),
      read: async () => ({ title: "会话", updatedAt: "2026-10-24T01:00:00Z", turns: [{ question: "问", reply: "答", steps: [], startedAt: "" }] }),
      readMany: async () => ({ sessions: [{ conversationId: "c1", title: "会话", updatedAt: "2026-10-24T01:00:00Z", turns: [{ question: "问", reply: "答", steps: [], startedAt: "" }] }] })
    } as unknown as LocalSessionReader;
    let listed: unknown[] | null = [];
    const { svc, calls, projectsDir } = setup({
      "GET /api/collab/projects": () => {
        if (listed === null) throw new Error("cloud down");
        return { projects: listed };
      },
      "PUT /api/collab/projects/p-1/sessions": () => ({ sessions: [{ id: "cloud-c1" }] })
    }, local);
    mkdirSync(join(projectsDir, "p-1"), { recursive: true });
    writeFileSync(join(projectsDir, "p-1", "links.json"), JSON.stringify({
      projectId: "p-1", accountId: "u-b", localProjectId: null, removedSessions: [], workingDirectory: null,
      groups: [], sessions: [{ sourceId: "codex", conversationId: "c1" }], synced: {}
    }));

    expect(await svc.syncLinkedSessions()).toEqual({ uploaded: 0, removed: 0, failed: 0 });
    expect(calls.filter((call) => call.method === "PUT")).toEqual([]);
    // Removed from the project: this computer forgets the association, so nothing is uploaded from it again.
    const cleared = JSON.parse(readFileSync(join(projectsDir, "p-1", "links.json"), "utf8")) as { sessions: unknown[] };
    expect(cleared.sessions).toEqual([]);

    // A listing that fails says nothing about membership: an association saved meanwhile still syncs.
    writeFileSync(join(projectsDir, "p-1", "links.json"), JSON.stringify({
      projectId: "p-1", accountId: "u-b", localProjectId: null, removedSessions: [], workingDirectory: null,
      groups: [], sessions: [{ sourceId: "codex", conversationId: "c1" }], synced: {}
    }));
    listed = null;
    expect(await svc.syncLinkedSessions()).toEqual({ uploaded: 1, removed: 0, failed: 0 });
  });
});
