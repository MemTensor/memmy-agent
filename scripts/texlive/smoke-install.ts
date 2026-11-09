/** Install an actual native release via the Host's download/verification path.
 * Registry/archive responses are streamed from a local release directory, so this
 * validation needs no published endpoint. It writes the resolved child env as JSON.
 * Usage: tsx scripts/texlive/smoke-install.ts RELEASE_DIR CACHE_DIR OUTPUT_ENV_JSON VERIFIED_FIXTURE_DIR
 */
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { Readable } from "node:stream";
import { createTexliveRuntimeInstaller, resolveTexliveRuntime } from "../../App/backend/src/adapters/outbound/plugin-runtime/texlive-installer.js";
const [release, cache, output, fixtures] = process.argv.slice(2);
if (!release || !cache || !output || !fixtures) throw new Error("Required: RELEASE_DIR CACHE_DIR OUTPUT_ENV_JSON VERIFIED_FIXTURE_DIR");
const target = `${process.platform}-${process.arch}`;
let downloads = 0;
const installer = createTexliveRuntimeInstaller({
  cacheRoot: resolve(cache), catalogUrl: "https://runtime.test.invalid/{target}.json",
  fetchFn: (async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith(".json")) {
      const manifest = JSON.parse(await readFile(resolve(release, `texlive-runtime-${target}.json`), "utf8"));
      return Response.json(manifest);
    }
    downloads++;
    return new Response(Readable.toWeb(createReadStream(resolve(release, basename(url.pathname)))) as ReadableStream);
  }) as typeof fetch,
  onProgress(stage) { if (stage !== "downloading") process.stdout.write(`TeX runtime: ${stage}\n`); }
});
process.env.MEMMY_TEXLIVE_RUNTIME_PREFER_MANAGED = "1";
const runtime = await resolveTexliveRuntime(process.platform, installer);
const offline = createTexliveRuntimeInstaller({ cacheRoot: resolve(cache), catalogUrl: "https://runtime.test.invalid/{target}.json",
  fetchFn: (async () => { throw new Error("offline cache reuse unexpectedly requested network"); }) as typeof fetch });
await resolveTexliveRuntime(process.platform, offline);
if (downloads !== 1) throw new Error(`Expected one archive download, got ${downloads}`);
await writeFile(resolve(output), JSON.stringify({ ...runtime.environment,
  PATH: [...runtime.pathEntries, process.env.PATH].join(process.platform === "win32" ? ";" : ":") }, null, 2));
console.log(`Native ${target} installation, package/font probe, and offline reuse passed.`);

// Relocated, managed engines compile the plugin's generated brand fixtures twice.
// Exclude provisioned TeX from PATH, so helper binaries cannot fall back to it.
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");
const { cp, mkdir } = await import("node:fs/promises");
const run = promisify(execFile);
const fixtureRoot = resolve(fixtures);
const qa = resolve(output + ".qa"); await mkdir(qa, { recursive: true });
const systemPath = process.platform === "win32" ? [process.env.SystemRoot + "\\System32", process.env.SystemRoot].join(";") : "/usr/bin:/bin:/usr/sbin:/sbin";
const cleanEnv = { ...process.env, ...runtime.environment, PATH: [...runtime.pathEntries, systemPath].join(process.platform === "win32" ? ";" : ":") };
for (const key of ["TEXMF", "TEXMFCNF", "TEXINPUTS", "TEXFONTS", "TEXFORMATS"]) delete cleanEnv[key];
const engine = resolve(runtime.pathEntries[0]!, process.platform === "win32" ? "xelatex.exe" : "xelatex");
const report = { target, downloads, offlineReuse: true, languages: [] as Array<{ language: string; bytes: number }> };
for (const language of ["zh-CN", "en"]) {
  const directory = resolve(qa, language);
  await cp(resolve(fixtureRoot, language), directory, { recursive: true });
  for (let pass = 0; pass < 2; pass++) {
    try { await run(engine, ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "review.tex"], { cwd: directory, env: cleanEnv, timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }); }
    catch (error) { console.error((error as { stdout?: string }).stdout); throw error; }
  }
  const pdf = await readFile(resolve(directory, "review.pdf"));
  if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error(`Invalid ${language} PDF`);
  const log = await readFile(resolve(directory, "review.log"), "utf8");
  if (/Missing character:|LaTeX Warning:.*undefined|LaTeX Font Warning:.*not available/i.test(log)) throw new Error(`${language} PDF has missing text/fonts/citations`);
  if (process.env.TEXLIVE_BUILD_SOURCE && log.includes(process.env.TEXLIVE_BUILD_SOURCE.replaceAll("\\", "/"))) throw new Error("Compilation escaped to the provisioned source tree");
  report.languages.push({ language, bytes: pdf.length });
}
await writeFile(resolve(qa, "native-validation.json"), JSON.stringify(report, null, 2));
console.log(`Native ${target} Chinese/English branded compilation passed: ${qa}`);
