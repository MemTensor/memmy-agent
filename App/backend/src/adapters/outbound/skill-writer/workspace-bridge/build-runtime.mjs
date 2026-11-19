import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const workspaceBridgeDirectory = dirname(fileURLToPath(import.meta.url));
const skillWriterDirectory = resolve(workspaceBridgeDirectory, "..");
const projectHookDirectory = join(skillWriterDirectory, "project-hook");
const backendDirectory = resolve(workspaceBridgeDirectory, "../../../../..");
const mode = process.argv.includes("--dist") ? "dist" : "source";

/**
 * 两个运行时各打一份，放在与各自源码相邻的位置：
 *
 * - `memmy-workspace-bridge.mjs`：记忆钩子用，随记忆钩子的版本指纹；
 * - `memmy-project-runtime.mjs`：项目钩子用，项目协作改读取逻辑只动这一份。
 */
const runtimes = [
  {
    name: "Lifecycle sidecar",
    entryPoint: join(workspaceBridgeDirectory, "runtime.ts"),
    directoryName: "workspace-bridge",
    fileName: "memmy-workspace-bridge.mjs",
  },
  {
    name: "Project hook runtime",
    entryPoint: join(projectHookDirectory, "runtime.ts"),
    directoryName: "project-hook",
    fileName: "memmy-project-runtime.mjs",
  }
];

for (const runtime of runtimes) {
  const destination = mode === "dist"
    ? join(
        backendDirectory,
        "dist/src/adapters/outbound/skill-writer",
        runtime.directoryName,
        runtime.fileName
      )
    : join(skillWriterDirectory, runtime.directoryName, runtime.fileName);
  await buildRuntime(runtime.entryPoint, destination, runtime.name);
}

async function buildRuntime(entryPoint, destination, name) {
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    await build({
      entryPoints: [entryPoint],
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
    if (bareImports.length) throw new Error(`${name} contains bare imports: ${bareImports.join(", ")}`);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
