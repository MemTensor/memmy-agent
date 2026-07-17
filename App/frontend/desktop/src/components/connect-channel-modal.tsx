/** Connect channel modal module. */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ChannelProvider, ConnectChannelInput, ConnectChannelResponse } from "@memmy/local-api-contracts";
import type { ChannelsClient } from "../api/channels-client.js";
import type { IntegrationConnection } from "../integrations/connection-state.js";
import { IntegrationLogoBadge, type IntegrationMeta } from "../integrations/integration-meta.js";
import { useTranslation } from "../i18n/use-translation.js";
import { openExternalUrl } from "../utils/open-url.js";
import {
  deriveChannelConnectResponseAfterConnectionRefresh,
  deriveChannelPhaseAfterConnectionRefresh,
  deriveInitialChannelPhase,
  type ConnectChannelPhase
} from "./connect-channel-modal-state.js";

export type { ConnectChannelPhase } from "./connect-channel-modal-state.js";

type ChannelMessageKey = Parameters<ReturnType<typeof useTranslation>["t"]>[0];

interface ChannelCredentialField {
  key: "appId" | "appSecret" | "clientId" | "clientSecret" | "token";
  labelKey: ChannelMessageKey;
  secret?: boolean;
}

const CHANNEL_CREDENTIAL_FIELDS: Partial<Record<ChannelProvider, ChannelCredentialField[]>> = {
  feishu: [
    { key: "appId", labelKey: "tools.channel.appId" },
    { key: "appSecret", labelKey: "tools.channel.appSecret", secret: true }
  ],
  dingtalk: [
    { key: "clientId", labelKey: "tools.channel.clientId" },
    { key: "clientSecret", labelKey: "tools.channel.clientSecret", secret: true }
  ],
  discord: [
    { key: "token", labelKey: "tools.channel.discordToken", secret: true }
  ],
  telegram: [
    { key: "token", labelKey: "tools.channel.telegramToken", secret: true }
  ]
};

const CHANNEL_FORM_BODY_KEY: Partial<Record<ChannelProvider, ChannelMessageKey>> = {
  wechat: "tools.channel.wechatBody",
  feishu: "tools.channel.feishuBody",
  dingtalk: "tools.channel.dingtalkBody",
  discord: "tools.channel.discordBody",
  telegram: "tools.channel.telegramBody",
  imessage: "tools.channel.imessageBody"
};

const FEISHU_FORM_PERMISSION_NOTE_ITEMS: ReadonlyArray<{
  scopeKey: ChannelMessageKey;
  descKey: ChannelMessageKey;
}> = [
  { scopeKey: "tools.channel.feishuPermissionNoteScope1", descKey: "tools.channel.feishuPermissionNoteDesc1" },
  { scopeKey: "tools.channel.feishuPermissionNoteScope2", descKey: "tools.channel.feishuPermissionNoteDesc2" },
  { scopeKey: "tools.channel.feishuPermissionNoteScope3", descKey: "tools.channel.feishuPermissionNoteDesc3" }
];

const QR_CHANNELS: ChannelProvider[] = ["wechat"];

const LOCAL_CHANNELS: ChannelProvider[] = ["imessage"];

const MACOS_FULL_DISK_ACCESS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";
const MACOS_AUTOMATION_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";

const CHANNEL_TUTORIAL: Partial<Record<ChannelProvider, { url: string; labelKey: ChannelMessageKey }>> = {
  dingtalk: {
    url: "https://open.dingtalk.com/document/orgapp/the-creation-and-installation-of-the-application-robot-in-the",
    labelKey: "tools.channel.dingtalkTutorial"
  },
  feishu: {
    url: "https://open.feishu.cn/document/develop-process/self-built-application-development-process",
    labelKey: "tools.channel.feishuTutorial"
  },
  discord: {
    url: "https://docs.discord.com/developers/quick-start/getting-started",
    labelKey: "tools.channel.discordTutorial"
  },
  telegram: {
    url: "https://core.telegram.org/bots/tutorial",
    labelKey: "tools.channel.telegramTutorial"
  }
};

/** Contract for connect channel modal props. */
export interface ConnectChannelModalProps {
  open: boolean;
  channel: IntegrationMeta | null;
  connection?: IntegrationConnection;
  client: ChannelsClient;
  onClose: () => void;
  onChanged: () => void;
  forcedPhase?: ConnectChannelPhase;
  forcedConnectResponse?: ConnectChannelResponse;
}

/** Handles connect channel modal. */
export function ConnectChannelModal(props: ConnectChannelModalProps) {
  const { t } = useTranslation();
  const provider = toChannelProvider(props.channel?.slug);
  const [phase, setPhase] = useState<ConnectChannelPhase>(() =>
    deriveInitialChannelPhase(props.connection, props.forcedPhase, props.forcedConnectResponse)
  );
  const [activeConnection, setActiveConnection] = useState<IntegrationConnection | undefined>(props.connection);
  const [connectResponse, setConnectResponse] = useState<ConnectChannelResponse | undefined>(props.forcedConnectResponse);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    setPhase(deriveInitialChannelPhase(props.connection, props.forcedPhase, props.forcedConnectResponse));
    setActiveConnection(props.connection);
    setConnectResponse(props.forcedConnectResponse);
    setErrorMessage("");
  }, [props.open, props.channel?.slug, props.forcedPhase, props.forcedConnectResponse]);

  useEffect(() => {
    if (!props.open) {
      return;
    }

    setActiveConnection(props.connection);
    setConnectResponse((currentResponse) =>
      deriveChannelConnectResponseAfterConnectionRefresh(currentResponse, props.connection)
    );

    const nextPhase = deriveChannelPhaseAfterConnectionRefresh(props.connection);
    if (nextPhase) {
      setPhase(nextPhase);
      if (nextPhase === "connected" || nextPhase === "error") {
        setErrorMessage("");
      }
    }
  }, [props.open, props.connection]);

  useEffect(() => {
    setCredentials({});
  }, [props.channel?.slug]);

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
    if (!props.channel || !provider) {
      return;
    }

    if (!canConnectChannel(provider)) {
      setPhase("unsupported");
      return;
    }

    const credentialFields = CHANNEL_CREDENTIAL_FIELDS[provider];
    if (credentialFields && credentialFields.some((field) => !(credentials[field.key] ?? "").trim())) {
      setErrorMessage(t("tools.channel.formRequired"));
      setPhase("error");
      return;
    }

    setPhase("starting");
    setErrorMessage("");

    try {
      const response = await props.client.connect(provider, buildChannelConnectInput(credentialFields, credentials));
      applyConnectResponse({
        provider,
        response,
        setPhase,
        setConnectResponse,
        setActiveConnection,
        onChanged: props.onChanged
      });
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
      setPhase("error");
    }
  }, [credentials, props, provider, t]);

  const handlePoll = useCallback(async () => {
    if (!provider || !connectResponse?.pollToken) {
      return;
    }

    setPhase("starting");
    setErrorMessage("");

    try {
      const response = await props.client.pollConnect(provider, connectResponse.pollToken);
      applyConnectResponse({
        provider,
        response,
        setPhase,
        setConnectResponse,
        setActiveConnection,
        onChanged: props.onChanged
      });
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
      setPhase("error");
    }
  }, [connectResponse?.pollToken, props, provider]);

  const handleDisconnect = useCallback(async () => {
    if (!provider) {
      return;
    }

    setPhase("disconnecting");
    setErrorMessage("");

    try {
      await props.client.disconnect(provider);
      setActiveConnection(undefined);
      setConnectResponse(undefined);
      setPhase("idle");
      props.onChanged();
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
      setPhase("error");
    }
  }, [props, provider]);

  if (!props.open || !props.channel) {
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
        aria-labelledby="channel-connect-title"
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
                <IntegrationLogoBadge slug={props.channel.slug} name={props.channel.name} surface={props.channel.surface} />
                <h2 id="channel-connect-title" className="text-base font-semibold text-stone-900">
                  {phase === "connected" ? `${t("tools.modal.manage")} ${props.channel.name}` : `${t("tools.modal.connect")} ${props.channel.name}`}
                </h2>
              </div>
              <p className="text-xs text-stone-400 mt-1.5 line-clamp-2">{props.channel.description}</p>
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
          {renderChannelPhaseBody({
            phase,
            provider,
            channel: props.channel,
            connectResponse,
            credentials,
            errorMessage,
            lastError: activeConnection?.lastError ?? null,
            onCredentialChange: (key, value) => setCredentials((prev) => ({ ...prev, [key]: value })),
            onConnect: handleConnect,
            onPoll: handlePoll,
            onDisconnect: handleDisconnect,
            onClose: props.onClose,
            onDismiss: () => {
              setErrorMessage("");
              setPhase("idle");
            },
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
 * Renders the official tutorial external link for the current channel.
 *
 * Only credential channels with a tutorial configured in CHANNEL_TUTORIAL (Feishu, DingTalk) render it; QR-code channels (WeChat) have no credentials and return null.
 *
 * @param provider the current channel id.
 * @param t the translation function.
 * @returns the tutorial link node; null when not configured.
 */
function renderChannelTutorialLink(
  provider: ChannelProvider | null,
  t: ReturnType<typeof useTranslation>["t"],
): ReactNode {
  const tutorial = provider ? CHANNEL_TUTORIAL[provider] : undefined;
  if (!tutorial) {
    return null;
  }

  return (
    <a
      href={tutorial.url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-action-sky hover:underline no-underline"
    >
      {t(tutorial.labelKey)}
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
        />
      </svg>
    </a>
  );
}

/**
 * Renders the permission note for the Feishu connection form (amber notice bar).
 *
 * @param t the translation function.
 * @returns the notice bar node.
 */
function renderFeishuFormPermissionNote(t: ReturnType<typeof useTranslation>["t"]): ReactNode {
  return (
    <div className="channel-permission-note rounded-xl border border-amber-200 bg-amber-50">
      <p className="channel-permission-note__intro">{t("tools.channel.feishuPermissionNoteIntro")}</p>
      <ul className="channel-permission-note__list">
        {FEISHU_FORM_PERMISSION_NOTE_ITEMS.map(({ scopeKey, descKey }) => (
          <li key={scopeKey} className="channel-permission-note__item">
            <span className="channel-permission-note__scope">{t(scopeKey)}</span>
            {t(descKey)}
          </li>
        ))}
      </ul>
      <p className="channel-permission-note__footer">{t("tools.channel.feishuPermissionNoteFooter")}</p>
    </div>
  );
}

/**
 * Parses the required scope list and application link out of the Feishu permission error hint string.
 *
 * lastError is generated by the backend feishuPermissionHint, in the form "...required permissions: [im:message:send, im:message]...
 * click the link to apply for and enable any one of the permissions: https://open.feishu.cn/app/.../auth?...".
 *
 * @param text the permission error hint string.
 * @returns the deduplicated scopes list and the application URL (null if none).
 */
function parseFeishuPermissionError(text: string): { scopes: string[]; applyUrl: string | null } {
  const bracket = text.match(/\[([^\]]+)\]/);
  const scopes = bracket?.[1]
    ? Array.from(new Set(bracket[1].split(",").map((item) => item.trim()).filter(Boolean)))
    : [];
  const url = text.match(/https?:\/\/[^\s)）]+/);
  return { scopes, applyUrl: url ? url[0] : null };
}

/**
 * Renders the Feishu insufficient-permission banner (white background + light pink #ffd9df structured hint).
 *
 * @param lastError the permission error hint string.
 * @param t the translation function.
 * @returns the banner node.
 */
function renderFeishuPermissionBanner(
  lastError: string,
  t: ReturnType<typeof useTranslation>["t"],
): ReactNode {
  const { scopes, applyUrl } = parseFeishuPermissionError(lastError);
  return (
    <div className="rounded-xl border border-coral-200 bg-coral-50 p-3">
      <div className="flex items-start gap-2">
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-coral-700"
          style={{ marginTop: 1, flexShrink: 0 }}
          aria-hidden="true"
        >
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-coral-700">{t("tools.channel.feishuPermTitle")}</p>
          <p className="text-xs mt-1 leading-relaxed text-coral-700">{t("tools.channel.feishuPermBody")}</p>
          {scopes.length ? (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {scopes.map((scope) => (
                <span
                  key={scope}
                  className="font-mono text-xs rounded-md px-2 py-0.5 border border-coral-200 bg-white text-coral-700"
                >
                  {scope}
                </span>
              ))}
            </div>
          ) : null}
          {applyUrl ? (
            <a
              href={applyUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-white rounded-lg px-3 py-1.5 mt-3 no-underline"
              style={{ backgroundColor: "#b91c1c" }}
            >
              {t("tools.channel.feishuPermCta")}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the channel dialog phase body.
 *
 * @param input the phase render input.
 * @returns the phase body node.
 */
function renderChannelPhaseBody(input: {
  phase: ConnectChannelPhase;
  provider: ChannelProvider | null;
  channel: IntegrationMeta;
  connectResponse?: ConnectChannelResponse;
  credentials: Record<string, string>;
  errorMessage: string;
  lastError?: string | null;
  onCredentialChange: (key: string, value: string) => void;
  onConnect: () => void;
  onPoll: () => void;
  onDisconnect: () => void;
  onClose: () => void;
  onDismiss: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}): ReactNode {
  if (input.phase === "starting") {
    return <p className="text-sm text-stone-500">{input.t("tools.connect.connecting")}</p>;
  }

  if (input.phase === "connected") {
    return (
      <>
        <div className="flex items-center gap-2 text-sm text-sage-700">
          <span className="w-2 h-2 rounded-full bg-sage-500" />
          <span>{input.t("tools.channel.connected", { name: input.channel.name })}</span>
        </div>
        {input.lastError ? renderFeishuPermissionBanner(input.lastError, input.t) : null}
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

  if (input.phase === "pendingQr") {
    return (
      <>
        <div className="flex items-center gap-2 text-sm text-stone-600">
          <span className="w-2 h-2 rounded-full bg-amber-300" />
          <span>{input.t("tools.channel.pendingQr", { name: input.channel.name })}</span>
        </div>
        <QrCodePreview channel={input.channel} qrCodeDataUrl={input.connectResponse?.qrCodeDataUrl} />
        <button
          type="button"
          className="w-full rounded-xl border border-stone-200 bg-white text-stone-700 text-sm font-semibold py-2.5 hover:bg-stone-50 transition-colors"
          onClick={input.onPoll}
        >
          {input.t("tools.channel.scanned")}
        </button>
      </>
    );
  }

  if (input.phase === "error") {
    // For "connected but not functional" errors like insufficient permissions: show the structured permission banner and keep disconnect/close,
    // rather than a generic "connection failed + ignore", otherwise the user can neither see the reason nor disconnect.
    if (input.lastError) {
      return (
        <>
          {renderFeishuPermissionBanner(input.lastError, input.t)}
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              className="w-full rounded-xl border border-coral-200 bg-coral-50 text-coral-700 text-sm font-medium py-2.5 hover:bg-coral-100 transition-colors"
              onClick={input.onDisconnect}
            >
              {input.t("tools.modal.disconnect")}
            </button>
            <button
              type="button"
              className="w-full rounded-xl bg-action-sky text-white text-sm font-medium py-2.5 hover:bg-action-sky-hover transition-colors"
              onClick={input.onClose}
            >
              {input.t("common.close")}
            </button>
          </div>
        </>
      );
    }
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

  if (!input.provider || !canConnectChannel(input.provider) || input.phase === "unsupported") {
    return (
      <>
        <p className="text-sm font-normal text-stone-600">{input.t("tools.channel.unsupported")}</p>
        <button
          type="button"
          className="w-full rounded-xl bg-action-sky text-white text-sm font-normal py-2.5 disabled:opacity-60 disabled:cursor-not-allowed"
          disabled
        >
          {input.t("tools.modal.connect")} {input.channel.name}
        </button>
      </>
    );
  }

  // By this point the provider has passed canConnectChannel: it's either a form credential channel (has credentialFields),
  // or a QR-code channel (no input, just shows a description + connect button, and transitions to pendingQr on connect).
  const credentialFields = CHANNEL_CREDENTIAL_FIELDS[input.provider];
  const bodyKey = CHANNEL_FORM_BODY_KEY[input.provider];
  return (
    <>
      {bodyKey ? <p className="text-sm font-normal text-stone-600">{input.t(bodyKey)}</p> : null}
      {renderChannelTutorialLink(input.provider, input.t)}
      {input.provider === "feishu" ? renderFeishuFormPermissionNote(input.t) : null}
      {input.provider === "imessage" ? (
        <div className="channel-permission-note rounded-xl border border-amber-200 bg-amber-50">
          <p className="channel-permission-note__intro">{input.t("tools.channel.imessagePermissionNote")}</p>
          <div className="mt-2 flex flex-wrap gap-3">
            <button
              type="button"
              className="text-xs font-medium text-action-sky hover:underline"
              onClick={() => void openExternalUrl(MACOS_FULL_DISK_ACCESS_URL)}
            >
              {input.t("tools.channel.imessageOpenFullDisk")}
            </button>
            <button
              type="button"
              className="text-xs font-medium text-action-sky hover:underline"
              onClick={() => void openExternalUrl(MACOS_AUTOMATION_URL)}
            >
              {input.t("tools.channel.imessageOpenAutomation")}
            </button>
          </div>
        </div>
      ) : null}
      {credentialFields ? (
        <div className="space-y-2">
          {credentialFields.map((field) => (
            <ChannelInput
              key={field.key}
              label={input.t(field.labelKey)}
              value={input.credentials[field.key] ?? ""}
              onChange={(value) => input.onCredentialChange(field.key, value)}
              type={field.secret ? "password" : "text"}
              autoComplete="off"
            />
          ))}
        </div>
      ) : null}
      <button
        type="button"
        className="w-full rounded-xl bg-action-sky text-white text-sm font-normal py-2.5 hover:bg-action-sky-hover transition-colors"
        onClick={input.onConnect}
      >
        {input.t("tools.modal.connect")} {input.channel.name}
      </button>
    </>
  );
}

/**
 * Renders a channel form input.
 *
 * @param props.label the field label.
 * @param props.value the current value.
 * @param props.onChange the value-change callback.
 * @param props.type the input type.
 * @param props.autoComplete the browser autofill policy.
 * @returns a labeled input node.
 */
function ChannelInput(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password";
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-normal text-stone-600">{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        autoComplete={props.autoComplete}
        onChange={(event) => props.onChange(event.target.value)}
        className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-800 outline-none placeholder:text-stone-300 focus:outline-none"
      />
    </label>
  );
}

/**
 * Renders the QR code preview.
 *
 * @param props.channel the channel metadata.
 * @param props.qrCodeDataUrl the QR code image data URL.
 * @returns the QR code image or a waiting placeholder.
 */
function QrCodePreview(props: { channel: IntegrationMeta; qrCodeDataUrl?: string }) {
  const { t } = useTranslation();

  if (!props.qrCodeDataUrl) {
    return (
      <div className="flex h-40 items-center justify-center rounded-xl border border-stone-200 bg-stone-50 text-sm text-stone-400">
        {t("tools.modal.qrPending")}
      </div>
    );
  }

  return (
    <div className="flex justify-center rounded-xl border border-stone-200 bg-stone-50 p-3">
      <img
        src={props.qrCodeDataUrl}
        alt={t("tools.channel.qrAlt", { name: props.channel.name })}
        className="h-40 w-40 rounded-lg bg-white object-contain"
      />
    </div>
  );
}

/**
 * Applies the backend connection response to the modal state.
 *
 * @param input the connection response and state setters.
 */
function applyConnectResponse(input: {
  provider: ChannelProvider;
  response: ConnectChannelResponse;
  setPhase: (phase: ConnectChannelPhase) => void;
  setConnectResponse: (response: ConnectChannelResponse | undefined) => void;
  setActiveConnection: (connection: IntegrationConnection | undefined) => void;
  onChanged: () => void;
}) {
  input.setConnectResponse(input.response);

  if (input.response.status === "connected") {
    input.setActiveConnection({
      id: input.response.connectionId,
      toolkit: input.provider,
      status: "connected"
    });
    input.setPhase("connected");
    if (shouldRefreshAfterChannelConnectStatus(input.response.status)) {
      input.onChanged();
    }
    return;
  }

  if (input.response.status === "pendingQr") {
    input.setPhase("pendingQr");
    return;
  }

  if (input.response.status === "starting" || input.response.status === "restarting") {
    input.setPhase("starting");
    if (shouldRefreshAfterChannelConnectStatus(input.response.status)) {
      input.onChanged();
    }
    return;
  }

  if (input.response.status === "unsupported") {
    input.setPhase("unsupported");
    return;
  }

  input.setPhase(input.response.status === "error" || input.response.status === "expired" ? "error" : "idle");
}

/**
 * Determines whether the connection response requires refreshing the parent page's connection list.
 *
 * @param status the channel connection status returned by the backend.
 * @returns true if the parent page should re-read the connection list.
 */
export function shouldRefreshAfterChannelConnectStatus(status: ConnectChannelResponse["status"]): boolean {
  return status === "connected" || status === "starting" || status === "restarting";
}

/**
 * Converts an integration slug to a product channel id.
 *
 * @param slug the integration catalog slug.
 * @returns a supported ChannelProvider; null if not a channel.
 */
function toChannelProvider(slug?: string): ChannelProvider | null {
  if (
    slug === "telegram" ||
    slug === "discord" ||
    slug === "imessage" ||
    slug === "wechat" ||
    slug === "feishu" ||
    slug === "dingtalk"
  ) {
    return slug;
  }

  return null;
}

/**
 * Determines whether real connection is enabled in phase one.
 *
 * @param provider the product channel id.
 * @returns true for form credential channels (Feishu, DingTalk) or QR-code channels (WeChat) that have real connection enabled.
 */
function canConnectChannel(provider: ChannelProvider): boolean {
  return Boolean(CHANNEL_CREDENTIAL_FIELDS[provider]) || QR_CHANNELS.includes(provider) || LOCAL_CHANNELS.includes(provider);
}

/**
 * Collects connection input according to the credential field table.
 *
 * @param fields the credential field descriptors for the current channel; returns undefined when absent (non-form channel).
 * @param credentials the raw values the user entered in the form.
 * @returns the connection input to submit to the backend.
 */
function buildChannelConnectInput(
  fields: ChannelCredentialField[] | undefined,
  credentials: Record<string, string>
): ConnectChannelInput | undefined {
  if (!fields) {
    return undefined;
  }

  const input: ConnectChannelInput = {};
  for (const field of fields) {
    input[field.key] = (credentials[field.key] ?? "").trim();
  }

  return input;
}

/**
 * Converts an unknown error into display text.
 *
 * @param error the caught error.
 * @returns the error message.
 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
