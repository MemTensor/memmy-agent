import { useEffect, useRef, useState } from "react";
import { AlertCircle, Download, FileOutput, X } from "lucide-react";
import type { PluginArtifactRef } from "@memmy/local-api-contracts";
import type { PluginsClient } from "../api/plugins-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { startBrowserDownload } from "./agent-message-content.js";
import { SidebarResizeHandle, useResizableSidebar } from "./sidebar-resize.js";

const PLUGIN_ARTIFACT_WIDTH_STORAGE_KEY = "memmy.pluginArtifact.previewWidth";

export interface PluginArtifactPreviewPanelProps {
  artifact: PluginArtifactRef;
  readArtifact: PluginsClient["readArtifact"];
  onClose(): void;
  onWidthChange?: (width: number) => void;
}

export function PluginArtifactPreviewPanel(props: PluginArtifactPreviewPanelProps) {
  const { t } = useTranslation();
  const generation = useRef(0);
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; blob: Blob; objectUrl: string | null; text: string | null }
    | { status: "error" }
  >({ status: "loading" });
  const resize = useResizableSidebar({
    storageKey: PLUGIN_ARTIFACT_WIDTH_STORAGE_KEY,
    defaultWidth: 560,
    minWidth: 380,
    maxWidth: 880,
    resizeDirection: -1
  });

  useEffect(() => props.onWidthChange?.(resize.width), [props.onWidthChange, resize.width]);

  useEffect(() => {
    const current = generation.current + 1;
    generation.current = current;
    let objectUrl: string | null = null;
    setState({ status: "loading" });
    void props.readArtifact(props.artifact.uri).then(async (blob) => {
      if (generation.current !== current) return;
      const mediaType = props.artifact.mediaType.toLowerCase();
      if (isTextPreview(mediaType)) {
        setState({ status: "ready", blob, objectUrl: null, text: await blob.text() });
        return;
      }
      if (mediaType === "application/pdf" || mediaType.startsWith("image/")) {
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", blob, objectUrl, text: null });
        return;
      }
      setState({ status: "ready", blob, objectUrl: null, text: null });
    }).catch(() => {
      if (generation.current === current) setState({ status: "error" });
    });
    return () => {
      if (generation.current === current) generation.current += 1;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [props.artifact.id, props.artifact.uri, props.artifact.mediaType, props.readArtifact]);

  const download = async () => {
    const blob = state.status === "ready"
      ? state.blob
      : await props.readArtifact(props.artifact.downloadUri ?? props.artifact.uri);
    const objectUrl = URL.createObjectURL(blob);
    startBrowserDownload(objectUrl, props.artifact.name);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  };

  const mediaType = props.artifact.mediaType.toLowerCase();
  return (
    <>
      <SidebarResizeHandle
        label={t("workspaceArtifact.resize")}
        width={resize.width}
        minWidth={resize.minWidth}
        maxWidth={resize.maxWidth}
        isResizing={resize.isResizing}
        onResizeStart={resize.beginResize}
        onResizeBy={resize.resizeBy}
      />
      <aside className="workspace-artifact-preview-pane workspace-artifact-preview-pane--lifted" style={resize.sidebarStyle} aria-label={t("plugin.ui.artifactPreview")}>
        <header className="workspace-artifact-preview-toolbar">
          <div className="workspace-artifact-file-tabs">
            <div className="workspace-artifact-file-tab workspace-artifact-file-tab--active">
              <FileOutput size={13} aria-hidden="true" />
              <span title={props.artifact.name}>{props.artifact.name}</span>
            </div>
          </div>
          <div className="workspace-artifact-preview-toolbar__actions">
            <button type="button" aria-label={t("plugin.ui.download")} title={t("plugin.ui.download")} onClick={() => void download()}>
              <Download size={15} />
            </button>
            <button type="button" aria-label={t("common.close")} title={t("common.close")} onClick={props.onClose}>
              <X size={15} />
            </button>
          </div>
        </header>
        <div className="workspace-artifact-preview-body">
          <section className="workspace-artifact-preview-main">
            {state.status === "loading" ? (
              <div className="workspace-artifact-preview-empty"><FileOutput size={28} /><strong>{t("common.loading")}</strong></div>
            ) : state.status === "error" ? (
              <div className="workspace-artifact-preview-empty" role="alert"><AlertCircle size={28} /><strong>{t("plugin.ui.previewFailed")}</strong></div>
            ) : state.text !== null ? (
              <article className="workspace-artifact-preview-document"><pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{state.text}</pre></article>
            ) : state.objectUrl && mediaType.startsWith("image/") ? (
              <div className="flex h-full w-full items-center justify-center overflow-auto bg-canvas-oat/40 p-4"><img src={state.objectUrl} alt={props.artifact.name} className="max-h-full max-w-full object-contain" /></div>
            ) : state.objectUrl && mediaType === "application/pdf" ? (
              <iframe title={props.artifact.name} src={state.objectUrl} className="h-full w-full border-0 bg-background-paper" />
            ) : (
              <div className="workspace-artifact-preview-empty"><FileOutput size={28} /><strong>{t("plugin.ui.previewUnavailable")}</strong><small>{t("plugin.ui.downloadToView")}</small></div>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}

function isTextPreview(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/json" || mediaType === "application/x-bibtex";
}
