import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Plug, RefreshCw } from "lucide-react";
import type { InstalledPlugin, PluginPermission } from "@memmy/local-api-contracts";
import type { PluginsClient } from "../api/plugins-client.js";
import { useTranslation } from "../i18n/use-translation.js";

export function PluginSettingsSection(props: { client?: PluginsClient }) {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [pluginId, setPluginId] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!props.client) return;
    setLoading(true);
    try {
      setPlugins(await props.client.list());
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [props.client]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function mutate(id: string, operation: () => Promise<unknown>) {
    setBusyId(id);
    try {
      await operation();
      await refresh();
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyId(null);
    }
  }

  async function install(event: FormEvent) {
    event.preventDefault();
    const id = pluginId.trim();
    if (!id || !props.client) return;
    await mutate(id, async () => {
      await props.client!.install(id);
      setPluginId("");
    });
  }

  return (
    <section aria-labelledby="plugin-settings-title" className="mb-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Plug size={16} className="text-text-ink/60" aria-hidden="true" />
          <h2 id="plugin-settings-title" className="text-sm font-semibold text-text-ink">{t("settings.plugins")}</h2>
        </div>
        <button type="button" disabled={!props.client || loading} onClick={() => void refresh()} className="inline-flex items-center gap-1 text-xs text-action-sky disabled:opacity-50">
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} aria-hidden="true" />{t("common.refresh")}
        </button>
      </div>

      <form onSubmit={(event) => void install(event)} className="mb-4 flex gap-2 rounded-card border border-border-stone/30 bg-background-paper p-3">
        <input value={pluginId} onChange={(event) => setPluginId(event.target.value)} placeholder={t("settings.plugins.idPlaceholder")} aria-label={t("settings.plugins.idLabel")} className="min-w-0 flex-1 rounded-input border border-border-stone/45 bg-white px-3 py-2 text-sm" />
        <button type="submit" disabled={!props.client || !pluginId.trim() || busyId !== null} className="rounded-btn bg-action-sky px-3 py-2 text-xs text-white disabled:opacity-50">{t("common.install")}</button>
      </form>

      {error ? <p role="alert" className="mb-3 text-xs text-status-error">{error}</p> : null}
      {!loading && plugins.length === 0 ? <p className="text-sm text-text-ink/45">{t("settings.plugins.empty")}</p> : null}
      <div className="space-y-3">
        {plugins.map((plugin) => (
          <article key={plugin.id} className="rounded-card border border-border-stone/30 bg-background-paper p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-text-ink">{plugin.manifest.name}</h3>
                <p className="mt-0.5 text-xs text-text-ink/45">{plugin.id} · {plugin.version} · {plugin.state}</p>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                {plugin.state === "pending_approval" ? (
                  <ActionButton disabled={busyId !== null} onClick={() => void mutate(plugin.id, async () => {
                    await props.client!.approvePermissions(plugin.id, plugin.manifest.permissions);
                    await props.client!.enable(plugin.id);
                  })}>{t("settings.plugins.approveEnable")}</ActionButton>
                ) : plugin.state === "active" ? (
                  <ActionButton disabled={busyId !== null} onClick={() => void mutate(plugin.id, () => props.client!.disable(plugin.id))}>{t("settings.plugins.disable")}</ActionButton>
                ) : (
                  <ActionButton disabled={busyId !== null} onClick={() => void mutate(plugin.id, () => props.client!.enable(plugin.id))}>{t("settings.plugins.enable")}</ActionButton>
                )}
                <ActionButton secondary disabled={busyId !== null} onClick={() => void mutate(plugin.id, () => props.client!.uninstall(plugin.id))}>{t("settings.plugins.uninstall")}</ActionButton>
              </div>
            </div>
            {plugin.manifest.permissions.length ? (
              <div className="mt-3 border-t border-border-stone/20 pt-3">
                <p className="mb-1.5 text-xs font-medium text-text-ink/60">{t("settings.plugins.permissions")}</p>
                <ul className="space-y-1 text-xs text-text-ink/50">
                  {plugin.manifest.permissions.map((permission, index) => <li key={`${permission.type}-${index}`}>{describePermission(permission, t)}</li>)}
                </ul>
              </div>
            ) : null}
            {plugin.lastError ? <p className="mt-2 text-xs text-status-error">{plugin.lastError}</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function ActionButton(props: { children: string; disabled: boolean; onClick(): void; secondary?: boolean }) {
  return <button type="button" disabled={props.disabled} onClick={props.onClick} className={`rounded-btn border px-2.5 py-1.5 text-xs disabled:opacity-50 ${props.secondary ? "border-border-stone/40 text-text-ink/55" : "border-action-sky/30 bg-action-sky/10 text-action-sky"}`}>{props.children}</button>;
}

function describePermission(permission: PluginPermission, t: ReturnType<typeof useTranslation>["t"]): string {
  switch (permission.type) {
    case "network": return `${t("settings.plugins.permission.network")}: ${permission.hosts.join(", ")}`;
    case "filesystem": return `${t("settings.plugins.permission.filesystem")}: ${permission.access} · ${permission.paths.join(", ")}`;
    case "secret": return `${t("settings.plugins.permission.secret")}: ${permission.keys.join(", ")}`;
    case "host-service": return `${t("settings.plugins.permission.hostService")}: ${permission.services.join(", ")}`;
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
