import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function minimumMacOS(loadCommands) {
  const versions = [];
  for (const block of loadCommands.split(/(?=Load command \d+)/)) {
    if (/\bcmd LC_BUILD_VERSION\b/.test(block)) {
      // SDK is the compiler's SDK, not the runtime requirement.
      if (!/^\s*platform (?:1|MACOS)\s*$/m.test(block)) continue;
      const match = block.match(/^\s*minos (\d+(?:\.\d+){0,2})\s*$/m);
      if (match) versions.push(match[1]);
    } else if (/\bcmd LC_VERSION_MIN_MACOSX\b/.test(block)) {
      const match = block.match(/^\s*version (\d+(?:\.\d+){0,2})\s*$/m);
      if (match) versions.push(match[1]);
    }
  }
  if (versions.length !== 1) throw new Error("Expected exactly one macOS deployment target for the selected architecture");
  return versions[0];
}

export function targetIsSupported(actual, maximum) {
  const parse = value => {
    if (!/^\d+(?:\.\d+){0,2}$/.test(value)) throw new Error("Invalid macOS deployment target");
    return value.split(".").map(Number);
  };
  const left = parse(actual), right = parse(maximum);
  for (let index = 0; index < 3; index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta) return delta < 0;
  }
  return true;
}

export function verifyLibraryDeploymentTarget(library, architecture, maximum = "12.0") {
  const result = spawnSync("/usr/bin/otool", ["-arch", architecture, "-l", library], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Cannot inspect library deployment target: ${library}`);
  const minimum = minimumMacOS(result.stdout);
  if (!targetIsSupported(minimum, maximum)) {
    throw new Error(`Library requires macOS ${minimum}, exceeding supported ${maximum}: ${library}. Build compatible dependencies with build-wechat-sqlcipher.sh and set MEMMY_SQLCIPHER_PREFIX / MEMMY_OPENSSL_PREFIX.`);
  }
  return { library, architecture, minimumMacOS: minimum, maximumMacOS: maximum };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [library, architecture, maximum = "12.0"] = process.argv.slice(2);
  if (!library || !["arm64", "x86_64"].includes(architecture)) throw new Error("Usage: verify-library-deployment-target.mjs <library> <arm64|x86_64> [maximum-macOS]");
  console.log(JSON.stringify(verifyLibraryDeploymentTarget(library, architecture, maximum)));
}
