import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WINDOWS_APP_ID = /^win32\.[a-z0-9._-]{1,128}$/u;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const MAX_BATCH = 48;
const MAX_ICON_BYTES = 128 * 1024;
const BATCH_DELAY_MS = 15;

type RunCommand = (binary: string, args: string[], options: {
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
}) => Promise<{ stdout: string }>;

function scriptPath(): string {
  const source = fileURLToPath(new URL("./app-icon.ps1", import.meta.url));
  const unpacked = source.replace(/app\.asar([\\/])/u, "app.asar.unpacked$1");
  return fs.existsSync(unpacked) ? unpacked : source;
}

function pngDataUrl(encoded: unknown): string | null {
  if (typeof encoded !== "string" || encoded.length === 0
    || encoded.length > Math.ceil(MAX_ICON_BYTES * 4 / 3) + 4
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 24 || bytes.length > MAX_ICON_BYTES
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 16 || height < 16 || width > 256 || height > 256) return null;
  return `data:image/png;base64,${encoded}`;
}

/**
 * Resolve only locally discovered Windows process/Start Menu icons. Callers
 * pass a History app id, never a path; the helper does not accept paths either.
 * A short batch delay lets a timeline or the app picker share one PowerShell
 * invocation, while successful results stay in memory for the app's lifetime.
 */
export class WindowsApplicationIconReader {
  private readonly platform: NodeJS.Platform;
  private readonly script: string;
  private readonly powershell: string;
  private readonly run: RunCommand;
  private readonly cache = new Map<string, string>();
  private readonly pending = new Map<string, { promise: Promise<string | null>; resolve(value: string | null): void }>();
  private readonly queue: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(input: {
    platform?: NodeJS.Platform;
    script?: string;
    powershell?: string;
    run?: RunCommand;
  } = {}) {
    this.platform = input.platform ?? process.platform;
    this.script = input.script ?? scriptPath();
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    this.powershell = input.powershell ?? path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    this.run = input.run ?? ((binary, args, options) => execFileAsync(binary, args, options));
  }

  iconFor(bundleId: string): Promise<string | null> {
    if (this.platform !== "win32" || !WINDOWS_APP_ID.test(bundleId)
      // This process hosts several unrelated packaged applications. A History
      // process id alone cannot identify which app supplied the window.
      || bundleId === "win32.applicationframehost") return Promise.resolve(null);
    const cached = this.cache.get(bundleId);
    if (cached) return Promise.resolve(cached);
    const existing = this.pending.get(bundleId);
    if (existing) return existing.promise;

    let resolve!: (value: string | null) => void;
    const promise = new Promise<string | null>((done) => { resolve = done; });
    this.pending.set(bundleId, { promise, resolve });
    this.queue.push(bundleId);
    this.schedule();
    return promise;
  }

  private schedule(): void {
    if (this.running || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, BATCH_DELAY_MS);
  }

  private async flush(): Promise<void> {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    const ids = this.queue.splice(0, MAX_BATCH);
    let rows: Record<string, unknown> = {};
    try {
      const encodedIds = Buffer.from(JSON.stringify(ids), "utf8").toString("base64");
      const { stdout } = await this.run(this.powershell, [
        "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass",
        "-File", this.script, "-IdsBase64", encodedIds,
      ], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      const parsed: unknown = JSON.parse(stdout.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rows = parsed as Record<string, unknown>;
    } catch {
      // A missing/unavailable helper is an ordinary icon miss. Do not cache it:
      // a later request can recover after a transient PowerShell failure.
    } finally {
      for (const id of ids) {
        const icon = pngDataUrl(rows[id]);
        if (icon) this.cache.set(id, icon);
        this.pending.get(id)?.resolve(icon);
        this.pending.delete(id);
      }
      this.running = false;
      this.schedule();
    }
  }
}
