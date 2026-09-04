import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

const viewerRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: viewerRoot,
  base: "/viewer/",
  plugins: [preact()],
  build: {
    outDir: resolve(viewerRoot, "../dist/viewer"),
    emptyOutDir: false,
    sourcemap: false,
    assetsDir: "assets"
  },
  server: {
    port: 18961,
    proxy: {
      "/api": "http://127.0.0.1:18960"
    }
  }
});
