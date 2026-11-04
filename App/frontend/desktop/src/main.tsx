import { lazy, StrictMode, Suspense, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./app.js";
import { ErrorBoundary } from "./app/error-boundary.js";
import { AppProviders } from "./app/providers.js";
import { initGtag } from "./analytics/gtag-init.js";
import { NicknameModal } from "./components/nickname-modal.js";
import {
  formatRendererFailure,
  registerRendererFailureDiagnostics,
  resolveStartupErrorLanguage,
  StartupErrorBoundary
} from "./components/startup-error-boundary.js";
import { I18nProvider } from "./i18n/i18n-provider.js";
import { randomNickname } from "./lib/nickname.js";
import { MemoryPluginConflictModal } from "./pages/memory-plugin-conflict-modal.js";
import { StartupScreen } from "./pages/startup-screen.js";
import { applyWindowPlatformClass } from "./utils/window-fullscreen.js";
import rendererLog from "electron-log/renderer";
import "./styles.css";

const MemoryPagePreview = lazy(() => import("./pages/memory-page.js").then(({ MemoryPage }) => ({ default: MemoryPage })));

if (typeof window !== "undefined" && window.memmy) {
  Object.assign(console, rendererLog.functions);
}

function reportRendererFailure(error: unknown, source: string, componentStack?: string | null): void {
  try {
    rendererLog.error(`[renderer] ${source}`, formatRendererFailure(error, componentStack));
  } catch {
    // Logging must not prevent the independent recovery page from appearing.
  }
}

const removeFailureDiagnostics = registerRendererFailureDiagnostics(window, reportRendererFailure);
import.meta.hot?.dispose(removeFailureDiagnostics);

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
      <Suspense fallback={<StartupScreen />}>
        <MemoryPagePreview initialSubPage="skills" />
      </Suspense>
    </AppProviders>
  );
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing root element");
}

const previewMode = readDevPreviewMode();
const rendererWindow = window as Window & { __memmyReactRoot?: Root };
const reactRoot = rendererWindow.__memmyReactRoot ?? createRoot(root, {
  onCaughtError: (error, info) => reportRendererFailure(error, "react-render", info.componentStack),
  onUncaughtError: (error, info) => reportRendererFailure(error, "react-uncaught", info.componentStack)
});

if (import.meta.env.DEV) {
  rendererWindow.__memmyReactRoot = reactRoot;
}

reactRoot.render(
  <StartupErrorBoundary
    language={resolveStartupErrorLanguage(navigator.language)}
    onRetry={() => window.location.reload()}
  >
    <StrictMode>
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
    </StrictMode>
  </StartupErrorBoundary>
);
