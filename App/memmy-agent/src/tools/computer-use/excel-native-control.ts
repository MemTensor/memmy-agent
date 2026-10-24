import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDataDir } from "../../config/paths.js";
import { validateExcelAction, type ExcelBridgeAction } from "./excel-bridge.js";
import { nativeExcelRunner, type NativeExcelRunner, type NativeExcelStatus } from "./excel-native-runtime.js";

export type NativeExcelAdapter = {
  status(run: NativeExcelRunner): Promise<NativeExcelStatus>;
  authorize(run: NativeExcelRunner): Promise<NativeExcelStatus>;
  invoke(action: ExcelBridgeAction, run: NativeExcelRunner): Promise<unknown>;
  running?(run: NativeExcelRunner): Promise<boolean>;
};
export type ExcelControlStatus = NativeExcelStatus & {
  scope: "application";
  connectionMode: "native";
  enabled: boolean;
  configured: boolean;
  setupCompleted: boolean;
  connectionCount: number;
  manifestUrl: null;
  manualInstallPath: null;
  permissionRequired: boolean;
  error: string | null;
  lockedUse: { supported: false; reason: "nativeExcelRequiresUnlockedSession" };
};

function permissionFailure(error: unknown): boolean {
  return /-174[34]|automation.*(?:denied|permission)|not authorized to send apple events/i.test(String(error));
}

/** One application permission applies to every workbook; no task pane is involved. */
export class NativeExcelControl {
  private tail: Promise<unknown> = Promise.resolve();
  private enabled = false;
  private stopped = false;
  private loadedPath = "";
  private permissionError: string | null = null;
  private pendingStatus: Promise<ExcelControlStatus> | null = null;
  constructor(private readonly options: {
    platform?: NodeJS.Platform;
    dataDir?: string;
    adapter?: NativeExcelAdapter;
    runner?: NativeExcelRunner;
  } = {}) {}

  private get platform(): NodeJS.Platform { return this.options.platform ?? process.platform; }
  private get setupPath(): string {
    return path.join(this.options.dataDir ?? getDataDir(), "computer-use", "excel-native", "setup.json");
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action, action);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<void> {
    const file = this.setupPath;
    if (this.loadedPath === file) return;
    this.loadedPath = file;
    this.enabled = false;
    this.permissionError = null;
    try {
      const record = JSON.parse(await fs.readFile(file, "utf8"));
      this.enabled = record.version === 1 && record.platform === this.platform && record.scope === "application"
        && record.consented === true && record.enabled === true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.permissionError = "Excel connection settings could not be read. Enable Microsoft Excel again.";
    }
    // A legacy document-scoped add-in consent is never expanded silently.
  }

  private async persist(enabled: boolean): Promise<void> {
    const file = this.setupPath;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, platform: this.platform, scope: "application",
        consented: true, enabled }), { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    this.enabled = enabled;
  }

  private async adapter(): Promise<NativeExcelAdapter> {
    if (this.options.adapter) return this.options.adapter;
    if (this.platform === "darwin") {
      const mac = await import("./excel-native-mac.js");
      return { status: mac.nativeMacExcelStatus, authorize: mac.nativeMacExcelAuthorize, invoke: mac.nativeMacExcelInvoke,
        running: mac.nativeMacExcelRunning };
    }
    if (this.platform === "win32") {
      const windows = await import("./excel-native-windows.js");
      return { status: windows.nativeWindowsExcelStatus, authorize: windows.nativeWindowsExcelAuthorize,
        invoke: windows.nativeWindowsExcelInvoke, running: windows.nativeWindowsExcelRunning };
    }
    throw new Error("Application-level Excel connection supports macOS and Windows only");
  }

  private payload(native?: NativeExcelStatus, error: string | null = this.permissionError, granted = false): ExcelControlStatus {
    const enabled = (this.enabled || granted) && !this.stopped;
    const workbooks = enabled && !error ? native?.workbooks ?? [] : [];
    return {
      available: native?.available ?? ["darwin", "win32"].includes(this.platform),
      connected: enabled && !error && native?.connected === true,
      workbooks, activeWorkbookId: enabled && !error ? native?.activeWorkbookId ?? null : null,
      scope: "application", connectionMode: "native", enabled, configured: enabled,
      setupCompleted: this.enabled, connectionCount: workbooks.length,
      manifestUrl: null, manualInstallPath: null, permissionRequired: error !== null && permissionFailure(error), error,
      lockedUse: { supported: false, reason: "nativeExcelRequiresUnlockedSession" },
    };
  }

  async start(): Promise<void> { this.stopped = false; await this.load(); }
  stop(): void { this.stopped = true; }

  /** `granted` is a decision for the current request only; it never changes the setting. */
  status(options: { granted?: boolean } = {}): Promise<ExcelControlStatus> {
    const granted = options.granted === true;
    // A modal Excel dialog must not queue a fresh 30-second probe on each poll.
    if (this.pendingStatus && !granted) return this.pendingStatus;
    const pending = this.exclusive(async () => {
      await this.load();
      // Reading settings does not launch Excel or ask for a new permission.
      if (!(this.enabled || granted) || this.stopped || this.permissionError) return this.payload(undefined, this.permissionError, granted);
      try { return this.payload(await (await this.adapter()).status(this.options.runner ?? nativeExcelRunner()), this.permissionError, granted); }
      catch (error) {
        const message = String(error instanceof Error ? error.message : error).slice(0, 500);
        if (permissionFailure(error)) this.permissionError = message;
        return this.payload(undefined, message, granted);
      }
    });
    if (granted) return pending;
    this.pendingStatus = pending;
    void pending.finally(() => { if (this.pendingStatus === pending) this.pendingStatus = null; }).catch(() => undefined);
    return pending;
  }

  async isEnabled(): Promise<boolean> {
    await this.load();
    return this.enabled && !this.stopped;
  }

  /** Never launches Excel or asks for a permission. */
  async running(): Promise<boolean> {
    if (this.platform !== "darwin" && this.platform !== "win32") return false;
    try {
      const adapter = await this.adapter();
      return adapter.running ? await adapter.running(this.options.runner ?? nativeExcelRunner({ timeoutMs: 10_000 })) : false;
    } catch { return false; }
  }

  private async authorizeNative(): Promise<NativeExcelStatus> {
    this.stopped = false;
    try {
      const native = await (await this.adapter()).authorize(this.options.runner ?? nativeExcelRunner({ timeoutMs: 60_000 }));
      if (!native.available) throw new Error("Microsoft Excel is not installed or is unavailable");
      this.permissionError = null;
      return native;
    } catch (error) {
      if (permissionFailure(error)) this.permissionError = String(error instanceof Error ? error.message : error).slice(0, 500);
      throw error;
    }
  }

  async setEnabled(enabled: boolean): Promise<ExcelControlStatus> {
    return this.exclusive(async () => {
      await this.load();
      if (!enabled) {
        await this.persist(false);
        this.permissionError = null;
        return this.payload();
      }
      const native = await this.authorizeNative();
      await this.persist(true);
      return this.payload(native);
    });
  }

  /** Requests the operating-system grant for the current request without turning the setting on. */
  async authorizeOnce(): Promise<ExcelControlStatus> {
    return this.exclusive(async () => {
      await this.load();
      return this.payload(await this.authorizeNative(), null, true);
    });
  }

  async invoke(action: ExcelBridgeAction, signal?: AbortSignal | null, options: { granted?: boolean } = {}): Promise<unknown> {
    validateExcelAction(action);
    if (action.kind === "write_range" && !action.workbook) {
      throw new Error("Call Excel status and pass its exact workbook ID before writing cells");
    }
    if (JSON.stringify(action).length > 500_000) throw new Error("Excel request is too large");
    return this.exclusive(async () => {
      await this.load();
      if (signal?.aborted) throw new Error("Excel operation cancelled before dispatch");
      if (!(this.enabled || options.granted === true) || this.stopped) throw new Error("Enable Microsoft Excel in Memmy Computer Use settings first. This applies to every workbook.");
      if (this.permissionError) throw new Error(this.permissionError);
      try { return await (await this.adapter()).invoke(action, this.options.runner ?? nativeExcelRunner({ signal })); }
      catch (error) {
        if (permissionFailure(error)) this.permissionError = String(error instanceof Error ? error.message : error).slice(0, 500);
        throw error; // Native actions are never replayed through another executor.
      }
    });
  }
}

export const nativeExcelControl = new NativeExcelControl();
