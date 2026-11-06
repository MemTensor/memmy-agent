// @vitest-environment happy-dom

import JSZip from "jszip";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { loadPreviewDuringLiveEdit, ThreadTabPreview, type ThreadPreviewContext } from "../agent-thread-panel-preview.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Office and source files in the merged thread preview", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    container.remove();
  });

  async function render(name: string, body: Blob) {
    const path = `/work/${name}`;
    const fetchFn = vi.fn(async () => new Response(body)) as unknown as typeof fetch;
    const context: ThreadPreviewContext = {
      artifactClient: {
        resolveArtifact: vi.fn(async () => ({ ok: true, path, name, kind: "file", media_url: "http://127.0.0.1:18980/media/test" })),
        openArtifact: vi.fn(async () => undefined),
        revealArtifact: vi.fn(async () => undefined),
      },
      agentClient: null, sessionScope: null, environment: null, workspaceRoot: null, fetchFn,
    };
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <ThreadTabPreview tab={{ id: path, type: "file", name, path }} context={context} />
      </I18nProvider>,
    ));
    for (let index = 0; index < 12; index += 1) {
      await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
    }
    return { context, fetchFn };
  }

  it("waits through a transient live-edit replacement instead of reporting the file missing", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockRejectedValueOnce(new Error("media_fetch_failed"))
      .mockResolvedValue("latest file");

    await expect(loadPreviewDuringLiveEdit(load, undefined, [0, 0])).resolves.toBe("latest file");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("reloads an open document after its completed edit revision changes", async () => {
    const path = "/work/report.md";
    let currentText = "旧内容";
    const fetchFn = vi.fn(async () => new Response(currentText)) as unknown as typeof fetch;
    const context: ThreadPreviewContext = {
      artifactClient: {
        resolveArtifact: vi.fn(async () => ({ ok: true, path, name: "report.md", kind: "file", media_url: "http://127.0.0.1:18980/media/report" })),
        openArtifact: vi.fn(async () => undefined),
        revealArtifact: vi.fn(async () => undefined),
      },
      agentClient: null, sessionScope: null, environment: null, workspaceRoot: null, fetchFn,
    };
    const tab = { id: `file:${path}`, type: "file" as const, name: "report.md", path };
    const preview = (revision: string) => <I18nProvider language="zh-CN"><ThreadTabPreview tab={tab} context={context} revision={revision} /></I18nProvider>;

    await act(async () => root.render(preview("")));
    await vi.waitFor(() => expect(container.textContent).toContain("旧内容"));
    currentText = "修改后的内容";
    await act(async () => root.render(preview("write-1:1:1")));
    await vi.waitFor(() => expect(container.textContent).toContain("修改后的内容"));
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("updates an open code editor when the agent finishes editing its file", async () => {
    vi.stubGlobal("memmy", { writeWorkspaceFile: vi.fn(async () => undefined) });
    const path = "/work/report.txt";
    let currentText = "旧版本";
    const fetchFn = vi.fn(async () => new Response(currentText)) as unknown as typeof fetch;
    const context: ThreadPreviewContext = {
      artifactClient: {
        resolveArtifact: vi.fn(async () => ({ ok: true, path, name: "report.txt", kind: "file", media_url: "http://127.0.0.1:18980/media/report" })),
        openArtifact: vi.fn(async () => undefined),
        revealArtifact: vi.fn(async () => undefined),
      },
      agentClient: null, sessionScope: null, environment: null, workspaceRoot: "/work", fetchFn,
    };
    const tab = { id: `file:${path}`, type: "file" as const, name: "report.txt", path };
    const preview = (revision: string) => <I18nProvider language="zh-CN"><ThreadTabPreview tab={tab} context={context} revision={revision} /></I18nProvider>;

    await act(async () => root.render(preview("")));
    await vi.waitFor(() => expect(container.querySelector<HTMLTextAreaElement>(".editable-code-preview__plain")?.value).toBe("旧版本"));
    currentText = "新版本";
    await act(async () => root.render(preview("edit-2:1:1")));
    await vi.waitFor(() => expect(container.querySelector<HTMLTextAreaElement>(".editable-code-preview__plain")?.value).toBe("新版本"));
  });

  it("loads DOCX through the existing renderer and preserves table merges", async () => {
    const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document xmlns:w="${ns}"><w:body>
      <w:p><w:r><w:t>合并后的 DOCX 预览</w:t></w:r></w:p>
      <w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/></w:tblGrid>
        <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>跨两列的说明</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>字段</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>内容</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl></w:body></w:document>`);
    await render("review.docx", new Blob([await zip.generateAsync({ type: "arraybuffer" })]));
    await vi.waitFor(() => expect(container.querySelector(".file-preview__office-document")).not.toBeNull());
    expect(container.textContent).toContain("合并后的 DOCX 预览");
    expect(container.querySelector("td[colspan='2']")?.textContent).toBe("跨两列的说明");
    expect(container.textContent).not.toContain("暂不支持");
  });

  it("preserves XLSX merged notes, column widths, row heights, colors and blank template rows", async () => {
    const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const zip = new JSZip();
    zip.file("xl/workbook.xml", `<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="基础设施授权" sheetId="1" r:id="rId1"/><sheet name="业务字典" sheetId="2" r:id="rId2"/></sheets></workbook>`);
    zip.file("xl/_rels/workbook.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>`);
    zip.file("xl/styles.xml", `<styleSheet xmlns="${ns}"><fonts count="2"><font/><font><b/><color rgb="FFFF0000"/></font></fonts><fills count="3"><fill/><fill/><fill><patternFill patternType="solid"><fgColor rgb="FFB0FFFF"/></patternFill></fill></fills><borders count="1"><border/></borders><cellXfs count="2"><xf fontId="0" fillId="0" borderId="0"/><xf fontId="1" fillId="2" borderId="0"><alignment horizontal="center" vertical="center"/></xf></cellXfs></styleSheet>`);
    zip.file("xl/worksheets/sheet1.xml", `<worksheet xmlns="${ns}"><dimension ref="A1:D10001"/><cols><col min="1" max="1" width="20"/><col min="2" max="4" width="30"/></cols><sheetData>
      <row r="1" ht="160" customHeight="1"><c r="A1" t="inlineStr"><is><t>备注：请勿改动模板格式</t></is></c></row>
      <row r="2" ht="32"><c r="A2" s="1" t="inlineStr"><is><t>操作</t></is></c><c r="B2" s="1" t="inlineStr"><is><t>人力账号</t></is></c></row>
      <row r="10001"><c r="D10001" s="1"/></row>
      </sheetData><mergeCells><mergeCell ref="A1:D1"/></mergeCells></worksheet>`);
    zip.file("xl/worksheets/sheet2.xml", `<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>字典内容</t></is></c></row></sheetData></worksheet>`);
    await render("基础设施授权.xlsx", new Blob([await zip.generateAsync({ type: "arraybuffer" })]));
    await vi.waitFor(() => expect(container.querySelector(".file-preview__sheet-grid")).not.toBeNull());
    const grid = container.querySelector<HTMLTableElement>(".file-preview__sheet-grid")!;
    expect(grid.getAttribute("aria-rowcount")).toBe("10002");
    expect(grid.querySelector("td[colspan='4']")?.textContent).toContain("备注");
    expect(parseFloat(grid.querySelector<HTMLTableRowElement>("tbody tr")!.style.height)).toBeGreaterThan(200);
    const cols = grid.querySelectorAll<HTMLTableColElement>("col");
    expect(parseFloat(cols[2]!.style.width)).toBeGreaterThan(parseFloat(cols[1]!.style.width));
    const header = [...grid.querySelectorAll<HTMLTableCellElement>("td")].find(cell => cell.textContent === "操作")!;
    expect(header.style.color.toLowerCase()).toBe("#ff0000");
    expect(header.style.backgroundColor.toLowerCase()).toBe("#b0ffff");
    expect(grid.querySelectorAll("tbody tr").length).toBeLessThan(100);
    act(() => [...container.querySelectorAll<HTMLButtonElement>(".file-preview__sheet-tabs button")].find(button => button.textContent === "业务字典")!.click());
    expect(container.textContent).toContain("字典内容");
  });

  it("shows an unpreviewable zip with the current preview placeholder", async () => {
    await render("bundle.zip", new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], { type: "application/zip" }));
    expect(container.querySelector(".thread-preview__placeholder-name")?.textContent).toBe("bundle.zip");
    expect(container.textContent).toContain("暂不支持在侧栏中预览此格式");
    expect(container.querySelector(".workspace-artifact-preview-empty")).toBeNull();
    expect(container.querySelector(".workspace-artifact-file-list")).toBeNull();
  });

  it.each([
    ["review.tex", "\\documentclass{article}\n\\begin{document}\n正文\n\\end{document}"],
    ["references.bib", "@article{example, title={示例文献}, year={2026}}"],
    ["neurips_2024.sty", "\\ProvidesPackage{neurips_2024}\n\\newcommand{\\review}{正文}"],
  ])("previews %s as source text", async (name, text) => {
    await render(name, new Blob([text], { type: "text/plain" }));
    for (const line of text.split("\n")) expect(container.querySelector(".thread-preview__code")?.textContent).toContain(line);
    expect(container.textContent).not.toContain("暂不支持");
  });
});
