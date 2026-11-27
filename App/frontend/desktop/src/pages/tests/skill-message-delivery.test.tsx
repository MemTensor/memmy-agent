// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginUiProvider, type PluginUiCall } from "../../app/plugin-ui-context.js";
import { PluginCapabilityHost, selectVisiblePluginCalls } from "../plugin-capability-host.js";
import { AgentThreadMessages } from "../agent-thread-messages.js";
import { collectThreadArtifacts } from "../agent-thread-panel-model.js";
import type { AgentChatMessage } from "../../state/agent-chat-slice.js";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows no standalone card after the tool, and shows the main file only when the model attaches it", async () => {
  const path = "/workspace/outputs/teach-mode/chat/note/SKILL.md";
  const call: PluginUiCall = { pluginId: "teach-mode", capabilityId: "create_skill", callId: "save", conversationId: "chat", origin: "agent",
    events: ["note/references/source.json", "note/references/teaching-gaps.json", "note/references/events.jsonl", "note/SKILL.md"].map(name => ({
      type: "artifact" as const, artifact: { id: name, name, role: "deliverable" as const, mediaType: "text/plain", uri: "/preview", path: `/workspace/outputs/teach-mode/chat/${name}` }
    })) };
  call.events.push({ type: "result", output: { saved: true, skillFile: path } });
  expect(selectVisiblePluginCalls([call])).toEqual([]);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const preview = vi.fn(() => true);
  const message: AgentChatMessage = { id: "reply", role: "assistant", content: "已保存", createdAt: "2026-11-25T00:00:00Z" };
  const render = async (messages: AgentChatMessage[]) => act(async () => root.render(<PluginUiProvider><I18nProvider language="zh-CN">
    <PluginCapabilityHost calls={selectVisiblePluginCalls([call])} plugins={[]} client={{ getUi: vi.fn(), cancel: vi.fn(), respond: vi.fn() } as any} />
    <AgentThreadMessages messages={messages} chatScopeKey="chat" onPreviewFile={preview} />
  </I18nProvider></PluginUiProvider>));
  try {
    await render([]); expect(container.querySelectorAll(".agent-delivered-file")).toHaveLength(0);
    await render([message]); expect(container.querySelectorAll(".agent-delivered-file")).toHaveLength(0);
    const attached = { ...message, media: [{ kind: "file" as const, name: "SKILL.md", path }] };
    await render([attached]);
    expect(container.querySelectorAll(".agent-delivered-file")).toHaveLength(1);
    expect(collectThreadArtifacts([attached])).toEqual([expect.objectContaining({ path, name: "SKILL.md" })]);
    await act(async () => (container.querySelector(".agent-delivered-file button") as HTMLButtonElement).click());
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ path }));
    await render([JSON.parse(JSON.stringify(attached))]);
    expect(container.querySelectorAll(".agent-delivered-file")).toHaveLength(1);
  } finally { act(() => root.unmount()); container.remove(); }
});
