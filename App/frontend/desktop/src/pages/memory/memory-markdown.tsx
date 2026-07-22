import type { ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

export interface MemoryMarkdownProps {
  text: string;
}

const components: Components = {
  a: ({ children }) => <>{children}</>,
  img: ({ alt }) => <>{alt ?? ""}</>,
  p: ({ children }) => <p className="memory-markdown__p">{children}</p>,
  h1: MemoryMarkdownHeading,
  h2: MemoryMarkdownHeading,
  h3: MemoryMarkdownHeading,
  h4: MemoryMarkdownHeading,
  h5: MemoryMarkdownHeading,
  h6: MemoryMarkdownHeading,
  ul: ({ children }) => <ul className="memory-markdown__list">{children}</ul>,
  ol: ({ children }) => <ol className="memory-markdown__list">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="memory-markdown__quote">{children}</blockquote>,
  code: ({ className, children }) => (
    <code className={className ?? "memory-markdown__code"}>{children}</code>
  ),
  pre: ({ children }) => <pre className="memory-markdown__pre">{children}</pre>,
  table: ({ children }) => (
    <div className="memory-markdown__table-scroll">
      <table className="memory-markdown__table">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="memory-markdown__th">{children}</th>,
  td: ({ children }) => <td className="memory-markdown__td">{children}</td>
};

export function MemoryMarkdown(props: MemoryMarkdownProps) {
  return (
    <div className="memory-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components} skipHtml>
        {props.text}
      </ReactMarkdown>
    </div>
  );
}

function MemoryMarkdownHeading(props: ComponentPropsWithoutRef<"h4">) {
  return <h4 className="memory-markdown__heading">{props.children}</h4>;
}
