import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileTypeIcon, FolderTypeIcon } from "../../components/file-type-icon.js";
import { resolveFileType } from "../../lib/file-type.js";

const stylesUrl = new URL("../../styles.css", import.meta.url);
const tokensUrl = new URL("../../theme/tokens.css", import.meta.url);

describe("shared file icon system", () => {
  it("resolves common file extensions and MIME values through one registry", () => {
    const cases = [
      ["paper.pdf", undefined, "pdf"],
      ["draft.doc", undefined, "word"],
      ["budget.xlsx", undefined, "spreadsheet"],
      ["slides.ppt", undefined, "presentation"],
      ["README.md", undefined, "markdown"],
      ["notes.txt", undefined, "text"],
      ["config.toml", undefined, "code"],
      ["photo.webp", undefined, "image"],
      ["clip.mov", undefined, "video"],
      ["voice.wav", undefined, "audio"],
      ["source.tar.gz", "application/gzip", "archive"],
      ["unknown.bin", undefined, "generic"],
      ["download", "application/pdf", "pdf"]
    ] as const;

    for (const [name, mime, kind] of cases) {
      expect(resolveFileType(name, mime).kind).toBe(kind);
    }
  });

  it("adds format labels only when the icon is large enough", () => {
    const card = renderToString(<FileTypeIcon name="report.pdf" surface="card" />);
    const spreadsheet = renderToString(<FileTypeIcon name="budget.xlsx" surface="card" />);
    const row = renderToString(<FileTypeIcon name="report.pdf" surface="row" />);
    const inline = renderToString(<FileTypeIcon name="report.pdf" surface="inline" />);
    const folder = renderToString(<FolderTypeIcon surface="row" />);

    expect(card).toContain("file-type-icon--card");
    expect(card).not.toContain("file-type-icon__paper-sheen");
    expect(card).toContain("file-type-icon__format-label");
    expect(card).toContain(">PDF</text>");
    expect(spreadsheet).toContain(">XLS</text>");
    expect(spreadsheet).not.toContain("file-type-icon__format-badge");
    expect(row).toContain("file-type-icon--row");
    expect(row).not.toContain("file-type-icon__format-label");
    expect(inline).toContain("file-type-icon--inline");
    expect(inline).not.toContain("file-type-icon__paper-sheen");
    expect(inline).toContain("<svg");
    expect(row).not.toContain("<text");
    expect(inline).not.toContain("<text");
    expect(folder).toContain("file-type-icon--folder");
    expect(folder).toContain("file-type-icon__folder-front");
  });

  it("routes user-visible file surfaces through shared icons", () => {
    const sourceUrls = [
      new URL("../knowledge-page.tsx", import.meta.url),
      new URL("../home-composer-quick-actions.tsx", import.meta.url),
      new URL("../agent-message-content.tsx", import.meta.url),
      new URL("../literature-review-page.tsx", import.meta.url)
    ];

    for (const sourceUrl of sourceUrls) {
      const source = readFileSync(sourceUrl, "utf8");
      expect(source).toContain("FileTypeIcon");
      expect(source).not.toContain("<FileText");
    }
  });

  it("defines fixed geometry and a restrained shared material palette", () => {
    const styles = readFileSync(stylesUrl, "utf8");
    const tokens = readFileSync(tokensUrl, "utf8");

    expect(styles).toContain(".file-type-icon--inline");
    expect(styles).toContain(".file-type-icon--row");
    expect(styles).toContain(".file-type-icon--card");
    expect(styles).toContain(".file-type-icon--folder");
    expect(styles).toContain("min-width: var(--file-icon-inline-size)");
    expect(tokens).toContain("--file-icon-inline-size: 16px");
    expect(tokens).toContain("--file-icon-row-size: 22px");
    expect(tokens).toContain("--file-icon-paper:");
    expect(tokens).toContain("--file-icon-glyph-pdf:");
    expect(tokens).toContain("--file-icon-folder-front:");
    expect(tokens).toContain("--file-icon-glyph-pdf: #e5484d");
    expect(tokens).toContain("--file-icon-glyph-word: #2f6fdb");
    expect(tokens).toContain("--file-icon-glyph-spreadsheet: #1f9d63");
    expect(tokens).toContain("--file-icon-folder-front: #49a9e2");
    expect(styles).toContain(".file-type-icon__paper");
    expect(styles).toContain(".file-type-icon__glyph");
    expect(styles).not.toContain("filter: drop-shadow(0 1px 1px var(--file-icon-shadow))");
    expect(styles).not.toContain(".file-type-icon__format-badge rect");
    expect(styles).not.toContain("#d4a017");
  });

  it("uses the operating-system icon for real local files and keeps SVG as fallback", () => {
    const iconSource = readFileSync(new URL("../../components/file-type-icon.tsx", import.meta.url), "utf8");
    const home = readFileSync(new URL("../home-page.tsx", import.meta.url), "utf8");
    const attachments = readFileSync(new URL("../agent-file-attachment-chip.tsx", import.meta.url), "utf8");
    const styles = readFileSync(stylesUrl, "utf8");

    expect(iconSource).toContain("window.memmy?.getSystemFileIcon(filePath)");
    expect(iconSource).toContain("window.memmy?.getSystemFolderIcon(kind)");
    expect(iconSource).toContain("preferSystemIcon");
    expect(iconSource).toContain('className="file-type-icon__native-image"');
    expect(iconSource).toContain("<DocumentSheet");
    expect(home).toContain("window.memmy.getPathForFile(file)");
    expect(home).toContain("filePath={item.localPath}");
    expect(attachments).toContain("filePath={props.filePath}");
    // Knowledge lists must not opt into native folder icons (IPC storm / Electron SIGTRAP).
    expect(readFileSync(new URL("../knowledge-page.tsx", import.meta.url), "utf8")).not.toContain("preferSystemIcon");
    expect(styles).toContain(".file-type-icon__native-image");
  });

  it("pins each UI density to the intended icon surface", () => {
    const knowledge = readFileSync(new URL("../knowledge-page.tsx", import.meta.url), "utf8");
    const references = readFileSync(new URL("../home-composer-quick-actions.tsx", import.meta.url), "utf8");
    const messages = readFileSync(new URL("../agent-message-content.tsx", import.meta.url), "utf8");
    const literature = readFileSync(new URL("../literature-review-page.tsx", import.meta.url), "utf8");
    const attachments = readFileSync(new URL("../agent-file-attachment-chip.tsx", import.meta.url), "utf8");

    expect(knowledge).toContain('<FileTypeIcon name={file.name} surface="row" />');
    expect(references).toContain('<FileTypeIcon name={item.path} surface="row" />');
    expect(references).toContain('<FileTypeIcon name={chip.label} surface="card" />');
    expect(messages).toContain('surface="inline"');
    expect(literature).toContain('<FileTypeIcon name={context.id} surface="card" />');
    expect(literature).toContain('<FileTypeIcon name={file.name} surface="inline" />');
    expect(attachments).toContain('surface={props.size === "md" ? "card" : "row"}');
  });
});
