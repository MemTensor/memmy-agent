import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryRow } from "../../../../../../../Memory/src/types.js";
import type { GetMemoryOutput, PanelItemsOutput } from "@memmy/local-api-contracts";
import { GetMemoryOutputSchema } from "@memmy/local-api-contracts";
import { Window } from "happy-dom";
import { Repositories } from "../../../../../../../Memory/src/storage/repositories.js";
import { detailFromMemory } from "../../../../../../../Memory/src/service/read-model/memory.js";
import { waitingSourceText } from "../../../../../../../Memory/src/service/read-model/display-fields.js";
import { createMemoryServiceFixture } from "../../../../../../../Memory/tests/fixtures/memory-service-fixture.js";
import { MemoriesSubPageView } from "../memories-sub-page.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";

const { createTestService, cleanup } = createMemoryServiceFixture();
afterEach(cleanup);
const at = "2026-10-27T06:00:00.000Z";
const context = '<in-app-browser-context source="ambient-ui-state">\n页面上下文\n</in-app-browser-context>';
const request = "请修复扫描标题";

function parseHTML(html: string) {
  const document = new Window({ settings: { disableJavaScriptEvaluation: true } }).document.createElement("div");
  document.innerHTML = html;
  return { document };
}

function legacyMemory(body: string): MemoryRow {
  return {
    id: "trace_legacy_preview", timeline: at, userId: "review-user", agentId: "codex",
    memoryType: "LongTermMemory", status: "activated", visibility: "private",
    memoryValue: body, tags: [], info: {}, memoryLayer: "L1", version: 1,
    // Legacy rows may omit memory_kind and trace metadata entirely.
    properties: { internal_info: { memory_layer: "L1" } }, createdAt: at, updatedAt: at
  };
}

function render(items: PanelItemsOutput["items"], detail?: GetMemoryOutput): string {
  const noop = () => {};
  return renderToStaticMarkup(createElement(I18nProvider, { language: "zh-CN", children:
    createElement(MemoriesSubPageView, {
      state: { status: "ready", detail: detail ? { status: "ready", data: detail } : null, data: { items, page: 1, pageSize: 20, total: items.length, totalPages: 1, hasNext: false, hasPrev: false, serverTime: at } },
      query: "", sourceAgent: "", onQueryChange: noop, onSourceAgentChange: noop,
      onSearch: noop, onPageChange: noop, onRefresh: noop, onOpenDetail: noop,
      onDeleteDetail: async () => {}, onCloseDetail: noop
    })
  }));
}

describe("stored memory -> panel/detail -> rendered trace title", () => {
  it.each([undefined, "trace"] as const)("shows a legacy body safely without manufacturing summary (kind %s)", (kind) => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const body = '<pasted_content id="legacy">\n<script>alert("quoted")</script>\n<img src="https://example.com/private" onerror="alert(1)">\n</pasted_content>\n第一行请求\n第二行请求';
    const row = legacyMemory(body);
    row.properties.internal_info.memory_kind = kind;
    repos.memories.insert(row);
    const before = repos.memories.get(row.id)!;
    const detail = GetMemoryOutputSchema.parse(service.getMemory(row.id));
    expect(detail.item.summary).toBe("");
    const { document } = parseHTML(render([], detail));
    const drawer = document.querySelector('.memory-drawer__body')!;
    const original = drawer.querySelector('.memory-detail-raw-body');
    expect(original?.textContent).toBe(body);
    expect(original?.children.length).toBe(0);
    expect(repos.memories.get(row.id)).toEqual(before);
  });

  it("keeps structured turn rendering and empty-body handling without a duplicate raw body", () => {
    const { db, service } = createTestService();
    const added = service.addMemory({ adapterId: "agent-source:codex", source: "codex", layer: "L1", turnId: "structured-detail", content: `## user\n${request}\n## assistant\n完成。` });
    const { document } = parseHTML(render([], GetMemoryOutputSchema.parse(service.getMemory(added.id))));
    const drawer = document.querySelector('.memory-drawer__body')!;
    expect(drawer.textContent).toContain(request);
    expect(drawer.textContent).toContain("完成。");
    expect(drawer.querySelector('.memory-detail-raw-body')).toBeNull();
    const empty = legacyMemory(" \n\t");
    new Repositories(db.db).memories.insert(empty);
    const emptyHtml = render([], GetMemoryOutputSchema.parse(service.getMemory(empty.id)));
    expect(emptyHtml).toContain("暂无本轮步骤");
    expect(emptyHtml).not.toContain('memory-detail-raw-body');
  });

  it.each([
    ["system_reminder", '<div title="<system_reminder>">引用</div>'],
    ["system_reminder", '<div title="</system_reminder>">引用</div>'],
    ["pasted_content", '<div title="<pasted_content>">引用</div>'],
    ["pasted_content", '<!-- </pasted_content> -->引用']
  ])("preserves imported role boundaries around tag text in %s payload: %s", (tag, payload) => {
    const { db, service } = createTestService();
    const input = `<${tag}>\n${payload}\n## assistant\n引用回复\n</${tag} id="261b">\n${request}`;
    const added = service.addMemory({ adapterId: "agent-source:codex", source: "codex", layer: "L1", turnId: "quoted-tag-import", content: `## user\n${input}\n## assistant\n实际回复` });
    expect(added.title).toBe(request);
    const stored = new Repositories(db.db).memories.get(added.id)!;
    const trace = stored.properties.internal_info.trace as Record<string, unknown>;
    expect(trace.userText).toBe(input);
    expect(trace.agentText).toBe("实际回复");
    const item = service.panelItems({ layer: "L1" }).items[0]!;
    expect(item.sourceText).toBe(request);
    expect(render([item])).toContain(`class="memory-card__title">${request}`);
    expect(service.getMemory(added.id).item.body).toContain(input);
  });

  it.each([
    ["L1", "span", "span body"], ["L1", "work_memory", "work body"],
    ["L1", "observed_activity", "observation body"], ["L2", "policy", "policy body"],
    ["L3", "world_model", "world body"], ["Skill", "skill", "skill body"]
  ] as const)("preserves %s / %s summary semantics", (layer, kind, body) => {
    const { db } = createTestService();
    const repos = new Repositories(db.db);
    const row = legacyMemory(body);
    row.memoryLayer = layer;
    row.properties.internal_info.memory_kind = kind;
    if (kind === "work_memory") row.properties.internal_info.requirement = "work requirement";
    const expected = kind === "work_memory" ? "work requirement" : body;
    expect(repos.memories.toListItem(row).summary).toBe(expected);
    expect(detailFromMemory(row).summary).toBe(expected);
  });

  it.each([
    '<pasted_content id="261b">正文</pasted_content id="261b">',
    '<pasted_content id="261b">截断正文',
    '<pasted_content id="261b"'
  ])("uses the ID for a persisted import without a semantic request: %s", (input) => {
    const { db, service } = createTestService();
    const added = service.addMemory({ adapterId: "agent-source:claude-code", source: "claude-code", layer: "L1", turnId: "preview-empty", content: input });
    const row = new Repositories(db.db).memories.get(added.id)!;
    const item = service.panelItems({ layer: "L1" }).items[0]!;
    expect(item.sourceText).toBeUndefined();
    expect(render([item])).toContain(`class="memory-card__title">${added.id}`);
    expect(detailFromMemory(row).body).toContain(input);
  });

  it("keeps storage and read-model user previews consistent around embedded role headings", () => {
    const { db } = createTestService();
    const repos = new Repositories(db.db);
    const input = '<pasted_content>\n## assistant\nquoted answer\n## user\nquoted request\n</pasted_content>\n' + request;
    const row = legacyMemory(`## user\n${input}\n## assistant\nDone`);
    expect(repos.memories.toListItem(row).title).toBe(request);
    expect(waitingSourceText(row)).toBe(request);
  });

  it("imports an unstructured source message without splitting role headings inside its envelope", () => {
    const { db, service } = createTestService();
    const input = '<pasted_content>\n## assistant\nquoted answer\n## user\nquoted request\n</pasted_content>\n' + request;
    const added = service.addMemory({ adapterId: "agent-source:claude-code", source: "claude-code", layer: "L1", turnId: "unstructured-import", content: input });
    expect(added.title).toBe(request);
    const row = new Repositories(db.db).memories.get(added.id)!;
    expect((row.properties.internal_info.trace as Record<string, unknown>).userText).toBe(input);
    const item = service.panelItems({ layer: "L1" }).items[0]!;
    expect(render([item])).toContain(`class="memory-card__title">${request}`);
  });
  it.each([undefined, "ready", "failed", "summary_pending", "summarizing", "embedding_pending", "embedding"] as const)("does not manufacture an old trace summary in state %s", (state) => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    for (const body of [`${context}\n${request}`, context]) {
      for (const summary of [undefined, "", "摘要总结中"]) {
        const row = legacyMemory(body);
        row.id += `_${body === context ? "empty" : "request"}_${summary === undefined ? "missing" : summary === "" ? "blank" : "placeholder"}`;
        if (summary !== undefined) row.info.summary = summary;
        repos.memories.insert(row);
        if (state) repos.processing.save({ memoryId: row.id, state, stage: null, activeJobId: null, attemptCount: 0, manualRetryCount: 0, retryAction: "none", errorCode: null, errorMessage: null, failedAt: null, updatedAt: at });
        const before = repos.memories.get(row.id)!;
        const item = service.panelItems({ layer: "L1" }).items.find(item => item.id === row.id)!;
        expect(item.summary).toBe("");
        expect(item.processing?.state).toBe(state);
        expect(detailFromMemory(before).summary).toBe("");
        const detail = service.getMemory(row.id);
        expect(detail.kind).toBe("trace");
        if (detail.kind === "trace") expect(detail.item.summary).toBe("");
        expect(item.sourceText).toBe(body === context ? undefined : request);
        const html = render([item]);
        expect(html).toContain(`class="memory-card__title">${body === context ? row.id : request}`);
        expect(html).not.toContain("in-app-browser-context");
        expect(repos.memories.get(row.id)).toEqual(before);
      }
    }
  });

  it.each(["info", "internal", "trace"] as const)("preserves multiline summaries from %s after earlier placeholders", (field) => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const row = legacyMemory(`${context}\n${request}`);
    const summary = "有效摘要第一行\n有效摘要第二行";
    row.info.summary = field === "info" ? summary : "摘要排队中";
    row.properties.internal_info.summary = field === "internal" ? summary : "摘要总结中";
    row.properties.internal_info.trace = { summary: field === "trace" ? summary : "", title: "生成标题" };
    repos.memories.insert(row);
    const stored = repos.memories.get(row.id)!;
    const item = service.panelItems({ layer: "L1" }).items[0]!;
    expect(item.summary).toBe(summary);
    expect(detailFromMemory(stored).summary).toBe(summary);
    expect(render([item])).toContain('class="memory-card__title">生成标题');
  });

  it.each([
    '<pasted_content id="261b">\n粘贴正文\n</pasted_content id="261b">',
    '<pasted_content>\n## assistant\n引用回复\n## user\n引用请求\n</pasted_content>',
    '[Image]\n<image_files>附件</image_files>',
    '```chat_selection\n引用对话\n```'
  ])("imports and renders the request following %s", (envelope) => {
    const { db, service } = createTestService();
    const input = `${envelope}\n${request}`;
    const added = service.addMemory({ adapterId: "agent-source:claude-code", source: "claude-code", layer: "L1", turnId: "preview-import", content: `## user\n\n${input}\n\n## assistant\n\n完成。` });
    expect(added.title).toBe(request);
    const item = service.panelItems({ layer: "L1" }).items.find(item => item.id === added.id)!;
    expect(item.sourceText).toBe(request);
    expect(render([item])).toContain(`class="memory-card__title">${request}`);
    const stored = new Repositories(db.db).memories.get(added.id)!;
    expect((stored.properties.internal_info.trace as Record<string, unknown>).userText).toBe(input);
    expect(detailFromMemory(stored).body).toContain(input);
  });

  it("refreshes existing log summaries to empty without replacing missing records or span goals", () => {
    const { db, service } = createTestService();
    const repos = new Repositories(db.db);
    const session = service.openSession({ namespace: { source: "codex", profileId: "default", userId: "review-log" } });
    const completed = service.completeTurn("preview-log-turn", { sessionId: session.sessionId, query: request, answer: "完成。" });
    const storedLog = db.db.prepare("SELECT output_json FROM api_logs WHERE tool_name = 'memory_add'").get() as { output_json: string };
    expect(JSON.parse(storedLog.output_json).details[0].summary).toBe("");
    const row = repos.memories.get(completed.l1MemoryId)!;
    row.info.summary = "";
    row.properties.internal_info.summary = "";
    (row.properties.internal_info.trace as Record<string, unknown>).summary = "";
    repos.memories.update(row);
    const log = service.apiLogs({ tools: ["memory_add"], limit: 1 }).logs[0]!;
    const output = JSON.parse(log.outputJson);
    output.details = [
      { role: "trace", traceId: row.id, summary: "旧标签摘要" },
      { role: "trace", traceId: "missing", summary: "历史摘要" },
      { role: "span", spanId: "missing_span", spanGoal: "历史目标" }
    ];
    db.db.prepare("UPDATE api_logs SET output_json = ? WHERE id = ?").run(JSON.stringify(output), log.id);
    const refreshed = JSON.parse(service.apiLogs({ tools: ["memory_add"], limit: 1 }).logs[0]!.outputJson);
    expect(refreshed.details).toEqual([
      { role: "trace", traceId: row.id, summary: "" },
      { role: "trace", traceId: "missing", summary: "历史摘要" },
      { role: "span", spanId: "missing_span", spanGoal: "历史目标" }
    ]);
  });
});
