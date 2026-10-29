/** Private plugin instructions: bounded cloud reads and memory-only, account-scoped caching. */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { InstalledPlugin } from "@memmy/local-api-contracts";

export { PluginSkillRefSchema as SkillRefSchema } from "@memmy/local-api-contracts";
import { PluginSkillRefSchema as SkillRefSchema, type PluginSkillRef } from "@memmy/local-api-contracts";
const Bundle = z.object({
  format: z.literal("memmy-plugin-skill-v1"),
  pluginId: z.string(), skillId: z.string(), pluginVersion: z.string(), revision: z.string(),
  files: z.record(z.string(), z.string())
}).strict();
const MAX_BYTES = 512 * 1024;
export interface PluginSkillContentService {
  reference(pluginId: string, skillId: string): PluginSkillRef;
  resolve(ref: PluginSkillRef, signal?: AbortSignal): Promise<string>;
  clear(pluginId?: string): void;
}
export function createPluginSkillContentService(options: {
  baseUrl: string;
  getPlugin(id: string): InstalledPlugin | null;
  authHeaders(): Record<string, string>;
  fetch?: typeof fetch;
  ttlMs?: number;
}): PluginSkillContentService {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) throw new Error("Skill service requires HTTPS");
  const cache = new Map<string, { pluginId: string; text: string; expires: number; timer: ReturnType<typeof setTimeout> }>();
  const pending = new Map<string, Promise<string>>();
  let account = "";
  let generation = 0;
  const service: PluginSkillContentService = {
    clear(pluginId) {
      generation++;
      for (const [key, value] of cache) if (!pluginId || value.pluginId === pluginId) {
        clearTimeout(value.timer); cache.delete(key);
      }
      pending.clear();
    },
    reference(pluginId, skillId) {
      const plugin = options.getPlugin(pluginId);
      if (!plugin || plugin.state !== "active" || plugin.eligibility?.canUse === false || !options.authHeaders().authorization) throw failure("plugin_skill_access_denied");
      const skill = plugin.manifest.skills?.find(s => s.id === skillId);
      if (!skill?.cloud) throw failure("plugin_skill_unavailable");
      return SkillRefSchema.parse({ pluginId, skillId, pluginVersion: plugin.version, ...skill.cloud });
    },
    async resolve(rawRef, signal) {
      const ref = SkillRefSchema.parse(rawRef);
      const current = service.reference(ref.pluginId, ref.skillId);
      if (JSON.stringify(current) !== JSON.stringify(ref)) throw failure("plugin_skill_version_changed");
      const headers = options.authHeaders();
      if (!headers.authorization) throw failure("plugin_skill_access_denied");
      const identity = createHash("sha256").update(headers.authorization).digest("hex");
      if (account !== identity) { service.clear(); account = identity; }
      const key = identity + JSON.stringify(ref);
      signal?.throwIfAborted();
      const cached = cache.get(key);
      if (cached && cached.expires > Date.now()) return cached.text;
      signal?.throwIfAborted();
      let request = pending.get(key);
      if (!request) {
        const epoch = generation;
        request = (async () => {
          const url = new URL(`/api/v1/plugins/${encodeURIComponent(ref.pluginId)}/skills/${encodeURIComponent(ref.skillId)}/bundle`, base);
          url.searchParams.set("pluginVersion", ref.pluginVersion); url.searchParams.set("revision", ref.revision);
          // Shared request has its own deadline; one cancelled consumer must not cancel other consumers.
          const response = await (options.fetch ?? fetch)(url, { headers: { ...headers, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
          if (!response.ok) throw failure(response.status === 401 || response.status === 403 ? "plugin_skill_access_denied" : "plugin_skill_unavailable");
          if (!response.body || Number(response.headers.get("content-length")) > MAX_BYTES) throw failure("plugin_skill_invalid");
          const chunks: Uint8Array[] = []; let size = 0;
          for await (const chunk of response.body) { size += chunk.byteLength; if (size > MAX_BYTES) throw failure("plugin_skill_invalid"); chunks.push(chunk); }
          const bytes = Buffer.concat(chunks);
          if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw failure("plugin_skill_invalid");
          let bundle: z.infer<typeof Bundle>;
          try { bundle = Bundle.parse(JSON.parse(bytes.toString("utf8"))); } catch { throw failure("plugin_skill_invalid"); }
          if (bundle.pluginId !== ref.pluginId || bundle.skillId !== ref.skillId || bundle.pluginVersion !== ref.pluginVersion || bundle.revision !== ref.revision
            || !bundle.files["SKILL.md"] || Object.keys(bundle.files).length > 20
            || Object.keys(bundle.files).some(p => !/^(SKILL\.md|references\/[a-zA-Z0-9_-]+\.md)$/.test(p))) throw failure("plugin_skill_invalid");
          const text = Object.entries(bundle.files).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => `### ${path}\n${content}`).join("\n\n");
          // Recheck after network I/O: a logout, update or disable cannot repopulate stale data.
          if (epoch !== generation || options.authHeaders().authorization !== headers.authorization
            || JSON.stringify(service.reference(ref.pluginId, ref.skillId)) !== JSON.stringify(ref)) throw failure("plugin_skill_access_denied");
          const ttl = options.ttlMs ?? 600_000;
          const timer = setTimeout(() => cache.delete(key), ttl); timer.unref?.();
          if (cache.size >= 64 && !cache.has(key)) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey) { clearTimeout(cache.get(oldestKey)!.timer); cache.delete(oldestKey); }
          }
          const previous = cache.get(key); if (previous) clearTimeout(previous.timer);
          cache.set(key, { pluginId: ref.pluginId, text, expires: Date.now() + ttl, timer });
          return text;
        })().catch(() => { throw failure("plugin_skill_unavailable"); }).finally(() => { if (pending.get(key) === request) pending.delete(key); });
        pending.set(key, request);
      }
      const text = await request;
      signal?.throwIfAborted();
      // Never hand the caller stale content after an account or plugin change.
      if (options.authHeaders().authorization !== headers.authorization || JSON.stringify(service.reference(ref.pluginId, ref.skillId)) !== JSON.stringify(ref)) throw failure("plugin_skill_access_denied");
      return text;
    }
  };
  return service;
}
function failure(code: string) { return Object.assign(new Error(code), { code }); }
