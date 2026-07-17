#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJsonPath = join(packageRoot, "package.json");
const binDirectory = join(packageRoot, "bin");
const defaultBinaryBaseUrl = "https://memos-test.oss-cn-shanghai.aliyuncs.com";

try {
  if (shouldSkipDownload()) {
    process.exit(0);
  }

  const manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const version = manifest.version;
  if (typeof version !== "string" || !version) {
    throw new Error("package.json version is missing");
  }

  const target = resolveTarget(process.platform, process.arch);
  const assetName = `memmy-memory-${version}-${target}.tar.gz`;
  const downloadUrl = process.env.MEMMY_MEMORY_BINARY_URL || `${defaultBinaryBaseUrl}/${assetName}`;
  const archivePath = join(tmpdir(), `${assetName}.${process.pid}.download`);

  await mkdir(binDirectory, { recursive: true });
  await downloadFile(downloadUrl, archivePath);
  extractArchive(archivePath, binDirectory);
  await rm(archivePath, { force: true });

  const binaryPath = join(binDirectory, process.platform === "win32" ? "memmy-memory.exe" : "memmy-memory");
  if (process.platform === "darwin") {
    spawnSync("xattr", ["-dr", "com.apple.quarantine", binaryPath], { stdio: "ignore" });
  }
  if (process.platform !== "win32") {
    await chmod(binaryPath, 0o755);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function shouldSkipDownload() {
  const value = process.env.MEMMY_MEMORY_INSTALL_SKIP_DOWNLOAD;
  return value === "1" || value?.toLowerCase() === "true";
}

function resolveTarget(platform, arch) {
  const platformMap = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows"
  };
  const archMap = {
    arm64: "arm64",
    x64: "x64"
  };
  const normalizedPlatform = platformMap[platform];
  const normalizedArch = archMap[arch];
  if (!normalizedPlatform || !normalizedArch) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }
  return `${normalizedPlatform}-${normalizedArch}`;
}

function downloadFile(url, destination) {
  if (url.startsWith("file://")) {
    return copyFile(fileURLToPath(url), destination);
  }

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const get = parsedUrl.protocol === "http:" ? httpGet : httpsGet;
    const request = get(parsedUrl, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }

      const stream = createWriteStream(destination);
      response.pipe(stream);
      stream.on("finish", () => stream.close(resolve));
      stream.on("error", reject);
    });

    request.on("error", reject);
  });
}

function extractArchive(archivePath, destination) {
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", destination], {
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`failed to extract ${archivePath}`);
  }
}
