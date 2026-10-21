import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ markOcu: vi.fn(), construct: vi.fn() }));
vi.mock("../../../src/tools/computer-recordings/session-service.js", () => ({
  RecordingSessionService: class {
    constructor() { mocks.construct(); }
    markOcu = mocks.markOcu;
  },
}));
vi.mock("../../../src/tools/computer-recordings/windows-driver.js", () => ({ WindowsTaskRecordingDriver: class {} }));
vi.mock("../../../src/tools/computer-recordings/macos-driver.js", () => ({ MacTaskRecordingDriver: class {} }));
vi.mock("../../../src/tools/computer-history/computer-history-api.js", () => ({ getComputerHistoryDemoService: () => ({ recorderBusy: false }) }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
describe("recording CU timeline bridge", () => {
  it("does not create a recorder for an ordinary CU call", async () => {
    const { markRecordingOcu } = await import("../../../src/tools/computer-recordings/service.js");
    markRecordingOcu("websocket:chat", "turn", "mcp_memmy_computer_use_click", "started");
    expect(mocks.construct).not.toHaveBeenCalled();
    expect(mocks.markOcu).not.toHaveBeenCalled();
  });
  it.each(["mcp_memmy_computer_use_click", "mcp_open_computer_use_click"])("forwards %s to the active run", async (tool) => {
    const { getRecordingSessionService, markRecordingOcu } = await import("../../../src/tools/computer-recordings/service.js");
    getRecordingSessionService();
    markRecordingOcu("websocket:chat", "turn", tool, "started");
    markRecordingOcu("websocket:chat", "turn", tool, "finished");
    expect(mocks.markOcu.mock.calls).toEqual([
      ["chat", tool, "started", "turn"], ["chat", tool, "finished", "turn"],
    ]);
  });
  it("ignores unrelated tools and calls without a recording run or websocket session", async () => {
    const { getRecordingSessionService, markRecordingOcu } = await import("../../../src/tools/computer-recordings/service.js");
    getRecordingSessionService();
    markRecordingOcu("websocket:chat", "turn", "exec", "finished");
    markRecordingOcu(null, null, "mcp_memmy_computer_use_click", "started");
    expect(mocks.markOcu).not.toHaveBeenCalled();
  });
});
