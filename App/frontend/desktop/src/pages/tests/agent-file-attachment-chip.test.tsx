import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentAttachmentCard, AgentFileIconTile, splitAgentAttachmentName } from "../agent-file-attachment-chip.js";

const attachmentSourceUrl = new URL("../agent-file-attachment-chip.tsx", import.meta.url);
const stylesUrl = new URL("../../styles.css", import.meta.url);

describe("Agent attachment cards", () => {
  it("renders stable attachment card classes with split name and extension metadata", () => {
    const html = renderToString(
      <AgentAttachmentCard
        kind="file"
        name="/Users/yuan/reports/very-long-contract-final.pdf"
        mime="application/pdf"
        subline="PDF · 4.0 KB"
        removable
        removeLabel="移除"
        onRemove={() => undefined}
      />
    );
    const compactHtml = html.replace(/<!-- -->/g, "");

    expect(html).toContain('data-testid="agent-attachment-card-file"');
    expect(html).toContain("agent-attachment-card");
    expect(html).toContain("file-type-icon--pdf");
    expect(html).toContain("agent-attachment-card__name");
    expect(html).toContain("agent-attachment-card__meta");
    expect(compactHtml).toContain(">very-long-contract-final<");
    expect(compactHtml).toContain(">PDF · 4.0 KB<");
    expect(html).toContain('aria-label="移除: /Users/yuan/reports/very-long-contract-final.pdf"');
    expect(html).not.toContain("rounded-[16px]");
    expect(html).not.toContain("border-rose-200/70");
  });

  it("renders image cards through the same shared card surface", () => {
    const html = renderToString(
      <AgentAttachmentCard
        kind="image"
        name="preview.png"
        previewUrl="blob:preview"
        subline="PNG · 2.0 KB"
        onClick={() => undefined}
        align="right"
      />
    );
    const compactHtml = html.replace(/<!-- -->/g, "");

    expect(html).toContain('data-testid="agent-attachment-card-image"');
    expect(html).toMatch(/<button[^>]*data-testid="agent-attachment-card-image"/);
    expect(html).toContain("agent-attachment-card--interactive");
    expect(html).toContain("agent-attachment-card--right");
    expect(html).toContain("agent-attachment-card__preview");
    expect(html).toContain("agent-attachment-card__preview-image");
    expect(html).toContain('src="blob:preview"');
    expect(compactHtml).toContain(">preview<");
    expect(compactHtml).toContain(">PNG · 2.0 KB<");
  });

  it("keeps preview and remove actions as sibling buttons for removable image cards", () => {
    const html = renderToString(
      <AgentAttachmentCard
        kind="image"
        name="preview.png"
        previewUrl="blob:preview"
        removable
        removeLabel="移除"
        onClick={() => undefined}
        onRemove={() => undefined}
      />
    );

    expect(html).toMatch(/<div[^>]*data-testid="agent-attachment-card-image"/);
    expect(html).not.toMatch(/<button[^>]*data-testid="agent-attachment-card-image"/);
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain('class="agent-attachment-card__action"');
    expect(html).toContain('aria-label="preview.png"');
    expect(html).toContain('aria-label="移除: preview.png"');
  });

  it("maps file types to stable CSS modifiers instead of generated utility colors", () => {
    const cases = [
      { name: "report.pdf", mime: "application/pdf", kind: "pdf", label: "pdf" },
      { name: "brief.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind: "word", label: "doc" },
      { name: "sheet.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", kind: "spreadsheet", label: "xls" },
      { name: "deck.pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", kind: "presentation", label: "ppt" },
      { name: "README.md", mime: "text/markdown", kind: "markdown", label: "md" },
      { name: "notes.txt", mime: "text/plain", kind: "text", label: "txt" },
      { name: "config.json", mime: "application/json", kind: "code", label: "json" },
      { name: "photo.svg", mime: "image/svg+xml", kind: "image", label: "svg" },
      { name: "clip.mp4", mime: "video/mp4", kind: "video", label: "mp4" },
      { name: "voice.mp3", mime: "audio/mpeg", kind: "audio", label: "mp3" },
      { name: "bundle.zip", mime: "application/zip", kind: "archive", label: "zip" },
      { name: "unknown.bin", mime: "application/octet-stream", kind: "generic", label: "file" }
    ];

    for (const item of cases) {
      const html = renderToString(<AgentFileIconTile name={item.name} mime={item.mime} size="md" />);

      expect(html).toContain(`data-testid="file-type-icon-${item.kind}"`);
      expect(html).toContain(`file-type-icon--${item.kind}`);
      expect(html).toContain("file-type-icon__paper");
      expect(html).toContain("file-type-icon__glyph");
      expect(html).toContain(`>${item.label.toUpperCase()}</text>`);
      expect(html).not.toContain("rounded-[12px]");
      expect(html).not.toContain("bg-rose-50");
    }
  });

  it("keeps extension parsing deterministic for visible card labels", () => {
    expect(splitAgentAttachmentName("/Users/yuan/report.final.pdf")).toEqual({
      displayName: "report.final",
      extensionLabel: "PDF"
    });
    expect(splitAgentAttachmentName("archive", ".txt")).toEqual({
      displayName: "archive",
      extensionLabel: "TXT"
    });
    expect(splitAgentAttachmentName(".env", ".txt")).toEqual({
      displayName: ".env",
      extensionLabel: "TXT"
    });
  });

  it("defines attachment card CSS and keeps unsupported utility classes out of the component", () => {
    const source = readFileSync(attachmentSourceUrl, "utf8");
    const styles = readFileSync(stylesUrl, "utf8");

    expect(styles).toContain(".composer-media-preview-strip");
    expect(styles).toContain(".composer-context-attachments .agent-attachment-card");
    expect(styles).toContain("width: calc((100% - 20px) / 3)");
    expect(styles).toContain(".agent-attachment-card");
    expect(styles).toContain(".agent-attachment-card__action");
    expect(styles).toContain(".file-type-icon--pdf");
    expect(styles).toContain(".file-type-icon--word");
    expect(styles).toContain(".file-type-icon--spreadsheet");
    expect(styles).toContain(".file-type-icon--presentation");
    expect(styles).toContain(".file-type-icon--markdown");
    expect(styles).toContain(".file-type-icon--code");
    expect(styles).toContain(".file-type-icon--folder");

    expect(source).not.toContain("rounded-[16px]");
    expect(source).not.toContain("rounded-[12px]");
    expect(source).not.toContain("border-rose-200/70");
    expect(source).not.toContain("bg-rose-50");
    expect(source).not.toContain("text-rose-600");
    expect(source).not.toContain("border-border-stone/35");
    expect(source).not.toContain("bg-background-paper/90");
  });
});
