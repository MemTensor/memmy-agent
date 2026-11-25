import crypto from "node:crypto";
import path from "node:path";

export function windowsPathKey(value: string): string { return path.win32.normalize(value).toLowerCase(); }
export function windowsApplicationId(value: string): string {
  return `windows:${crypto.createHash("sha256").update(windowsPathKey(value)).digest("hex")}`;
}
export function windowsApplicationAlias(value: string): string {
  return `win32.${path.win32.basename(windowsPathKey(value), ".exe")}`;
}
export function isWindowsApplicationId(value: string): boolean {
  return /^(?:windows:|win32\.)/iu.test(value);
}
