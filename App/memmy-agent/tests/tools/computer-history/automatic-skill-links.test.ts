import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { HistoryMemoryAdapter } from "../../../src/tools/computer-history/memory-adapter.js";

vi.mock("../../../src/memmy-memory/discovery.js", () => ({
  discoverMemmyMemoryConnection: () => ({ baseUrl: "http://127.0.0.1:17345" }),
  discoverMemmyMemoryUserId: () => "local-user"
}));

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

test.each(["com.apple.TextEdit", "win32.notepad"])(
  "the shared adapter links automatic Skills for %s and respects remote deletion",
  async (application) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "history-auto-skill-"));
    roots.push(root);
    const ids = ["first-10min-summary", "second-10min-summary"];
    const revision = "2026-10-09T10:20:00.000Z";
    let deleted = false;
    let suggestions = 0;
    const links: Array<{ id: string | null; previous?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      const route = new URL(String(url)).pathname;
      let response: unknown;
      if (route.endsWith("/sync")) {
        response = { id: `memory-${request.sourceRecordId}`, status: request.action === "delete" ? "deleted" : "activated" };
      } else if (route.endsWith("/skills/suggest")) {
        suggestions += 1;
        response = { id: "automatic-skill", status: "active" };
      } else if (route.endsWith("/status")) {
        response = {
          evidence: request.sourceRecordIds.map((id: string) => ({ sourceRecordId: id, id: `memory-${id}`,
            status: deleted && id === ids[0] ? "deleted" : "activated" })),
          skills: request.skillIds.map((id: string) => ({ id, status: deleted ? "deleted" : "activated" }))
        };
      } else throw new Error(`unexpected route ${route}`);
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const make = () => new HistoryMemoryAdapter({ historyDirectory: root, enabled: () => true,
      userId: () => "local-user",
      listEvidence: () => ids.map((id) => ({ id, title: "Release review", content: "Review the draft and save the result.",
        revision, startedAt: "2026-10-09T10:00:00.000Z", endedAt: revision, applications: [application] })),
      listSkillGroups: () => [{ id: "review-group", revision, sourceRecordIds: ids,
        actions: ids.flatMap((sourceRecordId) => [{ sourceRecordId, text: "Review the draft" }, { sourceRecordId, text: "Save the result" }]) }],
      onSkillCandidate: (_group, id, previous) => links.push({ id, ...(previous ? { previous } : {}) })
    });
    const first = make();
    await first.flushNow();
    expect(first.status().skillError).toBeNull();
    expect(links).toEqual([{ id: "automatic-skill" }]);
    await first.close();
    const resumed = make();
    await resumed.flushNow();
    expect(suggestions).toBe(1);
    deleted = true;
    await resumed.flushNow();
    expect(links.at(-1)).toEqual({ id: null, previous: "automatic-skill" });
    expect(resumed.memoryIdFor(ids[0]!)).toBeUndefined();
    expect(suggestions).toBe(1);
    await resumed.close();
  }
);
