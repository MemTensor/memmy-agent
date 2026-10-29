import { messageCatalogs, resolveLanguage, type MessageKey } from "../i18n/messages.js";
import type { InstalledPlugin } from "@memmy/local-api-contracts";
import type { MarketplacePlugin } from "./plugin-marketplace-section.js";

/**
 * Presentation policy only — a stand-in for the plugin-declared rules and the
 * server-issued eligibility that will drive this catalog. `audience` marks who a
 * plugin targets (server enforces the beta whitelist); `requiresLogin` / `requiresOfficialModel`
 * are the account requirements the marketplace reads per plugin.
 */
export const OFFICIAL_PLUGIN_POLICIES = {
  "literature-review": { audience: "public", defaultInstalled: true, requiresLogin: true, requiresOfficialModel: true },
  "office": { audience: "public" },
  "legal-labor": { audience: "beta", requiresLogin: true }
} as const;

export function pluginRequiresOfficialModel(pluginId: string | null | undefined): boolean {
  return pluginId === "literature-review";
}

export function officialPluginCatalog(options: {
  language: string;
  installed: InstalledPlugin[];
}): MarketplacePlugin[] {
  const t = (key: MessageKey) => messageCatalogs[resolveLanguage(options.language)][key];
  const installedOf = (id: string) => options.installed.find((plugin) => plugin.id === id);
  return [
    {
      id: "literature-review", category: "research",
      name: t("plugins.ui.literatureReview"),
      description: t("plugins.catalog.findPapersOrganizeEvidenceAndDraftAReferenced"),
      ...OFFICIAL_PLUGIN_POLICIES["literature-review"],
      version: installedOf("literature-review")?.version,
      installable: true,
      installed: installedOf("literature-review")
    },
    {
      id: "office", category: "office",
      name: "Office",
      description: t("plugins.catalog.createAndEditWordExcelAndPowerPointFiles"),
      ...OFFICIAL_PLUGIN_POLICIES["office"],
      version: installedOf("office")?.version,
      installable: true,
      installed: installedOf("office")
    },
    {
      id: "legal-labor", category: "legal",
      name: t("plugins.catalog.employmentComplianceDiagnosis"),
      description: t("plugins.catalog.organizeEmploymentResearchMaterialsVerifyInformationAndDraft"),
      ...OFFICIAL_PLUGIN_POLICIES["legal-labor"],
      version: installedOf("legal-labor")?.version,
      installable: true,
      installed: installedOf("legal-labor")
    }
  ];
}
