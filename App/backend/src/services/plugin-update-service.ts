import type { PluginService } from "./plugin-service.js";
import { compareVersions } from "./plugin-service.js";
import { pluginRules } from "./plugin-rules.js";

/** Updates only explicitly installed plugins; recording leases defer activation. */
export function createPluginUpdateService(plugins: PluginService, onUpdated: () => Promise<unknown> = async () => {}) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  const check = () => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const catalog = await plugins.catalog();
      for (const installed of plugins.list()) {
        if (stopped) break;
        const latest = catalog.find(item => item.manifest.id === installed.id);
        const autoUpdate = pluginRules(installed.manifest).autoUpdate;
        if (!latest || !latest.eligibility.canUse || !autoUpdate || installed.state === "pending_approval"
          || plugins.isBusy(installed.id) || compareVersions(latest.manifest.version, installed.version) <= 0) continue;
        try { await plugins.update(installed.id, latest.manifest.version); await onUpdated(); }
        catch (error) { console.warn(`Plugin update deferred or failed for ${installed.id}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };
  return {
    check,
    start() {
      if (timer || stopped) return;
      void check().catch(() => undefined);
      timer = setInterval(() => void check().catch(() => undefined), 6 * 60 * 60 * 1_000); timer.unref();
    },
    async close() { stopped = true; clearInterval(timer); await inFlight?.catch(() => undefined); }
  };
}
