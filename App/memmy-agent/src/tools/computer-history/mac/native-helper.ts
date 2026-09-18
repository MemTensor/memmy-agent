import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Packaged helpers must be real executables; only source installs need Swift. */
export async function ensureNativeHistoryHelper(source: string, cacheDirectory: string): Promise<string> {
  const name = path.basename(source, ".swift");
  const directory = path.dirname(source).replace(/([/\\])app\.asar([/\\])/g, "$1app.asar.unpacked$2");
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
  const hash = crypto.createHash("sha256").update(process.arch).update(contents).digest("hex").slice(0, 12);
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
    await execFileAsync("swiftc", ["-O", "-o", output, source], { timeout: 120_000 });
    fs.renameSync(output, cachedBinary);
    return cachedBinary;
  } catch (error) {
    throw new Error(`Could not compile the development Computer History helper (${name}): ${(error as Error).message}`, { cause: error });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
