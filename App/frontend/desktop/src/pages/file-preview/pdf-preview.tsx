import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
  Search,
  UnfoldHorizontal,
  GalleryVertical,
  X
} from "lucide-react";
import {
  GlobalWorkerOptions,
  TextLayer,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy
} from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { useTranslation } from "../../i18n/use-translation.js";
import { computePdfDisplayScale, highlightPdfTextLayer, nextPdfMatchIndex } from "./pdf-preview-state.js";
import type { FilePreviewViewState } from "./file-preview-types.js";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.15;

interface PdfSearchMatch {
  page: number;
  occurrence: number;
}

export interface PdfPreviewProps {
  data: ArrayBuffer;
  initialState?: FilePreviewViewState;
  onStateChange?: (state: FilePreviewViewState) => void;
}

export function PdfPreview(props: PdfPreviewProps): ReactNode {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const programmaticScrollUntilRef = useRef(0);
  const pageRef = useRef(props.initialState?.page ?? 1);
  const scrollSyncRafRef = useRef(0);
  const onStateChangeRef = useRef(props.onStateChange);
  onStateChangeRef.current = props.onStateChange;
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [thumbnailsOpen, setThumbnailsOpen] = useState(true);
  const [page, setPage] = useState(props.initialState?.page ?? 1);
  const [pageDraft, setPageDraft] = useState(String(props.initialState?.page ?? 1));
  const [scale, setScale] = useState(props.initialState?.scale ?? 1);
  const [fit, setFit] = useState<"width" | null>(
    props.initialState?.fit === null ? null : "width"
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PdfSearchMatch[]>([]);
  const [matchIndex, setMatchIndex] = useState(-1);
  const [viewportSize, setViewportSize] = useState({ width: 640, height: 720 });
  const [pageNaturalSize, setPageNaturalSize] = useState<{ width: number; height: number } | null>(null);
  pageRef.current = page;

  useEffect(() => {
    let active = true;
    const loadingTask = getDocument({ data: new Uint8Array(props.data.slice(0)) });
    setDocument(null);
    setFailed(false);
    void loadingTask.promise.then((next) => {
      if (active) setDocument(next);
      else void next.loadingTask.destroy();
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => {
      active = false;
      void loadingTask.destroy();
    };
  }, [props.data]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setViewportSize({
      width: Math.max(120, element.clientWidth - 48),
      height: Math.max(360, element.clientHeight - 48)
    });
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [document]);

  // Restore once when the document first becomes ready. Re-applying scrollTop on
  // every persisted-state update fights trackpad momentum and feels like rollback.
  useEffect(() => {
    if (!document) return;
    const top = props.initialState?.scrollTop;
    if (top == null) return;
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = top;
    });
    return () => window.cancelAnimationFrame(frame);
    // intentionally only when document identity changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document]);

  useEffect(() => {
    if (!document) {
      setPageNaturalSize(null);
      return;
    }
    let active = true;
    void document.getPage(Math.min(Math.max(page, 1), document.numPages)).then((pdfPage) => {
      if (!active) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      setPageNaturalSize({ width: natural.width, height: natural.height });
    }).catch(() => {
      if (active) setPageNaturalSize(null);
    });
    return () => {
      active = false;
    };
  }, [document, page]);

  useEffect(() => {
    setPageDraft(String(page));
    onStateChangeRef.current?.({
      page,
      scale,
      fit,
      scrollTop: scrollRef.current?.scrollTop ?? 0
    });
  }, [fit, page, scale]);

  useEffect(() => {
    if (!document || !query.trim()) {
      setMatches([]);
      setMatchIndex(-1);
      return;
    }
    setMatches([]);
    setMatchIndex(-1);
    let active = true;
    const timer = window.setTimeout(() => {
      void findPdfMatches(document, query).then((next) => {
        if (!active) return;
        setMatches(next);
        setMatchIndex(next.length ? 0 : -1);
        if (next[0]) {
          programmaticScrollUntilRef.current = Date.now() + 450;
          scrollToPage(scrollRef.current, next[0].page);
        }
      });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [document, query]);

  useEffect(() => {
    const receive = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => searchRef.current?.focus(), 0);
      } else if (event.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setQuery("");
      }
    };
    window.addEventListener("keydown", receive);
    return () => window.removeEventListener("keydown", receive);
  }, [searchOpen]);

  const changePage = useCallback((nextPage: number) => {
    if (!document) return;
    const normalized = Math.min(document.numPages, Math.max(1, Math.round(nextPage)));
    programmaticScrollUntilRef.current = Date.now() + 350;
    pageRef.current = normalized;
    setPage(normalized);
    window.requestAnimationFrame(() => {
      scrollToPage(scrollRef.current, normalized);
    });
  }, [document]);

  const navigateMatch = useCallback((direction: -1 | 1) => {
    if (!matches.length) return;
    const next = nextPdfMatchIndex(matchIndex, direction, matches.length);
    setMatchIndex(next);
    changePage(matches[next]!.page);
  }, [changePage, matchIndex, matches]);

  if (failed) {
    return <div className="workspace-artifact-preview-empty"><strong>{t("filePreview.failed")}</strong></div>;
  }
  if (!document) {
    return <div className="workspace-artifact-preview-empty"><strong>{t("filePreview.loading")}</strong></div>;
  }

  const effectiveScale = fit === null ? scale : undefined;
  const displayScale = pageNaturalSize
    ? computePdfDisplayScale({
      pageWidth: pageNaturalSize.width,
      pageHeight: pageNaturalSize.height,
      viewportWidth: viewportSize.width,
      viewportHeight: viewportSize.height,
      fit,
      scale
    })
    : scale;
  return (
    <div className="pdf-preview">
      <div className="pdf-preview__toolbar">
        <button type="button" title={t("filePreview.thumbnails")} aria-label={t("filePreview.thumbnails")} onClick={() => setThumbnailsOpen((open) => !open)}>
          <GalleryVertical size={15} />
        </button>
        <span className="pdf-preview__toolbar-separator" />
        <button type="button" title={t("filePreview.previous")} aria-label={t("filePreview.previous")} disabled={page <= 1} onClick={() => changePage(page - 1)}><ChevronLeft size={15} /></button>
        <label className="pdf-preview__page-field">
          <span className="sr-only">{t("filePreview.page")}</span>
          <input
            inputMode="numeric"
            value={pageDraft}
            onChange={(event) => setPageDraft(event.target.value.replace(/\D/g, ""))}
            onBlur={() => changePage(Number(pageDraft) || page)}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === "Enter") changePage(Number(pageDraft) || page);
            }}
          />
          <span>/ {document.numPages}</span>
        </label>
        <button type="button" title={t("filePreview.next")} aria-label={t("filePreview.next")} disabled={page >= document.numPages} onClick={() => changePage(page + 1)}><ChevronRight size={15} /></button>
        <span className="pdf-preview__toolbar-separator" />
        <button type="button" title={t("filePreview.zoomOut")} aria-label={t("filePreview.zoomOut")} onClick={() => { setFit(null); setScale((value) => clamp((fit ? displayScale : value) - SCALE_STEP)); }}><Minus size={15} /></button>
        <span className="pdf-preview__zoom-value">{Math.round(displayScale * 100)}%</span>
        <button type="button" title={t("filePreview.zoomIn")} aria-label={t("filePreview.zoomIn")} onClick={() => { setFit(null); setScale((value) => clamp((fit ? displayScale : value) + SCALE_STEP)); }}><Plus size={15} /></button>
        <button type="button" className={fit === "width" ? "is-active" : ""} title={t("filePreview.fitWidth")} aria-label={t("filePreview.fitWidth")} onClick={() => setFit("width")}><UnfoldHorizontal size={15} /></button>
        <span className="pdf-preview__toolbar-spacer" />
        <button type="button" className={searchOpen ? "is-active" : ""} title={t("filePreview.search")} aria-label={t("filePreview.search")} onClick={() => { setSearchOpen((open) => !open); window.setTimeout(() => searchRef.current?.focus(), 0); }}><Search size={15} /></button>
      </div>
      {searchOpen ? (
        <div className="pdf-preview__search">
          <Search size={14} />
          <input ref={searchRef} value={query} placeholder={t("filePreview.search")} onChange={(event) => setQuery(event.target.value)} />
          <span>{matches.length ? `${Math.max(1, matchIndex + 1)} / ${matches.length}` : "0 / 0"}</span>
          <button type="button" disabled={!matches.length} title={t("filePreview.previous")} onClick={() => navigateMatch(-1)}><ChevronLeft size={14} /></button>
          <button type="button" disabled={!matches.length} title={t("filePreview.next")} onClick={() => navigateMatch(1)}><ChevronRight size={14} /></button>
          <button type="button" aria-label={t("common.close")} onClick={() => { setSearchOpen(false); setQuery(""); }}><X size={14} /></button>
        </div>
      ) : null}
      <div className="pdf-preview__body">
        {thumbnailsOpen ? (
          <aside className="pdf-preview__thumbnails" aria-label={t("filePreview.thumbnails")}>
            {pageNumbers(document.numPages).map((number) => (
              <button key={number} type="button" className={number === page ? "is-active" : ""} onClick={() => changePage(number)}>
                <PdfCanvasPage document={document} pageNumber={number} targetWidth={112} thumbnail />
                <span>{number}</span>
              </button>
            ))}
          </aside>
        ) : null}
        <div
          ref={scrollRef}
          className="pdf-preview__pages"
          onScroll={(event) => {
            if (Date.now() < programmaticScrollUntilRef.current) return;
            const container = event.currentTarget;
            if (scrollSyncRafRef.current) return;
            scrollSyncRafRef.current = window.requestAnimationFrame(() => {
              scrollSyncRafRef.current = 0;
              let closestPage = pageRef.current;
              let closestDistance = Number.POSITIVE_INFINITY;
              for (const item of container.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
                const distance = Math.abs(item.offsetTop - container.scrollTop - 16);
                if (distance < closestDistance) {
                  closestDistance = distance;
                  closestPage = Number(item.dataset.pdfPage);
                }
              }
              if (closestPage !== pageRef.current) {
                pageRef.current = closestPage;
                setPage(closestPage);
              }
            });
          }}
        >
          {pageNumbers(document.numPages).map((number) => (
            <div key={number} data-pdf-page={number} className="pdf-preview__page-shell">
              <PdfCanvasPage
                document={document}
                pageNumber={number}
                targetWidth={viewportSize.width}
                scale={effectiveScale}
                fit={fit}
                searchQuery={query}
                activeSearchOccurrence={
                  matches[matchIndex]?.page === number
                    ? matches[matchIndex]!.occurrence
                    : null
                }
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PdfCanvasPage(props: {
  document: PDFDocumentProxy;
  pageNumber: number;
  targetWidth: number;
  scale?: number;
  fit?: "width" | null;
  thumbnail?: boolean;
  searchQuery?: string;
  activeSearchOccurrence?: number | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(props.pageNumber <= 2);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [renderFailed, setRenderFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || visible || typeof IntersectionObserver === "undefined") {
      if (typeof IntersectionObserver === "undefined") setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    }, { rootMargin: props.thumbnail ? "240px" : "900px" });
    observer.observe(host);
    return () => observer.disconnect();
  }, [props.thumbnail, visible]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    void props.document.getPage(props.pageNumber).then((next) => {
      if (active) setPage(next);
    });
    return () => {
      active = false;
      setPage(null);
    };
  }, [props.document, props.pageNumber, visible]);

  const viewport = useMemo(() => {
    if (!page) return null;
    const natural = page.getViewport({ scale: 1 });
    const chosenScale = props.thumbnail
      ? props.targetWidth / natural.width
      : props.fit === "width"
        ? props.targetWidth / natural.width
        : props.scale ?? 1;
    return page.getViewport({
      scale: props.thumbnail || props.fit
        ? Math.max(0.1, chosenScale)
        : clamp(chosenScale)
    });
  }, [page, props.fit, props.scale, props.targetWidth, props.thumbnail]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!page || !viewport || !canvas) return;
    setRenderFailed(false);
    const outputScale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    let renderTask: ReturnType<PDFPageProxy["render"]>;
    try {
      renderTask = page.render({
        canvas,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0]
      });
    } catch {
      setRenderFailed(true);
      return;
    }
    void renderTask.promise.catch(() => undefined);
    let textLayer: TextLayer | null = null;
    if (!props.thumbnail && textRef.current) {
      textRef.current.replaceChildren();
      textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: textRef.current,
        viewport
      });
      void textLayer.render()
        .then(() => highlightPdfTextLayer(
          textRef.current,
          props.searchQuery ?? "",
          props.activeSearchOccurrence ?? null
        ))
        .then((activeMark) => {
          if (!activeMark) return;
          window.requestAnimationFrame(() => scrollElementWithinContainer(
            activeMark.closest<HTMLElement>(".pdf-preview__pages"),
            activeMark,
            "center"
          ));
        })
        .catch(() => undefined);
    }
    return () => {
      renderTask.cancel();
      textLayer?.cancel();
    };
  }, [page, props.activeSearchOccurrence, props.searchQuery, props.thumbnail, viewport]);

  const placeholderRatio = page ? page.getViewport({ scale: 1 }).height / page.getViewport({ scale: 1 }).width : 1.414;
  return (
    <div
      ref={hostRef}
      className={`pdf-preview__canvas-host${props.thumbnail ? " pdf-preview__canvas-host--thumbnail" : ""}`}
      style={viewport
        ? { width: viewport.width, height: viewport.height }
        : { width: props.targetWidth, height: props.targetWidth * placeholderRatio }}
    >
      {renderFailed ? <div className="pdf-preview__page-error">!</div> : <canvas ref={canvasRef} />}
      {!props.thumbnail && !renderFailed ? <div ref={textRef} className="textLayer" /> : null}
    </div>
  );
}

async function findPdfMatches(document: PDFDocumentProxy, rawQuery: string): Promise<PdfSearchMatch[]> {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return [];
  const matches: PdfSearchMatch[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    let occurrence = 0;
    for (const item of content.items) {
      const text = ("str" in item ? item.str : "").toLocaleLowerCase();
      let index = 0;
      while ((index = text.indexOf(query, index)) >= 0) {
        matches.push({ page: pageNumber, occurrence });
        occurrence += 1;
        index += Math.max(1, query.length);
      }
    }
  }
  return matches;
}

function scrollToPage(container: HTMLDivElement | null, page: number): void {
  const target = container?.querySelector<HTMLElement>(`[data-pdf-page="${page}"]`);
  if (container && target) scrollElementWithinContainer(container, target, "start");
}

function scrollElementWithinContainer(
  container: HTMLElement | null,
  target: HTMLElement,
  block: "start" | "center"
): void {
  if (!container || !container.contains(target)) return;
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const centerOffset = block === "center"
    ? container.clientHeight / 2 - targetRect.height / 2
    : 0;
  container.scrollTop += targetRect.top - containerRect.top - centerOffset;
}

function pageNumbers(count: number): number[] {
  return Array.from({ length: count }, (_value, index) => index + 1);
}

function clamp(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}
