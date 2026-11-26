/** Event capture and skill services added to the plugin Host-service composition. */
import { join } from "node:path";
import type { PluginRepository } from "../infrastructure/app-state-store/repositories/plugin-repo.js";
import type { MemmyAgentAdminClient } from "../adapters/outbound/memmy-agent-admin-client/index.js";
import type { PluginHostServiceInvoker } from "../adapters/outbound/plugin-runtime/index.js";
import type { GeneratedPluginSkills } from "./plugin-generated-skills.js";
import { capabilityToolName } from "./plugin-tool-name.js";

export function createPluginNativeHostServices(options: {
  repository: PluginRepository; admin: MemmyAgentAdminClient;
  dataRoot: string; legacyDataRoot?: string; generated: GeneratedPluginSkills; language?: () => string;
}) {
  const { dataRoot, generated } = options;
  const eventLeases = new Set<string>();
  let leaseTimer: ReturnType<typeof setInterval> | undefined;
  let reconciling = false;
  const release = async (id: string) => {
    try {
      const nativeOwner = options.repository.get(id)?.manifest.permissions.some(permission => permission.type === "host-service"
        && permission.services.includes("event-sessions"));
      if (nativeOwner || eventLeases.has(id)) await options.admin.invokePluginHostService?.(id, "release", {}, { dataRoot });
    }
    finally { eventLeases.delete(id); }
  };
  const hostServices: PluginHostServiceInvoker = {
    async invoke(call) {
      const installed = options.repository.get(call.pluginId);
      const input = call.input as Record<string, unknown>;
      const cleanup = (call.service === "event-sessions" && ["stop", "cancel", "status", "list"].includes(String(input?.action)))
        || (call.service === "skills" && input?.action === "remove");
      if (!installed || (!(["active", "enabling"].includes(installed.state)) && !(installed.state === "disabling" && cleanup))
        || !installed.approvedPermissions.some(p => p.type === "host-service" && p.services.includes(call.service))) throw new Error("Plugin host service permission denied");
      if (!cleanup) call.signal?.throwIfAborted();
      if (call.service === "plugin-context") return { pluginId: call.pluginId, dataDirectory: join(dataRoot, call.pluginId),
        ...(options.legacyDataRoot ? { legacyDataDirectory: join(options.legacyDataRoot, call.pluginId) } : {}), config: installed.config, language: options.language?.() ?? "en-US",
        tools: Object.fromEntries(installed.manifest.capabilities.map(c => [c.id, `mcp_plugins_${capabilityToolName(installed.id, c.id)}`])) };
      if (call.service === "skills") {
        if (input.action === "publish") await generated.publish(call.pluginId, input.skill);
        else if (input.action === "remove" && typeof input.name === "string") await generated.remove(call.pluginId, input.name);
        else throw new Error("Unknown generated skill operation");
        return { ok: true };
      }
      if (call.service !== "event-sessions" || !options.admin.invokePluginHostService) throw new Error("Host service unavailable");
      if (!cleanup) call.signal?.throwIfAborted();
      if (input.action === "configuration" && call.callId === "plugin-lifecycle") {
        // A newly activated worker cannot resume resources left by its predecessor.
        await options.admin.invokePluginHostService(call.pluginId, "release", {}, { dataRoot });
      }
      const result = await options.admin.invokePluginHostService(call.pluginId, call.service,
        { ...input, conversationId: call.conversationId.replace(/^websocket:/, "") }, { dataRoot });
      const output = result as { state?: string };
      if (input.action === "start" && output.state === "recording") eventLeases.add(call.pluginId);
      if (["stop", "cancel", "status", "list"].includes(String(input.action))) {
        // Other chats may still own a subscription, so ask the Host rather
        // than clearing this plugin's lease on the first finished session.
        const status = await options.admin.invokePluginHostService(call.pluginId, "event-sessions", { action: "owner-status" }, { dataRoot });
        if ((status as { busy?: boolean }).busy) eventLeases.add(call.pluginId); else eventLeases.delete(call.pluginId);
      }
      if (call.signal?.aborted && !cleanup) {
        if (input.action === "start" && typeof (result as { id?: unknown }).id === "string") {
          await options.admin.invokePluginHostService(call.pluginId, "event-sessions", { action: "cancel", session_id: (result as { id: string }).id, conversationId: call.conversationId }, { dataRoot });
          const status = await options.admin.invokePluginHostService(call.pluginId, "event-sessions", { action: "owner-status" }, { dataRoot });
          if (!(status as { busy?: boolean }).busy) eventLeases.delete(call.pluginId);
        }
        call.signal.throwIfAborted();
      }
      return result;
    }
  };
  return {
    hostServices,
    isBusy: (id: string) => eventLeases.has(id),
    release: async (id: string) => {
      try { await generated.deactivate(id); } finally { await release(id); }
    },
    start() {
      leaseTimer = setInterval(() => {
        if (reconciling || !eventLeases.size) return; reconciling = true;
        void Promise.allSettled([...eventLeases].map(async id => {
          const status = await options.admin.invokePluginHostService?.(id, "event-sessions", { action: "owner-status" }, { dataRoot });
          if (status && !(status as { busy?: boolean }).busy) eventLeases.delete(id);
        })).finally(() => { reconciling = false; });
      }, 3_000); leaseTimer.unref();
    },
    async close() {
      clearInterval(leaseTimer);
      await Promise.allSettled([...eventLeases].map(release));
    }
  };
}
