// @vitest-environment happy-dom

/**
 * 项目成员 and 加入项目 (PRD 3.4). Who may do what is the cloud's call; the dialogs only show the controls a role
 * can use: owners and admins see the join mode, requests and role pickers, members see a plain list.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabMembers } from "../../api/collab-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { JoinProjectModal } from "../collab-join-project-dialog.js";
import { MEMBER_REQUESTS_POLL_MS, ProjectMembersDialog } from "../collab-members-dialog.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = { id: "cloud-1", name: "Memmy 开发", role: "owner", memberCount: 2, sessionCount: 3, createdAt: null, localProjectId: "local-1" };

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

/** 假定时器下的同一个冲刷：把待处理的微任务与零延时定时器都放完。 */
async function pushTimers(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((candidate) => candidate.textContent?.trim() === label);
  expect(found, `「${label}」按钮应已渲染`).toBeTruthy();
  return found!;
}

function hasText(text: string): boolean {
  return document.body.textContent?.includes(text) ?? false;
}

/** React owns the input's value, so the native setter has to run before the input event is dispatched. */
function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("project members dialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  const collab = {
    listMembers: vi.fn(),
    createInvite: vi.fn(),
    setJoinMode: vi.fn(),
    approveRequest: vi.fn(),
    rejectRequest: vi.fn(),
    setMemberRole: vi.fn(),
    removeMember: vi.fn()
  };
  const onToast = vi.fn();

  async function open(view: CollabMembers) {
    collab.listMembers.mockResolvedValue(view);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <ProjectMembersDialog open collab={collab as never} projectId="cloud-1" onClose={vi.fn()} onToast={onToast} />
        </I18nProvider>
      );
    });
    await flush();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("invites when the owner is alone, and copies the link", async () => {
    await open({
      project,
      joinMode: "approval",
      canManage: true,
      members: [{ userId: "7", name: "用户A", role: "owner", mine: true, joinedAt: null }],
      requests: []
    });
    expect(hasText("邀请成员")).toBe(true);
    expect(hasText("成员加入后可查看项目中的任务与对话，也可将自身的任务纳入项目；成员的 Agent 均可参考。")).toBe(true);
    expect(hasText("用户A（你）")).toBe(true);
    expect(hasText("获得链接者")).toBe(true);
    expect(button("申请后加入")).toBeTruthy();

    collab.createInvite.mockResolvedValue({ code: "c", link: "https://x/i/c", shareText: "【Memmy】邀请你加入协作项目「Memmy 开发」 https://x/i/c" });
    await act(async () => button("复制邀请链接").click());
    await flush();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("【Memmy】邀请你加入协作项目「Memmy 开发」 https://x/i/c");
    expect(onToast).toHaveBeenCalledWith("邀请链接已复制");
  });

  it("lets owners and admins review requests and set other members' roles", async () => {
    await open({
      project,
      joinMode: "approval",
      canManage: true,
      members: [
        { userId: "7", name: "用户A", role: "owner", mine: false, joinedAt: null },
        { userId: "8", name: "用户B", role: "admin", mine: true, joinedAt: null },
        { userId: "9", name: "用户C", role: "member", mine: false, joinedAt: null }
      ],
      requests: [{ userId: "10", name: "用户D", inviterName: "用户C", createdAt: null }]
    });
    expect(hasText("项目成员 · 3")).toBe(true);
    expect(hasText("加入申请 · 1")).toBe(true);
    expect(hasText("通过 用户C 的邀请链接申请")).toBe(true);

    collab.approveRequest.mockResolvedValue({ userId: "10", name: "用户D", role: "member", mine: false, joinedAt: null });
    await act(async () => button("通过").click());
    await flush();
    expect(collab.approveRequest).toHaveBeenCalledWith("cloud-1", "10");
    expect(onToast).toHaveBeenCalledWith("用户D 已加入项目");

    // The owner has a tag, oneself a plain role; only the other member gets a picker.
    expect(hasText("所有者")).toBe(true);
    const pickers = Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-haspopup='menu']"));
    expect(pickers.map((picker) => picker.textContent?.trim())).toEqual(["申请后加入", "成员"]);
    await act(async () => pickers[1]!.click());
    await act(async () => button("管理员").click());
    await flush();
    expect(collab.setMemberRole).toHaveBeenCalledWith("cloud-1", "9", "admin");
  });

  it("shows members a plain list without management controls", async () => {
    await open({
      project: { ...project, role: "member" },
      joinMode: "approval",
      canManage: false,
      members: [
        { userId: "7", name: "用户A", role: "owner", mine: false, joinedAt: null },
        { userId: "9", name: "用户C", role: "member", mine: true, joinedAt: null }
      ],
      requests: []
    });
    expect(hasText("项目成员 · 2")).toBe(true);
    expect(hasText("获得链接者")).toBe(false);
    expect(document.querySelectorAll("button[aria-haspopup='menu']")).toHaveLength(0);
    expect(button("复制邀请链接")).toBeTruthy();
  });

  /** 轮询用假定时器：申请在别的电脑上提交，这里只等一个周期就能看到。 */
  it("picks up a request submitted while the dialog stays open", async () => {
    const base: CollabMembers = {
      project,
      joinMode: "approval",
      canManage: true,
      members: [{ userId: "7", name: "用户A", role: "owner", mine: true, joinedAt: null }],
      requests: []
    };
    vi.useFakeTimers();
    try {
      collab.listMembers.mockResolvedValue(base);
      const onRequestsChange = vi.fn();
      await act(async () => {
        root.render(
          <I18nProvider language="zh-CN">
            <ProjectMembersDialog
              open
              collab={collab as never}
              projectId="cloud-1"
              onClose={vi.fn()}
              onToast={onToast}
              onRequestsChange={onRequestsChange}
            />
          </I18nProvider>
        );
      });
      await pushTimers();
      expect(hasText("加入申请")).toBe(false);
      expect(onRequestsChange).toHaveBeenLastCalledWith(0);

      // 对方提交后不关弹窗：下一个周期里列表中就出现待审核的申请。
      collab.listMembers.mockResolvedValue({
        ...base,
        requests: [{ userId: "10", name: "用户D", inviterName: "用户A", createdAt: null }]
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MEMBER_REQUESTS_POLL_MS);
      });
      await pushTimers();
      expect(hasText("加入申请 · 1")).toBe(true);
      expect(hasText("用户D")).toBe(true);
      expect(onToast).toHaveBeenCalledWith("用户D 申请加入项目");
      expect(onRequestsChange).toHaveBeenLastCalledWith(1);
      expect(button("通过")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("join project dialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  const collab = { previewInvite: vi.fn(), joinProject: vi.fn() };
  const onJoined = vi.fn();
  const onApplied = vi.fn();
  const onClose = vi.fn();
  const invite = {
    code: "AbCdEfGhIjKlMnOpQrStUv",
    projectId: "cloud-1",
    projectName: "Memmy 开发",
    inviterName: "用户A",
    memberCount: 3,
    memberNames: ["用户A", "用户C", "用户D"],
    joinMode: "approval" as const,
    status: "none" as const
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <JoinProjectModal open collab={collab as never} onClose={onClose} onJoined={onJoined} onApplied={onApplied} />
        </I18nProvider>
      );
    });
    await flush();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function paste(preview: typeof invite | (Omit<typeof invite, "joinMode" | "status"> & { joinMode: "direct" | "approval"; status: "none" | "pending" | "member" })) {
    collab.previewInvite.mockResolvedValue(preview);
    const input = document.querySelector<HTMLInputElement>(".modal-body input");
    await act(async () => type(input!, `【Memmy】邀请你加入协作项目「Memmy 开发」 https://x/i/${invite.code}`));
    await act(async () => button("下一步").click());
    await flush();
  }

  it("applies by default and says the request was sent", async () => {
    await paste(invite);
    expect(hasText("用户A 邀请你加入项目")).toBe(true);
    expect(hasText("你在项目中的任务记录同步至云端，对项目成员可见；本地文件不会上传。")).toBe(true);
    expect(hasText("项目中已有成员同步的任务。在输入框输入 @ 引用任务，Agent 将读取其完整对话。")).toBe(true);
    expect(hasText("任务在该目录中执行。未选择时，任务不访问本地文件。")).toBe(true);
    expect(button("暂不加入")).toBeTruthy();

    collab.joinProject.mockResolvedValue({ status: "pending", projectId: "cloud-1", project: null });
    await act(async () => button("申请加入").click());
    await flush();
    expect(collab.joinProject).toHaveBeenCalledWith(expect.stringContaining(invite.code), undefined);
    expect(onClose).toHaveBeenCalled();
    expect(onJoined).not.toHaveBeenCalled();
    expect(onApplied).toHaveBeenCalledWith({ projectId: "cloud-1", projectName: "Memmy 开发" });
    expect(hasText("已提交申请，审核通过后加入项目")).toBe(true);
  });

  it("joins at once when anyone with the link may, and hands the project over", async () => {
    await paste({ ...invite, joinMode: "direct" });
    const joined = { ...project, role: "member", localProjectId: null };
    collab.joinProject.mockResolvedValue({ status: "joined", projectId: "cloud-1", project: joined });
    await act(async () => button("加入项目").click());
    await flush();
    expect(onJoined).toHaveBeenCalledWith(joined);
  });

  it("does not send a second request while the first waits", async () => {
    await paste({ ...invite, status: "pending" });
    expect(button("已申请，等待审核").disabled).toBe(true);
  });
});
