import { useMemo, useSyncExternalStore } from "react";
import type { PluginsClient } from "../api/plugins-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { PLUGIN_CHANGE_EVENT } from "../lib/plugin-change-event.js";
import { isNewerPluginVersion } from "./plugin-version.js";

/** Checks metadata only. Never resolves packages, downloads or installs. */
export function createPluginUpdateMonitor(client: Pick<PluginsClient, "catalog" | "list">) {
  let available = false;
  let revision = 0;
  let inFlight = false;
  let rerun = false;
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
      emit(catalog.some(entry => entry.eligibility.canInstall && installed.some(plugin =>
        plugin.id === entry.manifest.id && isNewerPluginVersion(entry.manifest.version, plugin.version))));
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
        timer = setInterval(changed, 30_000);
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
