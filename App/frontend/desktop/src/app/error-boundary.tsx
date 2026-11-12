/**
 * Last line of defence for a renderer that throws.
 *
 * When a render or lifecycle error escapes React, React unmounts the entire
 * tree. Nothing in this app caught one, so the window kept its chrome and lost
 * every pixel of content — the blank page a user cannot report and cannot
 * recover from. This boundary sits above the providers (so a provider that
 * throws is caught too) and replaces that blank page with the error itself, a
 * retry that remounts the subtree, and a reload.
 *
 * It deliberately avoids `useTranslation` and the app's CSS classes: it renders
 * precisely when the providers above it may have failed, so it reads the
 * message catalog directly, picks a language from the OS, and carries its own
 * styles. A boundary that depends on the tree it is protecting is not a
 * boundary.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { formatMessage, messageCatalogs, type ResolvedLanguage } from "../i18n/messages.js";

export interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  language: ResolvedLanguage;
  /** Bumped per retry so the subtree remounts instead of resuming broken state. */
  attempt: number;
  showDetails: boolean;
}

/** Picks a language without the i18n provider, which may be the thing that broke. */
function preferredLanguage(): ResolvedLanguage {
  if (typeof navigator === "undefined") return "zh-CN";
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some((value) => value?.toLowerCase().startsWith("zh")) ? "zh-CN" : "en-US";
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null,
    language: preferredLanguage(),
    attempt: 0,
    showDetails: false
  };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // main.tsx routes console through electron-log, so this lands in the log
    // file the user can hand over. The component stack is the part that says
    // which subtree threw, and React only gives it to this hook.
    console.error("Renderer error boundary caught:", error, info.componentStack);
  }

  private readonly retry = (): void => {
    this.setState((current) => ({ error: null, attempt: current.attempt + 1, showDetails: false }));
  };

  private readonly reload = (): void => {
    window.location.reload();
  };

  private readonly toggleLanguage = (): void => {
    this.setState((current) => ({ language: current.language === "zh-CN" ? "en-US" : "zh-CN" }));
  };

  private readonly toggleDetails = (): void => {
    this.setState((current) => ({ showDetails: !current.showDetails }));
  };

  private t(key: "app.crash.title" | "app.crash.description" | "app.crash.retry" | "app.crash.reload" | "app.crash.details" | "app.crash.switchLanguage"): string {
    return formatMessage(messageCatalogs[this.state.language][key]);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      // Remounting on `attempt` gives a retry a genuinely fresh subtree rather
      // than the one that just threw, with its broken state still in place.
      return <Subtree key={this.state.attempt}>{this.props.children}</Subtree>;
    }

    return (
      <div style={SCREEN} role="alert">
        <div style={PANEL}>
          <h1 style={TITLE}>{this.t("app.crash.title")}</h1>
          <p style={DESCRIPTION}>{this.t("app.crash.description")}</p>
          <div style={ACTIONS}>
            <button type="button" style={PRIMARY_BUTTON} onClick={this.retry}>
              {this.t("app.crash.retry")}
            </button>
            <button type="button" style={BUTTON} onClick={this.reload}>
              {this.t("app.crash.reload")}
            </button>
            <button type="button" style={BUTTON} onClick={this.toggleLanguage}>
              {this.t("app.crash.switchLanguage")}
            </button>
          </div>
          <button type="button" style={DETAILS_TOGGLE} onClick={this.toggleDetails}>
            {this.t("app.crash.details")}
          </button>
          {this.state.showDetails ? (
            <pre style={DETAILS}>{`${error.name}: ${error.message}\n\n${error.stack ?? ""}`}</pre>
          ) : null}
        </div>
      </div>
    );
  }
}

/** Plain passthrough, so a retry can swap the subtree by key without a fragment import dance. */
function Subtree(props: { children: ReactNode }) {
  return <>{props.children}</>;
}

const SCREEN: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  background: "#f7f5f0",
  fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  zIndex: 2147483647
};

const PANEL: React.CSSProperties = {
  width: "100%",
  maxWidth: "520px",
  padding: "28px",
  borderRadius: "16px",
  border: "1px solid rgba(0,0,0,0.08)",
  background: "#ffffff",
  boxShadow: "0 12px 40px rgba(0,0,0,0.08)"
};

const TITLE: React.CSSProperties = {
  margin: 0,
  fontSize: "18px",
  fontWeight: 600,
  color: "#1f2933"
};

const DESCRIPTION: React.CSSProperties = {
  margin: "10px 0 0",
  fontSize: "13px",
  lineHeight: 1.6,
  color: "rgba(31,41,51,0.65)"
};

const ACTIONS: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px",
  marginTop: "20px"
};

const BUTTON: React.CSSProperties = {
  padding: "7px 14px",
  fontSize: "13px",
  borderRadius: "8px",
  border: "1px solid rgba(0,0,0,0.12)",
  background: "#ffffff",
  color: "#1f2933",
  cursor: "pointer"
};

const PRIMARY_BUTTON: React.CSSProperties = {
  ...BUTTON,
  border: "1px solid transparent",
  background: "#2f9e8f",
  color: "#ffffff"
};

const DETAILS_TOGGLE: React.CSSProperties = {
  marginTop: "18px",
  padding: 0,
  fontSize: "12px",
  border: "none",
  background: "none",
  color: "rgba(31,41,51,0.5)",
  textDecoration: "underline",
  cursor: "pointer"
};

const DETAILS: React.CSSProperties = {
  marginTop: "10px",
  padding: "12px",
  maxHeight: "220px",
  overflow: "auto",
  fontSize: "11px",
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  borderRadius: "8px",
  background: "rgba(0,0,0,0.04)",
  color: "rgba(31,41,51,0.75)"
};
