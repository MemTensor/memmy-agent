/** CI-only renderer inputs. Downloads are verified before any native installer runs. */
import { spawnSync } from "node:child_process";
import { appendFile, lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pinnedBuildInputs, downloadPinnedInput } from "./office-build-inputs.mjs";

const NATIVE_INPUT_TIMEOUT_MS = 180_000;
const EXPAND_POPPLER = "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:MEMMY_OFFICE_POPPLER_ARCHIVE -DestinationPath $env:MEMMY_OFFICE_POPPLER_DESTINATION";

function requiredPath(value, name) {
  if (typeof value !== "string" || !value || /[\r\n\0]/u.test(value)) throw new Error(`${name} must be a nonempty path without control characters`);
  return value;
}

function runBoundedNative(runNative, executable, args, env, description, installerLog) {
  let result;
  try {
    result = runNative(executable, args, {
      env, stdio: "inherit", windowsHide: true, timeout: NATIVE_INPUT_TIMEOUT_MS,
    });
  } catch (error) {
    throw new Error(`${description} failed; installer log: ${installerLog}`, { cause: error });
  }
  const accepted = executable === "msiexec.exe" ? [0, 3010] : [0];
  if (result?.error || result?.signal || !accepted.includes(result?.status)) {
    const outcome = result?.error?.code ?? result?.signal ?? `exit ${result?.status ?? "unknown"}`;
    throw new Error(`${description} failed (${outcome}); installer log: ${installerLog}`, { cause: result?.error });
  }
}

async function requireX64Executable(file) {
  let handle;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Expected a regular executable file");
    handle = await open(file, "r");
    const dos = Buffer.alloc(64);
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.toString("ascii", 0, 2) !== "MZ") throw new Error("Missing DOS executable header");
    const offset = dos.readUInt32LE(60);
    if (offset < 64 || offset > 1_048_576 || offset + 6 > info.size) throw new Error("Invalid PE header offset");
    const pe = Buffer.alloc(6);
    if ((await handle.read(pe, 0, pe.length, offset)).bytesRead !== pe.length
      || pe.toString("hex", 0, 4) !== "50450000" || pe.readUInt16LE(4) !== 0x8664) throw new Error("Expected an AMD64 PE executable");
  } catch (error) {
    throw new Error(`Invalid Windows renderer executable ${file}: ${error.message}`, { cause: error });
  } finally {
    await handle?.close();
  }
}

/** Native calls/downloads are injectable for orchestration and failure-boundary tests. */
export async function provisionWindowsBuildInputs({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  runnerTemp = env.RUNNER_TEMP,
  cacheDirectory = env.OFFICE_BUILD_INPUT_CACHE,
  githubEnv = env.GITHUB_ENV,
  programFiles = env.ProgramFiles ?? "C:\\Program Files",
  downloadInput = downloadPinnedInput,
  runNative = spawnSync,
} = {}) {
  if (platform !== "win32" || arch !== "x64") throw new Error("Windows Office release inputs require a native win32/x64 worker");
  requiredPath(runnerTemp, "RUNNER_TEMP");
  requiredPath(githubEnv, "GITHUB_ENV");
  requiredPath(programFiles, "ProgramFiles");
  const cache = requiredPath(cacheDirectory ?? join(runnerTemp, "office-input-cache"), "OFFICE_BUILD_INPUT_CACHE");
  const directory = join(runnerTemp, "office-build-inputs");
  await mkdir(directory); // Never merge old installation/extraction outputs.
  const inputs = pinnedBuildInputs(platform, arch);
  const downloads = await Promise.allSettled([
    downloadInput(inputs.libreoffice, cache),
    downloadInput(inputs.poppler, cache),
  ]);
  const failures = downloads.filter(result => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Windows renderer inputs failed verification before installation");
  const [libreofficeArchive, popplerArchive] = downloads.map(result => result.value);

  const installerLog = join(directory, "libreoffice-msi.log");
  runBoundedNative(runNative, "msiexec.exe", [
    "/i", libreofficeArchive, "/qn", "/norestart", "/L*v", installerLog,
  ], env, "LibreOffice installation", installerLog);
  const libreoffice = join(programFiles, "LibreOffice");
  try {
    await requireX64Executable(join(libreoffice, "program", "soffice.exe"));
  } catch (error) {
    throw new Error(`${error.message}; installer log: ${installerLog}`, { cause: error });
  }

  const extracted = join(directory, "poppler");
  runBoundedNative(runNative, "powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", EXPAND_POPPLER], {
    ...env,
    MEMMY_OFFICE_POPPLER_ARCHIVE: popplerArchive,
    MEMMY_OFFICE_POPPLER_DESTINATION: extracted,
  }, "Poppler extraction", installerLog);
  const poppler = join(extracted, `poppler-${inputs.poppler.version.replace(/-\d+$/u, "")}`);
  for (const name of ["pdfinfo", "pdftoppm", "pdftotext"]) await requireX64Executable(join(poppler, "Library", "bin", `${name}.exe`));
  await appendFile(githubEnv, `OFFICE_BUILD_LIBREOFFICE=${libreoffice}\nOFFICE_BUILD_POPPLER=${poppler}\n`);
  return { libreoffice, poppler };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  provisionWindowsBuildInputs().then(paths => console.info(`Verified Windows renderer inputs: ${JSON.stringify(paths)}`)).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
