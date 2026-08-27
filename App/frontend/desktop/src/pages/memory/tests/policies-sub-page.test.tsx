/** Policies sub page tests. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { MemoryStateBox } from "../memory-state-box.js";
import { PolicyStatusPill, policyStatusTone } from "../policies-sub-page.js";

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
});
