/** CI release input, pinned independently of Homebrew's changing cask/mirror. */
import { execFileSync } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { downloadPinnedInput, pinnedBuildInputs } from "./office-build-inputs.mjs";

if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new Error("Unsupported macOS release worker");
const directory = join(process.env.RUNNER_TEMP, "office-build-inputs");
await mkdir(directory); // Never merge stale release inputs.
const cache = process.env.OFFICE_BUILD_INPUT_CACHE ?? join(process.env.RUNNER_TEMP, "office-input-cache");
const archive = await downloadPinnedInput(pinnedBuildInputs().libreoffice, cache);
const mount = join(directory, "mounted");
execFileSync("hdiutil", ["attach", archive, "-nobrowse", "-readonly", "-mountpoint", mount], { stdio: "inherit" });
try {
  execFileSync("ditto", [join(mount, "LibreOffice.app"), join(directory, "LibreOffice.app")], { stdio: "inherit" });
} finally { execFileSync("hdiutil", ["detach", mount], { stdio: "inherit" }); }
await appendFile(process.env.GITHUB_ENV, `OFFICE_BUILD_LIBREOFFICE=${join(directory, "LibreOffice.app")}\n`);
