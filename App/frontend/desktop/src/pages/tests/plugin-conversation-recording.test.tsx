// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin, EventCaptureSession } from "@memmy/local-api-contracts";
import type { PluginsClient } from "../../api/plugins-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginConversationRecording } from "../plugin-conversation-recording.js";

let node: HTMLDivElement, root: Root;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; node = document.createElement("div"); document.body.appendChild(node); root = createRoot(node); });
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.useRealTimers(); });
function fixture() {
  const plugin = { id: "fixture.capture", version: "0.2.0", state: "active", manifest: { name: "Capture Plugin",
    conversation: { recordingCapabilityId: "capture", recordingSkillId: "capture-start", creatorSkillId: "next-step" },
    skills: [{ id: "capture-start" }], commands: [{ command: "/capture", agentSkillId: "capture-start", capabilityId: "capture" }] } } as InstalledPlugin;
  let session: EventCaptureSession = { schemaVersion: 1, id: "ba1142db-f861-4dca-8bff-f602d492d8db", pluginId: "fixture.capture", conversationId: "chat-a",
    goal: "记录实际操作", state: "recording", startedAt: new Date(Date.now() - 65_000).toISOString(), endedAt: null, eventCount: 0,
    eventTypes: {}, applications: [], eventsSha256: null, availability: "pending", limitations: [], error: null, ranges: [] };
  const onPrompt = vi.fn(), invoke = vi.fn(async (_pluginId: string, _capability: string, input: any) => {
    const action = input.input.action;
    if (action === "stop" || action === "cancel") session = { ...session, state: action === "stop" ? "ready" : "cancelled", endedAt: new Date().toISOString(),
      eventCount: 3, availability: "available", eventsSha256: "a".repeat(64) };
    const result = { ...session, ...(session.state === "ready" ? { presentation: { message: "插件提供的下一步说明", actions: [{ id: "continue", label: "继续处理", prompt: "$next-step " + session.id }] } } : {}) };
    return { callId: "call", event: { type: "result", output: action === "status" ? { sessions: [result] } : result } };
  });
  const client = { invoke, disable: vi.fn(async () => ({ ...plugin, state: "disabled" })) } as unknown as PluginsClient;
  const render = (conversationId = "chat-a") => act(async () => root.render(<I18nProvider language="zh-CN"><PluginConversationRecording
    client={client} plugins={[plugin]} conversationId={conversationId} onPrompt={onPrompt} /></I18nProvider>));
  const click = async (label: string) => act(async () => [...node.querySelectorAll("button")].find(button => button.textContent === label)!.click());
  const refresh = (patch: Partial<EventCaptureSession>) => act(async () => { session = { ...session, ...patch }; window.dispatchEvent(new Event("memmy:plugins-changed")); });
  return { plugin, client, invoke, onPrompt, render, click, refresh };
}
describe("conversation-owned recording", () => {
  it("shows a saved coverage gap separately from an unconfirmed end boundary", async () => {
    const f = fixture(); await f.render();
    await f.refresh({state: "ready", availability: "partial", endedAt: new Date().toISOString(),
      captureIntegrity: {protocolVersion: 2, coverageComplete: false, boundaryConfirmed: true, snapshotSaved: true, proofSha256: null, gaps: ["navigation_gap"]}});
    expect(node.textContent).toContain("录制已结束并保存，部分网页操作未能确认完整");
    expect(node.textContent).not.toContain("结束确认未完成");
    await f.refresh({captureIntegrity: {protocolVersion: 2, coverageComplete: false, boundaryConfirmed: false, snapshotSaved: true, proofSha256: null, gaps: ["navigation_gap"]}});
    expect(node.textContent).toContain("已保留已收到的事件，结束确认未完成");
  });
  it("keeps teaching-window preparation at zero and shows its browser-only scope after readiness", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.render();
    await f.refresh({ state: "starting", browserCapture: { browser: "chrome", scope: "teaching-window-and-popups" } });
    expect(node.textContent).toContain("正在准备教学窗口");
    expect(node.textContent).toContain("尚未开始录制");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(node.querySelector('[role="timer"]')?.textContent).toBe("00:00");
    expect(node.querySelector('.recording-bar--live')).toBeNull();
    await f.refresh({ state: "recording", startedAt: new Date().toISOString(),
      browserCapture: { browser: "chrome", windowId: 20, scope: "teaching-window-and-popups" } });
    expect(node.textContent).toContain("原有窗口不纳入");
    expect(node.querySelector('.recording-bar--live')).not.toBeNull();
  });
  it("shows an advancing video-style recording bar only for an actual active session and freezes its end time", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.render();
    expect(node.querySelector('.recording-bar--activity.recording-bar--live')).not.toBeNull();
    expect(node.querySelector('[role="timer"]')?.textContent).toBe("01:05");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(node.querySelector('[role="timer"]')?.textContent).toBe("01:07");
    await f.click("结束录制");
    expect(node.querySelector('[role="timer"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(node.querySelector('time')?.textContent).toBe("01:07");
    expect(f.onPrompt).not.toHaveBeenCalled();
  });
  it("shows partial coverage without treating a live recording as stopped", async () => {
    const f = fixture(); await f.render(); await f.refresh({ availability: "partial" });
    expect(node.querySelector('[role="timer"]')).not.toBeNull();
    expect(node.textContent).toContain("采集部分可用");
    expect(node.textContent).not.toContain("录制失败");
    await f.refresh({ state: "failed", endedAt: new Date().toISOString(), error: "capture_source_stopped" });
    expect(node.querySelector('.recording-bar--live')).toBeNull();
    expect(node.querySelector('[role="timer"]')).toBeNull();
    expect(node.textContent).toContain("录制失败");
  });
  it("does not start a timer before a recording exists, and supports recordings longer than an hour", async () => {
    const f = fixture(); f.invoke.mockResolvedValueOnce({ callId: "call", event: { type: "result", output: { sessions: [] } } });
    await f.render(); expect(node.querySelector('[role="timer"]')).toBeNull();
    await f.refresh({ startedAt: new Date(Date.now() - 3665_000).toISOString() });
    expect(node.querySelector('[role="timer"]')?.textContent).toBe("01:01:05");
  });
  it("queries state without contributing polling calls to the conversation", async () => {
    const f = fixture(); await f.render();
    expect(f.invoke).toHaveBeenLastCalledWith("fixture.capture", "capture", expect.objectContaining({ background: true, origin: "user", input: { action: "status" } }));
  });
  it("restores actual recording status, ends capture and waits for a separate generation request", async () => {
    const f = fixture(); await f.render(); expect(node.textContent).toContain("录制中"); expect(node.textContent).toContain("01:05");
    expect(f.invoke.mock.calls.every(([, , input]) => input.input.action === "status")).toBe(true);
    expect(node.querySelector("iframe")).toBeNull();
    await f.click("结束录制"); expect(node.textContent).toContain("插件提供的下一步说明"); expect(node.textContent).toContain("3 条事件");
    expect(f.onPrompt).not.toHaveBeenCalled(); expect(f.invoke.mock.calls.some(([, capability]) => capability === "next_capability")).toBe(false);
    await f.click("继续处理"); expect(f.onPrompt).toHaveBeenCalledWith(expect.stringContaining("$next-step"));
    await f.render(); expect(node.textContent).toContain("录制已结束");
  });
  it("keeps conversations isolated and exposes cancellation without generating a skill", async () => {
    const f = fixture(); await f.render(); await f.click("取消"); expect(node.textContent).toContain("录制已取消");
    expect(node.textContent).not.toContain("继续处理"); expect(f.onPrompt).not.toHaveBeenCalled();
    await f.render("chat-b"); expect(node.textContent).not.toContain("记录实际操作");
    expect(f.invoke).toHaveBeenLastCalledWith("fixture.capture", "capture", expect.objectContaining({ conversationId: "chat-b" }));
  });
  it("reports an unavailable service without showing a fictitious recording", async () => {
    const f = fixture(); f.invoke.mockRejectedValueOnce(new Error("capture_permission_required")); await f.render();
    expect(node.querySelector('[role="alert"]')?.textContent).toContain("capture_permission_required"); expect(node.textContent).not.toContain("录制中");
  });
});
