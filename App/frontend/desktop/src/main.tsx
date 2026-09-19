import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { ErrorBoundary } from "./app/error-boundary.js";
import { AppProviders } from "./app/providers.js";
import { initGtag } from "./analytics/gtag-init.js";
import { NicknameModal } from "./components/nickname-modal.js";
import { I18nProvider } from "./i18n/i18n-provider.js";
import { randomNickname } from "./lib/nickname.js";
import { MemoryPage } from "./pages/memory-page.js";
import { MemoryPluginConflictModal } from "./pages/memory-plugin-conflict-modal.js";
import { StartupScreen } from "./pages/startup-screen.js";
import { applyWindowPlatformClass } from "./utils/window-fullscreen.js";
import rendererLog from "electron-log/renderer";
import "./styles.css";

if (typeof window !== "undefined" && window.memmy) {
  Object.assign(console, rendererLog.functions);
}

/*
 * Errors that never reach React — a rejected promise in an effect callback, a
 * throw inside a socket handler — used to disappear into the devtools console
 * while the window sat there looking fine. Routing them through `console`
 * puts them in the electron-log file alongside everything else, so a report of
 * "it went blank" has something to read.
 */
if (typeof window !== "undefined") {
  window.addEventListener("error", (event) => {
    console.error("Uncaught renderer error:", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error("Unhandled renderer rejection:", event.reason);
  });
}

applyWindowPlatformClass(window.memmy?.platform);

initGtag();

function readDevPreviewMode(): string | null {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const direct = params.get("preview");
  if (direct) {
    return direct;
  }

  for (const [key] of params.entries()) {
    if (key === "preview=startup" || decodeURIComponent(key) === "preview=startup") {
      return "startup";
    }
  }

  return null;
}

function NicknameModalPreview() {
  const [nickname, setNickname] = useState(() => randomNickname("zh-CN"));

  return (
    <NicknameModal
      open
      nickname={nickname}
      onNicknameChange={setNickname}
      onShuffle={() => setNickname(randomNickname("zh-CN"))}
      onSubmit={() => undefined}
    />
  );
}

function MemoryPluginConflictModalPreview() {
  return (
    <I18nProvider language="zh-CN">
      <main className="min-h-screen bg-canvas-oat">
        <MemoryPluginConflictModal onChoice={() => undefined} />
      </main>
    </I18nProvider>
  );
}

function MemorySkillsPreview() {
  return (
    <AppProviders>
      <MemoryPage initialSubPage="skills" />
    </AppProviders>
  );
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

const previewMode = readDevPreviewMode();

createRoot(root).render(
  <StrictMode>
    {/*
      The boundary wraps the preview routes too: each mounts its own providers,
      so a failure in any of them would blank the window the same way.
    */}
    <ErrorBoundary>
      {previewMode === "startup" ? (
        <I18nProvider language="zh-CN">
          <StartupScreen />
        </I18nProvider>
      ) : previewMode === "nickname" ? (
        <I18nProvider language="zh-CN">
          <NicknameModalPreview />
        </I18nProvider>
      ) : previewMode === "memory-plugin-conflict" ? (
        <MemoryPluginConflictModalPreview />
      ) : previewMode === "memory-skills" ? (
        <MemorySkillsPreview />
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </StrictMode>
);
