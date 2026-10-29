/** Policies sub page tests. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { MemoryStateBox } from "../memory-state-box.js";
import { ExperienceState, PolicyStatusPill, policyStatusTone } from "../policies-sub-page.js";
import { panelItemsOutput } from "./fixtures.js";

const memoryPagesDir = resolve(__dirname, "..");

describe("PoliciesSubPage", () => {
  it("记忆、任务、经验、场域认知和技能空态共用状态卡片样式", () => {
    const emptyStates = {
      "memories-sub-page.tsx": '<MemoryStateBox message={t("memory.memories.empty")} />',
      "tasks-sub-page.tsx": '<MemoryStateBox message={t("memory.tasks.empty")} />',
      "policies-sub-page.tsx": '<MemoryStateBox message={t("memory.policies.empty")} />',
      "world-model-sub-page.tsx": '<MemoryStateBox message={t("memory.worldModel.empty")} />',
      "skills-sub-page.tsx": '<MemoryStateBox message={t("memory.skills.empty")} />'
    };
    const html = renderToString(<MemoryStateBox message="暂无经验" />);

    Object.entries(emptyStates).forEach(([fileName, emptyState]) => {
      const source = readFileSync(resolve(memoryPagesDir, fileName), "utf8");

      expect(source).toContain('import { MemoryStateBox } from "./memory-state-box.js";');
      expect(source).toContain(emptyState);
      expect(source).not.toContain("function StateBox");
      expect(source).not.toContain("rounded-card p-5 text-sm");
    });
    expect(html).toContain("memory-state-box");
    expect(html).not.toContain("rounded-card p-5 text-sm");
  });

  it("候选和已启用经验使用不同的状态标签 class", () => {
    expect(policyStatusTone("resolving")).toBe("candidate");
    expect(policyStatusTone("candidate")).toBe("candidate");
    expect(policyStatusTone("activated")).toBe("active");
    expect(policyStatusTone("active")).toBe("active");

    const html = renderToString(
      <I18nProvider language="zh-CN">
        <>
          <PolicyStatusPill status="resolving" />
          <PolicyStatusPill status="activated" />
        </>
      </I18nProvider>
    );

    expect(html).toContain("memory-pill--policy-candidate");
    expect(html).toContain("memory-pill--policy-active");
    expect(html).toContain("候选");
    expect(html).toContain("已启用");
    expect(html).not.toContain("memory-pill--policy-resolving");
    expect(html).not.toContain("memory-pill--policy-activated");
  });

  it("真实草稿列表用源用户句和 pill，抽屉只显示 id", () => {
    const draft = {
      id: "policy_panel_draft",
      kind: "policy" as const,
      memoryLayer: "L2" as const,
      status: "activated" as const,
      title: "Trigger: pytest workflow fails",
      summary: "pytest workflow fails",
      sourceText: "请修复自动扫描卡顿并运行测试",
      experienceDraft: true,
      tags: [],
      createdAt: "2026-06-03T09:10:00.000Z",
      updatedAt: "2026-06-03T09:20:00.000Z",
      version: 1
    };
    const ready = {
      ...draft,
      id: "policy_panel_ready",
      title: "使用 focused pytest",
      generatedTitle: "使用 focused pytest",
      summary: "当 pytest 失败时先看 migration 输出",
      sourceText: undefined,
      experienceDraft: undefined
    };
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <ExperienceState
          state={{ status: "ready", data: panelItemsOutput([draft, ready]) }}
          detail={{
            status: "ready",
            data: {
              item: {
                ...draft,
                body: "Policy: pytest retry\nTrigger: pytest workflow fails",
                sourceMemoryIds: ["trace_source"],
                metadata: { source: "codex" }
              },
              version: 1,
              etag: "policy-draft"
            }
          }}
          onOpenDetail={() => undefined}
          onDeleteDetail={async () => undefined}
          onCloseDetail={() => undefined}
          onPageChange={() => undefined}
          onOpenMemoryReference={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('class="memory-card__title">请修复自动扫描卡顿并运行测试');
    expect(html).toContain('class="memory-card__title">使用 focused pytest');
    expect(html).not.toContain('class="memory-card__title">Trigger:');
    expect(html).toContain("摘要总结中");
    expect(html).not.toContain("memory-card__summary");
    expect(html).not.toContain("memory-drawer__title");
    expect(html).toContain("policy_panel_draft");
  });

  it("旧经验没有 generatedTitle 时显示历史标题，不打等待 pill", () => {
    const legacy = {
      id: "policy_legacy",
      kind: "policy" as const,
      memoryLayer: "L2" as const,
      status: "activated" as const,
      title: "Trace suspicious memory content to its capture source",
      summary: "Read the capture log",
      tags: ["policy"],
      createdAt: "2026-06-03T09:10:00.000Z",
      updatedAt: "2026-06-03T09:20:00.000Z",
      version: 1
    };
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <ExperienceState
          state={{ status: "ready", data: panelItemsOutput([legacy]) }}
          detail={{
            status: "ready",
            data: {
              item: {
                ...legacy,
                body: "Trace suspicious memory content to its capture source\nTrigger: stored memory",
                sourceMemoryIds: [],
                metadata: { source: "codex" }
              },
              version: 1,
              etag: "policy-legacy"
            }
          }}
          onOpenDetail={() => undefined}
          onDeleteDetail={async () => undefined}
          onCloseDetail={() => undefined}
          onPageChange={() => undefined}
          onOpenMemoryReference={() => undefined}
        />
      </I18nProvider>
    );
    expect(html).toContain('class="memory-card__title">Trace suspicious memory content to its capture source');
    expect(html).toContain("memory-drawer__title");
    expect(html).toContain("Trace suspicious memory content to its capture source");
    expect(html).not.toContain("摘要总结中");
    expect(html).not.toContain("Read the capture log");
  });

  it("只有内部 id 且没有草稿标记时不打等待 pill", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <ExperienceState
          state={{
            status: "ready",
            data: panelItemsOutput([{
              id: "policy_38cf5db983ffa67200a8",
              kind: "policy",
              memoryLayer: "L2",
              status: "activated",
              title: "policy_38cf5db983ffa67200a8",
              summary: "Read the capture log",
              tags: [],
              createdAt: "2026-06-03T09:10:00.000Z",
              updatedAt: "2026-06-03T09:20:00.000Z",
              version: 1
            }])
          }}
          detail={null}
          onOpenDetail={() => undefined}
          onDeleteDetail={async () => undefined}
          onCloseDetail={() => undefined}
          onPageChange={() => undefined}
          onOpenMemoryReference={() => undefined}
        />
      </I18nProvider>
    );
    expect(html).not.toContain("摘要总结中");
  });

  it("列表标题仍是 Policy 草稿时进入等待", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <ExperienceState
          state={{
            status: "ready",
            data: panelItemsOutput([{
              id: "policy_panel_raw_draft",
              kind: "policy",
              memoryLayer: "L2",
              status: "activated",
              title: "Policy: pytest retry",
              summary: "pytest workflow fails",
              sourceText: "请修复自动扫描卡顿并运行测试",
              tags: [],
              createdAt: "2026-06-03T09:10:00.000Z",
              updatedAt: "2026-06-03T09:20:00.000Z",
              version: 1
            }])
          }}
          detail={null}
          onOpenDetail={() => undefined}
          onDeleteDetail={async () => undefined}
          onCloseDetail={() => undefined}
          onPageChange={() => undefined}
          onOpenMemoryReference={() => undefined}
        />
      </I18nProvider>
    );
    expect(html).toContain('class="memory-card__title">请修复自动扫描卡顿并运行测试');
    expect(html).toContain("摘要总结中");
    expect(html).not.toContain('class="memory-card__title">Policy:');
  });

  it("经验草稿没有源证据时不把 Procedure 当等待标题", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <ExperienceState
          state={{
            status: "ready",
            data: panelItemsOutput([{
              id: "policy_panel_procedure",
              kind: "policy",
              memoryLayer: "L2",
              status: "activated",
              title: "Procedure: rerun tests",
              summary: "pytest workflow fails",
              experienceDraft: true,
              tags: [],
              createdAt: "2026-06-03T09:10:00.000Z",
              updatedAt: "2026-06-03T09:20:00.000Z",
              version: 1
            }])
          }}
          detail={{
            status: "ready",
            data: {
              item: {
                id: "policy_panel_procedure",
                kind: "policy",
                memoryLayer: "L2",
                status: "activated",
                title: "Procedure: rerun tests",
                summary: "pytest workflow fails",
                experienceDraft: true,
                body: "Policy: retry\nProcedure: rerun tests",
                sourceMemoryIds: [],
                tags: [],
                createdAt: "2026-06-03T09:10:00.000Z",
                updatedAt: "2026-06-03T09:20:00.000Z",
                version: 1,
                metadata: { source: "codex" }
              },
              version: 1,
              etag: "policy-procedure"
            }
          }}
          onOpenDetail={() => undefined}
          onDeleteDetail={async () => undefined}
          onCloseDetail={() => undefined}
          onPageChange={() => undefined}
          onOpenMemoryReference={() => undefined}
        />
      </I18nProvider>
    );
    expect(html).toContain('class="memory-card__title">policy_panel_procedure');
    expect(html).toContain("摘要总结中");
    expect(html).not.toContain("Procedure: rerun tests");
    expect(html).not.toContain("Trigger:");
    expect(html).not.toContain("memory-drawer__title");
  });
});
