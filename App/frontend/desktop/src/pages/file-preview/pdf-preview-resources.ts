/** PDF.js needs external CMaps even when a PDF embeds its CJK fonts. */
export const PDFJS_RESOURCE_ROOT = "pdfjs/";
export const PDFJS_RESOURCE_DIRECTORIES = ["cmaps", "standard_fonts", "wasm"] as const;

export function getPdfPreviewResourceOptions(documentUrl: string, base = "./") {
  const root = new URL(PDFJS_RESOURCE_ROOT, new URL(base, documentUrl));
  return {
    cMapUrl: new URL("cmaps/", root).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("standard_fonts/", root).href,
    wasmUrl: new URL("wasm/", root).href,
    useWorkerFetch: true
  };
}
