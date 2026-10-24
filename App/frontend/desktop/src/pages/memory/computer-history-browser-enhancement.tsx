import { useState } from "react";
import { ChevronDown } from "lucide-react";
import type { MemmyAgentClient } from "../../api/memmy-agent-client.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { BrowserExtensionSetup } from "../browser-extension-setup.js";

export function ComputerHistoryBrowserEnhancement({ client }: { client: MemmyAgentClient | null }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  return <section className="ch__browser-enhancement">
    <button type="button" className="ch__browser-enhancement-heading"
      aria-expanded={expanded} aria-controls="computer-history-browser-extension"
      onClick={() => setExpanded(value => !value)}>
      <span>
        <span className="ch__setting-label">{t("computerHistory.browserEnhancement.title")}</span>
        <span className="ch__setting-description">{t("computerHistory.browserEnhancement.description")}</span>
      </span>
      <ChevronDown size={18} aria-hidden="true" className={expanded ? "ch__browser-enhancement-expanded" : undefined} />
    </button>
    {expanded ? <div id="computer-history-browser-extension">
      <BrowserExtensionSetup client={client} platform={window.memmy?.platform} />
    </div> : null}
  </section>;
}
