import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTexliveRuntimeInstaller, resolveTexliveRuntime } from "../texlive-installer.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const cacheRoot = await mkdtemp(join(tmpdir(), "memmy-texlive-")); roots.push(cacheRoot);
  const zip = new JSZip(), files: Record<string, string> = {}, tools: Record<string, string> = {};
  for (const name of ["xelatex", "kpsewhich"]) {
    const file = `bin/${name}.exe`, content = `fixture-${name}`;
    zip.file(file, content, { unixPermissions: 0o100755 }); files[file] = hash(content); tools[name] = file;
  }
  zip.file("texmf-dist/fonts/FandolSong-Regular.otf", "font"); files["texmf-dist/fonts/FandolSong-Regular.otf"] = hash("font");
  const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
  const manifest = { format: "memmy-texlive-runtime-v1", target: "win32-x64", version: "review-1", tools, files,
    archive: { url: "/texlive.zip", sha256: hash(bytes), bytes: bytes.length } };
  let downloads = 0, offline = false;
  const installer = createTexliveRuntimeInstaller({ cacheRoot, catalogUrl: "https://registry.example/texlive/{target}",
    fetchFn: (async input => {
      if (offline) throw new Error("offline");
      if (String(input).endsWith("win32-x64")) return Response.json(manifest);
      downloads++; return new Response(bytes);
    }) as typeof fetch });
  return { installer, manifest, cacheRoot, downloads: () => downloads, offline: () => { offline = true; } };
}
describe("managed review XeLaTeX", () => {
  it("downloads a verified font/engine bundle once and reuses it offline", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.installer.ensure("win32", "x64"), f.installer.ensure("win32", "x64")]);
    expect(a).toEqual(b); expect(f.downloads()).toBe(1);
    f.offline(); expect(await f.installer.ensure("win32", "x64")).toEqual(a);
  });
  it("rejects an Office descriptor on the TeX route", async () => {
    const f = await fixture(); f.manifest.format = "memmy-office-runtime-v1";
    await expect(f.installer.ensure("win32", "x64")).rejects.toThrow(/kind\/tools/);
  });
  it("repairs a changed font as well as changed executables", async () => {
    const f = await fixture(), installed = await f.installer.ensure("win32", "x64");
    await writeFile(join(installed.root, "texmf-dist/fonts/FandolSong-Regular.otf"), "bad-font");
    await f.installer.ensure("win32", "x64"); expect(f.downloads()).toBe(2);
  });
  it("mounts only verified runtime roots and keeps writable TeX caches outside them", async () => {
    vi.stubEnv("MEMMY_TEXLIVE_RUNTIME_PREFER_MANAGED", "1");
    const f = await fixture(), installed = await f.installer.ensure("win32", "x64");
    const ensure = vi.fn(async () => installed), probe = vi.fn(async () => true);
    const resolved = await resolveTexliveRuntime("win32", { ensure }, probe);
    expect(resolved.readRoots).toEqual([installed.root]);
    expect(resolved.executableRoots).toEqual([installed.root]);
    expect(resolved.pathEntries).toEqual([dirname(installed.tools.xelatex!)]);
    expect(resolved.environment.TEXMFVAR).not.toContain(installed.root);
    expect(resolved.environment.MEMMY_TEX_FONTSET).toBe("fandol");
    // A font cache write does not invalidate the runtime integrity manifest.
    await writeFile(join(resolved.environment.MEMMY_TEX_CACHE_ROOT!, "font-cache"), "cached");
    expect(await f.installer.ensure("win32", "x64")).toEqual(installed);
    expect(f.downloads()).toBe(1);
  });
  it("refuses an incomplete installation rather than presenting it as ready", async () => {
    vi.stubEnv("MEMMY_TEXLIVE_RUNTIME_PREFER_MANAGED", "1");
    const f = await fixture(), installed = await f.installer.ensure("win32", "x64");
    await expect(resolveTexliveRuntime("win32", { ensure: async () => installed }, async () => false)).rejects.toThrow(/incomplete/);
  });
  it("reports a failed download instead of returning an unverified binary", async () => {
    const f = await fixture(); f.offline();
    await expect(f.installer.ensure("win32", "x64")).rejects.toThrow("offline");
    await expect(readFile(join(f.cacheRoot, "win32-x64.json"))).rejects.toThrow();
  });
});
