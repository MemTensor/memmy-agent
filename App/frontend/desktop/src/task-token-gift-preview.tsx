import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "./i18n/i18n-provider.js";
import { TaskTokenGiftDialog } from "./components/task-token-gift-dialog.js";
import "./styles.css";
import "./task-token-gift-preview.css";

type Variant = "new" | "existing" | "existing-gift";
const variants: Array<{ id: Variant; label: string; note: string }> = [
  { id: "new", label: "新用户 · 新功能", note: "发放后不弹到账，11 月 20 日前只看四项新功能" },
  { id: "existing", label: "老用户 · 翻页", note: "11 月 20 日前：到账加四项新功能" },
  { id: "existing-gift", label: "老用户 · 仅到账", note: "11 月 21 日起只显示到账页" }
];
function Preview() {
  const requested = new URLSearchParams(window.location.search).get("variant");
  const initial = (requested === "features-only" ? "new" : requested) as Variant | null;
  const initialLanguage = new URLSearchParams(window.location.search).get("lang") === "en" ? "en-US" : "zh-CN";
  const [variant, setVariant] = useState<Variant>(variants.some((item) => item.id === initial) ? initial! : "existing");
  const [open, setOpen] = useState(true);
  const [language, setLanguage] = useState<"zh-CN" | "en-US">(initialLanguage);
  const choose = (next: Variant) => { setVariant(next); setOpen(true); window.history.replaceState(null, "", `?variant=${next}${language === "en-US" ? "&lang=en" : ""}`); };
  const gift = variant === "new" ? undefined : {
    hasGift: true as const, grantId: "mock-launch-gift-20m",
    audience: "existing" as const, tokenAmount: 20_000_000, totalTokens: 22_000_000
  };
  return <I18nProvider language={language}><main className="gift-preview-page">
    <header><strong>Memmy 1.2.5 · 领取与新功能弹窗</strong><span>交互 mock · 不发放额度</span></header>
    <div className="gift-preview-controls">{variants.map((item) => <button key={item.id} className={variant === item.id ? "active" : ""} onClick={() => choose(item.id)}><strong>{item.label}</strong><small>{item.note}</small></button>)}</div>
    <div className="gift-preview-extra"><button onClick={() => setOpen(true)}>重新打开</button><button onClick={() => {
      const next = language === "zh-CN" ? "en-US" : "zh-CN";
      setLanguage(next); setOpen(true);
      window.history.replaceState(null, "", `?variant=${variant}${next === "en-US" ? "&lang=en" : ""}`);
    }}>中文 / English</button></div>
  </main>
  {open ? <TaskTokenGiftDialog key={`${variant}:${language}`} gift={gift} showFeatures={variant !== "existing-gift"}
    onClose={() => setOpen(false)} onFeaturesCompleted={() => undefined} /> : null}
  </I18nProvider>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
