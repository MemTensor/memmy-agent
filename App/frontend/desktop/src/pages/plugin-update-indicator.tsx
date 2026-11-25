import { useMemo, useSyncExternalStore } from "react";
import type { PluginsClient } from "../api/plugins-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { PLUGIN_CHANGE_EVENT } from "../lib/plugin-change-event.js";
import { isNewerPluginVersion } from "@memmy/local-api-contracts";

const CHECK_INTERVAL_MS = 30_000;

/** Shares the desktop update check across subscribers; the Host authorizes and queues each upgrade. */
export function createPluginUpdateMonitor(client: Pick<PluginsClient, "catalog" | "list" | "update">) {
  let available = false;
  let revision = 0;
  let inFlight = false;
  let rerun = false;
  const pending = new Set<string>();
  const retryAfter = new Map<string, number>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  const emit = (next: boolean) => {
    if (available === next) return;
    available = next;
    for (const listener of listeners) listener();
  };
  const refresh = async () => {
    if (inFlight) { rerun = true; return; }
    inFlight = true;
    const current = revision;
    try {
      const [catalog, installed] = await Promise.all([client.catalog?.() ?? [], client.list()]);
      if (current !== revision) return;
      const byId = new Map(installed.map(plugin => [plugin.id, plugin]));
      let hasUpdates = false;
      for (const { manifest, eligibility, autoUpdateFromVersion } of catalog) {
        const plugin = byId.get(manifest.id);
        if (!eligibility.canInstall || !plugin || !isNewerPluginVersion(manifest.version, plugin.version)) continue;
        hasUpdates = true;
        if (autoUpdateFromVersion !== plugin.version || plugin.update || pending.has(plugin.id)
          || (retryAfter.get(plugin.id) ?? 0) > Date.now() || !listeners.size) continue;
        retryAfter.delete(plugin.id);
        pending.add(plugin.id);
        void client.update(plugin.id, manifest.version, autoUpdateFromVersion)
          .catch(() => { retryAfter.set(plugin.id, Date.now() + CHECK_INTERVAL_MS); })
          .finally(() => { pending.delete(plugin.id); });
      }
      emit(hasUpdates);
    } catch {
      // A failed check is not evidence that a known update has disappeared.
    } finally {
      inFlight = false;
      if (rerun && listeners.size) { rerun = false; void refresh(); }
    }
  };
  const changed = () => { void refresh(); };
  return {
    refresh,
    getSnapshot: () => available,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        timer = setInterval(changed, CHECK_INTERVAL_MS);
        window.addEventListener("focus", changed);
        window.addEventListener(PLUGIN_CHANGE_EVENT, changed);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          revision++; clearInterval(timer);
          window.removeEventListener("focus", changed);
          window.removeEventListener(PLUGIN_CHANGE_EVENT, changed);
        }
      };
    }
  };
}
const monitors = new WeakMap<PluginsClient, Map<string, ReturnType<typeof createPluginUpdateMonitor>>>();
const empty = { subscribe: () => () => undefined, getSnapshot: () => false };
export function usePluginUpdateAvailable(client: PluginsClient | undefined, accountId?: string | null): boolean {
  const monitor = useMemo(() => {
    if (!client) return empty;
    let accounts = monitors.get(client);
    if (!accounts) { accounts = new Map(); monitors.set(client, accounts); }
    const key = accountId ?? "signed-out";
    let value = accounts.get(key);
    if (!value) { value = createPluginUpdateMonitor(client); accounts.set(key, value); }
    return value;
  }, [client, accountId]);
  return useSyncExternalStore(monitor.subscribe, monitor.getSnapshot, () => false);
}
export function PluginUpdateDot() {
  const { t } = useTranslation();
  return <span role="status" aria-label={t("plugins.ui.updatesAvailable")} title={t("plugins.ui.updatesAvailable")}
    style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", backgroundColor: "#dc2626", flexShrink: 0 }} />;
}
