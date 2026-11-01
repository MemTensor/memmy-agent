/** Release-build inputs only: pinned official TinyTeX archives, verified before extraction. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
const inputs = {
  "darwin-arm64": ["darwin", "e40c294efae81026d8cc8d12c09d2dd456d268efe7fe092410478bc1973fd40f", 67189208],
  "darwin-x64": ["darwin", "e40c294efae81026d8cc8d12c09d2dd456d268efe7fe092410478bc1973fd40f", 67189208],
  "linux-x64": ["linux-x86_64", "4d519d6236ee6798e3ec0d8e2093d1fda01aeb267aa22c2a5586d76bcfce6566", 53589988],
  "linux-arm64": ["linux-arm64", "1bc5465c7a7c6f13e13c1b54a52147577eb3f389033af0444bc097698eb6653f", 53793596],
  "win32-x64": ["windows", "36c329c644683d981a668419d13c8804696e2816ae4d287ad755788fee231a31", 73701889]
};
const target = `${process.platform}-${process.arch}`, input = inputs[target];
if (!input) throw new Error(`No native TinyTeX input is available for ${target}`);
const work = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Required: fresh build-input directory");
await mkdir(work, { recursive: false });
const [platform, expected, size] = input, extension = process.platform === "win32" ? "exe" : "tar.xz";
const filename = `TinyTeX-1-${platform}-v2026.10.${extension}`;
const url = `https://github.com/rstudio/tinytex-releases/releases/download/v2026.10/${filename}`;
const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
if (!response.ok || !response.body) throw new Error(`TinyTeX download failed: HTTP ${response.status}`);
const archive = join(work, filename);
await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: "wx" }));
const hash = createHash("sha256"); let received = 0;
for await (const chunk of createReadStream(archive)) { hash.update(chunk); received += chunk.length; }
if (received !== size || hash.digest("hex") !== expected) throw new Error("Pinned TinyTeX input integrity check failed");
if (process.platform === "win32") {
  execFileSync("C:\\Program Files\\7-Zip\\7z.exe", ["x", archive, `-o${work}`, "-y"], { stdio: "inherit" });
} else execFileSync("tar", ["-xJf", archive, "-C", work], { stdio: "inherit" });
const names = await readdir(work);
const rootName = names.find(name => ["TinyTeX", ".TinyTeX"].includes(name));
if (!rootName) throw new Error("TinyTeX distribution root was not found");
const source = join(work, rootName), bins = await readdir(join(source, "bin"));
const bin = `bin/${process.platform === "win32" ? "windows" : bins.find(name => name.includes(process.platform === "darwin" ? "darwin" : process.arch === "arm64" ? "aarch64" : "x86_64"))}`;
await access(join(source, bin, process.platform === "win32" ? "tlmgr.bat" : "tlmgr"));
await writeFile(join(work, "provenance.json"), JSON.stringify({ url, sha256: expected, bytes: size, target, source, bin }, null, 2));
if (process.env.GITHUB_ENV) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(process.env.GITHUB_ENV, `TEXLIVE_BUILD_SOURCE=${source}\nTEXLIVE_BUILD_BIN=${bin}\n`);
}
console.log(`Pinned TinyTeX input verified and extracted for ${target}: ${source}`);
