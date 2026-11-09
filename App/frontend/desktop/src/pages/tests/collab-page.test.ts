import { describe, expect, it } from "vitest";
import type { CollabLinks, LocalAgentSession } from "../../api/collab-client.js";
import {
  agentHasLinks,
  formatSessionTime,
  groupAgentSessions,
  groupCheckState,
  groupingKind,
  pickerAgentName,
  isSessionChecked,
  localSessionKey,
  taskDayGroup,
  taskStamp,
  toggleGroupLink,
  toggleSessionLink,
  visibleQuestion,
  visibleReply
} from "../collab-page.js";

function session(sourceId: string, conversationId: string, title: string, groupId: string | null, updatedAt = "2026-10-21T13:30:00.000Z"): LocalAgentSession {
  return {
    sourceId,
    agentName: sourceId === "codex" ? "Codex" : "Claude Code",
    conversationId,
    title,
    lastQuestion: "",
    workspacePath: groupId,
    group: groupId ? { id: groupId, label: groupId.split("/").pop() ?? groupId, path: groupId } : null,
    updatedAt,
    turnCount: 3
  };
}

const none: CollabLinks = { groups: [], sessions: [] };

describe("collab page helpers", () => {
  it("shows the name the person entered for an added agent", () => {
    expect(pickerAgentName({ sourceId: "added-qoder-82ef827e", name: "Qoder" })).toBe("Qoder");
    expect(pickerAgentName({ sourceId: "cursor", name: "Cursor" })).toBe("Cursor");
  });

  const sessions = [
    session("claude_code", "a", "Memmy 中转 Claude Code 会话", "/w/memmy-agent", "2026-10-21T10:00:00.000Z"),
    session("claude_code", "b", "分享弹窗", "/w/memmy-agent", "2026-10-21T12:00:00.000Z"),
    session("claude_code", "c", "PRD 修订", "/w/Product_Doc", "2026-10-21T11:00:00.000Z"),
    session("claude_code", "d", "临时提问", null),
    session("codex", "e", "MemOS 社区周报", "p-1")
  ];

  it("names groups the way each agent organizes sessions", () => {
    expect(["claude_code", "codex", "cursor", "workbuddy", "hermes"].map(groupingKind)).toEqual(["directory", "project", "workspace", "workbuddy", "directory"]);
  });

  it("groups one agent's sessions, most recent group first, and searches titles and group names", () => {
    const all = groupAgentSessions(sessions, "claude_code", "");
    expect(all.groups.map((view) => [view.group.label, view.sessions.map((item) => item.conversationId)])).toEqual([
      ["memmy-agent", ["b", "a"]],
      ["Product_Doc", ["c"]]
    ]);
    expect(all.ungrouped.map((item) => item.conversationId)).toEqual(["d"]);
    expect(groupAgentSessions(sessions, "claude_code", "分享").groups.map((view) => view.sessions.length)).toEqual([1]);
    expect(groupAgentSessions(sessions, "claude_code", "product").groups[0]?.sessions.map((item) => item.conversationId)).toEqual(["c"]);
  });

  it("links a whole group, excludes a session inside it, and unlinks the group again", () => {
    const view = groupAgentSessions(sessions, "claude_code", "").groups[0]!;
    let links = toggleSessionLink(none, sessions[0]!);
    expect(groupCheckState(links, "claude_code", view)).toBe("mixed");

    links = toggleGroupLink(links, "claude_code", view);
    expect(links).toEqual({ groups: [{ sourceId: "claude_code", groupId: "/w/memmy-agent", excluded: [] }], sessions: [] });
    expect(groupCheckState(links, "claude_code", view)).toBe("checked");

    links = toggleSessionLink(links, sessions[1]!);
    expect(isSessionChecked(links, sessions[1]!)).toBe(false);
    expect(isSessionChecked(links, sessions[0]!)).toBe(true);
    expect(groupCheckState(links, "claude_code", view)).toBe("mixed");
    expect(agentHasLinks(links, "claude_code")).toBe(true);
    expect(agentHasLinks(links, "codex")).toBe(false);

    links = toggleGroupLink(links, "claude_code", view);
    expect(groupCheckState(links, "claude_code", view)).toBe("checked");
    links = toggleGroupLink(links, "claude_code", view);
    expect(links).toEqual(none);
  });

  it("keys sessions by agent and conversation so equal IDs from two agents stay distinct", () => {
    expect(localSessionKey({ sourceId: "codex", conversationId: "x" })).not.toBe(localSessionKey({ sourceId: "cursor", conversationId: "x" }));
  });

  it("formats the last activity compactly and leaves unknown times empty", () => {
    expect(formatSessionTime(null)).toBe("");
    expect(formatSessionTime("not a date")).toBe("");
    expect(formatSessionTime("2026-10-21T13:30:00.000Z")).toMatch(/^10\/2[12] \d{2}:30$/u);
  });

  it("shows the typed Cursor question and hides a notification-only bubble", () => {
    const envelope = [
      "<timestamp>Monday, Oct 26, 2026, 7:17 PM (UTC+8)</timestamp>",
      "<system_notification>",
      "The following task has finished.",
      "<task>",
      "kind: shell",
      "</task>",
      "</system_notification>",
      "<user_query>",
      "重新打包签名",
      "</user_query>"
    ].join("\n");

    expect(visibleQuestion(envelope)).toBe("重新打包签名");
    expect(visibleQuestion("<timestamp>now</timestamp>\n<system_notification>\nkind: shell\n</system_notification>")).toBe("");
    expect(visibleReply("可以发布。\n\n<system_notification>done</system_notification>")).toBe("可以发布。");
    expect(visibleQuestion("帮我看下部署")).toBe("帮我看下部署");
    expect(visibleQuestion([
      "<system_notification>",
      "The following task has finished.",
      "</system_notification>",
      "<user_query>",
      "Briefly inform the user about the task result and perform any follow-up actions (if needed). If there's no follow-ups needed, don't explicitly say that.",
      "</user_query>"
    ].join("\n"))).toBe("");
  });

  it("drops a skill body an agent wrote into a user record", () => {
    // Qoder 之类的 Agent 把「加载技能」也写成一条用户消息：整段技能正文不是谁问的问题。
    const skill = [
      "Base directory for this skill: /Users/sunq/.qoder/skills/memmy-project",
      "",
      "# Memmy 协作项目",
      "",
      "你负责在用户所在的 Memmy 协作项目里找到成员的任务并读取。"
    ].join("\n");
    expect(visibleQuestion(skill)).toBe("");
    // 前面还有真问题时保留那一句，技能正文从标记处截掉。
    expect(visibleQuestion(`帮我看下部署\n\n${skill}`)).toBe("帮我看下部署");
  });

  it("does not turn an interruption marker into a question", () => {
    // 打断是 Qoder 写进记录的一条用户消息，不是谁问的问题。
    expect(visibleQuestion("[Request interrupted by user]")).toBe("");
    expect(visibleQuestion("[Request interrupted by user for tool use]")).toBe("");
    expect(visibleQuestion("继续\n[Request interrupted by user]")).toBe("继续");
  });
});

describe("task list days", () => {
  // 2026-10-28 是周三，本周从 10-26（周一）开始。
  const now = new Date(2026, 9, 28, 15, 30, 0);

  function at(year: number, month: number, day: number, hour = 10, minute = 0): string {
    return new Date(year, month - 1, day, hour, minute, 0).toISOString();
  }

  it("classifies dates for compact timestamps", () => {
    expect(taskDayGroup(at(2026, 10, 28, 9, 5), now)).toBe("today");
    expect(taskDayGroup(at(2026, 10, 27, 23, 59), now)).toBe("yesterday");
    expect(taskDayGroup(at(2026, 10, 26, 8, 0), now)).toBe("week");
    expect(taskDayGroup(at(2026, 10, 25, 8, 0), now)).toBe("earlier");
    // 没有时间的任务排在最后，不会看起来像最新的。
    expect(taskDayGroup(null, now)).toBe("earlier");
  });

  it("shows the hour today, 昨天 for yesterday, and the date before that", () => {
    expect(taskStamp(at(2026, 10, 28, 9, 5), now)).toEqual({ kind: "time", text: "09:05" });
    expect(taskStamp(at(2026, 10, 27, 9, 5), now)).toEqual({ kind: "yesterday" });
    expect(taskStamp(at(2026, 10, 25, 9, 5), now)).toEqual({ kind: "date", month: 10, day: 25 });
    expect(taskStamp(null, now)).toBeNull();
  });
});
