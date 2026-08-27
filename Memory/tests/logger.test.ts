import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryLogger, memoryErrorFields } from "../src/logging/logger.js";

const originalLogLevel = process.env.MEMMY_LOG_LEVEL;

afterEach(() => {
  if (originalLogLevel === undefined) {
    delete process.env.MEMMY_LOG_LEVEL;
  } else {
    process.env.MEMMY_LOG_LEVEL = originalLogLevel;
  }
  vi.restoreAllMocks();
});

describe("Memory structured logger", () => {
  it("writes JSON lines with only timestamp, level, and a readable message", () => {
    process.env.MEMMY_LOG_LEVEL = "info";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    createMemoryLogger("worker").info("job.succeeded", {
      jobId: "job-1",
      jobType: "skill_crystallization"
    });

    const record = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(record).toEqual({
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      level: "info",
      message: expect.stringContaining("[skill.crystallize] 任务成功，jobId=job-1")
    });
    expect(Object.keys(record)).toEqual(["timestamp", "level", "message"]);
  });

  it("redacts credentials in fields and error messages", () => {
    process.env.MEMMY_LOG_LEVEL = "error";
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    createMemoryLogger("llm").error("request.failed", {
      apiKey: "secret-value",
      ...memoryErrorFields(new Error("Authorization: Bearer abc.def and sk-secret1234"))
    });

    const line = String(write.mock.calls[0]?.[0]);
    expect(line).not.toContain("secret-value");
    expect(line).not.toContain("abc.def");
    expect(line).not.toContain("sk-secret1234");
    expect(line).toContain("[redacted]");
  });

  it("honors MEMMY_LOG_LEVEL", () => {
    process.env.MEMMY_LOG_LEVEL = "warn";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    createMemoryLogger("worker").info("job.succeeded");

    expect(write).not.toHaveBeenCalled();
  });

  it("includes memory context when summary falls back to the evolution model", () => {
    process.env.MEMMY_LOG_LEVEL = "warn";
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    createMemoryLogger("pipeline").warn("summary.fallback_started", {
      operation: "capture.summarize",
      sourceMemoryId: "trace_test",
      episodeId: "episode_test",
      primaryModel: "memory_summary",
      fallbackModel: "memory_evolution",
      errorMessage: "HTTP 405"
    });

    const line = String(write.mock.calls[0]?.[0]);
    expect(line).toContain("trace_test");
    expect(line).toContain("episode_test");
    expect(line).toContain("primaryModel=memory_summary");
    expect(line).toContain("fallbackModel=memory_evolution");
    expect(line).toContain("HTTP 405");
  });
});
