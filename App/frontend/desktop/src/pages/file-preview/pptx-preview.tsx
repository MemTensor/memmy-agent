import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, LoaderCircle, Minus, Plus, RotateCw, Search, UnfoldHorizontal, X } from "lucide-react";
import { PptxViewer, RECOMMENDED_ZIP_LIMITS, type SearchHighlightHandle, type TextSearchResult } from "@aiden0z/pptx-renderer";
import pdfModuleUrl from "pdfjs-dist/build/pdf.min.mjs?url";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useTranslation } from "../../i18n/use-translation.js";
import type { FilePreviewResource, FilePreviewViewState } from "./file-preview-types.js";

const MIN_ZOOM = 25;
const MAX_ZOOM = 300;
const ZOOM_STEP = 25;
const MAX_SEARCH_MATCHES = 2_000;

// Office coordinates stay at the original slide size. The viewer scales the
// complete slide, and a shadow root keeps application CSS out of its layout.
const SLIDE_STYLES = `
  :host { display: block; width: 100%; min-width: 0; color: #000;
    font-family: Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 16px; line-height: normal; text-align: left;
    letter-spacing: normal; word-break: normal; }
  p { margin: 0; }
  img { max-width: none; }
`;

export function PptxPreview(props: {
  blob: Blob;
  resource: FilePreviewResource;
  viewState?: FilePreviewViewState;
  onViewStateChange?: (state: FilePreviewViewState) => void;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PptxViewer | null>(null);
  const readyRef = useRef(false);
  const viewStateRef = useRef(props.viewState);
  const onViewStateChangeRef = useRef(props.onViewStateChange);
  viewStateRef.current = props.viewState;
  onViewStateChangeRef.current = props.onViewStateChange;
  const searchRef = useRef<HTMLInputElement>(null);
  const highlightRef = useRef<SearchHighlightHandle | null>(null);
  const highlightGenerationRef = useRef(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [revision, setRevision] = useState(0);
  const [partial, setPartial] = useState(false);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageDraft, setPageDraft] = useState("1");
  const [zoom, setZoom] = useState(100);
  const [rendering, setRendering] = useState(false);
  const [renderRevision, setRenderRevision] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<TextSearchResult[]>([]);
  const [matchIndex, setMatchIndex] = useState(0);

  const saveViewState = useCallback(() => {
    const viewer = viewerRef.current;
    if (!readyRef.current || !viewer) return;
    onViewStateChangeRef.current?.({
      ...viewStateRef.current,
      page: viewer.currentSlideIndex + 1,
      scale: viewer.zoomPercent / 100,
      fit: viewer.fitMode === "contain" ? "width" : null,
      scrollTop: scrollRef.current?.scrollTop ?? 0,
    });
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const scroll = scrollRef.current;
    if (!host || !scroll) return;
    const controller = new AbortController();
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = SLIDE_STYLES;
    const container = document.createElement("div");
    shadow.replaceChildren(style, container);
    const initial = viewStateRef.current;
    readyRef.current = false;
    setStatus("loading");
    setPartial(false);
    setCount(0);
    setMatches([]);
    setMatchIndex(0);
    const viewer = new PptxViewer(container, {
      fitMode: initial?.fit === null ? "none" : "contain",
      zoomPercent: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (initial?.scale ?? 1) * 100)),
      scrollContainer: scroll,
      zipLimits: RECOMMENDED_ZIP_LIMITS,
      lazySlides: true,
      lazyMedia: true,
      pdfjs: { moduleUrl: new URL(pdfModuleUrl, window.location.href).href, workerUrl: new URL(pdfWorkerUrl, window.location.href).href },
      onSlideChange: (index) => {
        if (controller.signal.aborted) return;
        setPage(index + 1);
        setPageDraft(String(index + 1));
        saveViewState();
      },
      onSlideError: () => { if (!controller.signal.aborted) setPartial(true); },
      onNodeError: () => { if (!controller.signal.aborted) setPartial(true); },
      onSlideRendered: (index, element) => preserveLatinWordWrapping(viewer, index, element),
      onRenderStart: () => { if (!controller.signal.aborted) setRendering(true); },
      onRenderComplete: () => {
        if (controller.signal.aborted) return;
        setRendering(false);
        setRenderRevision((value) => value + 1);
      },
    });
    viewerRef.current = viewer;
    void viewer.open(props.blob, {
      renderMode: "list",
      listOptions: { windowed: true, initialSlides: 2, batchSize: 8 },
      signal: controller.signal,
    }).then(async () => {
      if (controller.signal.aborted) return;
      if (!viewer.slideCount) throw new Error("empty_presentation");
      setCount(viewer.slideCount);
      setZoom(viewer.zoomPercent);
      if (initial?.page && initial.page > 1) await viewer.goToSlide(initial.page - 1, { behavior: "instant", block: "start" });
      if (controller.signal.aborted) return;
      if (initial?.scrollTop != null) scroll.scrollTop = initial.scrollTop;
      readyRef.current = true;
      setStatus("ready");
    }).catch(() => {
      if (controller.signal.aborted) return;
      readyRef.current = false;
      viewer.destroy();
      setStatus("error");
    });
    return () => {
      controller.abort();
      readyRef.current = false;
      highlightGenerationRef.current += 1;
      highlightRef.current?.dispose();
      highlightRef.current = null;
      viewer.destroy();
      if (viewerRef.current === viewer) viewerRef.current = null;
      shadow.replaceChildren();
    };
  }, [props.blob, revision, saveViewState]);

  const runViewerAction = useCallback((action: (viewer: PptxViewer) => Promise<void>) => {
    const viewer = viewerRef.current;
    if (!viewer || !readyRef.current) return;
    void action(viewer).then(() => {
      if (viewerRef.current !== viewer) return;
      setZoom(viewer.zoomPercent);
      saveViewState();
    }).catch(() => { if (viewerRef.current === viewer) setPartial(true); });
  }, [saveViewState]);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    setMatchIndex(0);
    setMatches([]);
    if (status !== "ready" || !searchOpen || !query.trim()) return;
    const timer = window.setTimeout(() => {
      try {
        setMatches(viewerRef.current?.searchText(query.trim()).slice(0, MAX_SEARCH_MATCHES) ?? []);
      } catch {
        setPartial(true);
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query, searchOpen, status]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const match = matches[matchIndex];
    const generation = ++highlightGenerationRef.current;
    highlightRef.current?.dispose();
    highlightRef.current = null;
    if (viewer && match) {
      void viewer.highlightSearchResult(match).then((handle) => {
        if (generation !== highlightGenerationRef.current || viewer !== viewerRef.current) handle?.dispose();
        else highlightRef.current = handle;
      }).catch(() => undefined);
    }
    return () => {
      highlightGenerationRef.current += 1;
      highlightRef.current?.dispose();
      highlightRef.current = null;
    };
  }, [matches, matchIndex, renderRevision]);

  const goToPage = (value: number) => {
    const target = Math.max(1, Math.min(count, Number.isFinite(value) ? Math.trunc(value) : page));
    setPageDraft(String(target));
    runViewerAction((viewer) => viewer.goToSlide(target - 1, { behavior: "instant", block: "start" }));
  };
  const changeMatch = (offset: number) => {
    if (matches.length) setMatchIndex((index) => (index + offset + matches.length) % matches.length);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
      searchRef.current?.focus();
    }
  };
  const disabled = status !== "ready" || rendering;

  return (
    <div className="pptx-preview" aria-label={props.resource.name} aria-busy={status === "loading"} onKeyDownCapture={onKeyDown}>
      <div className="pptx-preview__toolbar" role="toolbar" aria-label={t("filePreview.slides")}>
        <button type="button" disabled={disabled || page <= 1} title={t("filePreview.previous")} aria-label={t("filePreview.previous")} onClick={() => goToPage(page - 1)}><ChevronLeft size={15} /></button>
        <input type="number" min={1} max={count || 1} value={pageDraft} disabled={disabled} aria-label={t("filePreview.page")}
          onChange={(event) => setPageDraft(event.target.value)} onBlur={() => goToPage(Number(pageDraft))}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); goToPage(Number(pageDraft)); } }} />
        <span className="pptx-preview__count" aria-live="polite">/ {count}</span>
        <button type="button" disabled={disabled || page >= count} title={t("filePreview.next")} aria-label={t("filePreview.next")} onClick={() => goToPage(page + 1)}><ChevronRight size={15} /></button>
        <span className="pptx-preview__toolbar-spacer" />
        <button type="button" disabled={disabled || zoom <= MIN_ZOOM} title={t("filePreview.zoomOut")} aria-label={t("filePreview.zoomOut")} onClick={() => runViewerAction((viewer) => viewer.setZoom(Math.max(MIN_ZOOM, zoom - ZOOM_STEP)))}><Minus size={14} /></button>
        <span className="pptx-preview__zoom">{Math.round(zoom)}%</span>
        <button type="button" disabled={disabled || zoom >= MAX_ZOOM} title={t("filePreview.zoomIn")} aria-label={t("filePreview.zoomIn")} onClick={() => runViewerAction((viewer) => viewer.setZoom(Math.min(MAX_ZOOM, zoom + ZOOM_STEP)))}><Plus size={14} /></button>
        <button type="button" disabled={disabled} title={t("filePreview.fitWidth")} aria-label={t("filePreview.fitWidth")} onClick={() => runViewerAction(async (viewer) => { await viewer.setZoom(100); await viewer.setFitMode("contain"); })}><UnfoldHorizontal size={15} /></button>
        <button type="button" disabled={status !== "ready"} title={t("filePreview.findInFile")} aria-label={t("filePreview.findInFile")} onClick={() => setSearchOpen((open) => !open)}><Search size={14} /></button>
      </div>
      {searchOpen ? (
        <div className="file-preview__search-bar" role="search">
          <Search size={13} aria-hidden="true" />
          <input ref={searchRef} value={query} aria-label={t("filePreview.findInFile")} placeholder={t("filePreview.findInFile")}
            onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); changeMatch(event.shiftKey ? -1 : 1); }
              if (event.key === "Escape") setSearchOpen(false);
            }} />
          <span className="file-preview__search-count" aria-live="polite">{query ? `${matches.length ? matchIndex + 1 : 0}/${matches.length}` : ""}</span>
          <button type="button" disabled={!matches.length} aria-label={t("filePreview.previous")} onClick={() => changeMatch(-1)}><ChevronLeft size={13} /></button>
          <button type="button" disabled={!matches.length} aria-label={t("filePreview.next")} onClick={() => changeMatch(1)}><ChevronRight size={13} /></button>
          <button type="button" aria-label={t("common.close")} onClick={() => setSearchOpen(false)}><X size={13} /></button>
        </div>
      ) : null}
      {partial && status === "ready" ? <div className="file-preview__notice" role="status">{t("filePreview.slidesPartial")}</div> : null}
      <div ref={scrollRef} className="pptx-preview__scroll" onScroll={saveViewState}>
        <div ref={hostRef} className="pptx-preview__slides" />
      </div>
      {status !== "ready" ? (
        <div className="pptx-preview__status" role="status">
          {status === "loading" ? <LoaderCircle size={22} className="thread-panel-spin" /> : null}
          <span>{t(status === "loading" ? "filePreview.loading" : "filePreview.failed")}</span>
          {status === "error" ? (
            <div className="file-preview__fallback-actions">
              <button type="button" onClick={() => setRevision((value) => value + 1)}><RotateCw size={13} />{t("home.threadPanel.preview.retry")}</button>
              {props.resource.open ? <button type="button" onClick={() => void props.resource.open?.()}><ExternalLink size={13} />{t("filePreview.open")}</button> : null}
              {props.resource.download ? <button type="button" onClick={() => void props.resource.download?.()}>{t("filePreview.download")}</button> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const DRAWINGML_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";

function preserveLatinWordWrapping(viewer: PptxViewer, index: number, element: HTMLElement) {
  // Renderer 1.3 treats eaLnBrk="0" as CSS line-break:anywhere, which also
  // splits English words even when the paragraph explicitly has latinLnBrk="0".
  // Match those paragraphs to their OOXML text without altering other rules.
  const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
  const rules = new Map<string, boolean>();
  for (const node of viewer.presentationData?.slides[index]?.nodes ?? []) {
    const source = node.source.element;
    if (!source) continue;
    for (const paragraph of source.getElementsByTagNameNS(DRAWINGML_NS, "p")) {
      const properties = Array.from(paragraph.children).find((child) => child.namespaceURI === DRAWINGML_NS && child.localName === "pPr");
      const flag = properties?.getAttribute("latinLnBrk");
      if (flag !== "0" && flag !== "false" && flag !== "1" && flag !== "true") continue;
      const text = normalize(Array.from(paragraph.getElementsByTagNameNS(DRAWINGML_NS, "t")).map((run) => run.textContent ?? "").join(""));
      if (!text) continue;
      const bullet = properties?.getElementsByTagNameNS(DRAWINGML_NS, "buChar")[0]?.getAttribute("char");
      for (const label of bullet ? [text, normalize(`${bullet} ${text}`), normalize(`${bullet}${text}`)] : [text]) {
        rules.set(label, rules.get(label) === true || flag === "1" || flag === "true");
      }
    }
  }
  for (const paragraph of element.querySelectorAll<HTMLElement>("div")) {
    if (!paragraph.style.lineBreak || rules.get(normalize(paragraph.textContent ?? "")) !== false) continue;
    paragraph.style.lineBreak = "auto";
    paragraph.style.overflowWrap = "normal";
    paragraph.style.wordBreak = "normal";
  }
}
