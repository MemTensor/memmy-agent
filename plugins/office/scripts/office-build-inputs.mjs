/** Verified CI inputs. Download caches are untrusted until their full digest matches. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const INPUT_DOWNLOAD_SECONDS = 180;

export function pinnedBuildInputs(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && ["arm64", "x64"].includes(arch)) {
    const folder = arch === "arm64" ? "aarch64" : "x86_64";
    const suffix = arch === "arm64" ? "aarch64" : "x86-64";
    const filename = "LibreOffice_26.8.1.1_MacOS_" + suffix + ".dmg";
    return { libreoffice: {
      version: "26.8.1", buildVersion: "26.8.1.1", filename,
      sha256: arch === "arm64" ? "ca074e0b13571efb30a31fc531c5f95e997030637325e5d5de92d67aefdf0dfc" : "4c7464313a529e9074400cbcdc894fc40ac4ef9421ded03b16b5a78d12cb155e",
      // Retired stable versions move to the immutable four-component archive.
      urls: ["https://downloadarchive.documentfoundation.org/libreoffice/old/26.8.1.1/mac/" + folder + "/" + filename],
    } };
  }
  if (platform === "win32" && arch === "x64") {
    const stable = "libreoffice/stable/26.2.7/win/x86_64/LibreOffice_26.2.7_Win_x86-64.msi";
    return {
      libreoffice: {
        version: "26.2.7", buildVersion: "26.2.7.3", filename: "LibreOffice_26.2.7.3_Win_x86-64.msi",
        sha256: "480fecf759fc6393bd614fbf43753eb95a8198fc1a065d41b727e3b664cd1e59",
        urls: ["https://ftp.osuosl.org/pub/tdf/" + stable, "https://mirrors.nju.edu.cn/tdf/" + stable,
          "https://download.documentfoundation.org/" + stable,
          "https://downloadarchive.documentfoundation.org/libreoffice/old/26.2.7.3/win/x86_64/LibreOffice_26.2.7.3_Win_x86-64.msi"],
      },
      poppler: {
        version: "26.09.0-0", filename: "Release-26.09.0-0.zip",
        sha256: "7a6f256a0ddf7536182246a5733331bf4677cbcc34f4663774947ad34556c8d0",
        urls: ["https://github.com/oschwartz10612/poppler-windows/releases/download/v26.09.0-0/Release-26.09.0-0.zip"],
      },
    };
  }
  throw new Error("Unsupported Office release worker: " + platform + "/" + arch);
}

export function buildInputCacheKey(platform = process.platform, arch = process.arch) {
  const pins = Object.entries(pinnedBuildInputs(platform, arch)).map(([name, input]) =>
    [name, input.buildVersion ?? input.version, input.filename, input.sha256]);
  return "office-inputs-v1-" + platform + "-" + arch + "-" + createHash("sha256").update(JSON.stringify(pins)).digest("hex");
}

async function verifiedFile(file, expected) {
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return false;
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest("hex") === expected;
}

export function downloadWithCurl(url, destination) {
  return new Promise((resolveDownload, reject) => {
    const child = spawn(process.platform === "win32" ? "curl.exe" : "curl", [
      "--disable", "--fail", "--location", "--silent", "--show-error",
      "--proto", "=https", "--proto-redir", "=https",
      "--connect-timeout", "15", "--max-time", String(INPUT_DOWNLOAD_SECONDS),
      "--speed-time", "30", "--speed-limit", "32768",
      "--output", destination, url,
    ], { stdio: "inherit", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); }, (INPUT_DOWNLOAD_SECONDS + 10) * 1000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveDownload();
      else reject(new Error("Input download failed: " + (signal ?? code)));
    });
  });
}

export async function downloadPinnedInput(input, directory, { fetchFile = downloadWithCurl, warn = console.warn } = {}) {
  if (!input || typeof input.filename !== "string" || !input.filename || basename(input.filename) !== input.filename
      || /[/\\]/.test(input.filename) || !/^[a-f0-9]{64}$/.test(input.sha256)
      || !Array.isArray(input.urls) || input.urls.length === 0) throw new Error("Invalid pinned Office input");
  for (const value of input.urls) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Office inputs require credential-free HTTPS");
  }
  await mkdir(directory, { recursive: true });
  const destination = join(directory, input.filename);
  if (await verifiedFile(destination, input.sha256)) return destination;
  await rm(destination, { force: true });
  const failures = [];
  for (const url of input.urls) {
    const partial = destination + "." + randomUUID() + ".partial";
    try {
      await fetchFile(url, partial);
      if (!await verifiedFile(partial, input.sha256)) throw new Error("Office input SHA256 integrity check failed");
      await rename(partial, destination);
      return destination;
    } catch (error) {
      failures.push(error);
      warn("Office input source failed: " + url + ": " + error.message);
    } finally {
      await rm(partial, { force: true });
    }
  }
  throw new AggregateError(failures, "No verified Office build input could be downloaded: " + input.filename);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--cache-key") throw new Error("Usage: office-build-inputs.mjs --cache-key");
  console.log("key=" + buildInputCacheKey());
}
