import { Component, type ReactNode } from "react";
import { messageCatalogs } from "../i18n/messages.js";

type StartupErrorLanguage = "zh-CN" | "en-US";
type ErrorReporter = (error: unknown, source: string, componentStack?: string | null) => void;

export function resolveStartupErrorLanguage(language: string | undefined): StartupErrorLanguage {
  return language?.toLowerCase().startsWith("en") ? "en-US" : "zh-CN";
}

/** Keep the recovery page independent of the providers that may have failed. */
export function StartupErrorScreen(props: { language: StartupErrorLanguage; onRetry: () => void }) {
  const copy = messageCatalogs[props.language];
  return (
    <main className="min-h-screen bg-canvas-oat px-6 flex items-center justify-center" role="alert">
      <div className="max-w-sm text-center">
        <h1 className="text-xl font-semibold text-text-ink">
          {copy["app.error.title"]}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-text-ink/60">
          {copy["app.error.body"]}
        </p>
        <button
          type="button"
          onClick={props.onRetry}
          className="mt-5 px-8 py-2.5 bg-action-sky text-white rounded-btn hover:bg-action-sky-hover cursor-pointer"
        >
          {copy["app.error.retry"]}
        </button>
      </div>
    </main>
  );
}

export class StartupErrorBoundary extends Component<{
  children: ReactNode;
  language: StartupErrorLanguage;
  onRetry: () => void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    return this.state.failed
      ? <StartupErrorScreen language={this.props.language} onRetry={this.props.onRetry} />
      : this.props.children;
  }
}

/** These diagnostics stay in the local renderer log; never expand arbitrary rejection payloads. */
export function formatRendererFailure(error: unknown, componentStack?: string | null): string {
  const description = error instanceof Error
    ? error.stack || `${error.name}: ${error.message}`
    : `Non-Error failure (${typeof error})`;
  return redactDiagnosticText([description, componentStack].filter(Boolean).join("\n")).slice(0, 8_000);
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [redacted]")
    .replace(/((?:["']?)(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s<>'")]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.href;
      } catch {
        return "[url]";
      }
    });
}

/** Log asynchronous failures without changing their default browser behavior or showing dialogs. */
export function registerRendererFailureDiagnostics(target: Window, report: ErrorReporter): () => void {
  const onError = (event: ErrorEvent) => report(
    event.error ?? new Error(event.message || "Unknown renderer script error"), "window-error"
  );
  const onRejection = (event: PromiseRejectionEvent) => report(event.reason, "unhandled-rejection");
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
