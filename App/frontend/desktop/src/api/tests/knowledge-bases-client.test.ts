import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listKnowledgeBases } from "../knowledge-bases-client.js";

const config: RuntimeConfig = { baseUrl: "http://127.0.0.1:18100", localToken: "test-token" };
afterEach(() => vi.unstubAllGlobals());

function reply(value: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })));
}

describe("project knowledge candidates", () => {
  it("preserves available sharing metadata and stays compatible with name-only entries", async () => {
    const bases = [{ id: "a", name: "产品" }, { id: "b", name: "团队", shared: true, sharedByMe: false, ownerName: "小林" }];
    reply({ serviceAvailable: true, bases });
    await expect(listKnowledgeBases(config)).resolves.toEqual(bases);
    expect(fetch).toHaveBeenCalledWith(new URL("/api/knowledge/settings", config.baseUrl), expect.objectContaining({ method: "GET", headers: expect.objectContaining({ "x-memmy-local-token": "test-token" }) }));
  });
  it("does not expose candidates when the service is unavailable", async () => {
    reply({ serviceAvailable: false, bases: [{ id: "a", name: "产品" }] });
    await expect(listKnowledgeBases(config)).resolves.toEqual([]);
  });
  it("keeps the picker usable when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(listKnowledgeBases(config)).resolves.toEqual([]);
  });
});
