// @vitest-environment happy-dom

/**
 * 成员列表里的演示成员：云端给这一行 `demo: true` 时，名字旁显示「官方」。
 * 客户端只认这个字段，不认 userId 或昵称，也不提供「重新体验」。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabMembers } from "../../api/collab-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ProjectMembersDialog } from "../collab-members-dialog.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

const project = {
  id: "cloud-1",
  name: "项目协作体验",
  role: "owner",
  memberCount: 2,
  sessionCount: 1,
  createdAt: null,
  localProjectId: "local-1"
};

describe("demo member in the member list", () => {
  let container: HTMLDivElement;
  let root: Root;
  const collab = { listMembers: vi.fn(), createInvite: vi.fn().mockResolvedValue({ code: "c", link: "l", shareText: "s" }) };

  async function open(view: CollabMembers) {
    collab.listMembers.mockResolvedValue(view);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <ProjectMembersDialog open collab={collab as never} projectId="cloud-1" onClose={vi.fn()} onToast={vi.fn()} />
        </I18nProvider>
      );
    });
    await flush();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("marks the demo member as official without any way to run it again", async () => {
    await open({
      project,
      joinMode: "approval",
      canManage: true,
      members: [
        { userId: "7", name: "用户A", role: "owner", mine: true, joinedAt: null },
        { userId: "9001", name: "小饭团", role: "member", mine: false, joinedAt: null, demo: true }
      ],
      requests: []
    });
    expect(document.body.textContent).toContain("小饭团");
    expect(document.body.textContent).toContain("官方");
    expect(document.body.textContent).not.toContain("重新体验");
  });

  it("leaves ordinary members unmarked", async () => {
    await open({
      project: { ...project, memberCount: 2 },
      joinMode: "approval",
      canManage: true,
      members: [
        { userId: "7", name: "用户A", role: "owner", mine: true, joinedAt: null },
        { userId: "8", name: "用户B", role: "member", mine: false, joinedAt: null }
      ],
      requests: []
    });
    expect(document.body.textContent).toContain("用户B");
    expect(document.body.textContent).not.toContain("官方");
  });
});
