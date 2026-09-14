import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Download, FileOutput, X } from "lucide-react";
import type { PluginArtifactRef } from "@memmy/local-api-contracts";
import type { PluginsClient } from "../api/plugins-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import {
  readDocxBlocks,
  readXlsxSheets,
  type DocxBlock,
  type DocxTextSpan,
  type XlsxSheet
} from "../lib/office-preview.js";
import { startBrowserDownload } from "./agent-message-content.js";
import { SidebarResizeHandle, useResizableSidebar } from "./sidebar-resize.js";

const PLUGIN_ARTIFACT_WIDTH_STORAGE_KEY = "memmy.pluginArtifact.previewWidth";
const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
    | { status: "ready"; blob: Blob; objectUrl: string | null; text: string | null; office: OfficePreview | null }
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
        setState({ status: "ready", blob, objectUrl: null, text: await blob.text(), office: null });
        return;
      }
      if (mediaType === "application/pdf" || mediaType.startsWith("image/")) {
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", blob, objectUrl, text: null, office: null });
        return;
      }
      if (mediaType === DOCX_MEDIA_TYPE || mediaType === XLSX_MEDIA_TYPE) {
        // A malformed or password-protected package must still offer a download,
        // so a parse failure degrades to the unavailable placeholder.
        const office = await readOfficePreview(mediaType, blob).catch(() => null);
        if (generation.current !== current) return;
        setState({ status: "ready", blob, objectUrl: null, text: null, office });
        return;
      }
      setState({ status: "ready", blob, objectUrl: null, text: null, office: null });
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
            ) : state.office?.kind === "docx" ? (
              <article className="workspace-artifact-preview-document"><DocxPreview blocks={state.office.blocks} /></article>
            ) : state.office?.kind === "xlsx" ? (
              <XlsxPreview sheets={state.office.sheets} />
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

type OfficePreview =
  | { kind: "docx"; blocks: DocxBlock[] }
  | { kind: "xlsx"; sheets: XlsxSheet[] };

/**
 * Parses an Office artifact into previewable data.
 *
 * @param mediaType the artifact media type.
 * @param blob the artifact contents.
 * @returns the parsed preview.
 */
async function readOfficePreview(mediaType: string, blob: Blob): Promise<OfficePreview> {
  if (mediaType === DOCX_MEDIA_TYPE) {
    return { kind: "docx", blocks: await readDocxBlocks(blob) };
  }
  return { kind: "xlsx", sheets: await readXlsxSheets(blob) };
}

/** Renders parsed Word content as React nodes, so no document markup is injected. */
function DocxPreview(props: { blocks: DocxBlock[] }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed text-text-ink/80">
      {props.blocks.map((block, index) => {
        if (block.kind === "table") {
          return (
            <table key={index} className="w-full table-auto border-collapse text-xs">
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} className="border border-border-stone/40 px-2 py-1 align-top">
                        {cell.map((span, spanIndex) => <DocxSpan key={spanIndex} span={span} />)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        // An empty paragraph is the document's own vertical spacing; keep it visible.
        if (!block.spans.length) return <div key={index} className="h-3" />;
        const content = block.spans.map((span, spanIndex) => <DocxSpan key={spanIndex} span={span} />);
        if (block.headingLevel === null) {
          return <p key={index} className="whitespace-pre-wrap break-words">{content}</p>;
        }
        const Heading = `h${Math.min(6, block.headingLevel + 1)}` as "h2";
        return (
          <Heading key={index} className={`mt-3 break-words font-semibold text-text-ink/90 ${block.headingLevel === 1 ? "text-base" : "text-sm"}`}>
            {content}
          </Heading>
        );
      })}
    </div>
  );
}

function DocxSpan(props: { span: DocxTextSpan }) {
  const { text, bold, italic } = props.span;
  if (!bold && !italic) return <>{text}</>;
  return <span className={`${bold ? "font-semibold" : ""} ${italic ? "italic" : ""}`.trim()}>{text}</span>;
}

/** Renders each worksheet as a table, with the first row treated as the header. */
function XlsxPreview(props: { sheets: XlsxSheet[] }) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);
  const sheet = props.sheets[Math.min(activeIndex, props.sheets.length - 1)];
  if (!sheet) {
    return <div className="workspace-artifact-preview-empty"><FileOutput size={28} /><strong>{t("plugin.ui.previewUnavailable")}</strong></div>;
  }

  const [header, ...body] = sheet.rows;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {props.sheets.length > 1 ? (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border-stone/35 px-2 py-1.5" role="tablist" aria-label={t("plugin.ui.sheets")}>
          {props.sheets.map((candidate, index) => (
            <button
              key={`${candidate.name}:${index}`}
              type="button"
              role="tab"
              aria-selected={index === activeIndex}
              onClick={() => setActiveIndex(index)}
              className={`shrink-0 rounded-btn px-2.5 py-1 text-xs transition-colors ${index === activeIndex ? "bg-action-sky/10 font-medium text-action-sky" : "text-text-ink/55 hover:bg-canvas-oat"}`}
            >
              {candidate.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          {header ? (
            <thead className="sticky top-0 bg-background-paper">
              <tr>
                {header.map((cell, index) => (
                  <th key={index} scope="col" className="whitespace-nowrap border border-border-stone/40 px-2 py-1 text-left font-medium text-text-ink/70">{cell}</th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="border border-border-stone/40 px-2 py-1 align-top text-text-ink/75">{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
