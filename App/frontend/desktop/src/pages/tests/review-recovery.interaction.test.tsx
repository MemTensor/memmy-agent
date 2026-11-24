// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ReviewRecovery, reviewContinuation, reviewRecovery } from "../review-recovery.js";
import type { PluginUiCall } from "../../app/plugin-ui-context.js";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../app/providers.js", () => ({ useOptionalApiClients: () => ({ clients: { plugins: { invoke: mocks.invoke } } }) }));
const call: PluginUiCall = { pluginId: "literature-review", capabilityId: "review_generate_sections", callId: "failed", conversationId: "websocket:chat", origin: "agent", events: [
  { type: "error", code: "host_service_timeout", message: "Timed out", retryable: true, recovery: { taskId: "review-fixture", runId: "failed" } }
] };
const status = (running = false) => ({ callId: "status", event: { type: "result", output: { ok: true, data: { runs: running ? [{ status: "running" }] : [], recoverableRuns: [{ runId: "failed" }], sectionGeneration: { completedOutlineNodeIds: ["s1"], pendingOutlineNodeIds: ["s2"], paragraphProgress: [{ savedModelParagraphs: 3 }] } } } } });

it("shows recovery only for failed runs and keeps successful partial batches resumable", () => {
  const partial: PluginUiCall = { ...call, events: [{ type: "result", output: { taskId: "review-fixture", data: { result: { generation: { safeToResume: true } } }, suggestedNextTools: [{ toolName: "review_generate_sections", args: { taskId: "review-fixture", outlineNodeIds: ["s2"], batchSize: 1 } }] } }] };
  expect(reviewRecovery(partial)).toBeNull();
  expect(reviewContinuation(partial)?.input).toEqual({ taskId: "review-fixture", outlineNodeIds: ["s2"], batchSize: 1 });
  expect(reviewRecovery(call)?.capabilityId).toBe("review_resume");
  expect(reviewRecovery({ ...call, pluginId: "another-plugin" })).toBeNull();
});

it.each([false, true])("checks live status before recovery, running=%s", async running => {
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValueOnce(status(running)).mockResolvedValueOnce({ callId: "resumed", event: { type: "result", output: { ok: true, summary: "已复用保存段落" } } });
  const container = document.createElement("div"); const root = createRoot(container);
  try {
    await act(async () => root.render(<I18nProvider language="zh-CN"><ReviewRecovery call={call} /></I18nProvider>));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(mocks.invoke.mock.calls[0]).toEqual(["literature-review", "review_get_status", { conversationId: "websocket:chat", origin: "user", input: { taskId: "review-fixture" } }]);
    if (running) {
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("任务仍在运行");
    } else {
      expect(mocks.invoke.mock.calls[1]).toEqual(["literature-review", "review_resume", { conversationId: "websocket:chat", origin: "user", input: { taskId: "review-fixture", runId: "failed" } }]);
      expect(container.textContent).toContain("已保存 1 节、3 个段落");
      expect(container.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true);
    }
  } finally { await act(async () => root.unmount()); }
});
