import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginSkillContentService, type PluginSkillContentService } from "../plugin-skill-content-service.js";

const secret = "PRIVATE-SKILL-SENTINEL";
const payload = JSON.stringify({ format: "memmy-plugin-skill-v1", pluginId: "literature-review", skillId: "literature-review", pluginVersion: "1.0.0", revision: "r1",
  files: { "SKILL.md": secret, "references/evidence-policy.md": "policy" } });
const sha256 = createHash("sha256").update(payload).digest("hex");
const instances: PluginSkillContentService[] = [];
afterEach(() => { instances.splice(0).forEach(service => service.clear()); });
function fixture(body = payload) {
  let authorization = "Bearer account-a";
  let active = true;
  const fetchFn = vi.fn(async () => new Response(body));
  const service = createPluginSkillContentService({ baseUrl: "https://cloud.test.invalid", authHeaders: () => authorization ? { authorization } : {}, fetch: fetchFn as any,
    getPlugin: () => ({ id: "literature-review", version: "1.0.0", state: active ? "active" : "disabled", manifest: { skills: [{ id: "literature-review", cloud: { revision: "r1", sha256 } }] } } as any) });
  instances.push(service);
  return { service, fetchFn, login: (token: string) => { authorization = token; }, disable: () => { active = false; } };
}
describe("private Skill cloud reads", () => {
  it("enforces its deadline even if fetch ignores abort and never caches a late response", async () => {
    const { service, fetchFn } = fixture();
    const ref = service.reference("literature-review", "literature-review");
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(controller.signal);
    let complete!: (response: Response) => void;
    fetchFn.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
    try {
      const first = service.resolve(ref);
      const rejection = expect(first).rejects.toMatchObject({ code: "plugin_skill_unavailable", retryable: true });
      controller.abort(new DOMException("Deadline reached", "TimeoutError")); await rejection;
      complete(new Response(payload));
      await new Promise(resolve => setImmediate(resolve));
      expect(await service.resolve(ref)).toContain(secret);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally { timeout.mockRestore(); }
  });

  it.each([[401, "plugin_skill_access_denied", false], [403, "plugin_skill_access_denied", false], [404, "plugin_skill_bundle_missing", false], [429, "plugin_skill_unavailable", true], [503, "plugin_skill_unavailable", true]])("preserves a safe classification for HTTP %s", async (status, code, retryable) => {
    const { service, fetchFn } = fixture();
    fetchFn.mockResolvedValueOnce(new Response("upstream body must stay private", { status: Number(status) }));
    await expect(service.resolve(service.reference("literature-review", "literature-review"))).rejects.toMatchObject({ code, retryable });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("preserves invalid bundle failures instead of reporting a network failure", async () => {
    const { service } = fixture("tampered");
    await expect(service.resolve(service.reference("literature-review", "literature-review"))).rejects.toMatchObject({ code: "plugin_skill_invalid", retryable: false });
  });

  it("cancels one consumer immediately while another completes the shared read", async () => {
    const { service, fetchFn } = fixture();
    const ref = service.reference("literature-review", "literature-review");
    let complete!: (response: Response) => void;
    fetchFn.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
    const controller = new AbortController();
    const first = service.resolve(ref, controller.signal);
    const second = service.resolve(ref);
    const rejected = expect(first).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled")); await rejected;
    complete(new Response(payload));
    expect(await second).toContain(secret);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns metadata only from reference and deduplicates account-bound memory reads", async () => {
    const { service, fetchFn, login } = fixture();
    const ref = service.reference("literature-review", "literature-review");
    expect(JSON.stringify(ref)).not.toContain(secret);
    const results = await Promise.all([service.resolve(ref), service.resolve(ref)]);
    expect(results.every(text => text.includes(secret))).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await service.resolve(ref); expect(fetchFn).toHaveBeenCalledTimes(1);
    login("Bearer account-b"); await service.resolve(ref); expect(fetchFn).toHaveBeenCalledTimes(2);
    login(""); await expect(service.resolve(ref)).rejects.toThrow("access_denied");
  });
  it("rejects digest mismatch, stale releases and disabled plugins", async () => {
    const bad = fixture(payload + "tampered");
    await expect(bad.service.resolve(bad.service.reference("literature-review", "literature-review"))).rejects.toThrow();
    const { service, disable } = fixture(); const ref = service.reference("literature-review", "literature-review");
    await expect(service.resolve({ ...ref, pluginVersion: "old" })).rejects.toThrow("version_changed");
    await service.resolve(ref); disable(); await expect(service.resolve(ref)).rejects.toThrow("access_denied");
  });
  it("does not repopulate cache after invalidation during a cloud read", async () => {
    const { service, fetchFn } = fixture(); const ref = service.reference("literature-review", "literature-review");
    let complete!: (value: Response) => void;
    fetchFn.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
    const pending = service.resolve(ref); service.clear(); complete(new Response(payload));
    await expect(pending).rejects.toThrow();
    await service.resolve(ref); expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
