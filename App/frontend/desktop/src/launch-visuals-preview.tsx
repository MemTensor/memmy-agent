import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Puzzle } from "lucide-react";
import { I18nProvider } from "./i18n/i18n-provider.js";
import { messageCatalogs, type MessageKey } from "./i18n/messages.js";
import { Memmy } from "./components/mascot/memmy.js";
import { RecordingEntryCard, type RecordingEntrySession } from "./pages/recording-entry.js";
import { PluginMarketplaceSection } from "./pages/plugin-marketplace-section.js";
import { officialPluginCatalog } from "./pages/official-plugin-catalog.js";
import { FileTypeIcon } from "./components/file-type-icon.js";
import reviewCoverUrl from "./assets/launch/review-cover-hd.png";
import reviewPageTwoUrl from "./assets/launch/review-page-two-hd.png";
import "./styles.css";
import "./pages/conversation-features.css";
import "./pages/plugin-marketplace.css";
import "./launch-visuals-preview.css";

type Visual = "token" | "token-new" | "recording" | "marketplace" | "literature" | "office";
const visualOptions = [
  { id: "token", label: "preview.launch.extraTokens" },
  { id: "recording", label: "preview.launch.recording" },
  { id: "marketplace", label: "preview.launch.marketplace" },
  { id: "literature", label: "preview.launch.literature" },
  { id: "office", label: "preview.launch.office" }
] as const;
const noop = () => undefined;
const recordingEntry = (t: (key: MessageKey) => string): RecordingEntrySession => ({
  view: "live", status: "recording", elapsedMs: 32_000,
  levels: [.3,.5,.7,.4,.8,.6,.3,.55,.75,.45,.65,.4,.8,.5,.35],
  lines: [
    { startMs: 1_000, endMs: 5_800, text: t("preview.launch.recordingLineOne") },
    { startMs: 7_200, endMs: 13_500, text: t("preview.launch.recordingLineTwo") }
  ],
  live: null, recordings: [], opened: null, deliverables: [], error: null,
  start: noop, pause: noop, resume: noop, finish: noop, back: noop, showLive: noop,
  open: noop, upload: noop, deliver: noop, reset: noop
});

function VisualContent({ visual, language }: { visual: Visual; language: "zh-CN" | "en-US" }) {
  const t = (key: MessageKey) => messageCatalogs[language][key];
  if (visual === "token" || visual === "token-new") return <div className="launch-visual-token">
    <div className="launch-visual-token__mascot"><Memmy pose="celebrate" size={78} /></div>
    <div className="launch-visual-token__label">{t(visual === "token-new" ? "preview.launch.welcome" : "preview.launch.thanks")}</div>
    <div className="launch-visual-token__amount">{t("preview.launch.amount")}<span>{t("preview.launch.unit")}</span></div>
    <div className="launch-visual-token__caption">{t(visual === "token-new" ? "preview.launch.allowance" : "preview.launch.extraTaskTokens")}</div>
  </div>;
  if (visual === "recording") return <div className="launch-visual-recording-story">
    <div className="launch-visual-recording-story__bubble">{t("preview.launch.recordRequest")}</div>
    <div className="launch-visual-recording-story__card"><RecordingEntryCard session={recordingEntry(t)} onClose={noop} onOpenList={noop} /></div>
    <div className="launch-visual-recording-story__transcript">
      <span>{t("preview.launch.liveTranscript")}</span>
      <p><em>00:01</em> {t("preview.launch.recordingLineOne")}</p>
      <p><em>00:07</em> {t("preview.launch.recordingLineTwo")}</p>
    </div>
  </div>;
  if (visual === "marketplace") return <div className="launch-visual-marketplace">
    <div className="launch-visual-marketplace__panel">
      <PluginMarketplaceSection plugins={officialPluginCatalog({ language, installed: [] }).filter((item) => item.id === "literature-review" || item.id === "office")}
        officialModelReady signedIn onInstall={noop} onUpdate={noop} onUninstall={noop} onEnable={noop} onAddToChat={noop}
        onConfigureModel={noop} onRefresh={noop} />
    </div>
    <div className="launch-visual-marketplace__future"><Puzzle size={15} /><span>{t("preview.launch.morePlugins")}</span><i /><i /><i /></div>
  </div>;
  if (visual === "literature") return <div className="launch-visual-literature">
    <div className="launch-visual-literature__card launch-visual-literature__card--back"><img src={reviewPageTwoUrl} alt={t("preview.launch.reviewPageTwoAlt")} /></div>
    <div className="launch-visual-literature__card launch-visual-literature__card--front"><img src={reviewCoverUrl} alt={t("preview.launch.reviewCoverAlt")} /></div>
  </div>;
  return <div className="launch-visual-office-chat">
    <div className="launch-visual-office-chat__question">{t("preview.launch.officeRequest")}</div>
    <div className="launch-visual-office-chat__answer"><span className="launch-visual-office-chat__brand"><Memmy pose="work" size={35} />Memmy</span>
      <p>{t("preview.launch.officeAnswer")}</p>
      <p>{t("preview.launch.officeDelivery")}</p>
      <div className="launch-visual-office-chat__formats" aria-label="Word, Excel, PowerPoint">
        <FileTypeIcon name="report.docx" surface="card" />
        <FileTypeIcon name="data.xlsx" surface="card" />
        <FileTypeIcon name="slides.pptx" surface="card" />
      </div>
    </div>
  </div>;
}

function Preview() {
  const params = new URLSearchParams(window.location.search);
  const selected = params.get("visual") as Visual | null;
  const exportMode = params.get("export") === "1";
  const language = params.get("lang") === "en" ? "en-US" : "zh-CN";
  const t = (key: MessageKey) => messageCatalogs[language][key];
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = messageCatalogs[language]["preview.launch.title"];
  }, [language]);
  const [visual, setVisual] = useState<Visual>(selected === "token-new" || visualOptions.some((item) => item.id === selected) ? selected! : "token");
  const choose = (next: Visual) => { setVisual(next); window.history.replaceState(null, "", `?visual=${next}${language === "en-US" ? "&lang=en" : ""}`); };
  return <I18nProvider language={language}><main className={`launch-visual-preview${exportMode ? " launch-visual-preview--export" : ""}`}>
    <header><strong>{t("preview.launch.title")}</strong><span>{t("preview.launch.subtitle")}</span></header>
    <nav aria-label={t("preview.launch.visualOptions")} className="launch-visual-tabs">{visualOptions.map((item) => <button key={item.id} className={visual === item.id ? "active" : ""} onClick={() => choose(item.id)}>{t(item.label)}</button>)}</nav>
    <div className="launch-visual-stage"><div className="launch-visual-canvas" data-visual={visual}><VisualContent visual={visual} language={language} /></div></div>
    <p className="launch-visual-footnote">{t("preview.launch.footnote")}</p>
  </main></I18nProvider>;
}

createRoot(document.getElementById("root")!).render(<Preview />);
