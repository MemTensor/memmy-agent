import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type LlmConfig } from "../src/config/index.js";
import { ModelHttpError } from "../src/model/http.js";
import { createLlmClient } from "../src/model/llm.js";
import { classifyProcessingError } from "../src/service/worker/job-handlers.js";
import { addAgentSourceImport, createMemoryServiceFixture } from "./fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
afterEach(async () => { await fixture.cleanup(); vi.unstubAllGlobals(); });

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return { ...DEFAULT_MEMMY_CONFIG.summary, provider: "openai_compatible",
    endpoint: "https://opencode.ai/zen/go/v1", model: "test-model", apiKey: "test-key",
    maxRetries: 0, malformedRetries: 0, ...overrides };
}

function mockProvider() {
  const seen: Headers[] = [];
  const mock = vi.fn<typeof fetch>(async (_url, init) => {
    const headers = new Headers(init?.headers);
    seen.push(headers);
    if (!headers.get("x-opencode-session")) return new Response(JSON.stringify({
      error: { message: "Request is missing x-opencode-session", type: "MissingSessionID" }
    }), { status: 400 });
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"title":"Validated task","summary":"The isolated development task was validated."}' }, finish_reason: "stop" }],
      output: [{ type: "message", content: [{ type: "output_text", text: '{"title":"Validated task","summary":"The isolated development task was validated."}' }] }],
      content: [{ type: "text", text: '{"title":"Validated task","summary":"The isolated development task was validated."}' }]
    }), { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return seen;
}

describe("OpenCode Go memory requests", () => {
  it("propagates real worker session identities without mixing concurrent conversations", async () => {
    const seen = mockProvider();
    const { service, db } = fixture.createTestService({ llm: createLlmClient(config()) });
    const namespace = { source: "codex", profileId: "default", userId: "go-worker-user" };
    const sessions = ["conversation-a", "conversation-b"].map(sessionKey => service.openSession({
      namespace: { ...namespace, sessionKey }, workspaceId: "go-worker-workspace"
    }).sessionId);
    const ids = [0, 1, 0].map((sessionIndex, index) => {
      const added = addAgentSourceImport(service, namespace, `Validate isolated worker task ${index}.`, `go-worker-${index}`);
      db.db.prepare("UPDATE evolution_jobs SET session_id = ? WHERE target_memory_id = ?").run(sessions[sessionIndex], added.id);
      db.db.prepare("UPDATE memories SET session_id = ? WHERE id = ?").run(sessions[sessionIndex], added.id);
      return added.id;
    });
    const result = await service.runWorkerOnce(3, { targetMemoryIds: ids });
    expect(result.succeeded).toBe(3);
    expect(seen).toHaveLength(3);
    const counts = new Map<string | null, number>();
    for (const headers of seen) counts.set(headers.get("x-opencode-session"), (counts.get(headers.get("x-opencode-session")) ?? 0) + 1);
    expect(counts.has(null)).toBe(false);
    expect([...counts.values()].sort()).toEqual([1, 2]);
  });

  it.each(["openai_compatible", "openai_responses", "anthropic"] as const)(
    "sends stable conversation headers for %s, including background roles and replacement clients", async provider => {
      const seen = mockProvider();
      for (const sessionId of ["conversation-a", "conversation-b", "conversation-a"]) {
        for (const modelRole of ["memory_summary", "memory_evolution"] as const) {
          await createLlmClient(config({ provider }), { modelRole }).completeJson(
            [{ role: "user", content: "Summarize a completed development task." }],
            { operation: "capture.summarize", sessionId }
          );
        }
      }
      const ids = seen.map(h => h.get("x-opencode-session"));
      expect(ids).toHaveLength(6);
      expect(ids[0]).toBeTruthy();
      expect(ids[0]).toBe(ids[1]);
      expect(ids[2]).toBe(ids[3]);
      expect(ids[0]).not.toBe(ids[2]);
      expect(ids[4]).toBe(ids[0]);
      expect(ids[5]).toBe(ids[0]);
      expect(seen.every(h => h.get("user-agent")?.includes("memmy"))).toBe(true);
    }
  );

  it.each(["x-opencode-session", "X-OpenCode-Session", "X-OPENCODE-SESSION"])(
    "preserves explicitly configured %s without merging another value", async name => {
      const seen = mockProvider();
      await createLlmClient(config({ extraHeaders: { [name]: "ses_explicit", "User-Agent": "custom-client" } }))
        .complete([{ role: "user", content: "run" }], { operation: "capture.summarize", sessionId: "automatic-session" });
      expect(seen[0]!.get("x-opencode-session")).toBe("ses_explicit");
      expect(seen[0]!.get("user-agent")).toBe("custom-client");
    }
  );

  it.each([
    { endpoint: "https://opencode.ai/inference/go/openai/v1" },
    { endpoint: "http://127.0.0.1:18999/go/v1", sourceProvider: "opencode-go" }
  ])("recognizes Go connection %j", async overrides => {
    const seen = mockProvider();
    const client = createLlmClient(config(overrides));
    await client.complete([{ role: "user", content: "run" }], { operation: "capture.summarize" });
    await client.complete([{ role: "user", content: "retry" }], { operation: "capture.summarize" });
    expect(seen[0]!.get("x-opencode-session")).toBeTruthy();
    expect(seen[0]!.get("x-opencode-session")).toBe(seen[1]!.get("x-opencode-session"));
  });

  it.each(["https://api.openai.com/v1", "https://opencode.ai/zen/v1", "https://opencode.ai.evil.test/zen/go/v1"])(
    "does not inject Go headers into unrelated endpoint %s", async endpoint => {
      const mock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })));
      vi.stubGlobal("fetch", mock);
      await createLlmClient(config({ endpoint })).complete([{ role: "user", content: "run" }],
        { operation: "capture.summarize", sessionId: "conversation-a" });
      expect(new Headers(mock.mock.calls[0]![1]!.headers).has("x-opencode-session")).toBe(false);
    }
  );

  it.each([
    "Missing required header: x-opencode-session",
    "Request is missing x-opencode-session and cannot be routed efficiently."
  ])("classifies the missing header as configuration: %s", message => {
    expect(classifyProcessingError(new ModelHttpError(message, "openai_compatible", 400, "MissingSessionID", message)))
      .toEqual({ code: "model_configuration", retryAction: "open_settings" });
  });

  it("keeps unrelated invalid requests and transient errors in their existing categories", () => {
    expect(classifyProcessingError(new ModelHttpError("invalid tools", "openai_compatible", 400, undefined, "invalid tools")))
      .toEqual({ code: "invalid_model_request", retryAction: "none" });
    expect(classifyProcessingError(new ModelHttpError("upstream error", "openai_compatible", 503, undefined, "missing x-opencode-session")))
      .toEqual({ code: "transient_provider_error", retryAction: "retry" });
  });
});
