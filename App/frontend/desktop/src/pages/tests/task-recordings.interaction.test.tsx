// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { RecordingSessionSchema } from "@memmy/local-api-contracts";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { TaskRecordingsPanel, AgentTaskRecordingOption, ActiveRecordingBar } from "../memory/task-recordings.js";
import { submitAgentComposerMessage } from "../home-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const session = RecordingSessionSchema.parse({ schemaVersion: 1, id: "2e887c14-ef13-48f3-b9b1-2efbc1e89537", title: "Example recording", platform: "windows",
  source: "human", state: "ready", createdAt: "2026-10-13T00:00:00Z", stoppedAt: "2026-10-13T00:00:10Z", durationMs: 10000,
  applications: ["C:\\Apps\\Fixture.exe"], agent: null, pinned: false, videoIntegrity: "complete", timelineCompleteness: "complete", taskEndReason: "user_stopped", error: null,
  qpc: { origin: "1000000", frequency: "10000" }, video: { mediaId: "recording", width: 1920, height: 1080, fps: 15, audio: false },
  parts: [], gaps: [], privacy: { rawVisibleFrames: true, audio: false, localOnly: true, retentionHours: 48 } });
let root: Root, container: HTMLDivElement;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === text)!;
const render = async (node: React.ReactNode) => { await act(async () => root.render(<I18nProvider language="zh-CN">{node}</I18nProvider>)); };
function client() {
  const api = { list: vi.fn().mockResolvedValue({ recordings: [] }), start: vi.fn().mockResolvedValue(session),
    configuration: vi.fn().mockResolvedValue({ platform: "macos", supported: true, minimumSystemVersion: "12.3",
      permissions: { screenRecording: true, accessibility: true, inputMonitoring: true }, applications: [
        { id: "test.memmy.Editor", name: "Mac Editor", running: true, supported: true, allowed: true },
        { id: "com.apple.Safari", name: "Safari", running: true, supported: false, allowed: true },
        { id: "test.memmy.Blocked", name: "Blocked", running: true, supported: true, allowed: false },
      ] }), openPermission: vi.fn(),
    control: vi.fn().mockResolvedValue(session), pin: vi.fn().mockResolvedValue(session), delete: vi.fn().mockResolvedValue({ deleted: true }),
    events: vi.fn().mockResolvedValue({ events: [{ id: "1", sequence: 1, timeMs: 1500, timestamp: "2026-10-13T00:00:01.500Z", origin: "native", type: "mouse_click", window: null }], nextCursor: null }),
    mediaUrl: vi.fn(() => `memmy-recording://recording/${session.id}/video?media=recording`) };
  const value = { recordings: api, getWindowsHistoryConfiguration: vi.fn().mockResolvedValue({ applications: [
    { executable: "C:\\Apps\\Fixture.exe", name: "Fixture", running: true, supported: true, allowed: true },
    { executable: "C:\\Apps\\chrome.exe", name: "Browser", running: true, supported: false, allowed: false },
  ] }) } as unknown as MemmyAgentClient;
  return { value, api };
}
beforeEach(() => { window.memmy = { platform: "win32" } as typeof window.memmy; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); Reflect.deleteProperty(window, "memmy"); });
async function consent() {
  const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(boxes).toHaveLength(2);
  await act(async () => { boxes[0]!.click(); boxes[1]!.click(); });
}
describe("task recording product controls", () => {
  it("requires application selection and raw-video consent before starting a human demonstration", async () => {
    const { value, api } = client();
    await render(<TaskRecordingsPanel client={value} human />);
    expect(api.start).not.toHaveBeenCalled();
    await act(async () => button("开始示范录制").click());
    expect(document.body.textContent).toContain("视频保留原始可见画面");
    expect(document.body.textContent).not.toContain("Browser");
    expect(button("开始录制").disabled).toBe(true);
    await consent(); expect(button("开始录制").disabled).toBe(false);
    await act(async () => button("开始录制").click());
    expect(api.start).toHaveBeenCalledExactlyOnceWith({ title: "任务录制", applications: ["C:\\Apps\\Fixture.exe"], consent: true });
  });
  it.each(["win32", "darwin"])("keeps Agent recording consent on one submitted message on %s without starting capture from the composer", async (platform) => {
    window.memmy = { platform } as typeof window.memmy;
    const { value, api } = client(); const change = vi.fn();
    await render(<AgentTaskRecordingOption client={value} value={null} onChange={change} />);
    await act(async () => button("录制本次执行").click()); await consent(); await act(async () => button("确认录制范围").click());
    expect(api.start).not.toHaveBeenCalled(); const taskRecording = change.mock.calls[0]![0];
    const submitMessage = vi.fn().mockResolvedValue({ status: "queued" });
    expect(await submitAgentComposerMessage({ chatId: "chat-1", content: "Do the task", taskRecording,
      connection: { getReadyGeneration: () => 1, newChat: vi.fn(), submitMessage }, pendingAttachments: [], uploadAgentMedia: vi.fn(),
      dispatch: vi.fn(), track: vi.fn(), clearComposer: vi.fn() })).toBe(true);
    expect(submitMessage.mock.calls[0]![0]).toMatchObject({ chatId: "chat-1", taskRecording });
    expect(api.start).not.toHaveBeenCalled();
  });
  it.each(["win32", "darwin"])("seeks a video on %s when an input event is clicked and provides token-free downloads", async (platform) => {
    window.memmy = { platform } as typeof window.memmy;
    const { value, api } = client(); api.list.mockResolvedValue({ recordings: [session] });
    await render(<TaskRecordingsPanel client={value} human />); await act(async () => button("视频回看").click());
    const video = document.querySelector("video")!;
    expect(video.getAttribute("src")).toBe(`memmy-recording://recording/${session.id}/video?media=recording`);
    const event = document.querySelector<HTMLButtonElement>(".task-recordings__timeline button")!;
    await act(async () => event.click()); expect(video.currentTime).toBe(1.5);
    const speed = document.querySelector<HTMLSelectElement>(".task-recordings__player select")!;
    await act(async () => { speed.value = "2"; speed.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(video.playbackRate).toBe(2);
    expect(document.querySelector<HTMLAnchorElement>("a[download]")!.href).not.toContain("token");
    expect(api.control).not.toHaveBeenCalled();
  });
  it.each(["win32", "darwin"])("keeps pause and stop visible globally while recording on %s", async (platform) => {
    window.memmy = { platform } as typeof window.memmy;
    const { value, api } = client(); api.list.mockResolvedValue({ recordings: [{ ...session, state: "recording" }] });
    await render(<ActiveRecordingBar client={value} />);
    expect(document.body.textContent).toContain("停止录制不会停止 Agent");
    expect(document.body.textContent).toContain(platform === "darwin" ? "⌃ + ⌥ + ⌘ + R" : "Ctrl + Alt + Shift + R");
    await act(async () => button("停止录制").click()); expect(api.control).toHaveBeenCalledExactlyOnceWith(session.id, "stop");
  });
  it("blocks macOS capture until system permissions, application scope and fresh raw-video consent are all present", async () => {
    window.memmy = { platform: "darwin" } as typeof window.memmy;
    const { value, api } = client(); const configuration = await api.configuration();
    api.configuration.mockResolvedValue({ ...configuration, permissions: { ...configuration.permissions, screenRecording: false } });
    api.openPermission.mockResolvedValue(configuration);
    await render(<TaskRecordingsPanel client={value} human />); await act(async () => button("开始示范录制").click());
    expect(document.body.textContent).toContain("macOS 录制权限");
    expect(document.body.textContent).toContain("Mac Editor"); expect(document.body.textContent).not.toContain("Safari"); expect(document.body.textContent).not.toContain("Blocked");
    expect(value.getWindowsHistoryConfiguration).not.toHaveBeenCalled(); expect(api.openPermission).not.toHaveBeenCalled();
    await consent(); expect(button("开始录制").disabled).toBe(true);
    await act(async () => button("申请授权").click());
    expect(api.openPermission).toHaveBeenCalledExactlyOnceWith("screenRecording", "request");
    expect(button("开始录制").disabled).toBe(false);
    await act(async () => button("开始录制").click());
    expect(api.start).toHaveBeenCalledExactlyOnceWith({ title: "任务录制", applications: ["test.memmy.Editor"], consent: true });
  });
  it("rechecks macOS settings on return while keeping the current application selection and consent", async () => {
    window.memmy = { platform: "darwin" } as typeof window.memmy;
    const { value, api } = client(); const configuration = await api.configuration();
    api.configuration.mockResolvedValueOnce({ ...configuration, permissions: { ...configuration.permissions, accessibility: false } }).mockResolvedValue(configuration);
    api.openPermission.mockResolvedValue({ ...configuration, permissions: { ...configuration.permissions, accessibility: false } });
    await render(<TaskRecordingsPanel client={value} human />); await act(async () => button("开始示范录制").click()); await consent();
    expect(button("开始录制").disabled).toBe(true);
    await act(async () => button("打开系统设置").click()); expect(api.openPermission).toHaveBeenCalledExactlyOnceWith("accessibility", "settings");
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(button("开始录制").disabled).toBe(false); expect(api.start).not.toHaveBeenCalled();
  });
  it("explains the minimum macOS version and keeps recording disabled on an unsupported system", async () => {
    window.memmy = { platform: "darwin" } as typeof window.memmy;
    const { value, api } = client(); const configuration = await api.configuration();
    api.configuration.mockResolvedValue({ ...configuration, supported: false });
    await render(<TaskRecordingsPanel client={value} human />); await act(async () => button("开始示范录制").click()); await consent();
    expect(document.body.textContent).toContain("macOS 12.3 或更新版本"); expect(button("开始录制").disabled).toBe(true); expect(api.start).not.toHaveBeenCalled();
  });
});
