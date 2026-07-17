import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { ExternalLink, FileText, Image as ImageIcon } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Prism as SyntaxHighlighter, type SyntaxHighlighterProps } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import type { MemmyAgentClient, ResolvedAgentArtifact } from "../api/memmy-agent-client.js";
import { useTranslation } from "../i18n/use-translation.js";

export type AgentArtifactClient = Pick<MemmyAgentClient, "resolveArtifact" | "revealArtifact" | "openArtifact">;
export type AttachmentActionStatus = "opened" | "revealed" | "downloaded" | "failed";
export type AttachmentCopyTarget = "path" | "url";
export type AttachmentDownloadStarter = (url: string, name: string) => boolean;

interface AgentMessageContentProps {
  content: string;
  isStreaming?: boolean;
  artifactClient?: AgentArtifactClient | null;
  deferRender?: boolean;
  deferredRevealDelayMs?: number;
  className?: string;
  style?: CSSProperties;
}

const TRAILING_PUNCTUATION_RE = /[.,;:!?，。；：！？)）\]]+$/;
const LONG_TEXT_WRAP_CLASS = "break-words [overflow-wrap:anywhere]";
const INLINE_CODE_WRAP_CLASS = "whitespace-pre-wrap break-all [overflow-wrap:anywhere]";
const DEFERRED_MARKDOWN_ROOT_MARGIN = "900px 0px";
const MIN_DEFERRED_MARKDOWN_HEIGHT = 56;
const MAX_DEFERRED_MARKDOWN_HEIGHT = 520;
const PRISM_CODE_SELECTOR = 'code[class*="language-"]' as const;
const PRISM_PRE_SELECTOR = 'pre[class*="language-"]' as const;
const AGENT_CODE_BACKGROUND = "transparent";
const AGENT_CODE_THEME = {
  ...oneLight,
  [PRISM_CODE_SELECTOR]: {
    ...oneLight[PRISM_CODE_SELECTOR],
    background: AGENT_CODE_BACKGROUND
  },
  [PRISM_PRE_SELECTOR]: {
    ...oneLight[PRISM_PRE_SELECTOR],
    background: AGENT_CODE_BACKGROUND
  }
} satisfies NonNullable<SyntaxHighlighterProps["style"]>;

export const AgentMessageContent = memo(function AgentMessageContent(props: AgentMessageContentProps) {
  const source = useMemo(
    () => unwrapSingleMarkdownResult(stripLeakedInternalTags(props.content, Boolean(props.isStreaming))),
    [props.content, props.isStreaming]
  );
  const deferred = useDeferredMarkdownRender(source, Boolean(props.deferRender), Boolean(props.isStreaming), props.deferredRevealDelayMs);
  const components = useMemo<Components>(() => ({
    a({ href, children }) {
      const localPath = localArtifactPathFromHref(href);
      if (localPath) {
        return <FileReferenceChip path={localPath} label={children} isStreaming={props.isStreaming} artifactClient={props.artifactClient} />;
      }
      if (isMailtoHref(href)) {
        return <MailtoLink href={href?.trim() ?? ""}>{children}</MailtoLink>;
      }
      return (
        <a href={href} target="_blank" rel="noreferrer noopener" className={`agent-message-content__link inline-flex max-w-full min-w-0 items-baseline gap-1 text-action-sky underline underline-offset-2 ${LONG_TEXT_WRAP_CLASS}`}>
          <span className={`min-w-0 ${LONG_TEXT_WRAP_CLASS}`}>{children}</span>
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      );
    },
    img({ src, alt }) {
      const url = String(src ?? "");
      if (!url) {
        return null;
      }
      if (isDirectMediaUrl(url)) {
        return <img src={url} alt={alt ?? ""} className="agent-message-content__image my-3 max-h-80 max-w-full rounded-card border border-border-stone/30 object-contain" />;
      }
      return <FileReferenceChip path={url} isStreaming={props.isStreaming} artifactClient={props.artifactClient} preferPreview />;
    },
    // Spacing, size, and color for every markdown block live in ONE place —
    // the `.agent-message-content*` rules in styles.css — so the vertical
    // rhythm cannot drift between elements (the old mix of Tailwind margin /
    // leading utilities and CSS overrides is exactly what caused uneven line
    // spacing around lists). Renderers only keep structural + wrap classes.
    code({ className, children }) {
      const code = String(children ?? "").replace(/\n$/, "");
      const language = /language-([A-Za-z0-9_+-]+)/.exec(className ?? "")?.[1] ?? null;
      const isInline = !language && !code.includes("\n");
      if (isInline) {
        return <code className={`agent-message-content__inline-code ${INLINE_CODE_WRAP_CLASS}`}>{code}</code>;
      }
      return <CodeBlock code={code} language={language} highlight={!props.isStreaming} />;
    },
    p({ children }) {
      return <p className={`agent-message-content__p ${LONG_TEXT_WRAP_CLASS}`}>{children}</p>;
    },
    ul({ children }) {
      return <ul className={`agent-message-content__list agent-message-content__list--unordered ${LONG_TEXT_WRAP_CLASS}`}>{children}</ul>;
    },
    ol({ children }) {
      return <ol className={`agent-message-content__list agent-message-content__list--ordered ${LONG_TEXT_WRAP_CLASS}`}>{children}</ol>;
    },
    blockquote({ children }) {
      return <blockquote className={`agent-message-content__quote ${LONG_TEXT_WRAP_CLASS}`}>{children}</blockquote>;
    },
    hr() {
      return <hr className="agent-message-content__separator" />;
    },
    table({ children }) {
      return <div className="agent-message-content__table-scroll"><table className="agent-message-content__table">{children}</table></div>;
    },
    th({ children }) {
      return <th className={`agent-message-content__th ${LONG_TEXT_WRAP_CLASS}`}>{children}</th>;
    },
    td({ children }) {
      return <td className={`agent-message-content__td ${LONG_TEXT_WRAP_CLASS}`}>{children}</td>;
    }
  }), [props.artifactClient, props.isStreaming]);

  if (!deferred.ready) {
    return <DeferredMarkdownPlaceholder content={source} containerRef={deferred.containerRef} className={props.className} style={props.style} />;
  }

  return (
    <div
      ref={deferred.containerRef}
      className={joinClassNames(
        "agent-message-content min-w-0 max-w-full overflow-hidden text-sm text-text-ink/85",
        props.isStreaming ? "agent-message-content--streaming" : undefined,
        props.className
      )}
      style={props.style}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]} rehypePlugins={[rehypeKatex]} components={components}>
        {source}
      </ReactMarkdown>
      {props.isStreaming ? <span className="agent-streaming-cursor" aria-hidden="true" /> : null}
    </div>
  );
}, areAgentMessageContentPropsEqual);

function areAgentMessageContentPropsEqual(previous: AgentMessageContentProps, next: AgentMessageContentProps): boolean {
  return previous.content === next.content
    && previous.isStreaming === next.isStreaming
    && previous.artifactClient === next.artifactClient
    && previous.deferRender === next.deferRender
    && previous.deferredRevealDelayMs === next.deferredRevealDelayMs
    && previous.className === next.className
    && previous.style === next.style;
}

function useDeferredMarkdownRender(content: string, deferRender: boolean, isStreaming: boolean, revealDelayMs = 0): {
  ready: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
} {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const revealSnapshotRef = useRef<DeferredRevealSnapshot | null>(null);
  const shouldDefer = deferRender && !isStreaming && canDeferMarkdownRendering();
  const [ready, setReady] = useState(!shouldDefer);

  useEffect(() => {
    setReady(!shouldDefer);
  }, [content, shouldDefer]);

  const reveal = () => {
    if (ready) {
      return;
    }
    revealSnapshotRef.current = captureDeferredRevealSnapshot(containerRef.current);
    setReady(true);
  };

  useEffect(() => {
    if (!shouldDefer || ready) {
      return undefined;
    }
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      const timeoutId = window.setTimeout(() => setReady(true), 1);
      return () => window.clearTimeout(timeoutId);
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        reveal();
        observer.disconnect();
      }
    }, { rootMargin: DEFERRED_MARKDOWN_ROOT_MARGIN });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ready, shouldDefer]);

  useEffect(() => {
    if (!shouldDefer || ready) {
      return undefined;
    }
    return scheduleDeferredMarkdownReveal(reveal, revealDelayMs);
  }, [ready, revealDelayMs, shouldDefer]);

  useLayoutEffect(() => {
    const snapshot = revealSnapshotRef.current;
    if (!ready || !snapshot) {
      return;
    }
    revealSnapshotRef.current = null;
    compensateDeferredRevealScroll(snapshot, containerRef.current);
  }, [ready]);

  return { ready, containerRef };
}

interface DeferredRevealSnapshot {
  scrollParent: HTMLElement;
  scrollTop: number;
  scrollRectTop: number;
  elementRectTop: number;
  elementHeight: number;
}

function DeferredMarkdownPlaceholder(props: {
  content: string;
  containerRef: React.RefObject<HTMLDivElement | null>;
  className?: string;
  style?: CSSProperties;
}) {
  const style = useMemo<CSSProperties>(() => ({
    ...props.style,
    minHeight: estimateDeferredMarkdownHeight(props.content)
  }), [props.content, props.style]);
  return (
    <div
      ref={props.containerRef}
      className={joinClassNames("agent-message-content agent-message-content--deferred min-w-0 max-w-full overflow-hidden", props.className)}
      style={style}
      aria-hidden="true"
    />
  );
}

function joinClassNames(...classNames: Array<string | undefined>): string {
  return classNames.filter(Boolean).join(" ");
}

function captureDeferredRevealSnapshot(node: HTMLDivElement | null): DeferredRevealSnapshot | null {
  if (!node) {
    return null;
  }
  const scrollParent = nearestScrollParent(node);
  if (!scrollParent) {
    return null;
  }
  const elementRect = node.getBoundingClientRect();
  const scrollRect = scrollParent.getBoundingClientRect();
  return {
    scrollParent,
    scrollTop: scrollParent.scrollTop,
    scrollRectTop: scrollRect.top,
    elementRectTop: elementRect.top,
    elementHeight: elementRect.height
  };
}

function compensateDeferredRevealScroll(snapshot: DeferredRevealSnapshot, node: HTMLDivElement | null): void {
  if (!node || snapshot.elementRectTop >= snapshot.scrollRectTop) {
    return;
  }
  const nextHeight = node.getBoundingClientRect().height;
  const delta = nextHeight - snapshot.elementHeight;
  if (Math.abs(delta) < 1) {
    return;
  }
  snapshot.scrollParent.scrollTop = snapshot.scrollTop + delta;
}

function nearestScrollParent(node: HTMLElement): HTMLElement | null {
  let current = node.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function scheduleDeferredMarkdownReveal(callback: () => void, delayMs: number): () => void {
  let idleHandle: number | null = null;
  const timeoutId = window.setTimeout(() => {
    const scheduler = window as typeof window & {
      requestIdleCallback?: (handler: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof scheduler.requestIdleCallback === "function") {
      idleHandle = scheduler.requestIdleCallback(callback, { timeout: 300 });
      return;
    }
    callback();
  }, Math.max(0, delayMs));

  return () => {
    window.clearTimeout(timeoutId);
    if (idleHandle != null) {
      const scheduler = window as typeof window & { cancelIdleCallback?: (handle: number) => void };
      scheduler.cancelIdleCallback?.(idleHandle);
    }
  };
}

export function estimateDeferredMarkdownHeight(content: string): number {
  const lines = content.split(/\r?\n/);
  const tableLines = lines.filter((line) => /^\s*\|.+\|\s*$/.test(line)).length;
  const codeFenceLines = lines.filter((line) => /^\s*```/.test(line)).length;
  const rawHeight = tableLines >= 3
    ? 44 + tableLines * 30
    : 44 + lines.length * 18 + codeFenceLines * 18;
  return Math.max(MIN_DEFERRED_MARKDOWN_HEIGHT, Math.min(MAX_DEFERRED_MARKDOWN_HEIGHT, rawHeight));
}

export function isLikelyExpensiveAgentMarkdown(content: string): boolean {
  const lines = content.split(/\r?\n/);
  if (lines.length >= 24) {
    return true;
  }
  const tableLines = lines.filter((line) => /^\s*\|.+\|\s*$/.test(line)).length;
  return tableLines >= 6 || content.includes("```");
}

function canDeferMarkdownRendering(): boolean {
  return typeof window !== "undefined";
}

function CodeBlock(props: { code: string; language: string | null; highlight: boolean }) {
  const languageLabel = props.language ?? "text";
  return (
    <div className="agent-message-content__code-block">
      <div className="agent-message-content__code-header flex items-center justify-between">
        <span>{languageLabel}</span>
      </div>
      {props.highlight && props.language ? (
        <div className="agent-message-content__code-scroll max-w-full overflow-x-auto">
          <SyntaxHighlighter
            language={props.language}
            style={AGENT_CODE_THEME}
            customStyle={{ margin: 0, background: "transparent", fontSize: "12px", minWidth: "max-content" }}
            PreTag="div"
          >
            {props.code}
          </SyntaxHighlighter>
        </div>
      ) : (
        <pre className="agent-message-content__pre max-w-full overflow-x-auto"><code>{props.code}</code></pre>
      )}
    </div>
  );
}

function FileReferenceChip(props: {
  path: string;
  label?: ReactNode;
  isStreaming?: boolean;
  artifactClient?: AgentArtifactClient | null;
  preferPreview?: boolean;
}) {
  const [resolved, setResolved] = useState<ResolvedAgentArtifact | null>(null);
  const [failed, setFailed] = useState(false);
  const [actionState, setActionState] = useState<"idle" | "working" | "error">("idle");
  const [copiedTarget, setCopiedTarget] = useState<AttachmentCopyTarget | null>(null);
  const { t } = useTranslation();
  const cleanPath = cleanPathToken(props.path);

  useEffect(() => {
    let cancelled = false;
    if (props.isStreaming || !props.artifactClient || !isLikelyLocalPath(cleanPath)) {
      setResolved(null);
      setFailed(false);
      return () => {
        cancelled = true;
      };
    }
    setFailed(false);
    void props.artifactClient.resolveArtifact(cleanPath)
      .then((artifact) => {
        if (!cancelled) {
          setResolved(artifact);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolved(null);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cleanPath, props.artifactClient, props.isStreaming]);

  const handleAttachmentAction = async () => {
    if (actionState === "working") return;
    setActionState("working");
    setCopiedTarget(null);
    if (!resolved) {
      setActionState("error");
      return;
    }
    const result = await runAttachmentAction({
      path: resolved.path,
      url: resolved.media_url,
      name: resolved.name,
      label: typeof props.label === "string" ? props.label : basename(cleanPath),
      artifactClient: props.artifactClient,
    });
    setActionState(result === "failed" ? "error" : "idle");
  };

  const handleCopy = async (target: AttachmentCopyTarget, value: string) => {
    const copied = await writeClipboardText(value);
    if (copied) setCopiedTarget(target);
  };

  if (props.preferPreview && resolved?.media_url && resolved.kind === "image") {
    return (
      <span className="agent-message-content__preview my-3 block max-w-full">
        <button
          type="button"
          onClick={() => void handleAttachmentAction()}
          disabled={actionState === "working"}
          className="block max-w-full cursor-pointer text-left disabled:cursor-wait disabled:opacity-70"
        >
          <img src={resolved.media_url} alt={resolved.name} className="agent-message-content__preview-image max-h-80 max-w-full rounded-card border border-border-stone/30 object-contain" />
          <span className="mt-1 inline-flex items-center gap-1 text-xs text-text-ink/45"><ImageIcon size={12} />{actionState === "working" ? t("agent.attachment.opening") : resolved.name}</span>
        </button>
        {actionState === "error" ? (
          <AttachmentActionError path={resolved.path} url={resolved.media_url} copiedTarget={copiedTarget} onCopy={(target, value) => void handleCopy(target, value)} />
        ) : null}
      </span>
    );
  }

  if (props.preferPreview && resolved?.media_url && resolved.kind === "video") {
    return <video src={resolved.media_url} controls className="my-3 max-h-80 max-w-full rounded-card border border-border-stone/30" />;
  }

  const label = props.label ?? resolved?.name ?? basename(cleanPath);
  return (
    <>
      <button
        type="button"
        title={cleanPath}
        onClick={() => void handleAttachmentAction()}
        disabled={actionState === "working" || (!resolved && !failed)}
        className={`agent-message-content__file-chip inline-flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-tag border px-2 py-1 align-baseline text-xs disabled:cursor-wait disabled:opacity-70 ${failed || actionState === "error" ? "border-status-error/30 bg-status-error/5 text-status-error" : "border-border-stone/40 bg-canvas-oat/70 text-text-ink/65 hover:text-action-sky"}`}
      >
        <FileText size={12} className="shrink-0" />
        <span className="min-w-0 truncate">{actionState === "working" ? t("agent.attachment.opening") : label}</span>
      </button>
      {actionState === "error" ? (
        <AttachmentActionError path={resolved?.path ?? cleanPath} url={resolved?.media_url} copiedTarget={copiedTarget} onCopy={(target, value) => void handleCopy(target, value)} />
      ) : null}
    </>
  );
}

export async function runAttachmentAction(input: {
  path?: string;
  url?: string;
  name?: string;
  label: string;
  artifactClient?: AgentArtifactClient | null;
  startDownload?: AttachmentDownloadStarter;
}): Promise<AttachmentActionStatus> {
  let actionPath = input.path;
  let actionUrl = input.url;
  let actionName = input.name;

  if (actionPath && input.artifactClient) {
    try {
      const fresh = await input.artifactClient.resolveArtifact(actionPath);
      actionPath = fresh.path;
      actionUrl = fresh.media_url ?? actionUrl;
      actionName = fresh.name ?? actionName;
    } catch {
      // Keep the original values and continue through the existing fallbacks.
    }
  }

  if (actionPath && input.artifactClient) {
    try {
      await input.artifactClient.openArtifact(actionPath);
      return "opened";
    } catch {
      // Continue to reveal/download fallbacks without surfacing intermediate errors.
    }
    try {
      await input.artifactClient.revealArtifact(actionPath);
      return "revealed";
    } catch {
      // Continue to download fallback without surfacing intermediate errors.
    }
  }
  if (actionUrl) {
    const downloaded = (input.startDownload ?? startBrowserDownload)(actionUrl, actionName ?? input.label);
    if (downloaded) return "downloaded";
  }
  return "failed";
}

export function startBrowserDownload(url: string, name: string): boolean {
  if (typeof document === "undefined") return false;
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.rel = "noreferrer";
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch {
    return false;
  }
}

export async function writeClipboardText(value: string): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
    return false;
  }
  await navigator.clipboard.writeText(value);
  return true;
}

export function AttachmentActionError(props: {
  path?: string;
  url?: string;
  copiedTarget?: AttachmentCopyTarget | null;
  onCopy: (target: AttachmentCopyTarget, value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <span className="mt-1 flex max-w-full flex-wrap items-center gap-2 text-xs text-status-error">
      <span>{t("agent.attachment.openFailed")}</span>
      {props.path ? <button type="button" onClick={() => props.onCopy("path", props.path!)} className="underline underline-offset-2">{t("agent.attachment.copyPath")}</button> : null}
      {props.url ? <button type="button" onClick={() => props.onCopy("url", props.url!)} className="underline underline-offset-2">{t("agent.attachment.copyLink")}</button> : null}
      {props.copiedTarget ? <span>{props.copiedTarget === "path" ? t("agent.attachment.copiedPath") : t("agent.attachment.copiedLink")}</span> : null}
    </span>
  );
}

// Claude-family internal tags (antThinking / antArtifact …, including typo'd
// variants like `</antThthinking>`) occasionally leak into model output. The
// gateway strips them for new turns; this render-side guard also cleans
// already-persisted history. Orphan tags are only removed at line/edge
// positions so backticked mentions in prose survive.
const LEAKED_ANT_TAG_NAME = "ant[A-Za-z][\\w:-]*";
const LEAKED_ANT_BLOCK_RE = new RegExp(`<(${LEAKED_ANT_TAG_NAME})(?:\\s[^>]*)?>[\\s\\S]*?</\\1\\s*>`, "g");
const LEAKED_ANT_ORPHAN_LINE_RE = new RegExp(`(^|\\n)[ \\t]*</?${LEAKED_ANT_TAG_NAME}(?:\\s[^>]*)?>[ \\t]*(?=\\n|$)`, "g");
const LEAKED_ANT_ORPHAN_EDGE_RE = new RegExp(`^\\s*</?${LEAKED_ANT_TAG_NAME}(?:\\s[^>]*)?>|</?${LEAKED_ANT_TAG_NAME}(?:\\s[^>]*)?>\\s*$`, "g");
const LEAKED_ANT_PARTIAL_END_RE = new RegExp(`\\s*</?${LEAKED_ANT_TAG_NAME}$`);

export function stripLeakedInternalTags(content: string, isStreaming = false): string {
  if (!content || !content.includes("<")) {
    return content;
  }
  let out = content
    .replace(LEAKED_ANT_BLOCK_RE, "")
    .replace(LEAKED_ANT_ORPHAN_LINE_RE, "$1")
    .replace(LEAKED_ANT_ORPHAN_EDGE_RE, "");
  if (isStreaming) {
    out = out.replace(LEAKED_ANT_PARTIAL_END_RE, "");
  }
  return out;
}

function unwrapSingleMarkdownResult(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:md|markdown)\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  if (!match) {
    return content;
  }
  const body = match[1] ?? "";
  return containsResultMarkdown(body) ? body : content;
}

function containsResultMarkdown(value: string): boolean {
  return /^\s*\|.+\|\s*$/m.test(value) || /!\[[^\]]*]\([^)]+\)/.test(value);
}

function MailtoLink(props: {
  href: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "error" | "copied">("idle");
  const email = emailAddressFromMailtoHref(props.href);

  const handleOpen = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setStatus("idle");
    try {
      await openMailtoHref(props.href);
    } catch {
      setStatus("error");
    }
  };

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      const copied = await writeClipboardText(email);
      if (copied) {
        setStatus("copied");
      }
    } catch {
      // Keep the error affordance visible when clipboard access is denied.
    }
  };

  return (
    <span className="inline-flex max-w-full min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      <a href={props.href} onClick={handleOpen} className={`agent-message-content__link inline-flex max-w-full min-w-0 items-baseline gap-1 text-action-sky underline underline-offset-2 ${LONG_TEXT_WRAP_CLASS}`}>
        <span className={`min-w-0 ${LONG_TEXT_WRAP_CLASS}`}>{props.children}</span>
        <ExternalLink size={12} aria-hidden="true" />
      </a>
      {status === "error" ? (
        <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-status-error">
          <span>{t("agent.link.mailtoOpenFailed")}</span>
          <button type="button" onClick={handleCopy} className="underline underline-offset-2">{t("agent.link.copyEmail")}</button>
        </span>
      ) : null}
      {status === "copied" ? <span className="text-xs text-status-success">{t("agent.link.emailCopied")}</span> : null}
    </span>
  );
}

export function isMailtoHref(href: string | undefined): boolean {
  return /^mailto:/i.test(href?.trim() ?? "");
}

export function emailAddressFromMailtoHref(href: string): string {
  const value = href.trim();
  if (!isMailtoHref(value)) {
    return value;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol.toLowerCase() === "mailto:") {
      return decodeUriComponentSafely(parsed.pathname);
    }
  } catch {
    // Fall back to simple prefix/query stripping for partially encoded mailto values.
  }
  const recipient = value.replace(/^mailto:/i, "").split(/[?#]/u)[0] ?? "";
  return decodeUriComponentSafely(recipient);
}

async function openMailtoHref(href: string): Promise<void> {
  const mailtoUrl = href.trim();
  if (typeof window === "undefined" || typeof window.memmy?.openMailto !== "function") {
    throw new Error("mailto bridge unavailable");
  }
  await window.memmy.openMailto(mailtoUrl);
}

function decodeUriComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanPathToken(value: string): string {
  return value.trim().replace(TRAILING_PUNCTUATION_RE, "");
}

function isDirectMediaUrl(url: string): boolean {
  return url.startsWith("/api/media/") || /^(https?:|data:|blob:)/i.test(url);
}

export function localArtifactPathFromHref(href: string | undefined): string | null {
  const value = href?.trim() ?? "";
  if (!value || value.startsWith("#") || /^(https?:|mailto:)/i.test(value) || value.startsWith("/api/media/")) {
    return null;
  }
  if (/^file:/i.test(value)) {
    try {
      const pathname = new URL(value).pathname;
      const decoded = decodeURIComponent(pathname);
      return isLikelyLocalPath(decoded) ? decoded : null;
    } catch {
      return null;
    }
  }
  return isLikelyLocalPath(value) ? cleanPathToken(value) : null;
}

function isLikelyLocalPath(value: string): boolean {
  if (!value || isDirectMediaUrl(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return false;
  }
  return value.includes("/") && (value.startsWith("/") || value.startsWith("~/") || /^[A-Za-z0-9_.@+-]+\//.test(value));
}

function basename(value: string): string {
  const clean = value.replace(/[/\\]+$/, "");
  const index = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return index >= 0 ? clean.slice(index + 1) : clean;
}
