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
      message: expect.stringContaining("[skill.crystallize] Job succeeded, jobId=job-1")
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

  it.each([
    ["info", "job.started"],
    ["info", "job.succeeded"],
    ["error", "job.failed"],
    ["info", "embedding_retry.succeeded"],
    ["warn", "embedding_retry.retry_scheduled"],
    ["error", "embedding_retry.failed"]
  ] as const)("preserves scheduling identity in %s %s output", (level, event) => {
    process.env.MEMMY_LOG_LEVEL = "info";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    createMemoryLogger("worker")[level](event, {
      jobId: "job-1",
      retryId: "retry-1",
      queueLane: "repair_retry",
      enqueueSeq: 17,
      attempt: 1,
      maxAttempts: 3,
      errorMessage: "Authorization: Bearer abc.def",
      apiKey: "secret-value",
      content: "private memory content"
    });

    const stream = level === "info" ? stdout : stderr;
    const otherStream = level === "info" ? stderr : stdout;
    expect(stream).toHaveBeenCalledTimes(1);
    expect(otherStream).not.toHaveBeenCalled();
    const record = JSON.parse(String(stream.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(Object.keys(record)).toEqual(["timestamp", "level", "message"]);
    expect(record.level).toBe(level);
    expect(record.message).toContain("queueLane=repair_retry");
    expect(record.message).toContain("enqueueSeq=17");
    expect(record.message).not.toContain("abc.def");
    expect(record.message).not.toContain("secret-value");
    expect(record.message).not.toContain("private memory content");
  });

  it("includes the actual scheduler and WRR weights in drain output", () => {
    process.env.MEMMY_LOG_LEVEL = "info";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const laneWeights = { interactive: 4, repair_retry: 3, import: 2, evolution: 2, maintenance: 1 };

    createMemoryLogger("worker").info("drain.completed", {
      algorithm: "wrr",
      laneWeights,
      leased: 4,
      succeeded: 4,
      failed: 0,
      embeddingRetriesLeased: 2,
      embeddingRetriesSucceeded: 2,
      embeddingRetriesFailed: 0
    });

    const record = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(Object.keys(record)).toEqual(["timestamp", "level", "message"]);
    expect(record.message).toContain("algorithm=wrr");
    expect(record.message).toContain("laneWeights=interactive:4|repair_retry:3|import:2|evolution:2|maintenance:1");
    expect(record.message).toContain("leased=4, succeeded=4, failed=0");
    expect(record.message).toContain("embeddingRetriesLeased=2");
  });

  it("keeps legacy drain output concise and sanitizes scheduler fields", () => {
    process.env.MEMMY_LOG_LEVEL = "info";
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createMemoryLogger("worker");
    logger.info("drain.completed", { algorithm: "legacy", leased: 1 });
    logger.info("drain.completed", {
      algorithm: "wrr",
      laneWeights: { interactive: 4, apiKey: "nested-secret" },
      content: "private memory content"
    });

    const legacy = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(legacy.message).toContain("algorithm=legacy");
    expect(legacy.message).not.toContain("laneWeights=");
    const sanitized = String(write.mock.calls[1]?.[0]);
    expect(sanitized).toContain("[redacted]");
    expect(sanitized).not.toContain("nested-secret");
    expect(sanitized).not.toContain("private memory content");
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

  it("uses English for built-in log messages", () => {
    process.env.MEMMY_LOG_LEVEL = "debug";
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const events: Array<[string, string]> = [
      ["embedding", "request.started"],
      ["llm", "request.started"],
      ["http", "request.succeeded"],
      ["embedding", "request.succeeded"],
      ["llm", "request.succeeded"],
      ["model-http", "request.retry_scheduled"],
      ["http", "request.rejected"],
      ["llm", "request.rejected"],
      ["http", "request.failed"],
      ["embedding", "request.failed"],
      ["model-http", "request.failed"],
      ["llm", "request.failed"],
      ["llm", "json.truncated_retry"],
      ["llm", "json.malformed_retry"],
      ["llm", "json.recovered"],
      ["llm", "json.failed"],
      ["worker", "job.started"],
      ["worker", "job.succeeded"],
      ["worker", "job.failed"],
      ["worker", "embedding_retry.succeeded"],
      ["worker", "embedding_retry.retry_scheduled"],
      ["worker", "embedding_retry.failed"],
      ["worker", "drain.completed"],
      ["worker", "drain.failed"],
      ["worker", "startup.reconciliation_failed"],
      ["pipeline", "generation.skipped"],
      ["pipeline", "gate.skipped"],
      ["pipeline", "fallback.used"],
      ["pipeline", "summary.fallback_started"],
      ["pipeline", "summary.fallback_succeeded"],
      ["pipeline", "summary.fallback_failed"],
      ["pipeline", "batch_window.failed"],
      ["memory-service", "initialized"],
      ["memory-service", "config.reloaded"],
      ["memory-service", "service.starting"],
      ["memory-service", "service.startup_stage"],
      ["memory-service", "service.listening"],
      ["memory-service", "service.fatal"],
      ["memory-service", "config.endpoint_write_failed"],
      ["storage", "storage.startup_stage"]
    ];

    for (const [component, event] of events) {
      createMemoryLogger(component).info(event, {
        attempt: 1,
        delayMs: 100,
        errorMessage: "test error",
        path: "/health",
        phase: "storage.opening",
        elapsedMs: 42,
        status: 200
      });
    }

    const output = stdoutWrite.mock.calls.map(([line]) => String(line)).join("");
    expect(output).toContain("HTTP request succeeded");
    expect(output).toContain("HTTP request rejected");
    expect(output).toContain("HTTP request failed");
    expect(output).toContain("Memory service startup stage");
    expect(output).toContain("Memory storage startup stage");
    expect(output).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
