import { useState } from "react";
import type { InstalledPlugin } from "@memmy/local-api-contracts";
import { useTranslation } from "../i18n/use-translation.js";
import { officialPluginCatalog } from "./official-plugin-catalog.js";
import { PluginMarketplaceSection, type MarketplacePlugin } from "./plugin-marketplace-section.js";

/** Preview-only account states, standing in for the sign-in + beta eligibility the server will supply. */
type PreviewAccount = "signed-out" | "member" | "beta";

/** Development-only, isolated interaction preview. Never calls the real plugin client. */
export default function PluginMarketplacePreview() {
  const { language, t } = useTranslation();
  const literatureName = t("plugins.ui.literatureReview");
  const legalName = t("plugins.ui.legal");
  // Auto-installed plugins for a given eligibility, preserving any manually installed ones (e.g. Office).
  // Mirrors "eligibility met -> auto-installed": literature on sign-in, legal on beta access.
  function autoInstalledFor(next: PreviewAccount, manual: InstalledPlugin[] = []): InstalledPlugin[] {
    const list = [previewInstallation("literature-review", literatureName, t("common.preview"))];
    if (next === "beta") list.push(previewInstallation("legal", legalName, t("common.preview")));
    return [...list, ...manual.filter((item) => item.id !== "literature-review" && item.id !== "legal")];
  }
  const [officialModelReady, setOfficialModelReady] = useState(true);
  const [account, setAccount] = useState<PreviewAccount>("beta");
  const [installed, setInstalled] = useState<InstalledPlugin[]>(() => autoInstalledFor("beta"));
  const [notice, setNotice] = useState<string | null>(null);

  const signedIn = account !== "signed-out";
  const hasBeta = account === "beta";
  // Server-applied visibility: beta-only plugins (legal) are hidden unless the account is whitelisted.
  const plugins = officialPluginCatalog({ language, installed })
    .filter((plugin) => plugin.category !== "legal" || hasBeta);

  const accountOptions: { id: PreviewAccount; label: string }[] = [
    { id: "signed-out", label: t("plugins.ui.signedOut") },
    { id: "member", label: t("plugins.ui.signedInNoBeta") },
    { id: "beta", label: t("plugins.ui.signedInBeta") }
  ];

  // Switching account is a preview "eligibility refresh": auto-install what now qualifies, keep manual installs.
  function selectAccount(next: PreviewAccount) {
    setAccount(next);
    setNotice(null);
    setInstalled((items) => autoInstalledFor(next, items));
  }

  function install(plugin: MarketplacePlugin) {
    setInstalled((items) => [...items.filter((item) => item.id !== plugin.id), previewInstallation(plugin.id, plugin.name, t("common.preview"))]);
    setNotice(t("plugins.ui.previewInstalled", { name: plugin.name }));
  }

  return <>
    <aside className="plugin-marketplace-preview">
      <details>
        <summary>{t("plugins.ui.interactionPreviewDemoData")}</summary>
        <div className="plugin-marketplace-preview-controls">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <strong>{t("plugins.ui.interactionPreview")}</strong>
          <p className="mt-1 opacity-70">{t("plugins.ui.simulatesThePlannedReleaseInstallsAndRemovalsHere")}</p>
        </div>
        <button type="button" className="plugin-marketplace-preview-reset rounded-md px-3 py-1.5" onClick={() => {
          setAccount("beta"); setInstalled(autoInstalledFor("beta"));
          setOfficialModelReady(true); setNotice(null);
        }}>{t("plugins.ui.resetPreview")}</button>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="opacity-70">{t("plugins.ui.accountState")}</span>
        <div className="inline-flex flex-wrap gap-1.5" role="group" aria-label={t("plugins.ui.accountState")}>
          {accountOptions.map((option) => (
            <button key={option.id} type="button" aria-pressed={account === option.id}
              onClick={() => selectAccount(option.id)}
              className={`rounded-md border px-3 py-1.5 ${account === option.id
                ? "border-action-sky-hover bg-action-sky-hover/10 text-action-sky-hover"
                : "border-border-stone/40 text-text-ink/70 hover:bg-text-ink/5"}`}>
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-5">
        <label className="flex items-center gap-2"><input type="checkbox" checked={officialModelReady} onChange={(event) => setOfficialModelReady(event.target.checked)} />
          {t("plugins.ui.officialModelAvailable")}</label>
      </div>
        </div>
      </details>
    </aside>
    {notice && <p role="status" className="mb-3 text-xs text-text-ink/60">{notice}</p>}
    <PluginMarketplaceSection plugins={plugins} officialModelReady={officialModelReady} signedIn={signedIn}
      onRefresh={() => setNotice(t("plugins.ui.previewStateRefreshed"))}
      onInstall={install} onUpdate={install} onEnable={install}
      onUninstall={(plugin) => {
        setInstalled((items) => items.filter((item) => item.id !== plugin.id));
        setNotice(t("plugins.ui.previewUninstalled", { name: plugin.name }));
      }}
      onAddToChat={(plugin) => setNotice(t("plugins.ui.previewWouldBeAddedToTheCurrentChat", { name: plugin.name }))}
      onConfigureModel={() => setNotice(t("plugins.ui.thisOpensModelSettingsInTheAppCheck"))}
      onSignIn={() => { selectAccount("member"); setNotice(t("plugins.ui.previewSignedIn")); }}
    />
  </>;
}

function previewInstallation(id: string, name: string, version: string): InstalledPlugin {
  return {
    id, version, state: "active", approvedPermissions: [], config: {}, lastError: null,
    createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z",
    manifest: {
      apiVersion: "memmy/v1", id, name, version, runtime: { adapter: "command" },
      permissions: [], capabilities: [{ id: "preview", name: "Preview", description: "Preview only",
        inputSchema: {}, outputSchema: {}, execution: "request" }]
    }
  };
}
