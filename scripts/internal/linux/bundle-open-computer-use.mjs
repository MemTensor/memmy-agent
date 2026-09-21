import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Vendor OCU into the architecture-neutral Linux release, outside node_modules
 * so npm ci cannot delete it. Both manifests point to this local tarball. */
export function bundleLinuxOpenComputerUse(sourcePackageDirectory, agentDirectory) {
  const source = resolve(sourcePackageDirectory);
  const agent = resolve(agentDirectory);
  const manifestPath = join(agent, "package.json");
  const lockPath = join(agent, "package-lock.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const locked = lock.packages?.["node_modules/open-computer-use"];
  if (pkg.name !== "open-computer-use" || !/^\d+\.\d+\.\d+$/.test(pkg.version)
      || manifest.dependencies?.[pkg.name] !== pkg.version || locked?.version !== pkg.version
      || lock.packages?.[""]?.dependencies?.[pkg.name] !== pkg.version) {
    throw new Error("Bundled OCU must match the exact Agent dependency and lockfile version");
  }
  if (Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).length) {
    throw new Error("OCU now has runtime dependencies; review offline vendoring before upgrading");
  }
  for (const arch of ["amd64", "arm64"]) {
    const binary = join(source, "dist", "linux", arch, "open-computer-use");
    const stat = statSync(binary);
    if (!stat.isFile() || !(stat.mode & 0o111)) throw new Error(`Missing executable: ${binary}`);
  }
  const work = mkdtempSync(join(tmpdir(), "memmy-ocu-vendor-"));
  try {
    cpSync(source, join(work, "package"), {
      recursive: true,
      filter: (file) => {
        const name = relative(source, file).replaceAll("\\", "/");
        return !/^(?:node_modules|dist\/windows|dist\/Open Computer Use\.app)(?:\/|$)/.test(name);
      },
    });
    const tarName = `open-computer-use-${pkg.version}-linux.tgz`;
    const vendor = join(agent, "vendor");
    mkdirSync(vendor, { recursive: true });
    const tarball = join(vendor, tarName);
    execFileSync("tar", ["-czf", tarball, "-C", work, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const spec = `file:vendor/${tarName}`;
    manifest.dependencies[pkg.name] = spec;
    lock.packages[""].dependencies[pkg.name] = spec;
    locked.resolved = spec;
    locked.integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    return tarball;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error("Usage: bundle-open-computer-use.mjs SOURCE_PACKAGE AGENT_PAYLOAD");
  console.log(bundleLinuxOpenComputerUse(process.argv[2], process.argv[3]));
}
