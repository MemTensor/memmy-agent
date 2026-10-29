// @vitest-environment node
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, createServer } from "vite";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { bundledPdfResources } from "../../../pdfjs-assets.js";
import { getPdfPreviewResourceOptions } from "../file-preview/pdf-preview-resources.js";
import { startPackagedRendererStaticServer } from "../../../../../shell/desktop/src/main/renderer-static-server.js";

/** Self-authored PDF using a predefined Chinese CMap, no user or brand assets. */
function chinesePdf(): Uint8Array {
  const stream = "BT /F1 18 Tf 20 90 Td <4e2d6587> Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 6 0 R /DW 1000 >>",
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  ];
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}

describe("local PDF.js resources", () => {
  it("resolves packed CMaps, fonts and wasm relative to the renderer base", () => {
    const options = getPdfPreviewResourceOptions("http://127.0.0.1:19100/index.html?memmyMode=full");
    expect(options.cMapUrl).toBe("http://127.0.0.1:19100/pdfjs/cmaps/");
    expect(options.cMapPacked).toBe(true); expect(options.useWorkerFetch).toBe(true);
    expect(getPdfPreviewResourceOptions("https://local.test/desktop/index.html", "/desktop/").wasmUrl).toBe("https://local.test/desktop/pdfjs/wasm/");
  });

  it("renders Chinese text using CMaps served by the packaged renderer", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pdf-preview-resources-")));
    let server: Awaited<ReturnType<typeof startPackagedRendererStaticServer>> | undefined;
    try {
      await writeFile(join(root, "index.html"), "<html><body>PDF resource regression</body></html>");
      await build({ configFile: false, root, logLevel: "silent", plugins: [bundledPdfResources()], build: { outDir: join(root, "dist") } });
      server = await startPackagedRendererStaticServer({ rootDirectory: join(root, "dist"), port: 0 });
      const options = getPdfPreviewResourceOptions(server.baseUrl + "/index.html");
      for (const file of ["pdfjs/cmaps/Adobe-GB1-UCS2.bcmap", "pdfjs/cmaps/UniGB-UCS2-H.bcmap", "pdfjs/standard_fonts/FoxitSerif.pfb", "pdfjs/wasm/openjpeg.wasm"]) {
        const response = await fetch(`${server.baseUrl}/${file}`);
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(join(root, "dist", file)));
        if (file.endsWith(".wasm")) expect(response.headers.get("content-type")).toBe("application/wasm");
      }
      // With the old preview configuration, this valid PDF loses all Chinese.
      const missing = getDocument({ data: chinesePdf() });
      try {
        const doc = await missing.promise;
        expect((await (await doc.getPage(1)).getTextContent()).items).toHaveLength(0);
      } finally { await missing.destroy(); }
      const fixed = getDocument({ data: chinesePdf(), ...options });
      try {
        const doc = await fixed.promise;
        const text = (await (await doc.getPage(1)).getTextContent()).items.map(item => "str" in item ? item.str : "").join("");
        expect(text).toBe("中文");
      } finally { await fixed.destroy(); }
    } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
  }, 20000);

  it("serves the same resources in development with a renderer base path", async () => {
    const server = await createServer({ configFile: false, logLevel: "silent", base: "/desktop/", plugins: [bundledPdfResources()], server: { host: "127.0.0.1", port: 0 } });
    try {
      await server.listen();
      const address = server.httpServer!.address();
      if (!address || typeof address === "string") throw new Error("Expected HTTP server");
      const base = `http://127.0.0.1:${address.port}/desktop/index.html`;
      const options = getPdfPreviewResourceOptions(base, "/desktop/");
      expect((await fetch(options.cMapUrl + "Adobe-GB1-UCS2.bcmap")).status).toBe(200);
      expect((await fetch(options.cMapUrl + "unknown-file.bcmap")).status).toBe(404);
    } finally { await server.close(); }
  });
});
