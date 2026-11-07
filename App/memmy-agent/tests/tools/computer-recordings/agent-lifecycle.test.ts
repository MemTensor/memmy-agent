import { beforeEach, describe, expect, it, vi } from "vitest";
const service = vi.hoisted(() => ({ start: vi.fn(), control: vi.fn(), claimAgentMessage: vi.fn() }));
vi.mock("../../../src/tools/computer-recordings/service.js", () => ({ getRecordingSessionService: () => service }));
import { startAgentRecording, finishAgentRecording } from "../../../src/tools/computer-recordings/agent-lifecycle.js";
const choice = { title: "Agent demonstration", applications: ["C:\\Apps\\Fixture.exe"], consent: true };
beforeEach(() => { vi.resetAllMocks(); service.claimAgentMessage.mockResolvedValue(true); });
describe("Agent recording isolation", () => {
  it("does not restart recording when the Agent recovers the same message", async () => {
    service.claimAgentMessage.mockResolvedValue(false);
    expect(await startAgentRecording({ runId: "backend-run-1", chatId: "chat", messageId: "message", metadata: { task_recording: choice }, notify: vi.fn() })).toBeNull();
    expect(service.start).not.toHaveBeenCalled();
  });
  it("does nothing without an explicit choice on this message", async () => {
    expect(await startAgentRecording({ runId: "backend-run-1", chatId: "chat", messageId: "message", metadata: {}, notify: vi.fn() })).toBeNull();
    expect(service.start).not.toHaveBeenCalled();
  });
  it("creates the run binding on actual start and preserves it if notification delivery fails", async () => {
    service.start.mockResolvedValue({ id: "recording", state: "recording" });
    expect(await startAgentRecording({ runId: "backend-run-1", chatId: "chat", messageId: "message", metadata: { task_recording: choice }, notify: vi.fn().mockRejectedValue(new Error("socket closed")) })).toBe("recording");
    expect(service.start.mock.calls[0]![1]).toMatchObject({ chatId: "chat", messageId: "message", runId: "backend-run-1" });
  });
  it("reports failed recording without throwing into task execution or retrying capture", async () => {
    service.start.mockRejectedValue(new Error("capture unavailable")); const notify = vi.fn().mockResolvedValue(undefined);
    expect(await startAgentRecording({ runId: "backend-run-1", chatId: "chat", messageId: "message", metadata: { task_recording: choice }, notify })).toBeNull();
    expect(service.start).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledWith({ recording_state: "failed", recording_error: "recording_not_started" });
  });
  it("finishes and cancels recording independently of Agent errors", async () => {
    service.control.mockRejectedValue(new Error("disk failure"));
    await expect(finishAgentRecording("recording", true)).resolves.toBeUndefined();
    expect(service.control).toHaveBeenCalledWith("recording", "stop", "cancelled");
    await expect(finishAgentRecording("recording", false)).resolves.toBeUndefined();
    expect(service.control).toHaveBeenLastCalledWith("recording", "stop", "completed");
  });
});
