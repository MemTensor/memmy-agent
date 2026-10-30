import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "./i18n/i18n-provider.js";
import { HistoryLaunchPrompt } from "./components/history-launch-prompt.js";
import "./styles.css";
import "./history-launch-preview.css";

function Preview() {
  const requestedLanguage = new URLSearchParams(window.location.search).get("lang");
  const [language, setLanguage] = useState<"zh-CN" | "en-US">(requestedLanguage === "en" ? "en-US" : "zh-CN");
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState("等待查看弹窗");

  function toggleLanguage() {
    const next = language === "zh-CN" ? "en-US" : "zh-CN";
    setLanguage(next);
    window.history.replaceState(null, "", next === "en-US" ? "?lang=en" : "");
  }

  return <I18nProvider language={language}>
    <main className="history-preview-page">
      <header className="history-preview-header">
        <div>
          <strong>Memmy · Computer History 弹窗 Mock</strong>
          <p>样式已对齐 Token 福利 / 新功能弹窗；这里仅展示界面，不会开启真实记录。</p>
        </div>
        <span>一次性 · 进入「记忆」页后触发</span>
      </header>
      <section className="history-preview-panel">
        <div>
          <b>触发方式</b>
          <p>用户从其他工作区页面主动进入「记忆」页，页面稳定约 0.9 秒后显示。</p>
        </div>
        <div className="history-preview-actions">
          <button type="button" onClick={() => { setOpen(true); setStatus("等待查看弹窗"); }}>重新打开</button>
          <button type="button" onClick={toggleLanguage}>中文 / English</button>
          <small>{status}</small>
        </div>
      </section>
    </main>
    {open ? <HistoryLaunchPrompt
      onDismiss={() => { setOpen(false); setStatus("已关闭"); }}
      onEnable={() => { setOpen(false); setStatus("已选择去开启（Mock，不会启动记录）"); }}
    /> : null}
  </I18nProvider>;
}

createRoot(document.getElementById("root")!).render(<Preview />);
