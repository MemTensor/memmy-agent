import { describe, expect, it, vi, afterEach } from "vitest";
import { stopTaskRecordingBeforeExit } from "../src/main/task-recording-exit.js";
afterEach(() => vi.unstubAllGlobals());
describe("task video exit drain", () => {
  it("extends the shutdown deadline only for an active video and waits for sealing", async () => {
    let finish!: (response: Response) => void;
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response('{"token":"fixture-token"}'))
      .mockResolvedValueOnce(new Response('{"recordings":[{"state":"finalizing"}]}'))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchFn); const onActive = vi.fn();
    let complete = false;
    const closing = stopTaskRecordingBeforeExit({ baseUrl: "http://127.0.0.1:1", bootstrapSecret: "fixture-secret" }, onActive).then(() => { complete = true; });
    await vi.waitFor(() => expect(onActive).toHaveBeenCalledOnce());
    expect(complete).toBe(false); expect(String(fetchFn.mock.calls[2]![0])).toContain("/api/computer-recordings/active/stop");
    finish(new Response('{"stopped":true}')); await closing; expect(complete).toBe(true);
  });
  it("leaves the existing quit deadline alone when no task video is active", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(new Response('{"token":"fixture-token"}')).mockResolvedValueOnce(new Response('{"recordings":[{"state":"ready"}]}'));
    vi.stubGlobal("fetch", fetchFn); const onActive = vi.fn();
    await stopTaskRecordingBeforeExit({ baseUrl: "http://127.0.0.1:1", bootstrapSecret: "fixture-secret" }, onActive);
    expect(onActive).not.toHaveBeenCalled(); expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
