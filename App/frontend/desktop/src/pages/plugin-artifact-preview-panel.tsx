import { useEffect, useMemo } from "react";
import { Download, FileOutput, X } from "lucide-react";
import type { PluginArtifactRef } from "@memmy/local-api-contracts";
import type { PluginsClient } from "../api/plugins-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { startBrowserDownload } from "./agent-message-content.js";
import { FilePreview } from "./file-preview/file-preview.js";
import type { FilePreviewResource } from "./file-preview/file-preview-types.js";
import { SidebarResizeHandle, useResizableSidebar } from "./sidebar-resize.js";

const PLUGIN_ARTIFACT_WIDTH_STORAGE_KEY = "memmy.pluginArtifact.previewWidth";

export interface PluginArtifactPreviewPanelProps {
  artifact: PluginArtifactRef;
  readArtifact: PluginsClient["readArtifact"];
  onClose(): void;
  onWidthChange?: (width: number) => void;
  /** Measured inline size of the row this pane shares with the chat. */
  sharedRowWidth?: number | null;
  /** Space the shared row always keeps for the chat beside this pane. */
  sharedRowReservedWidth?: number;
}

export function PluginArtifactPreviewPanel(props: PluginArtifactPreviewPanelProps) {
  const { t } = useTranslation();
  const resize = useResizableSidebar({
    storageKey: PLUGIN_ARTIFACT_WIDTH_STORAGE_KEY,
    defaultWidth: 560,
    minWidth: 380,
    maxWidth: 880,
    resizeDirection: -1,
    availableWidth: props.sharedRowWidth ?? null,
    reservedPrimaryWidth: props.sharedRowReservedWidth
  });
  useEffect(() => props.onWidthChange?.(resize.appliedWidth), [props.onWidthChange, resize.appliedWidth]);

  const download = async () => {
    const blob = await props.readArtifact(props.artifact.downloadUri ?? props.artifact.uri);
    const objectUrl = URL.createObjectURL(blob);
    startBrowserDownload(objectUrl, props.artifact.name);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  };
  const resource = useMemo<FilePreviewResource>(() => ({
    id: `plugin:${props.artifact.id}`,
    name: props.artifact.name,
    mediaType: props.artifact.mediaType,
    load: () => props.readArtifact(props.artifact.uri),
    download
  }), [
    props.artifact.id,
    props.artifact.mediaType,
    props.artifact.name,
    props.artifact.uri,
    props.artifact.downloadUri,
    props.readArtifact
  ]);
  return (
    <>
      <SidebarResizeHandle
        label={t("workspaceArtifact.resize")}
        width={resize.appliedWidth}
        minWidth={resize.appliedMinWidth}
        maxWidth={resize.appliedMaxWidth}
        isResizing={resize.isResizing}
        onResizeStart={resize.beginResize}
        onResizeBy={resize.resizeBy}
      />
      <aside className="workspace-artifact-preview-pane workspace-artifact-preview-pane--plugin workspace-artifact-preview-pane--lifted" style={resize.sidebarStyle} aria-label={t("plugin.ui.artifactPreview")}>
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
            <FilePreview resource={resource} />
          </section>
        </div>
      </aside>
    </>
  );
}
