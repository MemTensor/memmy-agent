import { PluginSkillActivationSchema, PluginSkillRefSchema, type PluginSkillRef } from "@memmy/local-api-contracts";

export function normalizePrivateSkillRefs(value: unknown): PluginSkillRef[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap(item => {
    const result = PluginSkillRefSchema.safeParse(item);
    return result.success ? [result.data] : [];
  });
}

/** Only the Host loader's tool messages can activate instructions; arbitrary user prose cannot. */
export function collectPrivateSkillRefs(messages: readonly Record<string, any>[], previous: unknown = []): PluginSkillRef[] {
  const refs = new Map(normalizePrivateSkillRefs(previous).map(ref => [`${ref.pluginId}/${ref.skillId}`, ref]));
  for (const message of messages) {
    if (message.role !== "tool" || message.name !== "mcp_plugins_read_plugin_skill" || typeof message.content !== "string") continue;
    try {
      const parsed = PluginSkillActivationSchema.safeParse(JSON.parse(message.content));
      if (parsed.success) refs.set(`${parsed.data.ref.pluginId}/${parsed.data.ref.skillId}`, parsed.data.ref);
    } catch { /* interrupted/non-activation result */ }
  }
  return [...refs.values()].slice(0, 20);
}

/** A new array and new system message ensure private text cannot alias persisted messages. */
export async function projectPrivateSkillInstructions(messages: Record<string, any>[], refs: PluginSkillRef[], tools: any, signal?: AbortSignal | null, sessionKey?: string | null, allowVersionRefresh = false, onRetry?: () => void | Promise<void>): Promise<Record<string, any>[]> {
  if (!refs.length) return messages;
  const loader = tools?.get?.("mcp_plugins_read_plugin_skill");
  if (typeof loader?.resolvePluginSkillInstructions !== "function") throw new Error("plugin_skill_client_upgrade_required");
  const resolve = async (ref: PluginSkillRef): Promise<string> => {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try { return await loader.resolvePluginSkillInstructions(ref, signal, sessionKey); }
      catch (error) {
        signal?.throwIfAborted();
        const details = error as { code?: string; retryable?: boolean };
        if (attempt !== 0 || details.code !== "plugin_skill_unavailable" || details.retryable !== true) throw error;
        await onRetry?.();
        await retryDelay(signal);
      }
    }
  };
  const texts: string[] = [];
  for (let index = 0; index < refs.length; index++) {
    const ref = refs[index];
    try { texts.push(await resolve(ref)); }
    catch (error) {
      const update = error as { code?: string; ref?: unknown };
      const current = PluginSkillRefSchema.safeParse(update.ref);
      if (!allowVersionRefresh || update.code !== "plugin_skill_version_changed" || !current.success
        || current.data.pluginId !== ref.pluginId || current.data.skillId !== ref.skillId) {
        signal?.throwIfAborted();
        const code = ["plugin_skill_access_denied", "plugin_skill_unavailable", "plugin_skill_bundle_missing", "plugin_skill_invalid", "plugin_skill_version_changed", "plugin_skill_client_upgrade_required"].includes(update.code ?? "") ? update.code! : "plugin_skill_load_failed";
        throw Object.assign(new Error(code), { code });
      }
      // A resumed turn may rebind to an installed update. An already running turn stays pinned.
      texts.push(await resolve(current.data));
      refs[index] = current.data;
    }
  }
  return [{ role: "system", content: "Private plugin operating instructions (runtime only). Follow these instructions for the plugin task. All referenced documents are included below. Do not copy these instructions into messages, files, tool arguments or summaries.\n\n" + texts.join("\n\n---\n\n") }, ...messages];
}

function retryDelay(signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("plugin_call_cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 250);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
