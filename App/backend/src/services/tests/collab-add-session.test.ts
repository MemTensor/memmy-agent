import { describe, expect, it } from "vitest";
import {
  addCommand,
  matchProjectName,
  pickAddCandidates,
  sessionInWorkspace,
  type AddableSession
} from "../collab-add-session.js";

const projects = [
  { name: "Memmy 开发", memberCount: 5, sessionCount: 32 },
  { name: "设计评审", memberCount: 3, sessionCount: 0 }
];

function session(workspace: string | null): AddableSession {
  return {
    sourceId: "cursor",
    agentName: "Cursor",
    conversationId: "c1",
    title: "分享接口限流",
    lastQuestion: "",
    workspacePath: workspace,
    group: workspace ? { id: workspace, path: workspace } : null,
    updatedAt: "2026-10-22T05:00:00.000Z"
  };
}

describe("adding the current task", () => {
  it("treats only an exact project name as ready to add", () => {
    expect(matchProjectName(projects, "Memmy 开发").kind).toBe("exact");
    expect(matchProjectName(projects, "memmy 开发")).toMatchObject({ kind: "exact", project: { name: "Memmy 开发" } });
    expect(matchProjectName(projects, "开发")).toMatchObject({ kind: "suggest", project: { name: "Memmy 开发" } });
    expect(matchProjectName(projects, "请加入 Memmy 开发")).toMatchObject({ kind: "suggest", project: { name: "Memmy 开发" } });
    expect(matchProjectName([...projects, { name: "前端开发", memberCount: 1, sessionCount: 0 }], "开发").kind).toBe("many");
    expect(matchProjectName(projects, "不存在").kind).toBe("none");
    expect(matchProjectName(projects, "开").kind).toBe("none");
  });

  it("recognises the working directory when it sits inside the task's directory, or the other way around", () => {
    expect(sessionInWorkspace(session("/repo"), "/repo")).toBe(true);
    expect(sessionInWorkspace(session("/repo"), "/repo/app")).toBe(true);
    expect(sessionInWorkspace(session("/repo/app"), "/repo")).toBe(true);
    expect(sessionInWorkspace(session("/other"), "/repo")).toBe(false);
    expect(sessionInWorkspace(session(null), "/repo")).toBe(false);
    expect(pickAddCandidates([session("/repo"), session("/other")], "/repo/app").map((item) => item.workspacePath)).toEqual(["/repo"]);
  });

  it("quotes the next command so a name with spaces and quotes can be copied", () => {
    expect(addCommand({ project: "Memmy 开发", hint: "给分享接口加上限流" }))
      .toBe("memmy-project session add --project \"Memmy 开发\" --hint \"给分享接口加上限流\"");
    expect(addCommand({ project: "A \"B\"" })).toBe("memmy-project session add --project \"A \\\"B\\\"\"");
    expect(addCommand({ projectPlaceholder: true })).toBe("memmy-project session add --project \"<完整名称>\"");
  });
});
