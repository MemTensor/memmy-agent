import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { physicalRuntimeAsset } from "../mac/native-helper.js";
import { resolveWindowsWeChatPython } from "./python-runtime.js";

const REVALIDATE_CONSENT_AFTER_MS = 60_000;
let verifiedConsent: { file: string; state: string; checkedAt: number } | null = null;

function checkPrivateState(mode: "prepare-directory" | "validate-consent", target: string): void {
  const runtime = resolveWindowsWeChatPython();
  if (!runtime) throw new Error("Windows WeChat local reader is unavailable");
  const helper = physicalRuntimeAsset(path.join(path.dirname(fileURLToPath(import.meta.url)), "private_files.py"));
  const stdout = execFileSync(runtime.executable, [...runtime.args, helper, mode, target], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 1_024, windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (JSON.parse(stdout)?.private !== true) throw new Error("Windows WeChat private state is unavailable");
}

/** NTFS changes ChangeTime (Node's ctime) on every owner, DACL and inheritance change. */
function securityState(file: string): string | null {
  try {
    const own = fs.lstatSync(file, { bigint: true });
    const parent = fs.lstatSync(path.dirname(file), { bigint: true });
    return [own.dev, own.ino, own.size, own.mtimeNs, own.ctimeNs, own.birthtimeNs,
      parent.dev, parent.ino, parent.ctimeNs].join(":");
  } catch {
    return null;
  }
}

/** Prepare private inherited NTFS permissions before Node creates any state file. */
export function prepareWindowsWeChatState(directory: string): void {
  checkPrivateState("prepare-directory", directory);
}

/**
 * Every read used to start Python synchronously, several times per poll. A
 * passed check is reused only while neither the file nor its directory has
 * changed any metadata, which includes its security descriptor.
 */
export function validateWindowsWeChatConsent(file: string): boolean {
  const before = securityState(file);
  if (before && verifiedConsent?.file === file && verifiedConsent.state === before
    && Date.now() - verifiedConsent.checkedAt < REVALIDATE_CONSENT_AFTER_MS) return true;
  verifiedConsent = null;
  try {
    checkPrivateState("validate-consent", file);
  } catch {
    return false;
  }
  // The check can repair the ACL itself; a state that moved during it is not reused.
  if (before && securityState(file) === before) verifiedConsent = { file, state: before, checkedAt: Date.now() };
  return true;
}
