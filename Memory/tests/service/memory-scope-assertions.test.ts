import { afterEach, describe, expect, it } from "vitest";
import { createMemoryServiceFixture, createBatchReflectionLlm } from "../fixtures/memory-service-fixture.js";
import { MemoryServiceError } from "../../src/utils/error.js";
import type { RuntimeNamespace } from "../../src/types.js";

const fixture = createMemoryServiceFixture();
const { createTestService } = fixture;

const nsAlice: RuntimeNamespace = {
  source: "codex",
  profileId: "profile-alice",
  userId: "scope-user-alice"
};

const nsBob: RuntimeNamespace = {
  source: "codex",
  profileId: "profile-bob",
  userId: "scope-user-bob"
};

function caughtError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectOutOfScope(fn: () => unknown): void {
  const error = caughtError(fn);
  expect(error).toBeInstanceOf(MemoryServiceError);
  expect((error as MemoryServiceError).code).toBe("forbidden");
}

afterEach(() => {
  fixture.cleanup();
});

describe("memory/episode/raw-turn scope assertions", () => {
  it("rejects cross-namespace archive and delete of generic memories", () => {
    const { service } = createTestService({ llm: createBatchReflectionLlm([]) });

    const archived = service.addMemory({
      namespace: nsAlice,
      adapterId: "codex-memory",
      requestId: "scope-archive-1",
      layer: "L1",
      content: "alice memory for archive scope check"
    });
    expect(archived.id).toBeTruthy();
    expectOutOfScope(() => service.archiveMemory(archived.id, { namespace: nsBob }));
    expect(service.archiveMemory(archived.id, { namespace: nsAlice }).status).toBe("archived");

    const deleted = service.addMemory({
      namespace: nsAlice,
      adapterId: "codex-memory",
      requestId: "scope-delete-1",
      layer: "L1",
      content: "alice memory for delete scope check"
    });
    expectOutOfScope(() => service.deleteMemory(deleted.id, { namespace: nsBob }));
    expect(service.deleteMemory(deleted.id, { namespace: nsAlice }).status).toBe("deleted");
  });

  it("rejects memory delete when namespace carries a different projectId", () => {
    const { service } = createTestService({ llm: createBatchReflectionLlm([]) });
    const nsProjectA: RuntimeNamespace = { ...nsAlice, projectId: "proj-alpha" };

    const memory = service.addMemory({
      namespace: nsProjectA,
      adapterId: "codex-memory",
      requestId: "scope-project-1",
      layer: "L1",
      content: "alice project memory"
    });

    expectOutOfScope(() => service.deleteMemory(memory.id, { namespace: { ...nsProjectA, projectId: "proj-beta" } }));
    expect(service.deleteMemory(memory.id, { namespace: nsProjectA }).status).toBe("deleted");
  });

  it("keeps whole-store semantics when the request carries no namespace", () => {
    const { service } = createTestService({ llm: createBatchReflectionLlm([]) });

    const memory = service.addMemory({
      namespace: nsAlice,
      adapterId: "codex-memory",
      requestId: "scope-no-namespace-1",
      layer: "L1",
      content: "alice memory deleted without namespace"
    });

    expect(service.deleteMemory(memory.id, {}).status).toBe("deleted");
  });

  it("rejects cross-namespace episode delete and raw-turn redaction", () => {
    const { service } = createTestService({ llm: createBatchReflectionLlm([]) });

    const session = service.openSession({
      namespace: nsAlice,
      sessionId: "codex-memory-agent:scope-session"
    });
    const turn = service.completeTurn("turn-scope-1", {
      sessionId: session.sessionId,
      namespace: nsAlice,
      query: "remember the scope probe",
      answer: "the scope probe is stored"
    });
    expect(turn.episodeId).toBeTruthy();
    expect(turn.rawTurnId).toBeTruthy();

    expectOutOfScope(() => service.redactRawTurn(turn.rawTurnId, { namespace: nsBob }));
    expect(service.redactRawTurn(turn.rawTurnId, { namespace: nsAlice }).ok).toBe(true);

    expectOutOfScope(() => service.deletePanelTask(turn.episodeId, { namespace: nsBob }));
    expect(service.deletePanelTask(turn.episodeId, { namespace: nsAlice }).ok).toBe(true);
  });
});
