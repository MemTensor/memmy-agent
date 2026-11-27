import { expect, it } from "vitest";
import { mixProjectRecall, awaitLocalRecall } from "../src/server/project-memory.js";
import { countSummaryTokens } from "../src/model/llm.js";
import type { InjectedContext } from "../src/types.js";
const section: InjectedContext["sections"][number] = { id: "local", title: "log", kind: "trace", memoryLayer: "L1", memoryIds: ["log"], content: "local diagnosis" };
const local = { hits: [], sourceMemoryIds: ["log"], injectedContext: { sections: [section], markdown: "local diagnosis" } };
it("ranks exact anchors, deduplicates within a project, keeps conflicts, and shares the budget", () => {
  const topic = { id: "share", project_id: "A", topic_name: "HTTP 409", topic_summary: "already shared",
    decisions: [{ content: "check first", conflicts: [{ author: "Lee", content: "retry" }] }], timeline: ["x ".repeat(5000)] };
  const cloud = { project_item_list: [{ id: "other", project_id: "A", topic_summary: "general" }, topic, topic, {...topic, project_id: "B" }] };
  const mixed = mixProjectRecall(local, cloud, "HTTP 409", 150);
  expect(mixed.projectMemory?.selectedIds.slice(0,2)).toEqual(["project:A:share","project:B:share"]);
  expect(mixed.projectMemory?.selectedIds.filter(id => id === "project:A:share")).toHaveLength(1);
  expect(mixed.injectedContext.markdown).toContain("local diagnosis");
  expect(mixed.injectedContext.markdown).toContain("Lee");
  expect(countSummaryTokens(mixed.injectedContext.markdown)).toBeLessThanOrEqual(150);
  expect(mixed.sourceMemoryIds).toEqual(["log"]);
  expect(mixProjectRecall(local, {}, "409").injectedContext).toBe(local.injectedContext);
});
it("returns project evidence on a failed local retrieval and enforces the trajectory budget", async () => {
  const cloud = Promise.resolve({ project_item_list: [{ project_id: "a", id: "1" }] });
  expect((await awaitLocalRecall(Promise.reject(new Error("retriever offline")),cloud)).found?.degraded).toContain("local_unavailable");
  const items = Array.from({length:6}, (_,i) => ({ id: String(i), project_id: "a", role: "tool",
    tool_calls: [{function:{name:"rollback",arguments:"{}"}}], content: "故障".repeat(600) }));
  const mixed = mixProjectRecall(local, { project_item_list: items }, "rollback", 180);
  expect(mixed.projectMemory?.selectedIds.length).toBeLessThanOrEqual(5);
  expect(mixed.injectedContext.markdown).toContain("rollback");
  expect(mixed.injectedContext.markdown).toContain("故障");
  expect(countSummaryTokens(mixed.injectedContext.markdown)).toBeLessThanOrEqual(180);
});
