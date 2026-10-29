import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Puzzle } from "lucide-react";
import { I18nProvider } from "./i18n/i18n-provider.js";
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
const visualOptions: Array<{ id: Exclude<Visual, "token-new">; label: string }> = [
  { id: "token", label: "额外赠送 Token" },
  { id: "recording", label: "录音" },
  { id: "marketplace", label: "插件商店" },
  { id: "literature", label: "文献综述" },
  { id: "office", label: "Office" }
];
const englishLabels: Record<Exclude<Visual, "token-new">, string> = {
  token: "Extra Task Tokens", recording: "Recording", marketplace: "Marketplace",
  literature: "Literature Review", office: "Office"
};
const noop = () => undefined;
const recordingEntry: RecordingEntrySession = {
  view: "live", status: "recording", elapsedMs: 32_000,
  levels: [.3,.5,.7,.4,.8,.6,.3,.55,.75,.45,.65,.4,.8,.5,.35],
  lines: [
    { startMs: 1_000, endMs: 5_800, text: "我们今天先看一下这次版本的新功能。" },
    { startMs: 7_200, endMs: 13_500, text: "插件商店和录音都可以直接在 Memmy 里使用。" }
  ],
  live: null, recordings: [], opened: null, deliverables: [], error: null,
  start: noop, pause: noop, resume: noop, finish: noop, back: noop, showLive: noop,
  open: noop, upload: noop, deliver: noop, reset: noop
};

function VisualContent({ visual, language }: { visual: Visual; language: "zh-CN" | "en-US" }) {
  const english = language === "en-US";
  if (visual === "token" || visual === "token-new") return <div className="launch-visual-token">
    <div className="launch-visual-token__mascot"><Memmy pose="celebrate" size={78} /></div>
    <div className="launch-visual-token__label">{english
      ? visual === "token-new" ? "Welcome to Memmy" : "Thank you for supporting Memmy"
      : visual === "token-new" ? "欢迎加入 Memmy" : "感谢你一直支持 Memmy"}</div>
    <div className="launch-visual-token__amount">{english ? "20" : "2000"}<span>{english ? "M" : "万"}</span></div>
    <div className="launch-visual-token__caption">{english
      ? visual === "token-new" ? "Task Token Allowance" : "Extra Task Tokens"
      : visual === "token-new" ? "任务体验 Token" : "额外赠送任务 Token"}</div>
  </div>;
  if (visual === "recording") return <div className="launch-visual-recording-story">
    <div className="launch-visual-recording-story__bubble">{english ? "Record this discussion for me" : "帮我记录这次讨论"}</div>
    <div className="launch-visual-recording-story__card"><RecordingEntryCard session={recordingEntry} onClose={noop} onOpenList={noop} /></div>
    <div className="launch-visual-recording-story__transcript">
      <span>{english ? "Live transcript" : "实时转写"}</span>
      <p><em>00:01</em> {english ? "Let's review what's new in this release." : "我们今天先看一下这次版本的新功能。"}</p>
      <p><em>00:07</em> {english ? "The marketplace and recording are ready in Memmy." : "插件商店和录音都可以直接在 Memmy 里使用。"}</p>
    </div>
  </div>;
  if (visual === "marketplace") return <div className="launch-visual-marketplace">
    <div className="launch-visual-marketplace__panel">
      <PluginMarketplaceSection plugins={officialPluginCatalog({ language, installed: [] }).filter((item) => item.id === "literature-review" || item.id === "office")}
        officialModelReady signedIn onInstall={noop} onUpdate={noop} onUninstall={noop} onEnable={noop} onAddToChat={noop}
        onConfigureModel={noop} onRefresh={noop} />
    </div>
    <div className="launch-visual-marketplace__future"><Puzzle size={15} /><span>{english ? "More plugins coming soon" : "更多插件陆续上架"}</span><i /><i /><i /></div>
  </div>;
  if (visual === "literature") return <div className="launch-visual-literature">
    <div className="launch-visual-literature__card launch-visual-literature__card--back"><img src={reviewPageTwoUrl} alt="综述第二页" /></div>
    <div className="launch-visual-literature__card launch-visual-literature__card--front"><img src={reviewCoverUrl} alt="Memmy 文献综述插件生成的综述首页" /></div>
  </div>;
  return <div className="launch-visual-office-chat">
    <div className="launch-visual-office-chat__question">{english ? "Read this spreadsheet and make a presentation" : "帮我读取这份表格，整理成汇报 PPT"}</div>
    <div className="launch-visual-office-chat__answer"><span className="launch-visual-office-chat__brand"><Memmy pose="work" size={35} />Memmy</span>
      <p>{english ? "I can read and edit Word, Excel, and PowerPoint files, and work with PDFs." : "可以。我能读取和编辑 Word、Excel、PPT，也能处理 PDF。"}</p>
      <p>{english ? "I'll analyze the data and deliver an editable presentation." : "先分析表格，再把可编辑的汇报文件交付给你。"}</p>
      <div className="launch-visual-office-chat__formats" aria-label="Word、Excel、PPT">
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
  const [visual, setVisual] = useState<Visual>(selected === "token-new" || visualOptions.some((item) => item.id === selected) ? selected! : "token");
  const choose = (next: Visual) => { setVisual(next); window.history.replaceState(null, "", `?visual=${next}${language === "en-US" ? "&lang=en" : ""}`); };
  return <I18nProvider language={language}><main className={`launch-visual-preview${exportMode ? " launch-visual-preview--export" : ""}`}>
    <header><strong>{language === "en-US" ? "Memmy 1.2.5 · Launch visuals" : "Memmy 1.2.5 · 弹窗右侧图片"}</strong><span>{language === "en-US" ? "Preview assets" : "独立视觉稿 · 左侧内容待定"}</span></header>
    <nav aria-label="右侧图片" className="launch-visual-tabs">{visualOptions.map((item) => <button key={item.id} className={visual === item.id ? "active" : ""} onClick={() => choose(item.id)}>{language === "en-US" ? englishLabels[item.id] : item.label}</button>)}</nav>
    <div className="launch-visual-stage"><div className="launch-visual-canvas" data-visual={visual}><VisualContent visual={visual} language={language} /></div></div>
    <p className="launch-visual-footnote">{language === "en-US" ? "Mock content uses existing Memmy components and the supplied PDF. No tokens are granted here." : "录音和插件商店使用 1.2.5 现有组件；文献综述两页来自你提供的真实 PDF。对话文字是示意，Office 文件图标来自应用。这里没有连接账号或发放 Token。"}</p>
  </main></I18nProvider>;
}

createRoot(document.getElementById("root")!).render(<Preview />);
