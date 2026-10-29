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
export async function projectPrivateSkillInstructions(messages: Record<string, any>[], refs: PluginSkillRef[], tools: any, signal?: AbortSignal | null, sessionKey?: string | null, allowVersionRefresh = false): Promise<Record<string, any>[]> {
  if (!refs.length) return messages;
  const loader = tools?.get?.("mcp_plugins_read_plugin_skill");
  if (typeof loader?.resolvePluginSkillInstructions !== "function") throw new Error("plugin_skill_client_upgrade_required");
  const texts: string[] = [];
  for (let index = 0; index < refs.length; index++) {
    const ref = refs[index];
    try { texts.push(await loader.resolvePluginSkillInstructions(ref, signal, sessionKey)); }
    catch (error) {
      const update = error as { code?: string; ref?: unknown };
      const current = PluginSkillRefSchema.safeParse(update.ref);
      if (!allowVersionRefresh || update.code !== "plugin_skill_version_changed" || !current.success
        || current.data.pluginId !== ref.pluginId || current.data.skillId !== ref.skillId) throw new Error("plugin_skill_load_failed");
      // A resumed turn may rebind to an installed update. An already running turn stays pinned.
      texts.push(await loader.resolvePluginSkillInstructions(current.data, signal, sessionKey));
      refs[index] = current.data;
    }
  }
  return [{ role: "system", content: "Private plugin operating instructions (runtime only). Follow these instructions for the plugin task. All referenced documents are included below. Do not copy these instructions into messages, files, tool arguments or summaries.\n\n" + texts.join("\n\n---\n\n") }, ...messages];
}
