import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentTaskView } from "../../state/agent-chat-slice.js";
import { SearchPalette, filterTasks, resolveTaskOwnership } from "../search-palette.js";

function makeTask(overrides: Partial<AgentTaskView> & Pick<AgentTaskView, "sessionKey">): AgentTaskView {
  return {
    chatId: overrides.sessionKey,
    title: "",
    preview: "",
    updatedAt: null,
    runStartedAt: null,
    completedUnseen: false,
    pinned: false,
    archived: false,
    tags: [],
    projectId: null,
    groupProjectId: null,
    cwd: "/workspace",
    missingProject: false,
    ...overrides
  };
}

const tasks: AgentTaskView[] = [
  makeTask({ sessionKey: "a", title: "Memmy PRD", preview: "整理产品需求", tags: ["work"] }),
  makeTask({ sessionKey: "b", title: "电商助手", preview: "创建 AI 助手", tags: ["demo"] }),
  makeTask({ sessionKey: "c", title: "", preview: "空白标题任务", tags: ["draft"] })
];

describe("filterTasks", () => {
  it("matches title, preview, and tags case-insensitively", () => {
    expect(filterTasks(tasks, "prd").map((task) => task.sessionKey)).toEqual(["a"]);
    expect(filterTasks(tasks, "助手").map((task) => task.sessionKey)).toEqual(["b"]);
    expect(filterTasks(tasks, "DRAFT").map((task) => task.sessionKey)).toEqual(["c"]);
  });

  it("returns all tasks for blank query", () => {
    expect(filterTasks(tasks, "   ")).toEqual(tasks);
    expect(filterTasks(tasks, "")).toEqual(tasks);
  });

  it("matches active, missing, and corrupt project ownership without guessing from cwd", () => {
    const project = {
      id: "project-a",
      name: "Alpha",
      rootPath: "/projects/alpha",
      pinned: false,
      createdAt: "2026-07-26T00:00:00.000Z"
    };
    const active = makeTask({
      sessionKey: "active",
      projectId: project.id,
      groupProjectId: project.id,
      cwd: "/projects/alpha"
    });
    const unavailable = makeTask({
      sessionKey: "unavailable",
      projectId: "removed-project",
      groupProjectId: null,
      cwd: "/projects/removed"
    });

    expect(filterTasks([active], "alpha", [project]).map((task) => task.sessionKey)).toEqual(["active"]);
    expect(filterTasks([unavailable], "项目记录不可用", [project], {
      missingProjectLabel: "项目记录不可用"
    }).map((task) => task.sessionKey)).toEqual(["unavailable"]);
    expect(filterTasks([unavailable], "/projects/removed", [project], {
      projectRegistryState: "corrupt",
      registryUnavailableLabel: "项目注册表不可用"
    }).map((task) => task.sessionKey)).toEqual(["unavailable"]);
    expect(resolveTaskOwnership(unavailable, [project], {
      projectRegistryState: "corrupt",
      registryUnavailableLabel: "项目注册表不可用"
    })).toBe("项目注册表不可用 · /projects/removed");
  });
});

describe("SearchPalette", () => {
  it("does not render when closed", () => {
    expect(renderToString(
      <SearchPalette
        open={false}
        tasks={tasks}
        placeholder="Search tasks"
        emptyLabel="No results"
        untitledLabel="Untitled"
        ariaLabel="Search tasks"
        onClose={() => undefined}
        onSelectTask={() => undefined}
      />
    )).toBe("");
  });

  it("renders a dialog listbox with localized labels", () => {
    const html = renderToString(
      <SearchPalette
        open
        tasks={tasks.slice(0, 2)}
        placeholder="搜索任务"
        emptyLabel="无匹配结果"
        untitledLabel="未命名对话"
        ariaLabel="搜索任务"
        onClose={() => undefined}
        onSelectTask={() => undefined}
      />
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Memmy PRD");
    expect(html).toContain('placeholder="搜索任务"');
    expect(html).not.toContain("无匹配结果");
  });

  it("shows the empty label when there are no tasks to display", () => {
    const html = renderToString(
      <SearchPalette
        open
        tasks={[]}
        placeholder="Search"
        emptyLabel="No matching results"
        untitledLabel="Untitled"
        ariaLabel="Search"
        onClose={() => undefined}
        onSelectTask={() => undefined}
      />
    );

    expect(html).toContain("No matching results");
  });

  it("renders unavailable project ownership with the full cwd in text and accessibility metadata", () => {
    const html = renderToString(
      <SearchPalette
        open
        tasks={[makeTask({
          sessionKey: "corrupt",
          title: "Project task",
          projectId: "project-a",
          groupProjectId: null,
          cwd: "/projects/alpha"
        })]}
        projectRegistryState="corrupt"
        registryUnavailableLabel="项目注册表不可用"
        standaloneLabel="任务"
        placeholder="搜索任务"
        emptyLabel="无匹配结果"
        untitledLabel="未命名对话"
        ariaLabel="搜索任务"
        onClose={() => undefined}
        onSelectTask={() => undefined}
      />
    );

    expect(html).toContain("项目注册表不可用 · /projects/alpha");
    expect(html).toContain('title="项目注册表不可用 · /projects/alpha"');
    expect(html).toContain('aria-label="Project task · 项目注册表不可用 · /projects/alpha"');
  });
});
