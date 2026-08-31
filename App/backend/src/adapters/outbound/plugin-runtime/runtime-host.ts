/** Active plugin runtime sessions and capability execution. */
import {
  CapabilityCallSchema,
  CapabilityEventSchema,
  type CapabilityCall,
  type CapabilityEvent
} from "@memmy/local-api-contracts";
import { Ajv } from "ajv";
import { PluginAdapterRegistry } from "./registry.js";
import type { PluginAdapter, PluginRuntimeHost, PluginRuntimeRecord, PluginSession } from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: false, addUsedSchema: false });

interface ActivePlugin {
  plugin: PluginRuntimeRecord;
  adapter: PluginAdapter;
  session: PluginSession;
  calls: Map<string, Map<string, Record<string, unknown> | undefined>>;
}

export function createPluginRuntimeHost(registry: PluginAdapterRegistry): PluginRuntimeHost {
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
      active.set(plugin.id, { plugin, adapter, session, calls: new Map() });
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

      current.calls.set(call.callId, new Map());
      let terminal = false;
      try {
        const iterator = current.adapter.invoke(current.session, call)[Symbol.asyncIterator]();
        for (;;) {
          const item = await nextBeforeDeadline(iterator, call.deadline, () =>
            current.adapter.cancel?.(current.session, call.callId)
          );
          if (item.done) break;
          const event = CapabilityEventSchema.parse(item.value);
          if (Buffer.byteLength(JSON.stringify(event)) > 10 * 1024 * 1024) {
            throw new Error("Plugin event exceeded size limit");
          }
          if (event.type === "interaction") {
            const pending = current.calls.get(call.callId)!;
            if (pending.has(event.request.interactionId)) {
              throw new Error(`Duplicate plugin interaction: ${event.request.interactionId}`);
            }
            pending.set(event.request.interactionId, event.request.responseSchema);
          }
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

    async respond(pluginId, callId, interactionId, response) {
      const current = active.get(pluginId);
      const pending = current?.calls.get(callId);
      if (!current || !pending?.has(interactionId)) {
        throw Object.assign(new Error("Plugin interaction is not pending"), { code: "plugin_interaction_invalid" });
      }
      if (!current.adapter.respond) {
        throw Object.assign(new Error("Plugin adapter does not support interactions"), { code: "plugin_interaction_invalid" });
      }
      const schema = pending.get(interactionId);
      if (schema) {
        const error = validateValue(schema, response);
        if (error) throw Object.assign(new Error(`Invalid plugin interaction response: ${error}`), {
          code: "plugin_interaction_invalid"
        });
      }
      await current.adapter.respond(current.session, callId, interactionId, response);
      pending.delete(interactionId);
    },

    async deactivate(pluginId) {
      const current = active.get(pluginId);
      if (!current) return;
      active.delete(pluginId);
      await Promise.all([...current.calls.keys()].map((callId) =>
        current.adapter.cancel?.(current.session, callId) ?? Promise.resolve()
      ));
      await current.adapter.deactivate(current.session);
    }
  };
}

function validateValue(schema: Record<string, unknown>, value: unknown): string | null {
  const validate = ajv.compile(schema);
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
