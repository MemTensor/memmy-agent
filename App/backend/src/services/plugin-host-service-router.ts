/** Routes plugin host-service calls to the invoker that owns each service name. */
import type { PluginHostServiceInvoker } from "../adapters/outbound/plugin-runtime/index.js";

export interface PluginHostServiceRoute {
  /** Service names this invoker answers, as declared in a plugin's `host-service` permission. */
  services: readonly string[];
  invoker: PluginHostServiceInvoker;
}

/**
 * Builds a single invoker from per-service routes.
 *
 * Routing is by explicit service name rather than by trying each invoker in
 * turn, so an unknown service fails fast instead of being masked by whichever
 * invoker happens to reject it last.
 */
export function createPluginHostServiceRouter(routes: readonly PluginHostServiceRoute[]): PluginHostServiceInvoker {
  const byService = new Map<string, PluginHostServiceInvoker>();
  for (const route of routes) {
    for (const service of route.services) {
      if (byService.has(service)) throw new Error(`Duplicate Host service route: ${service}`);
      byService.set(service, route.invoker);
    }
  }

  return {
    async invoke(call) {
      const invoker = byService.get(call.service);
      if (!invoker) {
        throw Object.assign(new Error(`Unknown Host service: ${call.service}`), {
          code: "host_service_unavailable",
          retryable: false
        });
      }
      return invoker.invoke(call);
    }
  };
}
