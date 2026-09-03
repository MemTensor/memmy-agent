import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ChangeEvent,
  type ReactNode
} from "react";
import {
  AlertCircle,
  Check,
  Circle,
  CircleDot,
  Download,
  ExternalLink,
  FileOutput,
  HelpCircle,
  ListChecks,
  LoaderCircle,
  MessageSquarePlus,
  Paperclip,
  X
} from "lucide-react";
import type {
  CapabilityEvent,
  InstalledPlugin,
  PluginArtifactRef,
  PluginInteractionRequest
} from "@memmy/local-api-contracts";
import type { UploadAgentMediaInput, UploadedAgentMedia } from "../api/memmy-agent-client.js";
import type { PluginsClient } from "../api/plugins-client.js";
import type { PluginUiCall } from "../app/plugin-ui-context.js";
import { useTranslation } from "../i18n/use-translation.js";
import { classifyAgentAttachmentFile } from "../lib/agent-attachment.js";
import { startBrowserDownload } from "./agent-message-content.js";
import { openExternalUrl } from "../utils/open-url.js";

const TASK_STATUS_KEYS = {
  pending: "plugin.ui.task.pending",
  running: "plugin.ui.task.running",
  completed: "plugin.ui.task.completed",
  failed: "plugin.ui.task.failed"
} as const;

interface PluginCapabilityHostProps {
  calls: PluginUiCall[];
  plugins: InstalledPlugin[];
  client: Pick<PluginsClient, "getUi" | "cancel" | "respond"> | null;
  uploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
  onAddArtifact?: (artifact: PluginArtifactRef) => void;
}

export interface PluginRendererInteractionState {
  interactionId: string;
  status: "stale";
  error: {
    code: "stale_card";
    message: string;
    latestContentHash: string;
  };
}

export function PluginCapabilityHost(props: PluginCapabilityHostProps) {
  const { t } = useTranslation();
  const plugins = useMemo(() => new Map(props.plugins.map((plugin) => [plugin.id, plugin])), [props.plugins]);
  const interactionStates = useMemo(() => resolveRendererInteractionStates(props.calls), [props.calls]);
  if (props.calls.length === 0) return null;

  return (
    <section className="space-y-3" aria-label={t("plugin.ui.regionLabel")}>
      {props.calls.map((call) => {
        const plugin = plugins.get(call.pluginId);
        const renderer = plugin?.manifest.ui?.renderer;
        const usesRenderer = Boolean(
          renderer
          && (!renderer.capabilities || renderer.capabilities.includes(call.capabilityId))
          && props.client
        );
        const respond = (interactionId: string, response: unknown) => {
          if (!props.client) return Promise.reject(new Error("Plugin client unavailable"));
          return props.client.respond(call.pluginId, call.callId, interactionId, response);
        };
        const cancel = () => {
          if (!props.client) return Promise.reject(new Error("Plugin client unavailable"));
          return props.client.cancel(call.pluginId, call.callId);
        };
        const cards = (
          <GenericPluginCards
            events={call.events}
            onRespond={respond}
            onCancel={cancel}
            onUploadFiles={props.uploadFiles}
            onAddArtifact={props.onAddArtifact}
          />
        );
        return (
          <div key={call.callId} className="rounded-card border border-border-stone/35 bg-background-paper p-3 shadow-sm">
            <p className="mb-2 text-xs font-medium text-text-ink/55">
              {plugin?.manifest.name ?? call.pluginId}
            </p>
            {usesRenderer && renderer ? (
              <SandboxedPluginRenderer
                call={call}
                interactionStates={interactionStates.get(call.pluginId + ":" + call.callId) ?? []}
                height={renderer.height ?? 320}
                client={props.client!}
                onRespond={respond}
                fallback={cards}
              />
            ) : (
              cards
            )}
          </div>
        );
      })}
    </section>
  );
}

function GenericPluginCards(props: {
  events: CapabilityEvent[];
  onRespond(interactionId: string, response: unknown): Promise<void>;
  onCancel(): Promise<void>;
  onUploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
  onAddArtifact?: (artifact: PluginArtifactRef) => void;
}) {
  const terminal = props.events.some((event) => event.type === "result" || event.type === "error");
  return (
    <div className="space-y-2">
      {props.events.map((event) => {
        if (event.type === "progress") return <ProgressCard key="progress" event={event} canCancel={Boolean(event.cancellable) && !terminal} onCancel={props.onCancel} />;
        if (event.type === "task-list") return <TaskCard key="tasks" event={event} />;
        if (event.type === "interaction") {
          return <InteractionCard key={`interaction:${event.request.interactionId}`} request={event.request} onRespond={props.onRespond} onUploadFiles={props.onUploadFiles} />;
        }
        if (event.type === "artifact") return <ArtifactCard key={`artifact:${event.artifact.id}`} event={event} onAddToChat={props.onAddArtifact} />;
        if (event.type === "error") return <ErrorCard key="error" event={event} />;
        return null;
      })}
    </div>
  );
}

function ProgressCard(props: {
  event: Extract<CapabilityEvent, { type: "progress" }>;
  canCancel: boolean;
  onCancel(): Promise<void>;
}) {
  const { t } = useTranslation();
  const [cancelState, setCancelState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const value = props.event.total ? Math.min(100, Math.round((props.event.current / props.event.total) * 100)) : undefined;
  const cancel = async () => {
    setCancelState("pending");
    try {
      await props.onCancel();
      setCancelState("done");
    } catch {
      setCancelState("error");
    }
  };
  return (
    <div className="rounded-card bg-canvas-oat/55 px-3 py-2.5" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm text-text-ink/75">
        <LoaderCircle size={15} className="animate-spin text-action-sky" aria-hidden="true" />
        <span>{props.event.message || t("plugin.ui.progress")}</span>
        {value !== undefined ? <span className="ml-auto text-xs text-text-ink/45">{value}%</span> : null}
        {props.canCancel && cancelState !== "done" ? (
          <button type="button" disabled={cancelState === "pending"} className="ml-1 text-xs text-text-ink/55 hover:text-status-error disabled:opacity-50" onClick={() => void cancel()}>
            {t("plugin.ui.cancel")}
          </button>
        ) : null}
        {cancelState === "done" ? <span className="ml-1 text-xs text-text-ink/45">{t("plugin.ui.cancelled")}</span> : null}
      </div>
      {value !== undefined ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border-stone/30" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
          <div className="h-full rounded-full bg-action-sky transition-[width]" style={{ width: `${value}%` }} />
        </div>
      ) : null}
      {cancelState === "error" ? <p className="mt-1 text-xs text-status-error" role="alert">{t("plugin.ui.cancelFailed")}</p> : null}
    </div>
  );
}

function TaskCard(props: { event: Extract<CapabilityEvent, { type: "task-list" }> }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-card border border-border-stone/30 px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-text-ink/75">
        <ListChecks size={15} className="text-action-sky" aria-hidden="true" />
        {t("plugin.ui.tasks")}
      </div>
      <ul className="space-y-1.5">
        {props.event.tasks.map((task) => {
          const Icon = task.status === "completed" ? Check : task.status === "failed" ? X : task.status === "running" ? CircleDot : Circle;
          return (
            <li key={task.id} className="flex items-center gap-2 text-sm text-text-ink/65">
              <Icon size={14} className={task.status === "failed" ? "text-status-error" : task.status === "completed" ? "text-status-success" : "text-action-sky"} aria-hidden="true" />
              <span className="min-w-0 flex-1 break-words">{task.title}</span>
              <span className="text-[11px] text-text-ink/40">{t(TASK_STATUS_KEYS[task.status])}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function InteractionCard(props: {
  request: PluginInteractionRequest;
  onRespond(interactionId: string, response: unknown): Promise<void>;
  onUploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState<unknown[]>([]);
  const [status, setStatus] = useState<"idle" | "submitting" | "answered" | "error">("idle");
  const payload = asRecord(props.request.payload);
  const title = firstString(payload, ["title", "question", "prompt", "message"])
    ?? (props.request.type === "approval" ? t("plugin.ui.approval") : t("plugin.ui.question"));
  const description = firstString(payload, ["description", "detail", "hint"]);
  const options = readOptions(payload.options);
  const multiple = payload.multiple === true;
  const allowText = options.length === 0 || payload.allowText === true;
  const disabled = status === "submitting" || status === "answered";

  const submit = async (response: unknown) => {
    setStatus("submitting");
    try {
      await props.onRespond(props.request.interactionId, response);
      setStatus("answered");
    } catch {
      setStatus("error");
    }
  };
  const submitText = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) void submit(value.trim());
  };

  if (props.request.type === "file-input") {
    return <FileInputCard request={props.request} title={title} description={description} disabled={disabled} status={status} onStatus={setStatus} onRespond={props.onRespond} onUploadFiles={props.onUploadFiles} />;
  }

  return (
    <div className="rounded-card border border-action-sky/25 bg-action-sky/[0.04] px-3 py-3">
      <div className="flex items-start gap-2">
        <HelpCircle size={16} className="mt-0.5 shrink-0 text-action-sky" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-ink/80">{title}</p>
          {description ? <p className="mt-1 text-xs leading-relaxed text-text-ink/50">{description}</p> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {props.request.type === "approval" ? (
              <>
                <ResponseButton disabled={disabled} onClick={() => void submit(true)}>{t("plugin.ui.approve")}</ResponseButton>
                <ResponseButton disabled={disabled} onClick={() => void submit(false)} secondary>{t("plugin.ui.reject")}</ResponseButton>
                {payload.allowModify === true ? <ResponseButton disabled={disabled} onClick={() => void submit("modify")} secondary>{t("plugin.ui.modify")}</ResponseButton> : null}
              </>
            ) : options.length > 0 ? (
              <>
                {options.map((option, index) => multiple ? (
                  <label key={`${index}:${option.label}`} className="inline-flex cursor-pointer items-center gap-1.5 rounded-btn border border-border-stone/45 bg-background-paper px-3 py-1.5 text-xs text-text-ink/65">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={selected.includes(option.value)}
                      onChange={(event) => setSelected((current) => event.target.checked ? [...current, option.value] : current.filter((item) => item !== option.value))}
                    />
                    {option.label}
                  </label>
                ) : (
                  <ResponseButton key={`${index}:${option.label}`} disabled={disabled} onClick={() => void submit(option.value)}>{option.label}</ResponseButton>
                ))}
                {multiple ? <ResponseButton disabled={disabled || selected.length === 0} onClick={() => void submit(selected)}>{t("plugin.ui.submit")}</ResponseButton> : null}
              </>
            ) : null}
            {allowText ? (
              <form className="flex w-full gap-2" onSubmit={submitText}>
                <input
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  disabled={disabled}
                  aria-label={title}
                  placeholder={t("plugin.ui.responsePlaceholder")}
                  className="min-w-0 flex-1 rounded-input border border-border-stone/50 bg-background-paper px-3 py-1.5 text-sm text-text-ink outline-none focus:border-action-sky disabled:opacity-60"
                />
                <ResponseButton disabled={disabled || !value.trim()}>{t("plugin.ui.submit")}</ResponseButton>
              </form>
            ) : null}
          </div>
          {status === "answered" ? <p className="mt-2 text-xs text-status-success" role="status">{t("plugin.ui.answered")}</p> : null}
          {status === "error" ? <p className="mt-2 text-xs text-status-error" role="alert">{t("plugin.ui.responseFailed")}</p> : null}
        </div>
      </div>
    </div>
  );
}

function FileInputCard(props: {
  request: PluginInteractionRequest;
  title: string;
  description: string | null;
  disabled: boolean;
  status: "idle" | "submitting" | "answered" | "error";
  onStatus(value: "idle" | "submitting" | "answered" | "error"): void;
  onRespond(interactionId: string, response: unknown): Promise<void>;
  onUploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
}) {
  const { t } = useTranslation();
  const payload = asRecord(props.request.payload);
  const [files, setFiles] = useState<File[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const accept = readStrings(payload.accept).join(",");
  const fileRules = readFileRules(payload.fileRules);
  const maxFiles = positiveInteger(payload.maxFiles) ?? (payload.multiple === true ? null : 1);
  const maxBytes = positiveInteger(payload.maxBytes);
  const fileStates = files.map((file) => classifyPluginInputFile(file, accept, maxBytes, fileRules, t));
  const readyFiles = fileStates.filter((item) => item.status === "ready").map((item) => item.file);
  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const next = Array.from(event.target.files ?? []);
    setFiles(next);
    const nextReady = next.filter((file) => classifyPluginInputFile(file, accept, maxBytes, fileRules, t).status === "ready");
    setValidationError(validateReadyFileCount(nextReady, maxFiles, t));
  };
  const upload = async () => {
    const error = validateReadyFileCount(readyFiles, maxFiles, t);
    if (error || !props.onUploadFiles) {
      setValidationError(error ?? t("plugin.ui.responseFailed"));
      return;
    }
    props.onStatus("submitting");
    try {
      const uploaded = await props.onUploadFiles(readyFiles.map((file) => {
        const classification = classifyAgentAttachmentFile(file)!;
        return { blob: file, name: file.name, kind: classification.kind, mime: classification.mime };
      }));
      await props.onRespond(props.request.interactionId, { files: uploaded });
      props.onStatus("answered");
    } catch {
      props.onStatus("error");
    }
  };
  return (
    <div className="rounded-card border border-action-sky/25 bg-action-sky/[0.04] px-3 py-3">
      <div className="flex items-start gap-2">
        <Paperclip size={16} className="mt-0.5 shrink-0 text-action-sky" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-ink/80">{props.title}</p>
          {props.description ? <p className="mt-1 text-xs text-text-ink/50">{props.description}</p> : null}
          <div className="mt-2 flex items-center gap-2">
            <label className="cursor-pointer rounded-btn border border-border-stone/45 bg-background-paper px-3 py-1.5 text-xs text-text-ink/65">
              {t("plugin.ui.chooseFiles")}
              <input className="sr-only" type="file" accept={accept || undefined} multiple={payload.multiple === true} disabled={props.disabled} onChange={choose} />
            </label>
            <span className="min-w-0 flex-1 truncate text-xs text-text-ink/45">
              {files.length ? t("plugin.ui.filesReadySummary", { ready: readyFiles.length, blocked: files.length - readyFiles.length }) : t("plugin.ui.noFiles")}
            </span>
            <ResponseButton disabled={props.disabled || readyFiles.length === 0 || Boolean(validationError) || !props.onUploadFiles} onClick={() => void upload()}>{t("plugin.ui.upload")}</ResponseButton>
          </div>
          {fileStates.length ? (
            <ul className="mt-2 space-y-1.5" aria-label={t("plugin.ui.selectedFiles")}>
              {fileStates.map((item, index) => (
                <li key={`${item.file.name}:${item.file.size}:${index}`} className={`flex items-start gap-2 rounded-btn border px-2.5 py-2 text-xs ${item.status === "blocked" ? "border-status-error/20 bg-status-error-soft/35 text-text-ink/55" : "border-border-stone/30 bg-background-paper text-text-ink/65"}`}>
                  {item.status === "blocked" ? <AlertCircle size={14} className="mt-0.5 shrink-0 text-status-error" aria-hidden="true" /> : <Check size={14} className="mt-0.5 shrink-0 text-status-success" aria-hidden="true" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.file.name}</span>
                    <span className={item.status === "blocked" ? "text-status-error" : "text-text-ink/40"} role={item.status === "blocked" ? "alert" : undefined}>
                      {item.message ?? t("plugin.ui.fileReady")}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {validationError ? <p className="mt-2 text-xs text-status-error" role="alert">{validationError}</p> : null}
          {props.status === "answered" ? <p className="mt-2 text-xs text-status-success" role="status">{t("plugin.ui.answered")}</p> : null}
          {props.status === "error" ? <p className="mt-2 text-xs text-status-error" role="alert">{t("plugin.ui.responseFailed")}</p> : null}
        </div>
      </div>
    </div>
  );
}

function ResponseButton(props: { children: string; disabled: boolean; onClick?: () => void; secondary?: boolean }) {
  return (
    <button
      type="submit"
      disabled={props.disabled}
      onClick={props.onClick}
      className={`rounded-btn border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${props.secondary ? "border-border-stone/45 bg-background-paper text-text-ink/60 hover:bg-canvas-oat" : "border-action-sky/30 bg-action-sky/10 text-action-sky hover:bg-action-sky/15"}`}
    >
      {props.children}
    </button>
  );
}

function ArtifactCard(props: { event: Extract<CapabilityEvent, { type: "artifact" }>; onAddToChat?: (artifact: PluginArtifactRef) => void }) {
  const { t } = useTranslation();
  const openUri = resolveSafeArtifactUri(props.event.artifact.uri);
  const downloadUri = resolveSafeArtifactUri(props.event.artifact.downloadUri ?? props.event.artifact.uri);
  return (
    <div className="flex items-center gap-3 rounded-card border border-border-stone/30 px-3 py-2.5">
      <FileOutput size={18} className="shrink-0 text-action-sky" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text-ink/75">{props.event.artifact.name}</p>
        <p className="truncate text-[11px] text-text-ink/40">{props.event.artifact.mediaType}</p>
      </div>
      {openUri ? (
        <button type="button" className="inline-flex items-center gap-1 text-xs text-action-sky hover:underline" onClick={() => void openExternalUrl(openUri)}>
          {t("plugin.ui.open")}<ExternalLink size={12} aria-hidden="true" />
        </button>
      ) : null}
      {downloadUri ? (
        <button type="button" className="inline-flex items-center gap-1 text-xs text-action-sky hover:underline" onClick={() => startBrowserDownload(downloadUri, props.event.artifact.name)}>
          {t("plugin.ui.download")}<Download size={12} aria-hidden="true" />
        </button>
      ) : null}
      {props.onAddToChat ? (
        <button type="button" className="inline-flex items-center gap-1 text-xs text-action-sky hover:underline" onClick={() => props.onAddToChat?.(props.event.artifact)}>
          {t("plugin.ui.addToChat")}<MessageSquarePlus size={12} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function ErrorCard(props: { event: Extract<CapabilityEvent, { type: "error" }> }) {
  return (
    <div className="flex items-start gap-2 rounded-card border border-status-error/25 bg-status-error-soft/40 px-3 py-2.5 text-sm text-status-error" role="alert">
      <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{props.event.message}</span>
    </div>
  );
}

function SandboxedPluginRenderer(props: {
  call: PluginUiCall;
  interactionStates: PluginRendererInteractionState[];
  height: number;
  client: Pick<PluginsClient, "getUi">;
  onRespond(interactionId: string, response: unknown): Promise<void>;
  fallback: ReactNode;
}) {
  const { t } = useTranslation();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const answered = useRef(new Set<string>());
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const document = useMemo(() => html === null ? "" : buildRendererDocument(html), [html]);
  const rendererMessage = useMemo(() => ({
    type: "memmy.plugin.render",
    version: 1,
    pluginId: props.call.pluginId,
    capabilityId: props.call.capabilityId,
    callId: props.call.callId,
    events: props.call.events,
    interactionStates: props.interactionStates
  }), [props.call, props.interactionStates]);

  useEffect(() => {
    let active = true;
    void props.client.getUi(props.call.pluginId, "renderer").then((content) => {
      if (active) setHtml(content);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => { active = false; };
  }, [props.call.pluginId, props.client]);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage(rendererMessage, "*");
  }, [rendererMessage]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = asRecord(event.data);
      if (message.type !== "memmy.plugin.interaction-response" || message.version !== 1 || typeof message.interactionId !== "string") return;
      const interactionId = message.interactionId;
      const declared = props.call.events.some((item) => item.type === "interaction" && item.request.interactionId === interactionId);
      if (!declared || answered.current.has(interactionId)) return;
      const response = asRecord(message.response);
      const stale = props.interactionStates.find((item) => item.interactionId === interactionId);
      if (stale && response.action === "submit") {
        iframeRef.current?.contentWindow?.postMessage({
          type: "memmy.plugin.response-result",
          version: 1,
          interactionId,
          ok: false,
          error: stale.error
        }, "*");
        return;
      }
      answered.current.add(interactionId);
      void props.onRespond(interactionId, message.response).then(
        () => iframeRef.current?.contentWindow?.postMessage({ type: "memmy.plugin.response-result", version: 1, interactionId, ok: true }, "*"),
        () => {
          answered.current.delete(interactionId);
          iframeRef.current?.contentWindow?.postMessage({ type: "memmy.plugin.response-result", version: 1, interactionId, ok: false }, "*");
        }
      );
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [props.call.events, props.interactionStates, props.onRespond]);

  if (failed) return props.fallback;
  if (html === null) return <p className="py-3 text-center text-xs text-text-ink/40" role="status">{t("plugin.ui.rendererLoading")}</p>;
  return (
    <iframe
      ref={iframeRef}
      title={`${props.call.pluginId} ${t("plugin.ui.renderer")}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={document}
      className="w-full rounded-card border-0 bg-transparent"
      style={{ height: props.height }}
      onLoad={() => iframeRef.current?.contentWindow?.postMessage(rendererMessage, "*")}
    />
  );
}

export function buildRendererDocument(html: string): string {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; navigate-to 'none'";
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${meta}`);
  if (/<html(?:\s[^>]*)?>/i.test(html)) return html.replace(/<html(\s[^>]*)?>/i, (root) => `${root}<head>${meta}</head>`);
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

export function resolveRendererInteractionStates(
  calls: PluginUiCall[]
): Map<string, PluginRendererInteractionState[]> {
  const latest = new Map<string, { contentHash: string }>();
  for (const call of calls) {
    for (const event of call.events) {
      if (event.type !== "result") continue;
      const output = asRecord(event.output);
      const taskId = typeof output.taskId === "string" ? output.taskId : null;
      if (!taskId || !Array.isArray(output.artifacts)) continue;
      for (const value of output.artifacts) {
        const artifact = asRecord(value);
        if (typeof artifact.kind !== "string" || typeof artifact.contentHash !== "string" || artifact.stale === true) continue;
        latest.set(call.pluginId + ":" + taskId + ":" + artifact.kind, {
          contentHash: artifact.contentHash
        });
      }
    }
  }

  const states = new Map<string, PluginRendererInteractionState[]>();
  for (const call of calls) {
    const callStates: PluginRendererInteractionState[] = [];
    for (const event of call.events) {
      if (event.type !== "interaction") continue;
      const payload = asRecord(event.request.payload);
      const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
      const baseArtifact = asRecord(payload.baseArtifact);
      if (!taskId || typeof baseArtifact.kind !== "string" || typeof baseArtifact.contentHash !== "string") continue;
      const current = latest.get(call.pluginId + ":" + taskId + ":" + baseArtifact.kind);
      let latestContentHash = current?.contentHash;
      let stale = Boolean(current && current.contentHash !== baseArtifact.contentHash);
      if (Array.isArray(payload.artifactSnapshot)) {
        for (const value of payload.artifactSnapshot) {
          const dependency = asRecord(value);
          if (typeof dependency.kind !== "string" || typeof dependency.contentHash !== "string") continue;
          const latestDependency = latest.get(call.pluginId + ":" + taskId + ":" + dependency.kind);
          if (latestDependency && latestDependency.contentHash !== dependency.contentHash) {
            stale = true;
            latestContentHash = latestDependency.contentHash;
            break;
          }
        }
      }
      if (!stale || !latestContentHash) continue;
      callStates.push({
        interactionId: event.request.interactionId,
        status: "stale",
        error: {
          code: "stale_card",
          message: "This card targets an older artifact version. Load the latest version before submitting.",
          latestContentHash
        }
      });
    }
    if (callStates.length) states.set(call.pluginId + ":" + call.callId, callStates);
  }
  return states;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readOptions(value: unknown): Array<{ label: string; value: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [{ label: item.trim(), value: item }];
    const option = asRecord(item);
    const label = firstString(option, ["label", "name", "title"]);
    return label ? [{ label, value: "value" in option ? option.value : label }] : [];
  });
}

function readStrings(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

interface PluginFileRule {
  extensions: string[];
  disposition: "blocked";
  code: string | null;
  message: string;
}

function readFileRules(value: unknown): PluginFileRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const rule = asRecord(raw);
    const extensions = readStrings(rule.extensions).map((item) => item.toLowerCase());
    const message = firstString(rule, ["message"]);
    if (rule.disposition !== "blocked" || !extensions.length || !message) return [];
    return [{ extensions, disposition: "blocked" as const, code: firstString(rule, ["code"]), message }];
  });
}

function classifyPluginInputFile(
  file: File,
  accept: string,
  maxBytes: number | null,
  rules: PluginFileRule[],
  t: ReturnType<typeof useTranslation>["t"]
): { file: File; status: "ready" | "blocked"; code: string | null; message: string | null } {
  const name = file.name.toLowerCase();
  const rule = rules.find((item) => item.extensions.some((extension) => name.endsWith(extension)));
  if (rule) return { file, status: "blocked", code: rule.code, message: rule.message };
  if (!matchesAccept(file, accept) || !classifyAgentAttachmentFile(file)) {
    return { file, status: "blocked", code: "file_unsupported", message: t("plugin.ui.fileUnsupported") };
  }
  if (maxBytes && file.size > maxBytes) {
    return { file, status: "blocked", code: "file_too_large", message: t("plugin.ui.fileTooLarge") };
  }
  return { file, status: "ready", code: null, message: null };
}

function validateReadyFileCount(files: File[], maxFiles: number | null, t: ReturnType<typeof useTranslation>["t"]): string | null {
  if (maxFiles && files.length > maxFiles) return t("plugin.ui.fileCountExceeded");
  return null;
}

function matchesAccept(file: File, accept: string): boolean {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  return accept.split(",").some((raw) => {
    const rule = raw.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith(".")) return name.endsWith(rule);
    if (rule.endsWith("/*")) return mime.startsWith(rule.slice(0, -1));
    return mime === rule;
  });
}

export function resolveSafeArtifactUri(raw: string): string | null {
  try {
    const url = new URL(raw, typeof window === "undefined" ? "http://localhost" : window.location.origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
