/**
 * 协作项目缓存契约：新旧条目的解析、按会话单位匹配，以及注入用那一段的渲染。
 *
 * <p>三种缺省都要能出文：没写背景与规范、没有成员、没有项目名——没写背景与规范的项目最要紧，
 * 它关联的目录里的 Agent 靠这一段知道「当前目录属于哪个协作项目」。</p>
 */
import { describe, expect, it } from "vitest";
import {
  MAX_COLLAB_INSTRUCTIONS_CHARS,
  MAX_COLLAB_PROJECT_MEMBERS,
  collabInstructionsFor,
  emptyCollabInstructionsFile,
  parseCollabInstructionsFile,
  renderCollabProjectContext
} from "../src/collab-instructions.js";

const DIRECTORY = "/Users/me/.memmy/local-projects/MemOS";

function fileWith(entry: Record<string, unknown>) {
  return { version: 1, projects: { "p-1": entry } };
}

describe("parseCollabInstructionsFile", () => {
  it("reads an entry from before the project name and members existed", () => {
    const file = parseCollabInstructionsFile(fileWith({
      scopes: [{ sourceId: "memmy", groupId: DIRECTORY }],
      text: "团队约定",
      updatedAt: "2026-10-28T12:00:00.000Z"
    }));
    expect(file.projects["p-1"]).toEqual({
      scopes: [{ sourceId: "memmy", groupId: DIRECTORY, roots: [DIRECTORY] }],
      text: "团队约定",
      updatedAt: "2026-10-28T12:00:00.000Z"
    });
  });

  it("reads the project name and members of a newer entry, keeping both optional", () => {
    const file = parseCollabInstructionsFile(fileWith({
      scopes: [{ sourceId: "memmy", groupId: DIRECTORY }],
      name: "  MemOS\n实验室 ",
      members: ["孙起", " 张三 ", "孙起", ""],
      text: "",
      updatedAt: "2026-10-28T12:00:00.000Z"
    }));
    // 名字去掉换行与多余空白，成员去空项、按名字去重。
    expect(file.projects["p-1"]).toMatchObject({ name: "MemOS 实验室", members: ["孙起", "张三"], text: "" });

    const without = parseCollabInstructionsFile(fileWith({
      scopes: [{ sourceId: "memmy", groupId: DIRECTORY }],
      name: "",
      members: [],
      text: "团队约定",
      updatedAt: "2026-10-28T12:00:00.000Z"
    }));
    // 空名字与空成员不留在条目里，读方只需判断有没有。
    expect(without.projects["p-1"]).not.toHaveProperty("name");
    expect(without.projects["p-1"]).not.toHaveProperty("members");
  });

  it("drops an over-long member list instead of the whole file", () => {
    const members = Array.from({ length: MAX_COLLAB_PROJECT_MEMBERS + 5 }, (_, index) => `成员${index}`);
    expect(parseCollabInstructionsFile(fileWith({
      scopes: [{ sourceId: "memmy", groupId: DIRECTORY }],
      members,
      text: "",
      updatedAt: "2026-10-28T12:00:00.000Z"
    })).projects["p-1"]?.members).toHaveLength(MAX_COLLAB_PROJECT_MEMBERS);
  });

  it("treats a file with an unknown field as no cache at all", () => {
    expect(parseCollabInstructionsFile(fileWith({
      scopes: [{ sourceId: "memmy", groupId: DIRECTORY }],
      text: "",
      updatedAt: "2026-10-28T12:00:00.000Z",
      unknown: true
    }))).toEqual(emptyCollabInstructionsFile());
  });
});

describe("collabInstructionsFor", () => {
  it("matches an entry that carries no rules: the project is there, the text is empty", () => {
    const file = parseCollabInstructionsFile(fileWith({
      scopes: [{ sourceId: "memmy", groupId: DIRECTORY }],
      name: "MemOS",
      members: ["孙起"],
      text: "",
      updatedAt: "2026-10-28T12:00:00.000Z"
    }));
    const hit = collabInstructionsFor(file, { sourceId: "memmy", directory: `${DIRECTORY}/packages/app` });
    expect(hit).toMatchObject({ projectId: "p-1", entry: { name: "MemOS", members: ["孙起"], text: "" } });
  });
});

describe("renderCollabProjectContext", () => {
  it("renders the whole paragraph when everything is known", () => {
    expect(renderCollabProjectContext({
      name: "MemOS",
      members: ["孙起", "张三"],
      text: "团队约定：先看 PRD。"
    })).toBe(
      [
        '<collab_project name="MemOS">',
        "当前工作目录属于 Memmy 协作项目「MemOS」，成员有孙起、张三，成员在各自 Agent 里做过的任务都共享在这个项目中。",
        "用户问到这个项目里以前做过什么、怎么定的、为什么这样做、谁在做、进展到哪时，即使没提成员和项目，也先用 memmy-project 在本项目的任务里查；问代码现在是什么样，以代码为准。",
        "",
        "所有者设定了以下背景与规范，在本项目中的任务里遵循：",
        "",
        "团队约定：先看 PRD。",
        "</collab_project>"
      ].join("\n")
    );
  });

  it("drops the rules part when the project has none", () => {
    expect(renderCollabProjectContext({ name: "MemOS", members: ["孙起"], text: "" })).toBe(
      [
        '<collab_project name="MemOS">',
        "当前工作目录属于 Memmy 协作项目「MemOS」，成员有孙起，成员在各自 Agent 里做过的任务都共享在这个项目中。",
        "用户问到这个项目里以前做过什么、怎么定的、为什么这样做、谁在做、进展到哪时，即使没提成员和项目，也先用 memmy-project 在本项目的任务里查；问代码现在是什么样，以代码为准。",
        "</collab_project>"
      ].join("\n")
    );
  });

  it("drops the member clause when there are no members", () => {
    expect(renderCollabProjectContext({ name: "MemOS", members: [], text: "团队约定" })).toBe(
      [
        '<collab_project name="MemOS">',
        "当前工作目录属于 Memmy 协作项目「MemOS」，成员在各自 Agent 里做过的任务都共享在这个项目中。",
        "用户问到这个项目里以前做过什么、怎么定的、为什么这样做、谁在做、进展到哪时，即使没提成员和项目，也先用 memmy-project 在本项目的任务里查；问代码现在是什么样，以代码为准。",
        "",
        "所有者设定了以下背景与规范，在本项目中的任务里遵循：",
        "",
        "团队约定",
        "</collab_project>"
      ].join("\n")
    );
  });

  it("still says the folder belongs to a collab project when nothing else is known", () => {
    expect(renderCollabProjectContext({})).toBe(
      [
        "<collab_project>",
        "当前工作目录属于一个 Memmy 协作项目，成员在各自 Agent 里做过的任务都共享在这个项目中。",
        "用户问到这个项目里以前做过什么、怎么定的、为什么这样做、谁在做、进展到哪时，即使没提成员和项目，也先用 memmy-project 在本项目的任务里查；问代码现在是什么样，以代码为准。",
        "</collab_project>"
      ].join("\n")
    );
  });

  it("keeps the tag intact when the name carries quotes or line breaks", () => {
    const rendered = renderCollabProjectContext({ name: '我的"项目"\n第二行', text: "" });
    // 标签属性里换行已换成空格、双引号换成单引号，标签不会被拆坏；正文里保留项目本来的写法。
    expect(rendered.startsWith(`<collab_project name="我的'项目' 第二行">`)).toBe(true);
    expect(rendered).toContain('当前工作目录属于 Memmy 协作项目「我的"项目" 第二行」');
  });

  it("cuts the rules at the same limit the cache enforces", () => {
    const rendered = renderCollabProjectContext({ name: "MemOS", members: ["孙起"], text: "字".repeat(MAX_COLLAB_INSTRUCTIONS_CHARS + 50) });
    const body = rendered.split("\n").at(-2) ?? "";
    expect(body).toHaveLength(MAX_COLLAB_INSTRUCTIONS_CHARS);
  });
});
