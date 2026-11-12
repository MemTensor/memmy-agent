import fs from "node:fs";
import { build } from "esbuild";

fs.mkdirSync("dist/src/cli", { recursive: true });
for (const relativePath of ["agent_inject.md", "skills"]) {
  const destination = `dist/src/cli/${relativePath}`;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(`src/cli/${relativePath}`, destination, { recursive: true });
}

// Each host installs a single adapter directory without the Memory runtime's dependencies.
for (const agent of ["openclaw", "dsh", "hermes"]) {
  fs.cpSync(`adapters/${agent}`, `dist/adapters/${agent}`, { recursive: true });
  if (agent === "hermes") continue;
  await build({
    entryPoints: [`adapters/${agent}/index.js`], outfile: `dist/adapters/${agent}/index.js`,
    bundle: true, format: "esm", platform: "node", target: "node22",
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    external: ["@deepseek-ai/*"]
  });
}
