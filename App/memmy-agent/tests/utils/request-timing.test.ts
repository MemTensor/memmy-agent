import { afterEach, expect, it, vi } from "vitest";
import { requestTiming, withRequestTiming } from "../../src/utils/request-timing.js";
import { createApp } from "../../src/entrypoints/openai-like-api/server.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("keeps concurrent request timings separate and excludes prompt and invalid trace input", async () => {
  vi.stubEnv("MEMMY_TIMING_LOG", "1");
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => { lines.push(String(chunk)); return true; });
  await Promise.all(["trace-a", "trace-b"].map((id) => withRequestTiming(id, async () => {
    await Promise.resolve();
    requestTiming("model.first_chunk", true);
    requestTiming("model.first_chunk", true);
  })));
  const records = lines.map((line) => JSON.parse(line.slice(15)));
  for (const id of ["trace-a", "trace-b"]) {
    expect(records.filter((row) => row.traceId === id).map((row) => row.stage)).toEqual(["api.received", "model.first_chunk"]);
  }
  withRequestTiming("Bearer secret\nprompt", () => requestTiming("api.finished"));
  expect(lines.join("")).not.toMatch(/secret|prompt/);
  vi.stubEnv("MEMMY_TIMING_LOG", "0");
  const count = lines.length;
  withRequestTiming("disabled", () => requestTiming("api.finished"));
  expect(lines).toHaveLength(count);
});

it("retains the trace through an SSE response without logging its content", async () => {
  vi.stubEnv("MEMMY_TIMING_LOG", "1");
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => { lines.push(String(chunk)); return true; });
  const app = createApp({ processDirect: async (args: any) => {
    await Promise.resolve();
    requestTiming("model.http_start");
    await args.onStream("private reply");
    return "private reply";
  } }, "test");
  const response = await app.fetch(new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", "x-memmy-trace-id": "trace-sse" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "private prompt" }] }),
  }));
  expect(await response.text()).toContain("private reply");
  const records = lines.map((line) => JSON.parse(line.slice(15)));
  expect(records.map((row) => row.stage)).toEqual([
    "api.received", "api.session_lock_acquired", "model.http_start", "api.first_content", "api.finished",
  ]);
  expect(records.every((row) => row.traceId === "trace-sse" && row.elapsedMs >= 0)).toBe(true);
  expect(lines.join("")).not.toContain("private");
});
