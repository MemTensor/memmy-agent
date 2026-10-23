import { describe, expect, it } from "vitest";
import type { MemoryRow } from "../../../src/types.js";
import { displayFieldsForMemory, waitingSourceText } from "../../../src/service/read-model/display-fields.js";
import { firstSemanticUserLine } from "../../../src/utils/text.js";

const request = "请修复扫描后的记忆标题";
const browser = '<in-app-browser-context source="ambient-ui-state">\n页面正文\n<user_query>页面内的引用</user_query>\n</in-app-browser-context>';

function memory(userText?: string, body = ""): MemoryRow {
  return {
    id: "trace_preview", timeline: "2026-09-10T13:00:00Z", userId: "user-preview",
    memoryType: "LongTermMemory", status: "activated", visibility: "private",
    memoryValue: body, tags: [], info: {},
    properties: { internal_info: { memory_layer: "L1", memory_kind: "trace", trace: { userText } } },
    memoryLayer: "L1", version: 1, createdAt: "2026-09-10T13:00:00Z", updatedAt: "2026-09-10T13:00:00Z"
  };
}

describe("waiting memory previews", () => {
  it.each([
    `<timestamp>Tuesday, Jun 16, 2026, 10:16 PM (UTC+8)</timestamp>\n${request}`,
    `${browser}\n${request}`,
    `\uFEFF<timestamp>today</timestamp>\n${request}`,
    `<attached_files>\n附件内容\n</attached_files>\n<user_query>${request}</user_query>`,
    `<timestamp>today</timestamp>\n<external_links>链接</external_links>\n<user_query>${request}</user_query>`,
    `<system-reminder>提醒</system-reminder>\n${request}`,
    `<manually_attached_skills>\n<user_query>技能中的示例请求</user_query>\n</manually_attached_skills>\n<timestamp>today</timestamp>\n<user_query>${request}</user_query>`,
    `<timestamp timezone="UTC+8">today</timestamp><user_query>\n${request}\n</user_query>`,
    `<system_reminder>outer<system_reminder>inner</system_reminder>tail</system_reminder>\n${request}`,
    `<system_notification reason="a > b">status</system_notification>\n${request}`,
    `<image_files />\n<user_query><timestamp>today</timestamp>\n${request}</user_query>`
  ])("extracts the same request for import titles and waiting previews: %s", (input) => {
    expect(firstSemanticUserLine(input)).toBe(request);
    const row = memory(input, `User:\n${input}\nAssistant:\n不要把回复当标题`);
    const before = JSON.stringify(row);
    expect(waitingSourceText(row)).toBe(request);
    expect(JSON.stringify(row)).toBe(before);
  });

  it.each([
    browser,
    '<attached_files>未闭合附件\n<user_query>不能提取附件内请求</user_query>',
    '<manually_attached_skills><user_query>技能内容</user_query></manually_attached_skills>',
    '<in-app-browser-context source="ambient-ui-state">\n未闭合页面正文',
    '<in-app-browser-context source="ambient-ui-state"',
    "<timestamp>today</timestamp>\n<system_notification>done</system_notification>",
    "<user_query>未闭合请求",
    "摘要总结中"
  ])("does not recover rejected context from the raw body: %s", (input) => {
    expect(waitingSourceText(memory(input, `User:\n${input}\nAssistant:\n不要把回复当标题`))).toBeUndefined();
    expect(waitingSourceText(memory(undefined, `User:\n${input}\nAssistant:\n不要把回复当标题`))).toBeUndefined();
  });

  it.each([
    '<div class="card">请修改这个元素</div>',
    '<div>普通 HTML</div>\n<user_query>字面量</user_query>',
    '<custom_element>自定义元素</custom_element>\n<user_query>字面量</user_query>',
    '> <attached_files>引用内容</attached_files>\n<user_query>字面量</user_query>',
    '```xml\n<attached_files>代码</attached_files>\n<user_query>字面量</user_query>\n```',
    "解释 <timestamp> 和 x < y 的含义",
    "> <timestamp>quoted example</timestamp>",
    "```xml\n<timestamp>code example</timestamp>\n```",
    "    <timestamp>indented code</timestamp>",
    "The following is the Codex agent history whose request action you are assessing."
  ])("preserves ordinary HTML, code, quotes and unverified review text: %s", (input) => {
    expect(firstSemanticUserLine(input)).toBe(input.split("\n")[0]!.trim());
    expect(waitingSourceText(memory(input))).toBe(input.split("\n")[0]!.trim());
  });

  it("handles legacy user_text and complete User sections without using assistant content", () => {
    const row = memory();
    row.properties.internal_info.trace = { user_text: `${browser}\n${request}` };
    expect(waitingSourceText(row)).toBe(request);
    expect(waitingSourceText(memory(undefined, `## user\n${browser}\n${request}\n## assistant\nDone`))).toBe(request);
    expect(waitingSourceText(memory(undefined, "Assistant:\nNot a user request"))).toBeUndefined();
    expect(waitingSourceText(memory(undefined, `Summary: ${browser}`))).toBeUndefined();
    expect(waitingSourceText(memory(undefined, "Summary: 旧版可读正文\nRawTurn: raw_id"))).toBe("旧版可读正文");
    const nestedRoles = '<in-app-browser-context>\n## assistant\n页面中的回复\n## user\n页面中的请求\n</in-app-browser-context>';
    expect(waitingSourceText(memory(undefined, `User:\n${nestedRoles}\n${request}\nAssistant:\nDone`))).toBe(request);
    expect(waitingSourceText(memory(undefined, `User:\n${nestedRoles}\nAssistant:\nDone`))).toBeUndefined();
    expect(waitingSourceText(memory(undefined, `Summary: ${nestedRoles}`))).toBeUndefined();
    expect(waitingSourceText(memory(undefined, `Summary: ${nestedRoles}\n${request}`))).toBe(request);
    expect(waitingSourceText(memory(undefined, "```text\nUser:\n示例内容\n```"))).toBe("```text");
  });

  it("skips empty L2 evidence and keeps generated titles independent of previews", () => {
    const policy = { ...memory(), memoryLayer: "L2" as const };
    expect(waitingSourceText(policy, [memory(browser), memory(`${browser}\n${request}`)])).toBe(request);
    expect(waitingSourceText(policy, [memory(browser)])).toBeUndefined();
    const row = memory(`${browser}\n${request}`);
    row.properties.internal_info.trace = { userText: `${browser}\n${request}`, title: "扫描标题修复" };
    expect(displayFieldsForMemory(row)).toEqual({ sourceText: request, generatedTitle: "扫描标题修复" });
  });

  it("filters before clipping so long context never displaces the real request", () => {
    const context = `<in-app-browser-context>\n${"页面正文\n".repeat(10_000)}</in-app-browser-context>`;
    expect(waitingSourceText(memory(`${context}\n${request}`))).toBe(request);
    const longRequest = request.repeat(30);
    const preview = waitingSourceText(memory(`${context}\n${longRequest}`))!;
    expect(preview).toHaveLength(120);
    expect(preview).toBe(`${longRequest.slice(0, 117)}...`);
  });
});
