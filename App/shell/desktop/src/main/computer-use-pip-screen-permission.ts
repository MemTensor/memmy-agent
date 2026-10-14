import type { MemmySystemPermission } from './computer-use-onboarding.js';

type Request = {
  isCurrent(): boolean;
  readGranted(): boolean;
  retryCapture(): void;
};

/** Serializes a native PiP permission miss behind any existing Memmy guide. */
export function createComputerUsePIPScreenPermissionGuide(deps: {
  whenIdle(): Promise<{ permission: MemmySystemPermission; approved: boolean; dismissedByUser: boolean } | null>;
  guide(readGranted: () => boolean): Promise<boolean>;
  isQuitting(): boolean;
  reportError(error: unknown): void;
}) {
  const pending = new Set<Request>();
  let running: Promise<void> | null = null;
  let disposed = false;
  const current = (request: Request) => {
    try { return request.isCurrent(); } catch { return false; }
  };
  const granted = (request: Request) => {
    try { return request.readGranted() === true; } catch { return false; }
  };
  const run = async () => {
    const previousGuide = await deps.whenIdle();
    if (disposed || deps.isQuitting()) return;
    const first = [...pending].find(current);
    if (!first) return;
    // Respect an explicit Later on the screen guide. A completed or failed
    // helper screen guide may still leave the host PiP TCC client unapproved.
    if (!granted(first) && (previousGuide?.permission !== 'screenRecording' || !previousGuide.dismissedByUser)) {
      await deps.guide(first.readGranted);
    }
    if (disposed || deps.isQuitting()) return;
    // A grant can become visible before a macOS restart is requested. Resume
    // the exact live binding only after the same host-process TCC check passes.
    for (const request of pending) if (current(request) && granted(request)) request.retryCapture();
  };
  return {
    request(request: Request) {
      if (disposed || deps.isQuitting() || !current(request)) return;
      pending.add(request);
      if (!running) running = run().catch(deps.reportError).finally(() => {
        pending.clear();
        running = null;
      });
    },
    dispose() { disposed = true; pending.clear(); },
  };
}
