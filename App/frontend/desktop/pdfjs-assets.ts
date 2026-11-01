/** Serve and bundle PDF.js resources locally, with names expected by its worker. */
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { PDFJS_RESOURCE_DIRECTORIES, PDFJS_RESOURCE_ROOT } from "./src/pages/file-preview/pdf-preview-resources.js";

export function bundledPdfResources(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  let base = "./";
  let pending: Promise<Map<string, Buffer>> | undefined;
  const resources = () => pending ??= (async () => {
    const files = new Map<string, Buffer>();
    for (const directory of PDFJS_RESOURCE_DIRECTORIES) {
      for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
        if (entry.isFile()) files.set(`${directory}/${entry.name}`, await readFile(join(root, directory, entry.name)));
      }
    }
    return files;
  })();
  return {
    name: "memmy-bundled-pdf-resources",
    configResolved(config) { base = config.base; },
    async configureServer(server) {
      const files = await resources();
      const prefix = new URL(`${base}${PDFJS_RESOURCE_ROOT}`, "http://pdfjs.local/").pathname;
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://pdfjs.local/").pathname;
        if (!pathname.startsWith(prefix)) return next();
        const name = pathname.slice(prefix.length);
        const bytes = files.get(name);
        if (!bytes) { response.statusCode = 404; response.end(); return; }
        response.setHeader("content-type", name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        response.end(bytes);
      });
    },
    async generateBundle() {
      for (const [name, source] of await resources()) {
        this.emitFile({ type: "asset", fileName: `${PDFJS_RESOURCE_ROOT}${name}`, source });
      }
    }
  };
}
