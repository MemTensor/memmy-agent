/** Connect integration modal module. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isIntegrationSetupDiagnosticError, logHiddenIntegrationSetupDiagnosticError } from "../api/integration-errors.js";
import type { IntegrationsClient } from "../api/integrations-client.js";
import { deriveIntegrationState, type IntegrationConnection } from "../integrations/connection-state.js";
import { IntegrationLogoBadge, type IntegrationMeta } from "../integrations/integration-meta.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { openUrl as defaultOpenUrl } from "../utils/open-url.js";

export type ConnectIntegrationPhase = "idle" | "authorizing" | "waiting" | "connected" | "disconnecting" | "error";

/** Contract for connect integration modal props. */
export interface ConnectIntegrationModalProps {
  open: boolean;
  integration: IntegrationMeta | null;
  connection?: IntegrationConnection;
  client: IntegrationsClient;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  openUrlFn?: (url: string) => Promise<void>;
  onClose: () => void;
  onChanged: () => void;
  forcedPhase?: ConnectIntegrationPhase;
  errorMessage?: string;
  qrWarning?: boolean;
}

/** Contract for integration connect flow input. */
export interface IntegrationConnectFlowInput {
  slug: string;
  client: IntegrationsClient;
  openUrl: (url: string) => Promise<void>;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  onPhase?: (phase: ConnectIntegrationPhase) => void;
  onConnectUrl?: (url: string) => void;
  signal?: AbortSignal;
}

/** Contract for integration connect flow result. */
export interface IntegrationConnectFlowResult {
  phase: ConnectIntegrationPhase;
  connection?: IntegrationConnection;
  error?: unknown;
  cancelled?: boolean;
}

/** Handles connect integration modal. */
export function ConnectIntegrationModal(props: ConnectIntegrationModalProps) {
  const { t } = useTranslation();
  const initialPhase = useMemo<ConnectIntegrationPhase>(() => deriveInitialModalPhase(props.connection, props.forcedPhase), [props.connection, props.forcedPhase]);
  const [phase, setPhase] = useState<ConnectIntegrationPhase>(initialPhase);
  const [activeConnection, setActiveConnection] = useState<IntegrationConnection | undefined>(props.connection);
  const [connectUrl, setConnectUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState(props.errorMessage ?? "");
  const [qrWarning, setQrWarning] = useState(Boolean(props.qrWarning));
  const mountedRef = useRef(false);
  const flowIdRef = useRef(0);
  const flowAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      flowIdRef.current += 1;
      flowAbortRef.current?.abort();
      flowAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    setPhase(initialPhase);
    setActiveConnection(props.connection);
    setErrorMessage(props.errorMessage ?? "");
    setQrWarning(Boolean(props.qrWarning));
  }, [initialPhase, props.connection, props.errorMessage, props.qrWarning]);

  useEffect(() => {
    if (!props.open) {
      return undefined;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [props]);

  const handleConnect = useCallback(async () => {
    if (!props.integration) {
      return;
    }

    if (!canStartOAuthConnect(props.integration)) {
      setQrWarning(true);
      return;
    }

    flowAbortRef.current?.abort();
    const abortController = new AbortController();
    const flowId = flowIdRef.current + 1;
    flowIdRef.current = flowId;
    flowAbortRef.current = abortController;
    const isCurrentFlow = () => mountedRef.current && flowIdRef.current === flowId && !abortController.signal.aborted;

    const result = await runIntegrationConnectFlow({
      slug: props.integration.slug,
      client: props.client,
      openUrl: props.openUrlFn ?? defaultOpenUrl,
      pollIntervalMs: props.pollIntervalMs ?? 4000,
      pollTimeoutMs: props.pollTimeoutMs ?? 5 * 60 * 1000,
      signal: abortController.signal,
      onPhase: (nextPhase) => {
        if (isCurrentFlow()) {
          setPhase(nextPhase);
        }
      },
      onConnectUrl: (nextConnectUrl) => {
        if (isCurrentFlow()) {
          setConnectUrl(nextConnectUrl);
        }
      }
    });

    if (!isCurrentFlow() || result.cancelled) {
      return;
    }

    if (result.phase === "connected" && result.connection) {
      setActiveConnection(result.connection);
      props.onChanged();
      return;
    }

    if (result.phase === "error") {
      setErrorMessage(toErrorMessage(result.error) || t("tools.modal.oauthTimeout"));
    }
  }, [props, t]);

  const handleReopenBrowser = useCallback(async () => {
    if (!connectUrl) {
      return;
    }

    await (props.openUrlFn ?? defaultOpenUrl)(connectUrl);
  }, [connectUrl, props.openUrlFn]);

  const handleDisconnect = useCallback(async () => {
    const connectionId = activeConnection?.id ?? props.connection?.id;

    if (!connectionId) {
      setPhase("idle");
      return;
    }

    setPhase("disconnecting");
    flowAbortRef.current?.abort();

    try {
      await props.client.deleteConnection(connectionId);
      setActiveConnection(undefined);
      setPhase("idle");
      props.onChanged();
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
      setPhase("error");
    }
  }, [activeConnection, props]);

  if (!props.open || !props.integration) {
    return null;
  }

  const body = (
    <div
      className="fixed inset-0 z-[9999] bg-black/30 backdrop-blur-sm flex items-center justify-center p-4"
      onMouseDown={props.onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="integration-connect-title"
        tabIndex={-1}
        className="bg-white border border-stone-200 rounded-3xl shadow-large w-full max-w-[460px] overflow-hidden animate-fade-up focus:outline-none focus:ring-0"
        style={{
          animationDuration: "200ms",
          animationTimingFunction: "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          animationFillMode: "both"
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="p-4 border-b border-stone-200">
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0 pr-2">
              <div className="flex items-center gap-2">
                <IntegrationLogoBadge slug={props.integration.slug} name={props.integration.name} surface={props.integration.surface} />
                <h2 id="integration-connect-title" className="text-base font-semibold text-stone-900">
                  {phase === "connected" ? `${t("tools.modal.manage")} ${props.integration.name}` : `${t("tools.modal.connect")} ${props.integration.name}`}
                </h2>
              </div>
              <p className="text-xs text-stone-400 mt-1.5 line-clamp-2">{props.integration.description}</p>
            </div>
            <button
              type="button"
              className="p-1 text-stone-400 hover:text-stone-900 transition-colors rounded-lg hover:bg-stone-100 flex-shrink-0"
              onClick={props.onClose}
              aria-label={t("common.close")}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="p-4 space-y-3">
          {renderPhaseBody({
            phase,
            integration: props.integration,
            errorMessage,
            qrWarning,
            connectUrl,
            onConnect: handleConnect,
            onDisconnect: handleDisconnect,
            onClose: props.onClose,
            onDismiss: () => {
              setErrorMessage("");
              setPhase("idle");
            },
            onReopenBrowser: handleReopenBrowser,
            t
          })}
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") {
    return body;
  }

  return createPortal(body, document.body);
}

/**
 * Derives the modal's initial phase from the external connection record.
 *
 * @param connection the connection record returned by the backend.
 * @param forcedPhase a phase specified by tests or as a fallback, with the highest priority.
 * @returns the modal phase corresponding to the current connection record.
 */
function deriveInitialModalPhase(connection: IntegrationConnection | undefined, forcedPhase?: ConnectIntegrationPhase): ConnectIntegrationPhase {
  if (forcedPhase) {
    return forcedPhase;
  }

  const connectionState = deriveIntegrationState(connection);

  if (connectionState === "connected") {
    return "connected";
  }

  if (connectionState === "pending") {
    return "waiting";
  }

  return "idle";
}

/**
 * Runs the connection flow: authorize, open the browser, poll connections.
 *
 * @param input the connection flow input.
 * @returns the final phase and connection record.
 */
export async function runIntegrationConnectFlow(input: IntegrationConnectFlowInput): Promise<IntegrationConnectFlowResult> {
  try {
    if (isCancelled(input.signal)) {
      return cancelledResult();
    }

    input.onPhase?.("authorizing");
    const authorization = await input.client.authorize(input.slug);
    if (isCancelled(input.signal)) {
      return cancelledResult();
    }

    input.onConnectUrl?.(authorization.connectUrl);
    input.onPhase?.("waiting");

    try {
      await input.openUrl(authorization.connectUrl);
    } catch (error) {
      console.warn("[tools] Failed to open authorization URL; continuing to wait for connection state:", error);
    }

    const deadline = Date.now() + input.pollTimeoutMs;

    while (Date.now() <= deadline) {
      if (isCancelled(input.signal)) {
        return cancelledResult();
      }

      let response: Awaited<ReturnType<IntegrationsClient["listConnections"]>>;
      try {
        response = await input.client.listConnections();
      } catch (error) {
        if (isIntegrationSetupDiagnosticError(error)) {
          logHiddenIntegrationSetupDiagnosticError(error);
          input.onPhase?.("idle");
          return { phase: "idle" };
        }

        console.warn("[tools] Failed to poll connection state; retrying on the next tick:", error);
        await wait(input.pollIntervalMs, input.signal);
        continue;
      }

      if (isCancelled(input.signal)) {
        return cancelledResult();
      }

      const connection = response.connections.find((item) => item.id === authorization.connectionId);
      const state = deriveIntegrationState(connection);

      if (state === "connected" && connection) {
        input.onPhase?.("connected");
        return { phase: "connected", connection };
      }

      if (state === "error") {
        input.onPhase?.("error");
        return { phase: "error", connection, error: new Error("Connection failed") };
      }

      await wait(input.pollIntervalMs, input.signal);
    }

    if (isCancelled(input.signal)) {
      return cancelledResult();
    }

    input.onPhase?.("error");
    return { phase: "error", error: new Error("Connection timed out") };
  } catch (error) {
    if (isCancelled(input.signal)) {
      return cancelledResult();
    }

    if (isIntegrationSetupDiagnosticError(error)) {
      logHiddenIntegrationSetupDiagnosticError(error);
      input.onPhase?.("idle");
      return { phase: "idle" };
    }

    input.onPhase?.("error");
    return { phase: "error", error };
  }
}

/**
 * Renders the current phase body.
 *
 * @param input the phase render input.
 * @returns the phase body node.
 */
function renderPhaseBody(input: {
  phase: ConnectIntegrationPhase;
  integration: IntegrationMeta;
  errorMessage: string;
  qrWarning: boolean;
  connectUrl: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onClose: () => void;
  onDismiss: () => void;
  onReopenBrowser: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}): ReactNode {
  if (input.phase === "authorizing") {
    return <p className="text-sm text-stone-500">{input.t("tools.modal.requestingUrl")}</p>;
  }

  if (input.phase === "waiting") {
    const waitingProvider = input.integration.authProvider;

    return (
      <>
        <div className="flex items-center gap-2 text-sm text-stone-600">
          <span className="w-2 h-2 rounded-full bg-amber-300" />
          <span>
            {input.t("tools.modal.waitingFor")} {input.integration.name} {input.t("tools.modal.oauthComplete")}
          </span>
        </div>
        <button
          type="button"
          className="w-full rounded-xl border border-stone-200 bg-white text-stone-700 text-sm font-semibold py-2.5 hover:bg-stone-50 transition-colors"
          onClick={input.onReopenBrowser}
        >
          {input.t("tools.modal.reopenBrowser")}
        </button>
        <p className="text-xs text-stone-400">
          {waitingProvider ? input.t("tools.modal.waitingProviderHint", { provider: waitingProvider }) : input.t("tools.modal.waitingHint")}
        </p>
      </>
    );
  }

  if (input.phase === "connected") {
    return (
      <>
        <div className="flex items-center gap-2 text-sm text-sage-700">
          <span className="w-2 h-2 rounded-full bg-sage-500" />
          <span>
            {input.integration.name} {input.t("tools.modal.isConnected")}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            className="w-full rounded-xl border border-coral-200 bg-coral-50 text-coral-700 text-sm font-normal py-2.5 hover:bg-coral-100 transition-colors"
            onClick={input.onDisconnect}
          >
            {input.t("tools.modal.disconnect")}
          </button>
          <button
            type="button"
            className="w-full rounded-xl bg-action-sky text-white text-sm font-normal py-2.5 hover:bg-action-sky-hover transition-colors"
            onClick={input.onClose}
          >
            {input.t("common.close")}
          </button>
        </div>
      </>
    );
  }

  if (input.phase === "disconnecting") {
    return <p className="text-sm text-stone-500">{input.t("tools.modal.disconnecting")}</p>;
  }

  if (input.phase === "error") {
    return (
      <>
        <div className="agent-model-error-notice" role="alert">
          <div className="agent-model-error-notice__header">
            <p className="agent-model-error-notice__title">{input.errorMessage || input.t("tools.modal.connectionFailed")}</p>
          </div>
        </div>
        <button
          type="button"
          className="w-full rounded-xl border border-stone-200 bg-white text-stone-700 text-sm font-normal py-2 hover:bg-stone-50 transition-colors"
          onClick={input.onDismiss}
        >
          {input.t("common.dismiss")}
        </button>
      </>
    );
  }

  const canConnectWithOAuth = canStartOAuthConnect(input.integration);
  const showAuthPendingWarning = input.qrWarning || !canConnectWithOAuth;
  const idleDescription = canConnectWithOAuth
    ? `${input.t("tools.modal.idleDescription")} ${input.integration.name} ${input.t("tools.modal.idleDescriptionSuffix")}`
    : input.t("tools.modal.channelPendingDescription");
  const authProvider = input.integration.authProvider;

  return (
    <>
      <p className="text-sm font-normal text-stone-600">{idleDescription}</p>
      <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
        <p className="mt-1 text-xs leading-relaxed text-stone-600">
          {input.integration.name} {input.t("tools.modal.permissionsNote")} <span className="font-normal">{input.integration.permissionLabel}</span>.{" "}
          {input.t("tools.modal.permissionsNoteSuffix")}
        </p>
      </div>
      {authProvider && (
        <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
          <p className="text-xs font-medium text-stone-500 mb-1">
            <svg className="inline-block w-3.5 h-3.5 mr-1 -mt-px" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            {input.t("tools.modal.authProviderNote", { provider: authProvider })}
          </p>
          <p className="text-xs leading-relaxed text-stone-400">
            {input.t("tools.modal.authProviderHint", { provider: authProvider })}
          </p>
        </div>
      )}
      {showAuthPendingWarning && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          {input.t(pendingAuthWarningKey(input.integration))}
        </div>
      )}
      <button
        type="button"
        className="w-full rounded-xl bg-action-sky text-white text-sm font-normal py-2.5 hover:bg-action-sky-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        disabled={showAuthPendingWarning}
        onClick={input.onConnect}
      >
        {input.t("tools.modal.connect")} {input.integration.name}
      </button>
    </>
  );
}

/**
 * Only OAuth integrations can enter the browser authorization flow; channel placeholders cannot access Cloud/Composio.
 */
export function canStartOAuthConnect(integration: Pick<IntegrationMeta, "authKind">): boolean {
  return integration.authKind === "oauth";
}

function pendingAuthWarningKey(integration: Pick<IntegrationMeta, "authKind">): MessageKey {
  return integration.authKind === "qrCode" ? "tools.modal.qrBackendPending" : "tools.modal.channelBackendPending";
}

/**
 * Wait for the given number of milliseconds.
 *
 * @param ms the wait duration; 0 just yields a single microtask.
 * @returns a promise that resolves when the wait completes.
 */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * Determine whether the connect flow was cancelled by the component closing or unmounting.
 *
 * @param signal an optional abort signal.
 * @returns true when it has been cancelled.
 */
function isCancelled(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

/**
 * Create a unified cancellation result.
 *
 * @returns a result indicating the flow was cancelled and the UI should not write back further.
 */
function cancelledResult(): IntegrationConnectFlowResult {
  return { phase: "idle", cancelled: true };
}

/**
 * Convert an unknown error into display text.
 *
 * @param error the caught error.
 * @returns the error message.
 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
