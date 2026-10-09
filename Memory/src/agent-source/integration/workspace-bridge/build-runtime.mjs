import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const memoryDirectory = resolve(sourceDirectory, "../../../..");
const mode = process.argv.includes("--dist") ? "dist" : "source";
const destination = mode === "dist"
  ? join(memoryDirectory, "dist/src/agent-source/integration/workspace-bridge/memmy-workspace-bridge.mjs")
  : join(sourceDirectory, "memmy-workspace-bridge.mjs");
const temporary = `${destination}.${process.pid}.tmp`;

await mkdir(dirname(destination), { recursive: true });
try {
  await build({
    entryPoints: [join(sourceDirectory, "runtime.ts")],
    outfile: temporary,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    sourcemap: false,
    minify: false,
    legalComments: "none",
    packages: "bundle",
    banner: {
      js: 'import { createRequire as __memmyCreateRequire } from "node:module"; const require = __memmyCreateRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
  const asset = await readFile(temporary, "utf8");
  const bareImports = [...asset.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/gu)]
    .map((match) => match[1])
    .filter((specifier) => !specifier.startsWith("node:"));
  if (bareImports.length) throw new Error(`Lifecycle sidecar contains bare imports: ${bareImports.join(", ")}`);
  await rename(temporary, destination);
} finally {
  await rm(temporary, { force: true });
}
