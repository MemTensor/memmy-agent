import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "./i18n/i18n-provider.js";
import { messageCatalogs, type MessageKey } from "./i18n/messages.js";
import { TaskTokenGiftDialog } from "./components/task-token-gift-dialog.js";
import "./styles.css";
import "./task-token-gift-preview.css";

type Variant = "new" | "existing" | "existing-gift";
const variants = [
  { id: "new", label: "preview.gift.newLabel", note: "preview.gift.newNote" },
  { id: "existing", label: "preview.gift.existingLabel", note: "preview.gift.existingNote" },
  { id: "existing-gift", label: "preview.gift.giftOnlyLabel", note: "preview.gift.giftOnlyNote" }
] as const;
function Preview() {
  const requested = new URLSearchParams(window.location.search).get("variant");
  const initial = (requested === "features-only" ? "new" : requested) as Variant | null;
  const initialLanguage = new URLSearchParams(window.location.search).get("lang") === "en" ? "en-US" : "zh-CN";
  const [variant, setVariant] = useState<Variant>(variants.some((item) => item.id === initial) ? initial! : "existing");
  const [open, setOpen] = useState(true);
  const [language, setLanguage] = useState<"zh-CN" | "en-US">(initialLanguage);
  const t = (key: MessageKey) => messageCatalogs[language][key];
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = messageCatalogs[language]["preview.gift.title"];
  }, [language]);
  const choose = (next: Variant) => { setVariant(next); setOpen(true); window.history.replaceState(null, "", `?variant=${next}${language === "en-US" ? "&lang=en" : ""}`); };
  const gift = variant === "new" ? undefined : {
    hasGift: true as const, grantId: "mock-launch-gift-20m",
    audience: "existing" as const, tokenAmount: 20_000_000, totalTokens: 22_000_000
  };
  return <I18nProvider language={language}><main className="gift-preview-page">
    <header><strong>{t("preview.gift.title")}</strong><span>{t("preview.gift.subtitle")}</span></header>
    <div className="gift-preview-controls">{variants.map((item) => <button key={item.id} className={variant === item.id ? "active" : ""} onClick={() => choose(item.id)}><strong>{t(item.label)}</strong><small>{t(item.note)}</small></button>)}</div>
    <div className="gift-preview-extra"><button onClick={() => setOpen(true)}>{t("preview.gift.reopen")}</button><button onClick={() => {
      const next = language === "zh-CN" ? "en-US" : "zh-CN";
      setLanguage(next); setOpen(true);
      window.history.replaceState(null, "", `?variant=${variant}${next === "en-US" ? "&lang=en" : ""}`);
    }}>{t("preview.gift.languages")}</button></div>
  </main>
  {open ? <TaskTokenGiftDialog key={`${variant}:${language}`} gift={gift} showFeatures={variant !== "existing-gift"}
    onClose={() => setOpen(false)} onFeaturesCompleted={() => undefined} /> : null}
  </I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
