import type { ReactNode } from "react";
import { threadFileKind, type ThreadFileKind } from "./agent-thread-panel-model.js";

const DOCUMENT_BODY = "M4 1h5.6l3.9 3.9v8.6A1.5 1.5 0 0 1 12 15H4a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 4 1Z";
const DOCUMENT_FOLD = "M9.6 1v2.4a1.5 1.5 0 0 0 1.5 1.5h2.4Z";

const GLYPHS: Record<ThreadFileKind, ReactNode> = {
  pdf: <path d="M5.1 12.3c1.6-.7 3.1-2.9 3.3-4.6.1-.7-.8-.8-.9-.2-.3 1.7 1.2 3.4 2.9 3.7.7.1.8-.6.1-.8-1.6-.3-3.7 0-5.1.9-.5.3-.7 1-.3 1Z" />,
  doc: <><rect x="5" y="7.4" width="6" height="1.1" rx=".55" /><rect x="5" y="9.6" width="6" height="1.1" rx=".55" /><rect x="5" y="11.8" width="3.8" height="1.1" rx=".55" /></>,
  sheet: <path d="M5 7.3h6v5.2H5Zm1 1v1.1h1.5V8.3Zm2.5 0v1.1H10V8.3ZM6 10.4v1.1h1.5v-1.1Zm2.5 0v1.1H10v-1.1Z" fillRule="evenodd" />,
  slides: <><rect x="4.8" y="7.3" width="6.4" height="4" rx=".7" /><rect x="7.45" y="11.6" width="1.1" height="1.4" rx=".4" /></>,
  image: <><circle cx="6.4" cy="8.3" r="1" /><path d="m4.8 12.6 2.2-2.6 1.3 1.4 1.4-1.8 1.6 3Z" /></>,
  video: <path d="M6.4 7.6v4.6l3.9-2.3Z" />,
  audio: <path d="M9.9 7v3.7a1.3 1.3 0 1 1-.9-1.2V8.2l-2.5.6v2.9a1.3 1.3 0 1 1-.9-1.2V8l4.3-1Z" />,
  archive: <><rect x="7.4" y="5.6" width="1.2" height="1.2" rx=".3" /><rect x="7.4" y="7.6" width="1.2" height="1.2" rx=".3" /><rect x="6.9" y="9.6" width="2.2" height="2.6" rx=".6" /></>,
  markdown: <path d="M4.8 12.2V7.7h1.1l1.1 1.5 1.1-1.5h1.1v4.5H8.1V9.5l-1.1 1.5-1.1-1.5v2.7Zm5.1-1.9h.9V7.7h.9v2.6h.9l-1.35 1.9Z" />,
  html: <path d="m6.4 7.4.8.8-1.7 1.7 1.7 1.7-.8.8L3.9 9.9Zm3.2 0 2.5 2.5-2.5 2.5-.8-.8 1.7-1.7-1.7-1.7Z" />,
  code: <path d="m5.9 7.4.8.8-1.7 1.7 1.7 1.7-.8.8-2.5-2.5Zm4.2 0 2.5 2.5-2.5 2.5-.8-.8 1.7-1.7-1.7-1.7ZM8.6 6.9l.9.3-2 5.8-.9-.3Z" />,
  data: <path d="M6.5 7.2c-.9 0-1.2.5-1.2 1.2v.6c0 .4-.2.7-.6.8.4.1.6.4.6.8v.6c0 .7.3 1.2 1.2 1.2v-.9c-.3 0-.3-.2-.3-.4v-.7c0-.4-.2-.8-.5-.9.3-.1.5-.5.5-.9v-.7c0-.2 0-.4.3-.4Zm3 0c.9 0 1.2.5 1.2 1.2v.6c0 .4.2.7.6.8-.4.1-.6.4-.6.8v.6c0 .7-.3 1.2-1.2 1.2v-.9c.3 0 .3-.2.3-.4v-.7c0-.4.2-.8.5-.9-.3-.1-.5-.5-.5-.9v-.7c0-.2 0-.4-.3-.4Z" />,
  text: <><rect x="5" y="7.8" width="6" height="1.1" rx=".55" /><rect x="5" y="10.2" width="4.2" height="1.1" rx=".55" /></>,
  file: null,
};

export function ThreadFileIcon(props: { name: string; kind?: ThreadFileKind }) {
  const kind = props.kind ?? threadFileKind(props.name);
  return (
    <svg className={`thread-file-icon thread-file-icon--${kind}`} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path className="thread-file-icon__body" d={DOCUMENT_BODY} />
      <path className="thread-file-icon__fold" d={DOCUMENT_FOLD} />
      <g className="thread-file-icon__glyph">{GLYPHS[kind]}</g>
    </svg>
  );
}

export function ThreadFolderIcon() {
  return (
    <svg className="thread-folder-icon" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.5 4.2A1.7 1.7 0 0 1 3.2 2.5h2.6c.5 0 .9.2 1.2.5l.9 1h5a1.6 1.6 0 0 1 1.6 1.6v6.7a1.7 1.7 0 0 1-1.7 1.7H3.2a1.7 1.7 0 0 1-1.7-1.7Z" />
    </svg>
  );
}
