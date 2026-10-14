import { describe, expect, it, vi } from 'vitest';
import { createComputerUseOnboarding, type PermissionPanelAction } from '../src/main/computer-use-onboarding.js';
import { createComputerUsePIPScreenPermissionGuide } from '../src/main/computer-use-pip-screen-permission.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

const drain = () => new Promise<void>(resolve => setImmediate(resolve));

function request(readGranted: () => boolean) {
  let live = true;
  const retryCapture = vi.fn();
  return {
    value: { isCurrent: () => live, readGranted, retryCapture },
    retryCapture,
    retire: () => { live = false; },
  };
}

describe('native PiP host screen permission queue', () => {
  it('waits for an active Accessibility guide before starting the screen guide and retries only after host permission is granted', async () => {
    let act!: (action: PermissionPanelAction) => void;
    const onboarding = createComputerUseOnboarding({
      target: () => null,
      showPanel: (_state, next) => { act = next; return { update: vi.fn(), close: vi.fn() }; },
      openSettings: vi.fn().mockResolvedValue(undefined),
      copyPath: vi.fn(), reportError: vi.fn(),
    });
    const accessibility = onboarding.guide('accessibility', '/Applications/Memmy Computer Use.app', {
      check: vi.fn().mockResolvedValue({ accessibility: 'required', screenRecording: 'required' }),
      signal: new AbortController().signal, canContinue: false,
    });
    let hostGranted = false;
    const screenGuide = vi.fn(async (readGranted: () => boolean) => {
      expect(readGranted()).toBe(false);
      hostGranted = true;
      return true;
    });
    const permission = createComputerUsePIPScreenPermissionGuide({
      whenIdle: () => onboarding.whenIdle(), guide: screenGuide,
      isQuitting: () => false, reportError: vi.fn(),
    });
    const pending = request(() => hostGranted);
    permission.request(pending.value);
    await Promise.resolve();
    expect(screenGuide).not.toHaveBeenCalled();
    expect(pending.retryCapture).not.toHaveBeenCalled();

    act('later');
    expect(await accessibility).toBe(false);
    await vi.waitFor(() => expect(pending.retryCapture).toHaveBeenCalledOnce());
    expect(screenGuide).toHaveBeenCalledOnce();
    permission.dispose();
  });

  it('drops a target that becomes stale while Accessibility is still active', async () => {
    const idle = deferred<{ permission: 'accessibility'; approved: boolean; dismissedByUser: boolean } | null>();
    const guide = vi.fn().mockResolvedValue(true);
    const permission = createComputerUsePIPScreenPermissionGuide({
      whenIdle: () => idle.promise, guide, isQuitting: () => false, reportError: vi.fn(),
    });
    const old = request(() => false);
    permission.request(old.value);
    old.retire();
    idle.resolve({ permission: 'accessibility', approved: false, dismissedByUser: true });
    await drain();
    expect(guide).not.toHaveBeenCalled();
    expect(old.retryCapture).not.toHaveBeenCalled();
    permission.dispose();
  });

  it('never retries a stale binding or a binding whose host grant is still missing after the guide', async () => {
    const finishGuide = deferred<boolean>();
    let hostGranted = false;
    const guide = vi.fn(() => finishGuide.promise);
    const permission = createComputerUsePIPScreenPermissionGuide({
      whenIdle: async () => null, guide, isQuitting: () => false, reportError: vi.fn(),
    });
    const old = request(() => hostGranted);
    const stillDenied = request(() => false);
    permission.request(old.value);
    permission.request(stillDenied.value);
    await vi.waitFor(() => expect(guide).toHaveBeenCalledOnce());
    old.retire();
    hostGranted = true;
    finishGuide.resolve(true);
    await drain();
    expect(old.retryCapture).not.toHaveBeenCalled();
    expect(stillDenied.retryCapture).not.toHaveBeenCalled();
    permission.dispose();
  });

  it('retries the exact replacement binding when the original target changes during the guide', async () => {
    const finishGuide = deferred<boolean>();
    let hostGranted = false;
    const guide = vi.fn(() => finishGuide.promise);
    const permission = createComputerUsePIPScreenPermissionGuide({
      whenIdle: async () => null, guide, isQuitting: () => false, reportError: vi.fn(),
    });
    const old = request(() => hostGranted);
    const replacement = request(() => hostGranted);
    permission.request(old.value);
    await vi.waitFor(() => expect(guide).toHaveBeenCalledOnce());
    old.retire();
    permission.request(replacement.value);
    hostGranted = true;
    finishGuide.resolve(true);
    await vi.waitFor(() => expect(replacement.retryCapture).toHaveBeenCalledOnce());
    expect(old.retryCapture).not.toHaveBeenCalled();
    expect(guide).toHaveBeenCalledOnce();
    permission.dispose();
  });

  it('retries each exact live binding once after a grant without opening duplicate guides', async () => {
    const finishGuide = deferred<boolean>();
    let hostGranted = false;
    const guide = vi.fn(() => finishGuide.promise);
    const permission = createComputerUsePIPScreenPermissionGuide({
      whenIdle: async () => null, guide, isQuitting: () => false, reportError: vi.fn(),
    });
    const first = request(() => hostGranted);
    const second = request(() => hostGranted);
    permission.request(first.value);
    permission.request(first.value);
    permission.request(second.value);
    await vi.waitFor(() => expect(guide).toHaveBeenCalledOnce());
    hostGranted = true;
    finishGuide.resolve(true);
    await vi.waitFor(() => expect(first.retryCapture).toHaveBeenCalledOnce());
    expect(second.retryCapture).toHaveBeenCalledOnce();
    permission.dispose();
  });

  it('respects Later on an existing screen guide instead of immediately opening another guide', async () => {
    const guide = vi.fn().mockResolvedValue(true);
    const permission = createComputerUsePIPScreenPermissionGuide({
      whenIdle: async () => ({ permission: 'screenRecording', approved: false, dismissedByUser: true }), guide,
      isQuitting: () => false, reportError: vi.fn(),
    });
    const denied = request(() => false);
    permission.request(denied.value);
    await drain();
    expect(guide).not.toHaveBeenCalled();
    expect(denied.retryCapture).not.toHaveBeenCalled();
    permission.dispose();
  });

  it('opens the host guide after an earlier screen guide times out or fails without a user dismissal', async () => {
    let hostGranted = false;
    const guide = vi.fn(async () => { hostGranted = true; return true; });
    const permission = createComputerUsePIPScreenPermissionGuide({
      whenIdle: async () => ({ permission: 'screenRecording', approved: false, dismissedByUser: false }), guide,
      isQuitting: () => false, reportError: vi.fn(),
    });
    const pending = request(() => hostGranted);
    permission.request(pending.value);
    await vi.waitFor(() => expect(pending.retryCapture).toHaveBeenCalledOnce());
    expect(guide).toHaveBeenCalledOnce();
    permission.dispose();
  });

  it('distinguishes an aborted screen guide from the user choosing Later', async () => {
    const abort = new AbortController();
    const onboarding = createComputerUseOnboarding({
      target: () => null,
      showPanel: () => ({ update: vi.fn(), close: vi.fn() }),
      openSettings: vi.fn().mockResolvedValue(undefined),
      copyPath: vi.fn(), reportError: vi.fn(),
    });
    const firstGuide = onboarding.guide('screenCaptureUnavailable', '/Applications/Memmy Computer Use.app', {
      check: vi.fn().mockResolvedValue({ accessibility: 'granted', screenRecording: 'required' }),
      signal: abort.signal, canContinue: false,
    });
    const completed = onboarding.whenIdle();
    let hostGranted = false;
    const hostGuide = vi.fn(async () => { hostGranted = true; return true; });
    const permission = createComputerUsePIPScreenPermissionGuide({
      whenIdle: () => onboarding.whenIdle(), guide: hostGuide,
      isQuitting: () => false, reportError: vi.fn(),
    });
    const pending = request(() => hostGranted);
    permission.request(pending.value);
    abort.abort();
    expect(await firstGuide).toBe(false);
    expect(await completed).toEqual({ permission: 'screenRecording', approved: false, dismissedByUser: false });
    await vi.waitFor(() => expect(pending.retryCapture).toHaveBeenCalledOnce());
    expect(hostGuide).toHaveBeenCalledOnce();
    permission.dispose();
  });

  it('asks for the host permission after an approved helper screen guide if the host still lacks its own grant', async () => {
    let hostGranted = false;
    const guide = vi.fn(async () => { hostGranted = true; return true; });
    const permission = createComputerUsePIPScreenPermissionGuide({
      whenIdle: async () => ({ permission: 'screenRecording', approved: true, dismissedByUser: false }), guide,
      isQuitting: () => false, reportError: vi.fn(),
    });
    const pending = request(() => hostGranted);
    permission.request(pending.value);
    await vi.waitFor(() => expect(pending.retryCapture).toHaveBeenCalledOnce());
    expect(guide).toHaveBeenCalledOnce();
    permission.dispose();
  });

  it('drops queued and in-flight work during quit or disposal', async () => {
    const idle = deferred<{ permission: 'accessibility'; approved: boolean; dismissedByUser: boolean } | null>();
    const guide = vi.fn().mockResolvedValue(true);
    let quitting = false;
    const permission = createComputerUsePIPScreenPermissionGuide({
      whenIdle: () => idle.promise, guide, isQuitting: () => quitting, reportError: vi.fn(),
    });
    const queued = request(() => true);
    permission.request(queued.value);
    quitting = true;
    idle.resolve({ permission: 'accessibility', approved: false, dismissedByUser: false });
    await drain();
    expect(guide).not.toHaveBeenCalled();
    expect(queued.retryCapture).not.toHaveBeenCalled();
    permission.dispose();

    const finishGuide = deferred<boolean>();
    const inFlightGuide = vi.fn(() => finishGuide.promise);
    const inFlight = createComputerUsePIPScreenPermissionGuide({
      whenIdle: async () => null, guide: inFlightGuide,
      isQuitting: () => false, reportError: vi.fn(),
    });
    const pending = request(() => true);
    // Readiness can change between the initial decision and guide completion.
    let reads = 0;
    pending.value.readGranted = () => ++reads > 1;
    inFlight.request(pending.value);
    await vi.waitFor(() => expect(inFlightGuide).toHaveBeenCalledOnce());
    inFlight.dispose();
    finishGuide.resolve(true);
    await drain();
    expect(pending.retryCapture).not.toHaveBeenCalled();
  });
});
