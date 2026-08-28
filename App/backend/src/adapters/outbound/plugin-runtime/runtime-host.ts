/** Active plugin runtime sessions and capability execution. */
import {
  CapabilityCallSchema,
  CapabilityEventSchema,
  type CapabilityCall,
  type CapabilityEvent
} from "@memmy/local-api-contracts";
import { Ajv } from "ajv";
import type { PluginRecord } from "../../../infrastructure/app-state-store/repositories/plugin-repo.js";
import type { PluginRuntimeHost } from "../../../services/plugin-service.js";
import { PluginAdapterRegistry } from "./registry.js";
import type { PluginAdapter, PluginSession } from "./types.js";

interface ActivePlugin {
  plugin: PluginRecord;
  adapter: PluginAdapter;
  session: PluginSession;
  calls: Set<string>;
}

export interface CapabilityRuntimeHost extends PluginRuntimeHost {
  invoke(call: CapabilityCall): AsyncIterable<CapabilityEvent>;
  cancel(pluginId: string, callId: string): Promise<void>;
}

export function createPluginRuntimeHost(registry: PluginAdapterRegistry): CapabilityRuntimeHost {
  const active = new Map<string, ActivePlugin>();

  return {
    supports(adapterId) {
      return registry.has(adapterId);
    },

    async activate(plugin, secrets) {
      if (active.has(plugin.id)) return;
      const adapter = registry.get(plugin.manifest.runtime.adapter);
      adapter.validate(plugin.manifest.runtime, plugin.rootPath);
      const session = await adapter.activate({
        plugin,
        config: plugin.config,
        secrets,
        rootPath: plugin.rootPath
      });
      if (session.pluginId !== plugin.id) {
        await adapter.deactivate(session).catch(() => undefined);
        throw new Error(`Plugin adapter activated a session for ${session.pluginId}`);
      }
      active.set(plugin.id, { plugin, adapter, session, calls: new Set() });
    },

    async *invoke(rawCall) {
      const call = CapabilityCallSchema.parse(rawCall);
      const current = active.get(call.pluginId);
      if (!current) {
        yield runtimeError("plugin_unavailable", `Plugin is not active: ${call.pluginId}`);
        return;
      }
      const capability = current.plugin.manifest.capabilities.find((candidate) => candidate.id === call.capabilityId);
      if (!capability) {
        yield runtimeError("plugin_unavailable", `Capability not found: ${call.capabilityId}`);
        return;
      }

      const inputError = validateValue(capability.inputSchema, call.input);
      if (inputError) {
        yield runtimeError("plugin_invalid", `Invalid capability input: ${inputError}`);
        return;
      }

      current.calls.add(call.callId);
      let terminal = false;
      try {
        const iterator = current.adapter.invoke(current.session, call)[Symbol.asyncIterator]();
        for (;;) {
          const item = await nextBeforeDeadline(iterator, call.deadline, () =>
            current.adapter.cancel?.(current.session, call.callId)
          );
          if (item.done) break;
          const event = CapabilityEventSchema.parse(item.value);
          if (event.type === "result") {
            const outputError = validateValue(capability.outputSchema, event.output);
            if (outputError) {
              yield runtimeError("plugin_runtime_error", `Invalid capability output: ${outputError}`);
              terminal = true;
              break;
            }
            terminal = true;
          } else if (event.type === "error") {
            terminal = true;
          }
          yield event;
          if (terminal) break;
        }
        if (!terminal) yield runtimeError("plugin_runtime_error", "Plugin ended without a result or error");
      } catch (error) {
        yield runtimeError(
          isTimeout(error) ? "plugin_timeout" : "plugin_runtime_error",
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        current.calls.delete(call.callId);
      }
    },

    async cancel(pluginId, callId) {
      const current = active.get(pluginId);
      if (!current?.calls.has(callId)) return;
      await current.adapter.cancel?.(current.session, callId);
    },

    async deactivate(pluginId) {
      const current = active.get(pluginId);
      if (!current) return;
      active.delete(pluginId);
      await Promise.all([...current.calls].map((callId) =>
        current.adapter.cancel?.(current.session, callId) ?? Promise.resolve()
      ));
      await current.adapter.deactivate(current.session);
    }
  };
}

function validateValue(schema: Record<string, unknown>, value: unknown): string | null {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  return validate(value) ? null : (validate.errors?.[0]?.message ?? "schema validation failed");
}

async function nextBeforeDeadline<T>(
  iterator: AsyncIterator<T>,
  deadline: string | undefined,
  cancel: () => Promise<void> | undefined
): Promise<IteratorResult<T>> {
  if (!deadline) return iterator.next();
  const remaining = Date.parse(deadline) - Date.now();
  if (remaining <= 0) {
    await cancel();
    throw timeoutError();
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          void Promise.resolve(cancel()).finally(() => reject(timeoutError()));
        }, Math.min(remaining, 2_147_483_647));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function timeoutError(): Error {
  return Object.assign(new Error("Plugin call timed out"), { code: "plugin_timeout" });
}

function isTimeout(error: unknown): boolean {
  return (error as { code?: unknown })?.code === "plugin_timeout";
}

function runtimeError(code: string, message: string): CapabilityEvent {
  return { type: "error", code, message, retryable: code === "plugin_timeout" || code === "plugin_runtime_error" };
}
