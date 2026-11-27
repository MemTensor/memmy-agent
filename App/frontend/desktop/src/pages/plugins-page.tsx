import { useApiClients } from "../app/providers.js";
import { useTranslation } from "../i18n/use-translation.js";
import { AppFrame } from "./app-frame.js";
import { PluginStoreSection } from "./plugin-store-section.js";

export function PluginsPage() {
  const { clients } = useApiClients(), { t } = useTranslation();
  return <AppFrame title={t("nav.plugins")}>
    <div className="app-frame-page-content p-6"><PluginStoreSection client={clients?.plugins} /></div>
  </AppFrame>;
}
