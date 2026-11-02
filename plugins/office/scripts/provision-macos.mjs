/** CI release input, pinned independently of Homebrew's changing cask/mirror. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Error("Unsupported macOS release worker");
const version = "26.8.1";
const folder = process.arch === "arm64" ? "aarch64" : "x86_64";
const arch = process.arch === "arm64" ? "aarch64" : "x86-64";
const expected = process.arch === "arm64" ? "ca074e0b13571efb30a31fc531c5f95e997030637325e5d5de92d67aefdf0dfc" : "4c7464313a529e9074400cbcdc894fc40ac4ef9421ded03b16b5a78d12cb155e";
const suffix = `libreoffice/stable/${version}/mac/${folder}/LibreOffice_${version}_MacOS_${arch}.dmg`;
const directory = join(process.env.RUNNER_TEMP, "office-build-inputs");
await mkdir(directory); // Never merge stale release inputs.
const archive = join(directory, "libreoffice.dmg");
let downloaded = false;
for (const base of ["https://ftp.osuosl.org/pub/tdf/", "https://mirrors.nju.edu.cn/tdf/", "https://download.documentfoundation.org/"]) {
  try {
    execFileSync("curl", ["--fail", "--location", "--silent", "--show-error", "--connect-timeout", "15", "--max-time", "180", "--output", archive, base + suffix], { stdio: "inherit" });
    const digest = createHash("sha256");
    for await (const bytes of createReadStream(archive)) digest.update(bytes);
    if (digest.digest("hex") !== expected) throw new Error("LibreOffice download integrity check failed");
    downloaded = true; break;
  } catch (error) { console.warn(`LibreOffice input mirror failed: ${error.message}`); }
}
if (!downloaded) throw new Error("No verified LibreOffice release input could be downloaded");
const mount = join(directory, "mounted");
execFileSync("hdiutil", ["attach", archive, "-nobrowse", "-readonly", "-mountpoint", mount], { stdio: "inherit" });
try {
  execFileSync("ditto", [join(mount, "LibreOffice.app"), join(directory, "LibreOffice.app")], { stdio: "inherit" });
} finally { execFileSync("hdiutil", ["detach", mount], { stdio: "inherit" }); }
await appendFile(process.env.GITHUB_ENV, `OFFICE_BUILD_LIBREOFFICE=${join(directory, "LibreOffice.app")}\n`);
