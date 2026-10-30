import { useEffect, useRef, useState } from "react";
import type { InstalledPlugin, PluginCatalogEntry } from "@memmy/local-api-contracts";
import type { PluginsClient } from "../api/plugins-client.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { useTranslation } from "../i18n/use-translation.js";

export function PluginStoreSection({ client, platform }: { client?: PluginsClient; platform?: string }) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([]), [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<InstalledPlugin | null>(null);
  const mutating = useRef(false);
  const os = platform ?? (typeof window !== "undefined" ? window.memmy?.platform : undefined);
  const refresh = async () => {
    if (!client) return;
    const results = await Promise.allSettled([client.catalog(), client.list()]);
    if (results[0].status === "fulfilled") setCatalog(results[0].value); else setError(t("plugins.store.unavailable"));
    if (results[1].status === "fulfilled") setInstalled(results[1].value);
  };
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 15_000); return () => clearInterval(timer); }, [client, t]);
  const mutate = async (id: string, operation: () => Promise<unknown>) => {
    if (mutating.current) return; mutating.current = true; setBusy(id); setError(null);
    try { await operation(); await refresh(); window.dispatchEvent(new Event("memmy:plugins-changed")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { mutating.current = false; setBusy(null); }
  };
  const items: PluginCatalogEntry[] = [...catalog, ...installed.filter(p => !catalog.some(c => c.manifest.id === p.id)).map(p => ({
    manifest: p.manifest,
    eligibility: p.eligibility ?? { visible: true, canInstall: true, canUse: true, reason: null },
    installed: p
  }))];
  return <section aria-label={t("plugins.store.title")} className="mb-6 rounded-card border border-border-stone/30 bg-background-paper p-4">
    <header className="flex items-center justify-between"><h2>{t("plugins.store.title")}</h2><button onClick={() => void refresh()}>{t("plugins.store.refresh")}</button></header>
    {error && <p role="alert">{error}</p>}
    {items.filter(item => item.eligibility.visible).map(({ manifest: item, eligibility }) => {
      const platforms = item.platforms ?? [];
      const plugin = installed.find(p => p.id === item.id), supported = !platforms.length || platforms.some(p => p === os);
      return <article key={item.id} className="mt-3 rounded-card border border-border-stone/30 p-4">
        <h3>{item.name}</h3><p>{item.description ?? item.capabilities[0]?.description}</p><p className="text-xs text-text-ink/60">{item.version} · {plugin?.state ?? (t("plugins.store.notInstalled"))}{(item.rules?.autoUpdate ?? item.updateMode === "automatic") ? t("plugins.store.automaticUpdates") : ""}</p>
        <p className="text-xs text-text-ink/60">{platforms.map(platform => ({ win32: "Windows", darwin: "macOS", linux: "Linux" })[platform]).join(" / ")}{item.minimumHostVersion ? ` · Memmy ≥ ${item.minimumHostVersion}` : ""}</p>
        {!supported && <p>{t("plugins.store.unsupportedPlatform")} ({platforms.join(", ")})</p>}
        {!eligibility.canUse && <p>{eligibility.reason === "login_required" ? t("plugins.store.signIn") : t("plugins.store.accessRequired")}</p>}
        <div className="mt-2 flex gap-3">
          {!plugin ? <button disabled={!client || !supported || !eligibility.canInstall || busy !== null} onClick={() => void mutate(item.id, async () => {
            const result = await client!.install(item.id, item.version);
            if (result.state === "pending_approval") setApproval(result); else await client!.enable(item.id);
          })}>{busy === item.id ? t("plugins.store.downloading") : t("plugins.store.install")}</button>
            : <>{plugin.manifest.conversation && plugin.state !== "pending_approval" ? <span className="text-sm">{t("plugins.store.conversationControls")}</span> : <button disabled={busy !== null || !supported || (plugin.state !== "active" && !eligibility.canUse)} onClick={() => plugin.state === "pending_approval" ? setApproval(plugin)
              : void mutate(item.id, () => plugin.state === "active" ? client!.disable(item.id) : client!.enable(item.id))}>
              {plugin.state === "active" ? t("plugins.store.disable") : plugin.state === "pending_approval" ? t("plugins.store.approveAndEnable") : t("plugins.store.enable")}</button>}
              <button disabled={busy !== null} onClick={() => void mutate(item.id, () => client!.uninstall(item.id))}>{t("plugins.store.uninstall")}</button></>}
        </div>{plugin?.lastError && <p role="alert">{plugin.lastError}</p>}
      </article>;
    })}
    <ConfirmDialog open={!!approval} title={t("plugins.store.approvePermissions")}
      message={approval?.manifest.permissions.map(p => p.description ?? (p.type === "host-service" ? p.services.join(", ") : p.type)).join("\n") ?? ""}
      cancelLabel={t("plugins.store.notNow")} confirmLabel={t("plugins.store.approveAndEnable")} onCancel={() => setApproval(null)}
      onConfirm={() => { const plugin = approval; setApproval(null); if (plugin) void mutate(plugin.id, async () => {
        await client!.approvePermissions(plugin.id, plugin.manifest.permissions); await client!.enable(plugin.id);
      }); }} />
  </section>;
}
