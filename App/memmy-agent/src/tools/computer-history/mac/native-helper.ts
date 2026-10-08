import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { managedOcuEnvironment, resolveOpenComputerUseCommand } from "../../computer-use/open-computer-use-binary.js";

const execFileAsync = promisify(execFile);

/** Child processes cannot open paths inside Electron's virtual app.asar. */
export function physicalRuntimeAsset(file: string): string {
  return file.replace(/([/\\])app\.asar([/\\])/gu, "$1app.asar.unpacked$2");
}

/** Product History executes inside the same LaunchServices-owned native app as Use. */
export async function historyNativeCommand(source: string): Promise<{
  binary: string; args: string[]; managed: boolean; env?: NodeJS.ProcessEnv;
}> {
  const packaged = /[/\\]app\.asar(?:\.unpacked)?[/\\]/.test(source);
  if (process.platform === "darwin" && (packaged || process.env.MEMMY_DEV_COMPUTER_USE_BINARY)) {
    const binary = resolveOpenComputerUseCommand("open-computer-use");
    return { binary, args: ["__memmy-history"], managed: true,
      env: { ...process.env, ...managedOcuEnvironment(binary, null) } };
  }
  return { binary: await ensureNativeHistoryHelper(source, "human-history-recorder"), args: [], managed: false };
}

/** Packaged helpers must be real executables; only source installs need Swift. */
export async function ensureNativeHistoryHelper(source: string, cacheDirectory: string): Promise<string> {
  const name = path.basename(source, ".swift");
  const directory = path.dirname(physicalRuntimeAsset(source));
  const binary = path.join(directory, "native", process.arch, name);
  try {
    fs.accessSync(binary, fs.constants.X_OK);
    return binary;
  } catch (error) {
    // Never hide a broken installation by compiling on the customer's machine.
    if (/[/\\]app\.asar(?:\.unpacked)?[/\\]/.test(source)) {
      throw new Error(`Computer History packaged helper is missing or not executable: ${binary}. Reinstall Memmy.`, { cause: error });
    }
  }

  const contents = fs.readFileSync(source);
  const entrypoint = name === "human-recorder" ? path.join(directory, "main.swift") : null;
  const hash = crypto.createHash("sha256").update(process.arch).update(contents)
    .update(entrypoint && fs.existsSync(entrypoint) ? fs.readFileSync(entrypoint) : "")
    .digest("hex").slice(0, 12);
  const cache = path.join(os.homedir(), ".memmy", "tools", cacheDirectory);
  const cachedBinary = path.join(cache, `${name}-${hash}`);
  try {
    fs.accessSync(cachedBinary, fs.constants.X_OK);
    return cachedBinary;
  } catch {
    // A development source change (or CPU change) needs a fresh executable.
  }
  fs.mkdirSync(cache, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(cache, ".build-"));
  try {
    const output = path.join(temporary, name);
    const sources = entrypoint ? [source, entrypoint] : [source];
    await execFileAsync("swiftc", ["-O", "-o", output, ...sources], { timeout: 120_000 });
    fs.renameSync(output, cachedBinary);
    return cachedBinary;
  } catch (error) {
    throw new Error(`Could not compile the development Computer History helper (${name}): ${(error as Error).message}`, { cause: error });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
