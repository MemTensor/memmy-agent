import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject
} from "react";
import {
  ChevronDown,
  ChevronUp,
  Code2,
  ExternalLink,
  Eye,
  FileOutput,
  FolderSearch,
  Maximize2,
  Minimize2,
  Search,
  X
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { useTranslation } from "../../i18n/use-translation.js";
import { resolveFileType } from "../../lib/file-type.js";
import {
  readDocxBlocks,
  readXlsxSheets,
  type DocxBlock,
  type DocxTextSpan,
  type XlsxSheet
} from "../../lib/office-preview.js";
import type { FilePreviewResource, FilePreviewViewState } from "./file-preview-types.js";

const PdfPreview = lazy(async () => {
  const module = await import("./pdf-preview.js");
  return { default: module.PdfPreview };
});

const TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const OFFICE_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
const BINARY_PREVIEW_MAX_BYTES = 100 * 1024 * 1024;

export interface FilePreviewProps {
  resource: FilePreviewResource;
  viewState?: FilePreviewViewState;
  onViewStateChange?: (state: FilePreviewViewState) => void;
}

type LoadedState =
  | { status: "loading" }
  | { status: "ready"; blob: Blob }
  | { status: "too-large" }
  | { status: "error" };

export function FilePreview(props: FilePreviewProps): ReactNode {
  const { t } = useTranslation();
  const fileType = resolveFileType(props.resource.name, props.resource.mediaType);
  const maxBytes = previewLimit(fileType.kind);
  const [state, setState] = useState<LoadedState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    if (props.resource.size != null && props.resource.size > maxBytes) {
      setState({ status: "too-large" });
      return () => controller.abort();
    }
    setState({ status: "loading" });
    void props.resource.load(controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      setState(blob.size > maxBytes ? { status: "too-large" } : { status: "ready", blob });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ status: "error" });
    });
    return () => controller.abort();
  }, [maxBytes, props.resource]);

  if (state.status === "loading") {
    return <PreviewStatus label={t("filePreview.loading")} />;
  }
  if (state.status === "too-large") {
    return <PreviewStatus label={t("filePreview.tooLarge")} resource={props.resource} />;
  }
  if (state.status === "error") {
    return <PreviewStatus label={t("filePreview.failed")} resource={props.resource} />;
  }

  const loadedFileType = resolveFileType(
    props.resource.name,
    props.resource.mediaType ?? state.blob.type
  );
  const searchable = (content: ReactNode) => (
    <SearchablePreview contentKey={props.resource.id}>{content}</SearchablePreview>
  );
  if (loadedFileType.kind === "pdf") {
    return (
      <Suspense fallback={<PreviewStatus label={t("filePreview.loading")} />}>
        <PdfBlobPreview blob={state.blob} initialState={props.viewState} onStateChange={props.onViewStateChange} />
      </Suspense>
    );
  }
  if (loadedFileType.kind === "image") {
    return <ImagePreview blob={state.blob} name={props.resource.name} />;
  }
  if (loadedFileType.kind === "video" || loadedFileType.kind === "audio") {
    return <MediaPreview blob={state.blob} name={props.resource.name} kind={loadedFileType.kind} />;
  }
  if (loadedFileType.kind === "markdown") {
    return searchable(
      <MarkdownPreview
        blob={state.blob}
        resource={props.resource}
        initialMode={props.viewState?.markdownMode}
        onModeChange={(markdownMode) => props.onViewStateChange?.({
          ...props.viewState,
          markdownMode
        })}
      />
    );
  }
  if (loadedFileType.kind === "code" || loadedFileType.kind === "text") {
    return searchable(
      <TextPreview blob={state.blob} name={props.resource.name} code={loadedFileType.kind === "code"} />
    );
  }
  if (loadedFileType.kind === "word" && props.resource.name.toLowerCase().endsWith(".docx")) {
    return searchable(<OfficePreview kind="docx" blob={state.blob} />);
  }
  if (loadedFileType.kind === "spreadsheet" && props.resource.name.toLowerCase().endsWith(".xlsx")) {
    return searchable(<OfficePreview kind="xlsx" blob={state.blob} />);
  }
  if (
    loadedFileType.kind === "spreadsheet"
    && /\.(?:csv|tsv)$/i.test(props.resource.name)
  ) {
    return searchable(<TextPreview blob={state.blob} name={props.resource.name} code={false} />);
  }
  if (loadedFileType.kind === "generic") {
    return <GenericFilePreview blob={state.blob} resource={props.resource} />;
  }
  return <PreviewStatus label={t("filePreview.unavailable")} resource={props.resource} />;
}

const FILE_SEARCH_MATCH_HIGHLIGHT = "file-preview-search-match";
const FILE_SEARCH_ACTIVE_HIGHLIGHT = "file-preview-search-active";
const MAX_FILE_SEARCH_MATCHES = 5_000;

function SearchablePreview(props: { children: ReactNode; contentKey: string }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const search = useFileSearch(contentRef, props.contentKey);
  return (
    <div className="file-preview__searchable">
      {search.open ? <FileSearchBar {...search} /> : null}
      <div ref={contentRef} className="file-preview__search-content">
        {props.children}
      </div>
    </div>
  );
}

interface FileSearchState {
  open: boolean;
  query: string;
  count: number;
  activeIndex: number;
  inputRef: RefObject<HTMLInputElement | null>;
  setQuery: (query: string) => void;
  close: () => void;
  move: (direction: -1 | 1) => void;
}

function FileSearchBar(props: FileSearchState) {
  const { t } = useTranslation();
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      props.move(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.close();
    }
  };
  return (
    <div className="file-preview__search-bar" role="search">
      <Search size={13} aria-hidden="true" />
      <input
        ref={props.inputRef}
        type="text"
        value={props.query}
        aria-label={t("filePreview.findInFile")}
        placeholder={t("filePreview.findInFile")}
        onChange={(event) => props.setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="file-preview__search-count" aria-live="polite">
        {props.query ? `${props.count ? props.activeIndex + 1 : 0}/${props.count}` : ""}
      </span>
      <button
        type="button"
        disabled={props.count === 0}
        aria-label={t("filePreview.previous")}
        title={t("filePreview.previous")}
        onClick={() => props.move(-1)}
      >
        <ChevronUp size={13} />
      </button>
      <button
        type="button"
        disabled={props.count === 0}
        aria-label={t("filePreview.next")}
        title={t("filePreview.next")}
        onClick={() => props.move(1)}
      >
        <ChevronDown size={13} />
      </button>
      <button type="button" aria-label={t("common.close")} title={t("common.close")} onClick={props.close}>
        <X size={13} />
      </button>
    </div>
  );
}

function useFileSearch(
  contentRef: RefObject<HTMLDivElement | null>,
  contentKey: string
): FileSearchState {
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  const clearHighlights = useCallback(() => {
    const registry = fileSearchHighlightRegistry();
    registry?.delete(FILE_SEARCH_MATCH_HIGHLIGHT);
    registry?.delete(FILE_SEARCH_ACTIVE_HIGHLIGHT);
  }, []);

  const refreshMatches = useCallback(() => {
    clearHighlights();
    const root = contentRef.current;
    if (!open || !root || !query) {
      rangesRef.current = [];
      setCount(0);
      setActiveIndex(0);
      return;
    }
    const ranges = findTextRanges(root, query);
    rangesRef.current = ranges;
    setCount(ranges.length);
    const nextActiveIndex = Math.min(activeIndex, Math.max(0, ranges.length - 1));
    setActiveIndex(nextActiveIndex);
    const registry = fileSearchHighlightRegistry();
    const HighlightConstructor = fileSearchHighlightConstructor();
    if (registry && HighlightConstructor && ranges.length) {
      registry.set(FILE_SEARCH_MATCH_HIGHLIGHT, new HighlightConstructor(...ranges));
      registry.set(FILE_SEARCH_ACTIVE_HIGHLIGHT, new HighlightConstructor(ranges[nextActiveIndex]!));
    }
  }, [activeIndex, clearHighlights, contentRef, open, query]);

  useEffect(() => {
    refreshMatches();
    const root = contentRef.current;
    if (!root || !open) return clearHighlights;
    const observer = new MutationObserver(refreshMatches);
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      clearHighlights();
    };
  }, [clearHighlights, contentKey, contentRef, open, refreshMatches]);

  useEffect(() => {
    const registry = fileSearchHighlightRegistry();
    const HighlightConstructor = fileSearchHighlightConstructor();
    registry?.delete(FILE_SEARCH_ACTIVE_HIGHLIGHT);
    const range = rangesRef.current[activeIndex];
    if (!open || !range) return;
    if (registry && HighlightConstructor) {
      registry.set(FILE_SEARCH_ACTIVE_HIGHLIGHT, new HighlightConstructor(range));
    }
    scrollRangeWithinPreview(contentRef.current, range);
  }, [activeIndex, count, open, query]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setOpen(true);
        window.requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      } else if (event.key === "Escape" && open) {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  return {
    open,
    query,
    count,
    activeIndex,
    inputRef,
    setQuery: (next) => {
      setQuery(next);
      setActiveIndex(0);
    },
    close: () => setOpen(false),
    move: (direction) => setActiveIndex((current) => (
      count > 0 ? (current + direction + count) % count : 0
    ))
  };
}

interface FileSearchHighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
}

function fileSearchHighlightRegistry(): FileSearchHighlightRegistry | null {
  return ((globalThis.CSS as typeof CSS & {
    highlights?: FileSearchHighlightRegistry;
  } | undefined)?.highlights) ?? null;
}

function fileSearchHighlightConstructor(): (new (...ranges: Range[]) => unknown) | null {
  return (globalThis as typeof globalThis & {
    Highlight?: new (...ranges: Range[]) => unknown;
  }).Highlight ?? null;
}

function findTextRanges(root: HTMLElement, query: string): Range[] {
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      return parent?.closest("[data-file-search-exclude], .linenumber")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    }
  });
  let current = walker.nextNode();
  while (current) {
    const node = current as Text;
    const start = text.length;
    text += node.data;
    nodes.push({ node, start, end: text.length });
    current = walker.nextNode();
  }
  if (!text || !query) return [];

  const expression = new RegExp(escapeRegularExpression(query), "giu");
  const ranges: Range[] = [];
  let startNodeIndex = 0;
  let endNodeIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) && ranges.length < MAX_FILE_SEARCH_MATCHES) {
    const startOffset = match.index;
    const endOffset = startOffset + match[0].length;
    while (nodes[startNodeIndex] && startOffset >= nodes[startNodeIndex]!.end) startNodeIndex += 1;
    endNodeIndex = Math.max(endNodeIndex, startNodeIndex);
    while (nodes[endNodeIndex] && endOffset > nodes[endNodeIndex]!.end) endNodeIndex += 1;
    const start = nodes[startNodeIndex];
    const end = nodes[endNodeIndex];
    if (!start || !end) continue;
    const range = document.createRange();
    range.setStart(start.node, startOffset - start.start);
    range.setEnd(end.node, endOffset - end.start);
    ranges.push(range);
  }
  return ranges;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scrollRangeWithinPreview(boundary: HTMLElement | null, range: Range): void {
  if (!boundary) return;
  const target = range.startContainer.parentElement;
  const scrollContainer = target?.closest<HTMLElement>(
    ".file-preview__text, .file-preview__code, .file-preview__markdown, "
    + ".file-preview__office-document, .file-preview__table-scroll"
  );
  if (!scrollContainer || !boundary.contains(scrollContainer)) return;
  const containerRect = scrollContainer.getBoundingClientRect();
  const rangeRect = range.getBoundingClientRect();
  scrollContainer.scrollTop += (
    rangeRect.top
    - containerRect.top
    - scrollContainer.clientHeight / 2
    + rangeRect.height / 2
  );
  if (rangeRect.left < containerRect.left) {
    scrollContainer.scrollLeft += rangeRect.left - containerRect.left;
  } else if (rangeRect.right > containerRect.right) {
    scrollContainer.scrollLeft += rangeRect.right - containerRect.right;
  }
}

function PreviewStatus(props: { label: string; resource?: FilePreviewResource }) {
  const { t } = useTranslation();
  return (
    <div className="workspace-artifact-preview-empty">
      <FileOutput size={28} />
      <strong>{props.label}</strong>
      {props.resource ? (
        <div className="file-preview__fallback-actions">
          {props.resource.open ? <button type="button" onClick={() => void props.resource?.open?.()}><ExternalLink size={13} />{t("filePreview.open")}</button> : null}
          {props.resource.reveal ? <button type="button" onClick={() => void props.resource?.reveal?.()}><FolderSearch size={13} />{t("filePreview.reveal")}</button> : null}
          {props.resource.download ? <button type="button" onClick={() => void props.resource?.download?.()}>{t("filePreview.download")}</button> : null}
        </div>
      ) : null}
    </div>
  );
}

function PdfBlobPreview(props: {
  blob: Blob;
  initialState?: FilePreviewViewState;
  onStateChange?: (state: FilePreviewViewState) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<ArrayBuffer | null>(null);
  useEffect(() => {
    let active = true;
    void props.blob.arrayBuffer().then((value) => {
      if (active) setData(value);
    });
    return () => {
      active = false;
    };
  }, [props.blob]);
  return data
    ? <PdfPreview data={data} initialState={props.initialState} onStateChange={props.onStateChange} />
    : <PreviewStatus label={t("filePreview.loading")} />;
}

function TextPreview(props: { blob: Blob; name: string; code: boolean }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const truncated = props.blob.size >= TEXT_PREVIEW_MAX_BYTES;
  useEffect(() => {
    let active = true;
    void props.blob.slice(0, TEXT_PREVIEW_MAX_BYTES).text().then((value) => {
      if (active) setText(value);
    });
    return () => {
      active = false;
    };
  }, [props.blob]);
  if (!props.code) {
    return (
      <article className="file-preview__text">
        {truncated ? <div className="file-preview__notice">{t("filePreview.truncated")}</div> : null}
        <pre>{text}</pre>
      </article>
    );
  }
  return (
    <article className="file-preview__code">
      {truncated ? <div className="file-preview__notice">{t("filePreview.truncated")}</div> : null}
      <SyntaxHighlighter
        language={languageForFilename(props.name)}
        style={oneLight}
        showLineNumbers
        wrapLongLines={false}
        customStyle={{ margin: 0, minHeight: "100%", background: "transparent", fontSize: "12px" }}
      >
        {text}
      </SyntaxHighlighter>
    </article>
  );
}

function MarkdownPreview(props: {
  blob: Blob;
  resource: FilePreviewResource;
  initialMode?: "preview" | "source";
  onModeChange?: (mode: "preview" | "source") => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"preview" | "source">(props.initialMode ?? "preview");
  useEffect(() => {
    let active = true;
    void props.blob.slice(0, TEXT_PREVIEW_MAX_BYTES).text().then((value) => {
      if (active) setText(value);
    });
    return () => {
      active = false;
    };
  }, [props.blob]);
  useEffect(() => {
    setMode(props.initialMode ?? "preview");
  }, [props.initialMode, props.resource.id]);
  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => {
      const relative = resolveRelativePath(props.resource.path, href);
      return relative && props.resource.openRelativePath ? (
        <button type="button" className="file-preview__markdown-link" onClick={() => props.resource.openRelativePath?.(relative)}>{children}</button>
      ) : <span>{children}</span>;
    },
    img: ({ src, alt }) => {
      const relative = resolveRelativePath(props.resource.path, src);
      return relative && props.resource.loadRelativePath
        ? <RelativeImage path={relative} alt={alt ?? ""} load={props.resource.loadRelativePath} />
        : <span>{alt ?? ""}</span>;
    },
    code: MarkdownCode,
    table: ({ children }) => <div className="file-preview__table-scroll"><table>{children}</table></div>
  }), [props.resource]);
  const updateMode = (next: "preview" | "source") => {
    setMode(next);
    props.onModeChange?.(next);
  };
  return (
    <div className="file-preview__markdown-shell">
      <div className="file-preview__markdown-toolbar" role="group" aria-label={t("filePreview.markdownView")} data-file-search-exclude>
        <button
          type="button"
          className={mode === "preview" ? "is-active" : ""}
          aria-pressed={mode === "preview"}
          onClick={() => updateMode("preview")}
        >
          <Eye size={13} />
          {t("filePreview.markdownPreview")}
        </button>
        <button
          type="button"
          className={mode === "source" ? "is-active" : ""}
          aria-pressed={mode === "source"}
          onClick={() => updateMode("source")}
        >
          <Code2 size={13} />
          {t("filePreview.markdownSource")}
        </button>
      </div>
      {mode === "source" ? (
        <TextPreview blob={props.blob} name={props.resource.name} code />
      ) : (
        <article className="file-preview__markdown">
          {props.blob.size >= TEXT_PREVIEW_MAX_BYTES ? <div className="file-preview__notice">{t("filePreview.truncated")}</div> : null}
          <ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }]]} components={components} skipHtml>
            {text}
          </ReactMarkdown>
        </article>
      )}
    </div>
  );
}

function MarkdownCode(props: ComponentPropsWithoutRef<"code">) {
  return <code className={props.className}>{props.children}</code>;
}

function RelativeImage(props: { path: string; alt: string; load: (path: string, signal?: AbortSignal) => Promise<Blob> }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void props.load(props.path, controller.signal).then((blob) => {
      if (controller.signal.aborted || !blob.type.startsWith("image/")) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [props.load, props.path]);
  return url ? <img src={url} alt={props.alt} /> : <span>{props.alt}</span>;
}

function ImagePreview(props: { blob: Blob; name: string }) {
  const { t } = useTranslation();
  const [fit, setFit] = useState(true);
  const url = useObjectUrl(props.blob);
  return (
    <div className="file-preview__image">
      <div className="file-preview__image-toolbar">
        <button type="button" onClick={() => setFit((value) => !value)}>
          {fit ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
          {fit ? t("filePreview.imageActual") : t("filePreview.imageFit")}
        </button>
      </div>
      <div className={`file-preview__image-stage${fit ? " is-fit" : ""}`}>
        {url ? <img src={url} alt={props.name} /> : null}
      </div>
    </div>
  );
}

function MediaPreview(props: { blob: Blob; name: string; kind: "video" | "audio" }) {
  const url = useObjectUrl(props.blob);
  return (
    <div className={`file-preview__media file-preview__media--${props.kind}`}>
      {url && props.kind === "video" ? <video src={url} controls aria-label={props.name} /> : null}
      {url && props.kind === "audio" ? <audio src={url} controls aria-label={props.name} /> : null}
    </div>
  );
}

function GenericFilePreview(props: { blob: Blob; resource: FilePreviewResource }) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<"checking" | "text" | "binary">("checking");
  useEffect(() => {
    let active = true;
    void props.blob.slice(0, 64 * 1024).arrayBuffer().then((buffer) => {
      if (active) setKind(isProbablyText(new Uint8Array(buffer)) ? "text" : "binary");
    }).catch(() => {
      if (active) setKind("binary");
    });
    return () => {
      active = false;
    };
  }, [props.blob]);
  if (kind === "checking") return <PreviewStatus label={t("filePreview.loading")} />;
  if (kind === "text") {
    return (
      <SearchablePreview contentKey={props.resource.id}>
        <TextPreview blob={props.blob} name={props.resource.name} code={false} />
      </SearchablePreview>
    );
  }
  return <PreviewStatus label={t("filePreview.unavailable")} resource={props.resource} />;
}

function isProbablyText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe)
    || (bytes[0] === 0xfe && bytes[1] === 0xff)
  ) return true;
  let controlBytes = 0;
  for (const byte of bytes) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 13 && byte < 32)) controlBytes += 1;
  }
  return controlBytes / bytes.length < 0.1;
}

function OfficePreview(props: { kind: "docx" | "xlsx"; blob: Blob }) {
  const { t } = useTranslation();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | { status: "docx"; blocks: DocxBlock[] }
    | { status: "xlsx"; sheets: XlsxSheet[] }
  >({ status: "loading" });
  useEffect(() => {
    let active = true;
    const request = props.kind === "docx"
      ? readDocxBlocks(props.blob).then((blocks) => ({ status: "docx" as const, blocks }))
      : readXlsxSheets(props.blob).then((sheets) => ({ status: "xlsx" as const, sheets }));
    void request.then((next) => {
      if (active) setState(next);
    }).catch(() => {
      if (active) setState({ status: "error" });
    });
    return () => {
      active = false;
    };
  }, [props.blob, props.kind]);
  if (state.status === "loading") return <PreviewStatus label={t("filePreview.loading")} />;
  if (state.status === "error") return <PreviewStatus label={t("filePreview.failed")} />;
  return state.status === "docx" ? <DocxPreview blocks={state.blocks} /> : <XlsxPreview sheets={state.sheets} />;
}

function DocxPreview(props: { blocks: DocxBlock[] }) {
  return (
    <article className="file-preview__office-document">
      {props.blocks.map((block, index) => {
        if (block.kind === "table") {
          return <table key={index}><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell.map((span, spanIndex) => <DocxSpan key={spanIndex} span={span} />)}</td>)}</tr>)}</tbody></table>;
        }
        if (!block.spans.length) return <div key={index} className="file-preview__office-space" />;
        const content = block.spans.map((span, spanIndex) => <DocxSpan key={spanIndex} span={span} />);
        if (block.headingLevel === null) return <p key={index}>{content}</p>;
        const Heading = `h${Math.min(6, block.headingLevel + 1)}` as "h2";
        return <Heading key={index}>{content}</Heading>;
      })}
    </article>
  );
}

function DocxSpan(props: { span: DocxTextSpan }) {
  if (!props.span.bold && !props.span.italic) return <>{props.span.text}</>;
  return <span className={`${props.span.bold ? "font-semibold" : ""} ${props.span.italic ? "italic" : ""}`.trim()}>{props.span.text}</span>;
}

function XlsxPreview(props: { sheets: XlsxSheet[] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const sheet = props.sheets[Math.min(activeIndex, props.sheets.length - 1)];
  if (!sheet) return null;
  const [header, ...body] = sheet.rows;
  return (
    <div className="file-preview__spreadsheet">
      {props.sheets.length > 1 ? <div className="file-preview__sheet-tabs">{props.sheets.map((item, index) => <button key={`${item.name}:${index}`} type="button" className={index === activeIndex ? "is-active" : ""} onClick={() => setActiveIndex(index)}>{item.name}</button>)}</div> : null}
      <div className="file-preview__table-scroll">
        <table>
          {header ? <thead><tr>{header.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead> : null}
          <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function useObjectUrl(blob: Blob): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

function resolveRelativePath(currentPath: string | undefined, rawHref: string | undefined): string | null {
  const href = String(rawHref ?? "").split(/[?#]/, 1)[0] ?? "";
  if (!href || href.startsWith("/") || href.startsWith("\\") || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  const base = (currentPath ?? "").replace(/\\/g, "/").split("/").slice(0, -1);
  for (const part of href.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!base.length) return null;
      base.pop();
    } else {
      base.push(part);
    }
  }
  return base.join("/") || null;
}

function previewLimit(kind: ReturnType<typeof resolveFileType>["kind"]): number {
  if (kind === "word" || kind === "spreadsheet" || kind === "presentation") return OFFICE_PREVIEW_MAX_BYTES;
  return BINARY_PREVIEW_MAX_BYTES;
}

function languageForFilename(name: string): string {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  return ({
    c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp",
    cs: "csharp", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift", dart: "dart",
    js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
    ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
    py: "python", pyi: "python", rb: "ruby", rs: "rust", go: "go",
    sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell",
    bat: "batch", cmd: "batch", yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini",
    json: "json", jsonl: "json", json5: "json5", jsonc: "json", geojson: "json",
    md: "markdown", mdx: "markdown", markdown: "markdown",
    html: "markup", htm: "markup", xml: "markup", vue: "markup", svelte: "markup",
    astro: "markup", css: "css", scss: "scss", sass: "sass", less: "less",
    tex: "latex", bib: "latex", graphql: "graphql", gql: "graphql", sql: "sql",
    php: "php", phtml: "php", pl: "perl", pm: "perl", lua: "lua", r: "r",
    scala: "scala", clj: "clojure", cljs: "clojure", ex: "elixir", exs: "elixir",
    erl: "erlang", hrl: "erlang", hs: "haskell", lhs: "haskell", ml: "ocaml", mli: "ocaml",
    diff: "diff", patch: "diff", proto: "protobuf"
  } as Record<string, string>)[extension] ?? "text";
}
