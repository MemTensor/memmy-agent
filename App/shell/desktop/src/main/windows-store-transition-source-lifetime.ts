import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { win32 } from "node:path";
import {
  resolveWindowsStoreTransitionSourceBarrier,
  type WindowsStoreTransitionSourceBarrierDecision,
  type WindowsStoreTransitionSourceBarrierOptions
} from "./windows-store-transition-source-barrier.js";

const DEFAULT_SOURCE_LEASE_TIMEOUT_MS = 15_000;
const DEFAULT_SOURCE_LEASE_RETRY_INTERVAL_MS = 100;
const SOURCE_LEASE_TIMEOUT_ERROR_CODE = "windows_store_transition_source_lease_timeout";

export interface WindowsStoreTransitionSourceLease {
  readonly pipeName: string;
  release(): Promise<void>;
}

export interface AcquireWindowsStoreTransitionSourceLeaseOptions {
  statePath: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
}

interface TryAcquireWindowsStoreTransitionSourceLeaseOptions {
  retainCleanupGuard?: boolean;
}

export interface WindowsStoreTransitionSourceLifetimeDependencies {
  tryAcquireLease?: (statePath: string) => Promise<WindowsStoreTransitionSourceLease | null>;
  resolveBarrier?: (
    options: WindowsStoreTransitionSourceBarrierOptions
  ) => Promise<WindowsStoreTransitionSourceBarrierDecision>;
}

type AllowedSourceBarrierAction = "no-transition" | "different-source" | "allow-source";

export type WindowsStoreTransitionSourceLifetimeResult =
  | { action: "not-applicable" }
  | {
      action: "hold-source";
      lease: WindowsStoreTransitionSourceLease;
      barrierAction: AllowedSourceBarrierAction;
    }
  | {
      action: "hold-source";
      lease: WindowsStoreTransitionSourceLease;
      barrierAction: "orphan-recovered";
      recoveredPhase: Extract<
        WindowsStoreTransitionSourceBarrierDecision,
        { action: "orphan-recovered" }
      >["phase"];
      archivedStatePath: string;
    }
  | { action: "block-source"; reason: "journal"; phase: Extract<
      WindowsStoreTransitionSourceBarrierDecision,
      { action: "block-source" }
    >["phase"] }
  | { action: "block-source"; reason: "lease-unavailable" };

export class WindowsStoreTransitionSourceLeaseTimeoutError extends Error {
  readonly code = SOURCE_LEASE_TIMEOUT_ERROR_CODE;

  constructor(readonly pipeName: string, readonly timeoutMs: number) {
    super(`Timed out waiting ${timeoutMs}ms for Windows Store transition source lease ${pipeName}`);
    this.name = "WindowsStoreTransitionSourceLeaseTimeoutError";
  }
}

export const resolveWindowsStoreTransitionSourceLeasePipeName = (statePath: string): string => {
  const normalizedStatePath = normalizeStatePath(statePath);
  // Keep the cross-language digest independent of the process locale. The
  // native helper applies this exact ASCII-only case fold before hashing; a
  // locale-sensitive Unicode lowercase operation can otherwise disagree for
  // non-ASCII Windows profile names.
  const digestInput = normalizedStatePath.replace(/[A-Z]/gu, (character) =>
    character.toLowerCase()
  );
  const digest = createHash("sha256")
    .update(digestInput, "utf8")
    .digest("hex");
  // MSIX processes must use the LOCAL named-pipe namespace to communicate
  // with an unpackaged full-trust desktop process in the same user session.
  return `\\\\.\\pipe\\LOCAL\\memmy-store-transition-source-${digest}`;
};

export const resolveWindowsStoreTransitionCleanupActivePipeName = (statePath: string): string =>
  `${resolveWindowsStoreTransitionSourceLeasePipeName(statePath)}-cleanup-active`;

export const tryAcquireWindowsStoreTransitionSourceLease = async (
  statePath: string,
  options: TryAcquireWindowsStoreTransitionSourceLeaseOptions = {}
): Promise<WindowsStoreTransitionSourceLease | null> => {
  const pipeName = resolveWindowsStoreTransitionSourceLeasePipeName(statePath);
  const cleanupActivePipeName = resolveWindowsStoreTransitionCleanupActivePipeName(statePath);
  const cleanupGuard = createLeaseServer();
  const cleanupIdle = await listenForExclusiveLease(cleanupGuard, cleanupActivePipeName);
  if (!cleanupIdle) return null;
  const sourceLease = createLeaseServer();
  try {
    const acquired = await listenForExclusiveLease(sourceLease, pipeName);
    if (!acquired) {
      await closeLeaseServer(cleanupGuard);
      return null;
    }
    if (!options.retainCleanupGuard) {
      // Store callers need the marker only until they own sourceLease. The
      // unpackaged broker then owns cleanupActive for the destructive interval.
      await closeLeaseServer(cleanupGuard);
      return createLease([sourceLease], pipeName);
    }
    // An NSIS process keeps both locks for its entire lifetime. This closes the
    // Store-crash gap between observing an idle marker and acquiring sourceLease:
    // a late broker cannot start cleanup after NSIS has already acquired source.
    return createLease([sourceLease, cleanupGuard], pipeName);
  } catch (error) {
    await closeLeaseServer(sourceLease).catch(() => undefined);
    await closeLeaseServer(cleanupGuard).catch(() => undefined);
    throw error;
  }
};

export const acquireWindowsStoreTransitionSourceLease = async (
  options: AcquireWindowsStoreTransitionSourceLeaseOptions
): Promise<WindowsStoreTransitionSourceLease> => {
  const pipeName = resolveWindowsStoreTransitionSourceLeasePipeName(options.statePath);
  const timeoutMs = normalizeNonNegativeInteger(
    options.timeoutMs ?? DEFAULT_SOURCE_LEASE_TIMEOUT_MS,
    "timeout"
  );
  const retryIntervalMs = normalizePositiveInteger(
    options.retryIntervalMs ?? DEFAULT_SOURCE_LEASE_RETRY_INTERVAL_MS,
    "retry interval"
  );
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const lease = await tryAcquireWindowsStoreTransitionSourceLease(options.statePath);
    if (lease) return lease;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new WindowsStoreTransitionSourceLeaseTimeoutError(pipeName, timeoutMs);
    }
    await delay(Math.min(retryIntervalMs, remainingMs));
  }
};

export const establishWindowsStoreTransitionSourceLifetime = async (
  options: WindowsStoreTransitionSourceBarrierOptions,
  dependencies: WindowsStoreTransitionSourceLifetimeDependencies = {}
): Promise<WindowsStoreTransitionSourceLifetimeResult> => {
  if (options.platform !== "win32" || !options.isPackaged || options.isWindowsStore) {
    return { action: "not-applicable" };
  }

  const lease = await (
    dependencies.tryAcquireLease
    ?? ((statePath) => tryAcquireWindowsStoreTransitionSourceLease(
      statePath,
      { retainCleanupGuard: true }
    ))
  )(options.statePath);
  if (!lease) {
    return { action: "block-source", reason: "lease-unavailable" };
  }
  try {
    const decision = await (
      dependencies.resolveBarrier ?? resolveWindowsStoreTransitionSourceBarrier
    )(options);
    if (decision.action === "not-applicable") {
      await lease?.release();
      return { action: "not-applicable" };
    }
    if (decision.action === "block-source") {
      await lease.release();
      return { action: "block-source", reason: "journal", phase: decision.phase };
    }
    if (decision.action === "orphan-recovered") {
      return {
        action: "hold-source",
        lease,
        barrierAction: decision.action,
        recoveredPhase: decision.phase,
        archivedStatePath: decision.archivedStatePath
      };
    }
    return { action: "hold-source", lease, barrierAction: decision.action };
  } catch (cause) {
    await lease.release();
    throw cause;
  }
};

const createLeaseServer = (): Server => createServer((socket) => {
  socket.destroy();
});

const listenForExclusiveLease = async (server: Server, pipeName: string): Promise<boolean> =>
  new Promise<boolean>((resolve, reject) => {
    const handleError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", handleListening);
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(error);
    };
    const handleListening = () => {
      server.removeListener("error", handleError);
      server.on("error", () => undefined);
      server.unref();
      resolve(true);
    };
    server.once("error", handleError);
    server.once("listening", handleListening);
    server.listen(pipeName);
  });

const createLease = (servers: Server[], pipeName: string): WindowsStoreTransitionSourceLease => {
  let releasePromise: Promise<void> | null = null;
  return {
    pipeName,
    release: () => {
      // Release source first while cleanupActive is still held. A waiting
      // broker cannot begin destructive work until this process has stopped
      // advertising itself as an active legacy source.
      releasePromise ??= servers.reduce(
        (previous, server) => previous.then(() => closeLeaseServer(server)),
        Promise.resolve()
      );
      return releasePromise;
    }
  };
};

const closeLeaseServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(error);
        return;
      }
      resolve();
    });
  });
};

const normalizeStatePath = (statePath: string): string => {
  if (!statePath || statePath !== statePath.trim() || !win32.isAbsolute(statePath)) {
    throw new Error("Windows Store transition source lease state path must be absolute");
  }
  return win32.normalize(statePath);
};

const normalizeNonNegativeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Windows Store transition source lease ${label} must be a non-negative integer`);
  }
  return value;
};

const normalizePositiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Windows Store transition source lease ${label} must be a positive integer`);
  }
  return value;
};

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
