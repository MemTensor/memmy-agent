// @vitest-environment happy-dom

/**
 * The @ menu's rows. Everything the menu offers is already in the task's own project, so a row spends its two
 * lines on the session's title and on who started it plus what it was about, the same information a project
 * board row carries. The project name would repeat on every row and is deliberately absent.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabProjectSession } from "../../api/collab-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabSessionMentionMenu } from "../collab-session-mention.js";
import { memberColor } from "../collab-member-color.js";

const project = {
  id: "p-1",
  name: "项目协作测试",
  role: "owner",
  memberCount: 2,
  sessionCount: 1,
  createdAt: "2026-10-21T03:00:00.000Z",
  localProjectId: null
};

const session: CollabProjectSession = {
  id: "s-1",
  projectId: project.id,
  projectName: project.name,
  title: "项目记忆价值与竞品分析",
  lastQuestion: "项目记忆目前还有些问题要去回答：1、竞品调研：竞品有没有做类似项目记忆的？",
  memberName: "快乐团子",
  mine: true,
  source: "claude_code",
  turnCount: 4,
  lastActiveAt: "2026-10-22T03:11:00.000Z",
  link: "memmy://collab/p-1/s-1",
  shareText: "Memmy 协作会话：项目记忆价值与竞品分析"
};

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("@ menu session row", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onSelect = vi.fn();

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CollabSessionMentionMenu
            sessions={[session]}
            selectedIndex={0}
            heading="引用项目中的会话"
            emptyLabel="这个项目还没有会话"
            onSelect={onSelect}
          />
        </I18nProvider>
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function row(): HTMLElement {
    const option = container.querySelector<HTMLElement>('[role="option"]');
    if (!option) throw new Error("expected one row");
    return option;
  }

  it("shows the member's avatar, the title, then the member and what the session was about", () => {
    const element = row();
    const lines = [...element.querySelectorAll<HTMLElement>("span")].map((span) => span.textContent);

    expect(lines).toContain("快");
    expect(lines).toContain("项目记忆价值与竞品分析");
    expect(lines).toContain(`快乐团子 · ${session.lastQuestion}`);
    // The task already belongs to this project, so naming it on every row would be noise.
    expect(element.textContent).not.toContain(project.name);
  });

  it("tints the avatar with the same colour the board uses for that member", () => {
    const avatar = [...row().querySelectorAll<HTMLElement>("span")]
      .find((span) => span.textContent === "快");
    expect(avatar?.style.background).toBe(memberColor(session.memberName));
  });

  it("hands the whole session to the picker when the row is clicked", () => {
    act(() => row().click());
    expect(onSelect).toHaveBeenCalledWith(session);
  });
});
