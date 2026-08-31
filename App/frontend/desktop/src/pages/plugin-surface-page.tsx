import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { InstalledPlugin } from "@memmy/local-api-contracts";
import { useApiClients } from "../app/providers.js";
import { usePluginUi, type PluginInvocationContext, type PluginUiCall } from "../app/plugin-ui-context.js";
import { useTranslation } from "../i18n/use-translation.js";
import { appActions } from "../state/app-actions.js";
import { useAppState } from "../state/app-state.js";
import { AppFrame } from "./app-frame.js";
import { buildRendererDocument, PluginCapabilityHost } from "./plugin-capability-host.js";

export function PluginSurfacePage() {
  const { clients } = useApiClients();
  const { dispatch } = useAppState();
  const { t } = useTranslation();
  const { activeSurface, calls, closeSurface } = usePluginUi();
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);

  useEffect(() => {
    let active = true;
    void clients?.plugins.list().then((items) => { if (active) setPlugins(items); }).catch(() => undefined);
    return () => { active = false; };
  }, [clients]);

  const close = () => {
    closeSurface();
    dispatch(appActions.navigate("/main"));
  };
  if (!activeSurface) {
    return <AppFrame title={t("plugin.surface.title")}><div className="p-8 text-sm text-text-ink/50">{t("plugin.surface.unavailable")}</div></AppFrame>;
  }
  const plugin = plugins.find((item) => item.id === activeSurface.pluginId);
  const visibleCalls = calls.filter((call) => call.pluginId === activeSurface.pluginId
    && call.capabilityId === activeSurface.capabilityId
    && call.conversationId === activeSurface.conversationId);
  const surface = plugin?.manifest.ui?.surface;
  const supportsCapability = !surface?.capabilities || surface.capabilities.includes(activeSurface.capabilityId);

  return (
    <AppFrame
      title={plugin?.manifest.name ?? activeSurface.pluginId}
      topBar={<button type="button" className="inline-flex items-center gap-1 text-sm text-text-ink/60 hover:text-text-ink" onClick={close}><ArrowLeft size={15} aria-hidden="true" />{t("plugin.surface.back")}</button>}
    >
      <main className="app-frame-page-content h-full overflow-y-auto p-5">
        {plugin && surface && supportsCapability ? (
          <SandboxedPluginSurface plugin={plugin} context={activeSurface} calls={visibleCalls} height={surface.height ?? 720} />
        ) : (
          <PluginCapabilityHost calls={visibleCalls} plugins={plugins} client={clients?.plugins ?? null} uploadFiles={clients ? (files) => clients.memmyAgent.uploadAgentMedia(files) : undefined} />
        )}
      </main>
    </AppFrame>
  );
}

function SandboxedPluginSurface(props: {
  plugin: InstalledPlugin;
  context: PluginInvocationContext;
  calls: PluginUiCall[];
  height: number;
}) {
  const { clients } = useApiClients();
  const { t } = useTranslation();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const answered = useRef(new Set<string>());
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const document = useMemo(() => html === null ? "" : buildRendererDocument(html), [html]);
  const message = useMemo(() => ({ type: "memmy.plugin.surface", version: 1, context: props.context, calls: props.calls }), [props.calls, props.context]);

  useEffect(() => {
    let active = true;
    void clients?.plugins.getUi(props.plugin.id, "surface").then((content) => { if (active) setHtml(content); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [clients, props.plugin.id]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  }, [message]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || !clients) return;
      const data = asRecord(event.data);
      if (data.type === "memmy.plugin.invoke" && data.version === 1 && typeof data.capabilityId === "string") {
        const capability = props.plugin.manifest.capabilities.find((item) => item.id === data.capabilityId);
        const allowed = props.plugin.manifest.ui?.surface?.capabilities;
        if (!capability || (allowed && !allowed.includes(capability.id))) return;
        void clients.plugins.invoke(props.plugin.id, capability.id, { conversationId: props.context.conversationId, input: data.input }).then(
          (result) => iframeRef.current?.contentWindow?.postMessage({ type: "memmy.plugin.invoke-result", version: 1, requestId: data.requestId, ok: true, result }, "*"),
          () => iframeRef.current?.contentWindow?.postMessage({ type: "memmy.plugin.invoke-result", version: 1, requestId: data.requestId, ok: false }, "*")
        );
        return;
      }
      if (data.type !== "memmy.plugin.interaction-response" || data.version !== 1 || typeof data.callId !== "string" || typeof data.interactionId !== "string") return;
      const call = props.calls.find((item) => item.callId === data.callId);
      const declared = call?.events.some((item) => item.type === "interaction" && item.request.interactionId === data.interactionId);
      if (!call || !declared) return;
      const responseKey = `${call.callId}:${data.interactionId}`;
      if (answered.current.has(responseKey)) return;
      answered.current.add(responseKey);
      void clients.plugins.respond(props.plugin.id, call.callId, data.interactionId, data.response).then(
        () => iframeRef.current?.contentWindow?.postMessage({ type: "memmy.plugin.response-result", version: 1, callId: call.callId, interactionId: data.interactionId, ok: true }, "*"),
        () => {
          answered.current.delete(responseKey);
          iframeRef.current?.contentWindow?.postMessage({ type: "memmy.plugin.response-result", version: 1, callId: call.callId, interactionId: data.interactionId, ok: false }, "*");
        }
      );
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [clients, props.calls, props.context.conversationId, props.plugin]);

  if (failed) return <PluginCapabilityHost calls={props.calls} plugins={[props.plugin]} client={clients?.plugins ?? null} uploadFiles={clients ? (files) => clients.memmyAgent.uploadAgentMedia(files) : undefined} />;
  if (html === null) return <p className="py-8 text-center text-sm text-text-ink/45" role="status">{t("plugin.ui.rendererLoading")}</p>;
  return <iframe ref={iframeRef} title={`${props.plugin.manifest.name} ${t("plugin.surface.title")}`} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={document} className="w-full rounded-card border border-border-stone/30 bg-background-paper" style={{ height: props.height }} onLoad={() => iframeRef.current?.contentWindow?.postMessage(message, "*")} />;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
