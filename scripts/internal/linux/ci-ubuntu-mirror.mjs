#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sourcePath = "/etc/apt/sources.list.d/ubuntu.sources";
const keyringPath = "/usr/share/keyrings/ubuntu-archive-keyring.gpg";
const aptConfigPath = "/etc/apt/apt.conf.d/80-memmy-ci-network";
const mirrors = Object.freeze({
  x64: "https://mirrors.mit.edu/ubuntu/",
  arm64: "https://mirrors.mit.edu/ubuntu-ports/",
});

export function assertHostedUbuntuRunner({ environment, platform, osRelease }) {
  if (environment.GITHUB_ACTIONS !== "true" || environment.RUNNER_ENVIRONMENT !== "github-hosted" || platform !== "linux") {
    throw new Error("Ubuntu mirror recovery is restricted to ephemeral GitHub-hosted Linux runners");
  }
  if (!/^ID=ubuntu$/m.test(osRelease) || !/^VERSION_ID="?24\.04"?$/m.test(osRelease)) {
    throw new Error("Ubuntu mirror recovery supports only the Ubuntu 24.04 runner image");
  }
}

export function planUbuntuMirror(source, architecture) {
  const mirror = mirrors[architecture];
  if (!mirror) throw new Error("Unsupported Ubuntu runner architecture");
  if (source.length > 64 * 1024 || /^\s*(?:Trusted:\s*yes|Check-Valid-Until:\s*no)/im.test(source)) {
    throw new Error("Unexpected Ubuntu source trust configuration");
  }
  let count = 0;
  const nextSource = source.split(/\n\s*\n/).map(stanza => {
    if (!/^URIs:/m.test(stanza)) return stanza;
    if (!new RegExp("^Signed-By: *" + keyringPath.replaceAll(".", "\\.") + " *$", "m").test(stanza)) {
      throw new Error("Ubuntu sources must retain the existing archive signing keyring");
    }
    const suites = stanza.match(/^Suites:\s*(.+)$/m)?.[1].trim().split(/\s+/);
    if (!suites?.length || suites.some(suite => !/^noble(?:-(?:updates|backports|security))?$/.test(suite))) {
      throw new Error("Unexpected Ubuntu source suites");
    }
    return stanza.replace(/^URIs:\s*(.+)$/m, (_, value) => {
      const uris = value.trim().split(/\s+/);
      if (!uris.every(uri => uri === "mirror+file:/etc/apt/apt-mirrors.txt" ||
        /^https?:\/\/(?:azure\.archive|archive|security|ports)\.ubuntu\.com\/(?:ubuntu|ubuntu-ports)\/?$/.test(uri) ||
        Object.values(mirrors).includes(uri))) {
        throw new Error("Refusing to replace an unexpected Ubuntu source URI");
      }
      count += 1;
      return "URIs: " + mirror;
    });
  }).join("\n\n");
  if (!count) throw new Error("Ubuntu Deb822 sources were not found");
  return { mirror, architecture, nextSource, changed: nextSource !== source };
}

// Keep verification ahead of every privileged write. Adapters let tests exercise
// failure ordering without running sudo or modifying the developer's apt setup.
export function recoverUbuntuMirror(plan, { fetchRelease, verifyRelease, applySource }) {
  if (!plan.changed) return { changed: false };
  const release = fetchRelease(plan.mirror + "dists/noble/InRelease");
  verifyRelease(release);
  const architectures = release.text.match(/^Architectures:\s*(.+)$/m)?.[1].trim().split(/\s+/) || [];
  const expectedArchitecture = plan.architecture === "x64" ? "amd64" : "arm64";
  if (!/^Codename: noble$/m.test(release.text) || !architectures.includes(expectedArchitecture)) {
    throw new Error("Signed Ubuntu mirror metadata does not match the runner suite/architecture");
  }
  applySource(plan.nextSource);
  return { changed: true };
}

function main() {
  assertHostedUbuntuRunner({ environment: process.env, platform: process.platform, osRelease: fs.readFileSync("/etc/os-release", "utf8") });
  const original = fs.readFileSync(sourcePath, "utf8");
  const plan = planUbuntuMirror(original, process.arch);
  if (!plan.changed) {
    console.log("The verified Ubuntu CI mirror is already configured.");
    return;
  }
  const directory = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), "memmy-linux-mirror."));
  fs.writeFileSync(path.join(directory, "original-ubuntu.sources"), original);
  const result = recoverUbuntuMirror(plan, {
    fetchRelease(url) {
      const file = path.join(directory, "InRelease");
      execFileSync("curl", ["--fail", "--location", "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "10", "--max-time", "30", "--max-filesize", "1048576", "--retry", "2", "--retry-max-time", "60", "--output", file, url], { stdio: "inherit", timeout: 70000 });
      return { file, text: fs.readFileSync(file, "utf8") };
    },
    verifyRelease(release) {
      execFileSync("gpgv", ["--homedir", directory, "--keyring", keyringPath, release.file], { stdio: "inherit", timeout: 10000 });
    },
    applySource(nextSource) {
      const file = path.join(directory, "ubuntu.sources");
      const config = path.join(directory, "apt-network.conf");
      fs.writeFileSync(file, nextSource);
      fs.writeFileSync(config, 'Acquire::Retries "2";\nAcquire::http::Timeout "20";\nAcquire::https::Timeout "20";\nAPT::Update::Error-Mode "any";\n');
      execFileSync("sudo", ["install", "-o", "root", "-g", "root", "-m", "0644", config, aptConfigPath], { stdio: "inherit" });
      execFileSync("sudo", ["install", "-o", "root", "-g", "root", "-m", "0644", file, sourcePath], { stdio: "inherit" });
    },
  });
  console.log(`Ubuntu CI mirror recovery: changed=${result.changed}; mirror=${plan.mirror}; Ubuntu archive signatures remain required. Backup: ${directory}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error("Ubuntu CI mirror recovery failed: " + error.message); process.exitCode = 1; }
}
