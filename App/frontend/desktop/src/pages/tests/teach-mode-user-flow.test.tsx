// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginConversationRecording } from "../plugin-conversation-recording.js";
import { PinnedPluginCommandBar } from "../plugin-conversation-controls.js";
import { ApiRequestError } from "../../api/http.js";
import { PLUGIN_CHANGE_EVENT } from "../../lib/plugin-change-event.js";
import type { InstalledPlugin } from "@memmy/local-api-contracts";

const id = "ba1142db-f861-4dca-8bff-f602d492d8db";
const plugin = { id: "teach-mode", version: "1", state: "active", manifest: { name: "Teach Mode",
  conversation: { recordingCapabilityId: "recording", recordingSkillId: "teach-mode-recording", creatorSkillId: "teach-skill-creator" }
} } as InstalledPlugin;
const session = { schemaVersion: 1, id, pluginId: "teach-mode", conversationId: "chat", goal: "演示操作",
  state: "recording", startedAt: "2026-11-26T00:00:00.000Z", endedAt: null, eventCount: 4, eventTypes: {},
  applications: [], eventsSha256: null, availability: "pending", limitations: [], error: null, ranges: [] };
let root: Root, node: HTMLDivElement;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); vi.stubGlobal("EventSource", undefined);
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); delete (window as any).memmy; vi.useRealTimers(); vi.unstubAllGlobals(); });
async function fixture(platform: string, initial: any = session, permissionAlert?: unknown, plugins = [plugin]) {
  (window as any).memmy = { platform };
  let current = initial;
  const client = { disable: vi.fn(async () => undefined), invoke: vi.fn(async (_id: string, _cap: string, request: any) => {
    if (request.input.action === "stop") current = { ...current, state: "ready", availability: "available", endedAt: "2026-11-26T00:01:00.000Z" };
    if (request.input.action === "cancel") current = { ...current, state: "cancelled", availability: "unavailable" };
    return { event: { type: "result", output: request.input.action === "status" ? { sessions: current ? [current] : [], permissionAlert } : current } };
  }) };
  const agentClient = { checkComputerHistoryPermissions: vi.fn(async () => ({ supported: true, accessibility: false, inputMonitoring: false })) };
  const onPrompt = vi.fn(async () => true);
  await act(async () => root.render(<I18nProvider language="zh-CN"><PluginConversationRecording client={client as any}
    plugins={plugins} conversationId="websocket:chat" onPrompt={onPrompt} /></I18nProvider>));
  return { client, agentClient, onPrompt };
}
function button(text: string) { return [...document.querySelectorAll("button")].find(el => el.textContent === text)!; }
for (const platform of ["darwin", "win32"]) {
  it.each(["starting", "recording", "finalizing", "ready", "cancelled", "failed"])(`does not render the removed Teach card for %s on ${platform}`, async state => {
    const { onPrompt } = await fixture(platform, { ...session, state, availability: "available",
      presentation: { message: "旧录制卡片", actions: [{ id: "old", label: "生成 Skill", prompt: "create" }] } });
    expect(node.querySelector("[data-recording-session]")).toBeNull();
    expect(node.textContent).toBe("");
    expect(onPrompt).not.toHaveBeenCalled();
  });
}
it("keeps declared non-Teach status, presentation actions and disable behavior", async () => {
  const other = { ...plugin, id: "other-plugin" };
  const { client, onPrompt } = await fixture("win32", { ...session, pluginId: other.id, state: "ready", availability: "available",
    presentation: { message: "插件自己的结果", actions: [{ id: "continue", label: "继续插件流程", prompt: "继续已声明流程" }] } }, undefined, [other]);
  expect(client.invoke).toHaveBeenCalledWith(other.id, "recording", expect.objectContaining({ background: true, input: { action: "status" } }));
  expect(node.querySelector("[data-recording-session]")).not.toBeNull();
  expect(node.textContent).toContain("插件自己的结果");
  await act(async () => button("继续插件流程").click());
  expect(onPrompt).toHaveBeenCalledWith("继续已声明流程");
  await act(async () => button("停用插件").click());
  expect(client.disable).toHaveBeenCalledWith(other.id);
  expect(node.querySelector("[data-recording-session]")).toBeNull();
});
it.each(["plugin_unavailable", "plugin_permission_denied"] as const)("refreshes plugin state without exposing %s in the conversation", async code => {
  const { client } = await fixture("darwin");
  const changed = vi.fn(); window.addEventListener(PLUGIN_CHANGE_EVENT, changed);
  try {
    client.invoke.mockRejectedValue(new ApiRequestError("Plugin is not active", 409, code));
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(changed).toHaveBeenCalledOnce();
    expect(node.querySelector('[role="alert"]')).toBeNull();
  } finally { window.removeEventListener(PLUGIN_CHANGE_EVENT, changed); }
});
it("does not restore the removed macOS permission card when the backend reports missing grants", async () => {
  const { agentClient, onPrompt } = await fixture("darwin", null, { required: ["accessibility"] });
  expect(node.querySelector(".teach-permission-card")).toBeNull();
  expect(node.textContent).toBe("");
  expect(agentClient.checkComputerHistoryPermissions).not.toHaveBeenCalled();
  expect(onPrompt).not.toHaveBeenCalled();
});
it("does not check macOS permissions on Windows, even with a stale alert", async () => {
  const { agentClient } = await fixture("win32", session, { required: ["accessibility"] });
  expect(node.querySelector(".teach-permission-card")).toBeNull();
  expect(agentClient.checkComputerHistoryPermissions).not.toHaveBeenCalled();
  expect(node.querySelector("[data-recording-session]")).toBeNull();
});
it("uses each declared conversation shortcut, not the listening entry", async () => {
  const onPress = vi.fn(), onRecordingPress = vi.fn();
  const command = { command: "/teach", name: "Teach", capabilityId: "recording", topbar: true };
  await act(async () => root.render(<PinnedPluginCommandBar targets={[
    { plugin, command },
    { plugin: { ...plugin, id: "other-plugin" }, command: { ...command, command: "/other", name: "Other" } },
    { plugin: { ...plugin, id: "legal-labor", manifest: { ...plugin.manifest, conversation: undefined } }, command: { ...command, command: "/legal-record", name: "听记" } }
  ]} disabled={false} recordingOpen={false} active={new Set()} onPress={onPress} onRecordingPress={onRecordingPress} />));
  await act(async () => button("Teach").click());
  await act(async () => button("Other").click());
  expect(onPress).toHaveBeenCalledTimes(2); expect(onRecordingPress).not.toHaveBeenCalled();
  await act(async () => button("听记").click());
  expect(onRecordingPress).toHaveBeenCalledOnce();
});
