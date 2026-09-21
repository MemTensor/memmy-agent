import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureNativeHistoryHelper } from "./native-helper.js";

const execFileAsync = promisify(execFile);

// A bundle identifier is passed to a helper as an argument, never a shell, but
// it also becomes a cache file name, so it is held to what an identifier can be.
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Marks an application whose icon macOS could not produce, so it is asked for once. */
const MISSING = "missing";

/**
 * Reads application icons, the way the Dock draws them.
 *
 * The alternative — reading `Contents/Resources/*.icns` out of the bundle — is
 * silently wrong for a growing share of applications, which ship their icon in
 * a compiled asset catalog with no `.icns` at all. Asking NSWorkspace costs a
 * helper process and gets the real answer for all of them.
 *
 * Icons are cached on disk because they change about as often as the
 * application is reinstalled, and a timeline of many windows asks for the same
 * dozen applications over and over.
 */
export class ApplicationIconReader {
  private readonly cacheDirectory: string;
  private readonly helperSource: string;
  private helper: Promise<string> | null = null;
  private readonly pending = new Map<string, Promise<string | null>>();

  constructor(input: { cacheDirectory?: string } = {}) {
    // Copied beside the compiled module by the build, as the recorder's is.
    this.helperSource = fileURLToPath(new URL("./app-icon.swift", import.meta.url));
    this.cacheDirectory = input.cacheDirectory
      ?? path.join(os.homedir(), ".memmy", "computer-history", "app-icons");
  }

  /** The icon as a `data:` URL, or null when macOS has none to give. */
  async iconFor(bundleId: string): Promise<string | null> {
    if (process.platform !== "darwin") return null;
    if (!BUNDLE_ID.test(bundleId)) return null;
    const cached = this.readCache(bundleId);
    if (cached !== undefined) return cached;
    const existing = this.pending.get(bundleId);
    if (existing) return existing;
    const request = this.extract(bundleId).finally(() => this.pending.delete(bundleId));
    this.pending.set(bundleId, request);
    return request;
  }

  private cacheFile(bundleId: string): string {
    return path.join(this.cacheDirectory, `${bundleId}.png`);
  }

  private missingFile(bundleId: string): string {
    return path.join(this.cacheDirectory, `${bundleId}.${MISSING}`);
  }

  /** `undefined` means unknown; `null` means known to have no icon. */
  private readCache(bundleId: string): string | null | undefined {
    try {
      if (fs.existsSync(this.missingFile(bundleId))) return null;
      const file = this.cacheFile(bundleId);
      if (!fs.existsSync(file)) return undefined;
      return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
    } catch {
      return undefined;
    }
  }

  private async extract(bundleId: string): Promise<string | null> {
    let binary: string;
    try {
      binary = await this.ensureHelper();
    } catch {
      // Helper availability is not a property of the requested application,
      // so it is not remembered as "this app has no icon".
      return null;
    }
    try {
      const { stdout } = await execFileAsync(binary, [bundleId], {
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const base64 = stdout.trim();
      if (!base64) return this.rememberMissing(bundleId);
      fs.mkdirSync(this.cacheDirectory, { recursive: true });
      fs.writeFileSync(this.cacheFile(bundleId), Buffer.from(base64, "base64"));
      return `data:image/png;base64,${base64}`;
    } catch {
      // The helper exits non-zero when the application is not installed, which
      // is an ordinary answer for history that outlived an application.
      return this.rememberMissing(bundleId);
    }
  }

  private rememberMissing(bundleId: string): null {
    try {
      fs.mkdirSync(this.cacheDirectory, { recursive: true });
      fs.writeFileSync(this.missingFile(bundleId), "", "utf8");
    } catch {
      // Re-asking is only a wasted process, so failing to remember is survivable.
    }
    return null;
  }

  /** Shares the packaged/development helper resolution with the recorder. */
  private ensureHelper(): Promise<string> {
    this.helper ??= ensureNativeHistoryHelper(this.helperSource, "app-icon").catch((error) => {
      // Let the next request retry after a transient development build failure.
      this.helper = null;
      throw error;
    });
    return this.helper;
  }
}
