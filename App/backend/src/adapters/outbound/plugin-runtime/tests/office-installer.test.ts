import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { createOfficeRuntimeInstaller, OFFICE_TOOLS, safeRuntimePath, type OfficeRuntimeManifest } from "../office-installer.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (v: Buffer | string) => createHash("sha256").update(v).digest("hex");
async function fixture() {
  const cacheRoot = await mkdtemp(join(tmpdir(), "office-runtime-test-")); roots.push(cacheRoot);
  const zip = new JSZip(), files: Record<string, string> = {}, tools = {} as OfficeRuntimeManifest["tools"];
  for (const name of OFFICE_TOOLS) {
    const file = `bin/${name}.exe`, bytes = Buffer.from(`fixture-${name}`);
    zip.file(file, bytes, { unixPermissions: 0o100755 }); files[file] = hash(bytes); tools[name] = file;
  }
  const bytes = await zip.generateAsync({ type: "nodebuffer", platform: "UNIX" });
  const manifest: OfficeRuntimeManifest = { format: "memmy-office-runtime-v1", target: "win32-x64", version: "test-1", archive: { url: "/runtime.zip", sha256: hash(bytes), bytes: bytes.length }, tools, files };
  let downloads = 0, catalogs = 0, offline = false, corrupt = false;
  const fetchFn = (async (input: URL | string) => {
    if (offline) throw new Error("offline");
    if (String(input).endsWith("win32-x64")) { catalogs++; return Response.json(manifest); }
    downloads++; return new Response(corrupt ? new Uint8Array(bytes.length) : bytes);
  }) as typeof fetch;
  const installer = createOfficeRuntimeInstaller({ cacheRoot, catalogUrl: "https://registry.example/runtimes/{target}", fetchFn });
  return { cacheRoot, installer, manifest, counts: () => ({ downloads, catalogs }), setOffline: () => { offline = true; }, setCorrupt: () => { corrupt = true; } };
}
describe("Host Office runtime installation", () => {
  it("installs once across concurrent callers, verifies every tool, and reuses its cache offline", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.installer.ensure("win32", "x64"), f.installer.ensure("win32", "x64")]);
    expect(a).toEqual(b); expect(f.counts()).toEqual({ downloads: 1, catalogs: 1 });
    expect(await readFile(a.tools.soffice!, "utf8")).toBe("fixture-soffice");
    f.setOffline(); expect(await f.installer.ensure("win32", "x64")).toEqual(a);
  });
  it("repairs a corrupted file instead of trusting a completion marker", async () => {
    const f = await fixture(), a = await f.installer.ensure("win32", "x64");
    await writeFile(a.tools.pdfinfo!, "corrupted"); await f.installer.ensure("win32", "x64");
    expect(await readFile(a.tools.pdfinfo!, "utf8")).toBe("fixture-pdfinfo"); expect(f.counts().downloads).toBe(2);
  });
  it("rejects injected native libraries and restores the verified tree", async () => {
    const f = await fixture(), installed = await f.installer.ensure("win32", "x64");
    await writeFile(join(installed.root, "bin", "injected.dll"), "not in manifest");
    await f.installer.ensure("win32", "x64");
    await expect(readFile(join(installed.root, "bin", "injected.dll"))).rejects.toThrow();
    expect(f.counts().downloads).toBe(2);
  });
  it("retries bounded downloads and never commits an invalid archive", async () => {
    const f = await fixture(); f.setCorrupt();
    await expect(f.installer.ensure("win32", "x64")).rejects.toThrow(/integrity/);
    expect(f.counts().downloads).toBe(3);
    await expect(readFile(join(f.cacheRoot, "win32-x64.json"))).rejects.toThrow();
  });
  it("rejects wrong targets, unmanifested ZIP entries, and missing tools", async () => {
    const a = await fixture(); a.manifest.target = "darwin-arm64";
    await expect(a.installer.ensure("win32", "x64")).rejects.toThrow(/mismatch/);
    const b = await fixture(); delete b.manifest.files[b.manifest.tools.pdftoppm];
    await expect(b.installer.ensure("win32", "x64")).rejects.toThrow(/Unexpected/);
    const c = await fixture(); c.manifest.tools.soffice = "bin/missing.exe";
    await expect(c.installer.ensure("win32", "x64")).rejects.toThrow(/not covered/);
  });
  it("refuses insecure origins and unsafe Windows/ZIP paths", () => {
    expect(() => createOfficeRuntimeInstaller({ cacheRoot: tmpdir(), catalogUrl: "http://example.com/runtime" })).toThrow(/HTTPS/);
    for (const value of ["../escape", "C:/escape", "bin\\escape", "bin/NUL.exe", "bin/a.", "bin/a ", "bin/a:b", "bin/<a>", "bin/a?b", "/root", "bin//a"]) expect(safeRuntimePath(value), value).toBe(false);
    expect(safeRuntimePath("LibreOffice/program/soffice.exe")).toBe(true);
  });
});
