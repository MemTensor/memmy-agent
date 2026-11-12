/** Host-owned portable XeLaTeX dependency. It never changes system TeX or PATH. */
import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, delimiter, parse } from "node:path";
import { promisify } from "node:util";
import { createPortableRuntimeInstaller, type PortableRuntimeInstallerOptions, type PortableRuntimeInstaller } from "./portable-installer.js";

const run = promisify(execFile);
export type TexliveRuntimeInstaller = PortableRuntimeInstaller;
export const TEXLIVE_TOOLS = ["xelatex", "kpsewhich"] as const;
// Includes Chinese fonts and the dependencies of every bundled review template.
export const REVIEW_TEX_FILES = ["ctex.sty", "fontspec.sty", "natbib.sty", "microtype.sty", "booktabs.sty", "graphicx.sty",
  "tabularx.sty", "float.sty", "hyperref.sty", "geometry.sty", "xcolor.sty", "fancyhdr.sty", "caption.sty", "colortbl.sty",
  "environ.sty", "trimspaces.sty", "times.sty", "FandolSong-Regular.otf", "FandolHei-Regular.otf", "FandolFang-Regular.otf",
  "FandolKai-Regular.otf", "lmroman10-regular.otf", "lmsans10-regular.otf"] as const;
export function createTexliveRuntimeInstaller(options: Omit<PortableRuntimeInstallerOptions, "kind" | "requiredTools">): TexliveRuntimeInstaller {
  return createPortableRuntimeInstaller({ ...options, kind: "texlive", requiredTools: TEXLIVE_TOOLS });
}
export interface ResolvedTexliveRuntime {
  pathEntries: string[]; readRoots: string[]; executableRoots: string[]; environment: Record<string, string>;
}
export type TexliveProbe = (engine: string, kpsewhich: string, environment: Record<string, string>) => Promise<boolean>;
export const probeTexlive: TexliveProbe = async (engine, kpsewhich, environment) => {
  try {
    const env = { ...process.env, ...environment };
    await run(engine, ["--version"], { env, timeout: 10000, maxBuffer: 65536, windowsHide: true });
    const { stdout } = await run(kpsewhich, [...REVIEW_TEX_FILES], { env, timeout: 15000, maxBuffer: 65536, windowsHide: true });
    return stdout.trim().split(/\r?\n/u).length === REVIEW_TEX_FILES.length;
  } catch { return false; }
};
export async function resolveTexliveRuntime(platform: NodeJS.Platform, installer?: TexliveRuntimeInstaller,
  probe: TexliveProbe = probeTexlive): Promise<ResolvedTexliveRuntime> {
  const result: ResolvedTexliveRuntime = { pathEntries: [], readRoots: [], executableRoots: [], environment: {} };
  const extension = platform === "win32" ? ".exe" : "";
  if (process.env.MEMMY_TEXLIVE_RUNTIME_PREFER_MANAGED !== "1") {
    const binaryRoot = platform === "darwin" ? await realpath("/Library/TeX/texbin").catch(() => null) : null;
    const find = async (name: string): Promise<string | null> => {
      for (const directory of [binaryRoot, ...(process.env.PATH ?? "").split(delimiter)]) {
        if (!directory) continue;
        const file = join(directory, name + extension);
        try { await access(file); return file; } catch { /* continue */ }
      }
      return null;
    };
    const engine = await find("xelatex"), kpsewhich = await find("kpsewhich");
    if (engine && kpsewhich && await probe(engine, kpsewhich, {})) {
      result.pathEntries.push(dirname(engine), dirname(kpsewhich));
      if (binaryRoot) result.pathEntries.push(binaryRoot);
      if (platform === "darwin") {
        for (const candidate of ["/usr/local/texlive", join(homedir(), "Library", "texmf")]) {
          const root = await realpath(candidate).catch(() => null);
          if (root) { result.readRoots.push(root); result.executableRoots.push(root);
            if (candidate.endsWith("texmf")) result.environment.TEXMFHOME = root; }
        }
      }
      if (platform !== "darwin") {
        // Query the chosen distribution instead of granting an arbitrary parent directory.
        try {
          const { stdout } = await run(kpsewhich, ["--var-value=TEXMFDIST"], { timeout: 10000, windowsHide: true });
          const root = await realpath(dirname(stdout.trim()));
          if (root === parse(root).root) throw new Error("Invalid TeX distribution root");
          result.readRoots.push(root); result.executableRoots.push(root);
        } catch { return resolveTexliveRuntimeManaged(platform, installer, probe); }
      }
      result.environment.MEMMY_TEX_FONTSET = "fandol";
      return result;
    }
  }
  return resolveTexliveRuntimeManaged(platform, installer, probe);
}
async function resolveTexliveRuntimeManaged(platform: NodeJS.Platform, installer: TexliveRuntimeInstaller | undefined,
  probe: TexliveProbe): Promise<ResolvedTexliveRuntime> {
  const result: ResolvedTexliveRuntime = { pathEntries: [], readRoots: [], executableRoots: [], environment: {} };
  if (!installer) return result; // Offline/test hosts still report the missing engine at render preflight.
  const installed = await installer.ensure(platform, process.arch);
  // TeX caches must be separate from the immutable, hash-verified installation.
  const mutableRoot = join(dirname(installed.root), "texmf-cache", installed.version);
  await mkdir(mutableRoot, { recursive: true });
  result.environment = { TEXMFVAR: join(mutableRoot, "var"), TEXMFCONFIG: join(mutableRoot, "config"),
    TEXMFHOME: join(mutableRoot, "home"), MEMMY_TEX_FONTSET: "fandol" };
  if (!await probe(installed.tools.xelatex!, installed.tools.kpsewhich!, result.environment)) {
    throw new Error("Memmy XeLaTeX runtime is incomplete: engine, review packages or Chinese fonts are unavailable; retry installation.");
  }
  result.pathEntries.push(...new Set(Object.values(installed.tools).map(file => dirname(file))));
  result.readRoots.push(installed.root); result.executableRoots.push(installed.root);
  // A writable TeX cache is granted separately by the command adapter.
  result.environment.MEMMY_TEX_CACHE_ROOT = mutableRoot;
  return result;
}
