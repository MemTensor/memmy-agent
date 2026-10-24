import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { memoryDetailFixture } from "./fixtures.js";
import { memoryDisplaySource } from "../memory-display.js";
import { ObservedMemoryDetail, observationDisplayMetadata, openObservationHistorySource } from "../observed-memory-detail.js";
import type { GetMemoryOutput } from "@memmy/local-api-contracts";

afterEach(() => vi.unstubAllGlobals());

function item(status: "pending" | "processed" | "skipped" = "processed"): GetMemoryOutput["item"] {
  return {
    ...memoryDetailFixture.item,
    id: "observation_history",
    kind: "observed_activity",
    title: "整理录音设备采购的后续上下文",
    summary: "录音设备采购仍有审批和报销事项需要跟进。",
    body: "## 后续上下文\n\n- 采购任务包含审批状态与报销跟进。\n\n<script>alert(1)</script>\n![secret](https://example.test/image.png)",
    metadata: {
      source: "memmy",
      properties: { internal_info: {
        memory_kind: "observed_activity",
        observation_memory: { schema_version: 1, status, processed_at: "2026-10-09T04:22:00Z", skip_reason: "这段记录只有重复的窗口切换。" },
        external_evidence: {
          source: "memmy",
          sourceRecordId: "2026-10-09T04-10-00Z-10min-summary",
          startedAt: "2026-10-09T04:10:00Z",
          endedAt: "2026-10-09T04:20:00Z",
          revision: "2026-10-09T04:20:09Z",
          source_title: "原始采购活动",
          source_content: "# 原始采购活动\n\n## Memory summary\n\n这是原始电脑历史，而非整理后的记忆。",
          provenance: { historyId: "2026-10-09T04-10-00Z-10min-summary", applications: ["com.TickTick.task.mac", "cn.memtensor.memmy"] },
        },
      } },
    },
  };
}

function render(observation: GetMemoryOutput["item"]) {
  return renderToString(<I18nProvider language="zh-CN"><ObservedMemoryDetail item={observation} /></I18nProvider>);
}

describe("observed memory detail", () => {
  it("shows processed context, source provenance and activity range without fake trace metrics", () => {
    const html = render(item());
    expect(html).toContain("电脑历史");
    expect(html).toContain("活动时间");
    expect(html).toContain("原始摘要更新时间");
    expect(html).toContain("已整理为记忆");
    expect(html).not.toContain("尚未经你核实");
    expect(html).toContain("TickTick");
    expect(html).toContain("Memmy");
    expect(html).toContain("memory-observation-app");
    expect(html).toContain('<h4 class="memory-markdown__heading">后续上下文</h4>');
    expect(html).toContain("录音设备采购仍有审批和报销事项需要跟进。");
    expect(html).toContain("<details><summary>展开摘要快照</summary>");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("https://example.test/image.png");
    expect(html).not.toContain("反思权重");
    expect(memoryDisplaySource(item())).toBe("computer_history");
  });

  it("keeps pending and skipped raw history in a closed source section instead of presenting a memory", () => {
    const pending = render(item("pending"));
    expect(pending).toContain("正在整理为记忆");
    expect(pending).not.toContain("可供后续参考的上下文");
    expect(pending).not.toContain("录音设备采购仍有审批和报销事项需要跟进。");
    const skipped = render(item("skipped"));
    expect(skipped).toContain("未提炼为记忆");
    expect(skipped).toContain("这段记录只有重复的窗口切换。");
    expect(skipped).not.toContain("可供后续参考的上下文");
  });

  it("marks legacy records without processing metadata as pending and keeps their original body", () => {
    const legacy = item();
    const properties = legacy.metadata.properties as { internal_info: Record<string, unknown> };
    delete properties.internal_info.observation_memory;
    expect(observationDisplayMetadata(legacy).state).toBe("pending");
    expect(render(legacy)).not.toContain("可供后续参考的上下文");
  });

  it("opens only the source file resolved from the live History service", async () => {
    const open = vi.fn(async () => undefined);
    vi.stubGlobal("window", { memmy: { openComputerHistoryMarkdown: open } });
    const getComputerHistory = vi.fn(async () => ({ histories: [{ id: "history-1", filePath: "/safe/history.md" }] }));
    await openObservationHistorySource({ getComputerHistory } as never, "history-1", "来源不可用");
    expect(open).toHaveBeenCalledWith("/safe/history.md");
    await expect(openObservationHistorySource({ getComputerHistory } as never, "missing", "来源不可用")).rejects.toThrow("来源不可用");
    expect(open).toHaveBeenCalledTimes(1);
  });
});
