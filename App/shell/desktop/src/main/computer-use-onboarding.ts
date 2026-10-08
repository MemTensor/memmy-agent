import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { COMPUTER_USE_ONBOARDING_PREFIX as PREFIX, isComputerUseOnboardingRequest, isComputerUsePermissions,
  type ComputerUseGuideReason, type ComputerUseProbeTarget, type ComputerUsePermissions } from '@memmy/local-api-contracts';

export type MemmySystemPermission = 'accessibility' | 'screenRecording' | 'inputMonitoring';
export type PermissionPanelAction = MemmySystemPermission | 'recheck' | 'continue' | 'later' | 'copyPath' | 'returned';
export type MemmyPermissionStatus = ComputerUsePermissions & { inputMonitoring?: ComputerUsePermissions['accessibility'] };
export type PermissionPanelState = {
  permissions: MemmyPermissionStatus; requiredPermission: MemmySystemPermission;
  helperApp: string; busy: boolean; canContinue: boolean; showActions: boolean; message: string;
};
export type PermissionPanel = { update(state: PermissionPanelState): void; close(): void };
export type GuideControls = {
  check(): Promise<ComputerUsePermissions>;
  /** Reads TCC state only; must not capture a screen or restart the helper. */
  observe?(): Promise<ComputerUsePermissions>;
  signal: AbortSignal;
  canContinue: boolean;
};
export type ComputerUseOnboarding = {
  prepare(): ComputerUseProbeTarget | null;
  guide(reason: ComputerUseGuideReason | 'inputMonitoring', helperApp: string, controls: GuideControls): Promise<boolean>;
};
const unknown = (): ComputerUsePermissions => ({ accessibility: 'unknown', screenRecording: 'unknown', failure: 'unavailable' });
const permissionState = (status: MemmyPermissionStatus, required: MemmySystemPermission) =>
  required === 'inputMonitoring' ? status.inputMonitoring : status[required];
const ready = (status: MemmyPermissionStatus, required: MemmySystemPermission) =>
  !status.failure && permissionState(status, required) === 'granted';
const permissionFor = (reason: ComputerUseGuideReason | 'inputMonitoring'): MemmySystemPermission =>
  reason === 'accessibility' ? 'accessibility' : reason === 'inputMonitoring' ? 'inputMonitoring' : 'screenRecording';
const SETTINGS_PANE: Record<MemmySystemPermission, string> = {
  accessibility: 'Privacy_Accessibility',
  inputMonitoring: 'Privacy_ListenEvent',
  screenRecording: 'Privacy_ScreenCapture',
};

/** One host-owned panel for the permission this operation requires. */
export function createComputerUseOnboarding(deps: {
  target(): ComputerUseProbeTarget | null;
  showPanel(state: PermissionPanelState, act: (action: PermissionPanelAction) => void): PermissionPanel;
  openSettings(url: string): Promise<unknown>;
  copyPath(path: string): void;
  reportError(error: unknown): void;
}): ComputerUseOnboarding {
  let active = false;
  return {
    prepare: deps.target,
    async guide(reason, helperApp, controls) {
      if (active || controls.signal.aborted) return false;
      active = true;
      try {
        return await new Promise<boolean>(resolve => {
          let closed = false;
          let panel: PermissionPanel | undefined;
          let observationTimer: ReturnType<typeof setTimeout> | undefined;
          let autoVerified = false;
          const requiredPermission = permissionFor(reason);
          const state: PermissionPanelState = {
            helperApp, requiredPermission,
            busy: false, canContinue: controls.canContinue, showActions: false, message: '',
            permissions: {
              accessibility: requiredPermission === 'screenRecording' ? 'granted' : requiredPermission === 'accessibility' ? 'required' : 'unknown',
              screenRecording: 'unknown',
              inputMonitoring: requiredPermission === 'inputMonitoring' ? 'required' : 'unknown',
            },
          };
          const finish = (approved = false) => {
            if (closed) return;
            closed = true;
            if (observationTimer) clearTimeout(observationTimer);
            controls.signal.removeEventListener('abort', cancel);
            panel?.close(); resolve(approved);
          };
          const cancel = () => finish();
          const update = () => { if (!closed) panel?.update({ ...state, permissions: { ...state.permissions } }); };
          const observe = async () => {
            if (closed || controls.signal.aborted || !controls.observe) return;
            if (!state.busy) {
              try {
                const observed = await controls.observe();
                if (closed || controls.signal.aborted) return;
                // An unavailable status is not a revocation. Keep the manual
                // recheck path visible if the passive reader cannot answer.
                if (!state.busy && state.permissions.failure !== 'helperPauseFailed' && !observed.failure
                  && permissionState(observed, state.requiredPermission) !== 'unknown') {
                  const wasReady = ready(state.permissions, state.requiredPermission);
                  state.permissions = observed;
                  const nowReady = ready(observed, state.requiredPermission);
                  if (nowReady) {
                    state.showActions = true;
                    state.message = controls.canContinue
                      ? '权限已开启，点击“继续任务”完成验证。'
                      : '权限已开启，点击“完成”验证。';
                  } else if (wasReady) {
                    state.message = '权限已关闭，请在系统设置中重新开启。';
                  }
                  update();
                  // The drag card has no further step once the switch is on.
                  // Verify and dismiss it; merely returning from Settings still
                  // must not start this check.
                  if (nowReady && !wasReady && !autoVerified) {
                    autoVerified = true;
                    void check(true);
                  }
                }
              } catch { /* A passive observation must not interrupt setup. */ }
            }
            if (!closed) observationTimer = setTimeout(() => void observe(), 1800);
          };
          const check = async (continueAfter = false) => {
            if (closed || state.busy) return;
            state.busy = true; state.showActions = true; state.message = ''; update();
            try { state.permissions = await controls.check(); }
            catch { state.permissions = unknown(); }
            if (closed) return;
            state.busy = false;
            state.message = state.permissions.failure === 'helperPauseFailed'
              ? '辅助程序未能暂停，请稍后重试。'
              : state.permissions.failure ? '暂时无法检测，请返回此窗口后重试。'
              : ready(state.permissions, state.requiredPermission) ? (controls.canContinue ? '权限已就绪，可以继续任务。' : '权限已就绪。')
              : '开启权限后，点击“重新检测”。';
            update();
            if (continueAfter && ready(state.permissions, state.requiredPermission)) finish(true);
          };
          const act = (action: PermissionPanelAction) => {
            if (closed) return;
            if (action === 'later') { finish(); return; }
            if (state.busy) return;
            if (action === 'copyPath') {
              deps.copyPath(helperApp);
              state.showActions = true;
              state.message = '程序路径已复制，可在系统设置中点击“+”添加。';
              update();
              return;
            }
            // A screen-specific check may take a screenshot. Returning from
            // Settings must never trigger a check or another system prompt.
            if (action === 'returned') { state.showActions = true; update(); return; }
            if (action === 'recheck') { void check(); return; }
            if (action === 'continue') { if (ready(state.permissions, state.requiredPermission)) void check(true); return; }
            if (action !== state.requiredPermission || state.permissions.failure === 'helperPauseFailed') return;
            const pane = SETTINGS_PANE[action];
            // No helper is running here. Opening one link does not close the panel.
            void deps.openSettings(`x-apple.systempreferences:com.apple.preference.security?${pane}`).catch(error => {
              deps.reportError(error); state.showActions = true; state.message = '系统设置未能打开，请重试。'; update();
            });
          };
          controls.signal.addEventListener('abort', cancel, { once: true });
          try {
            panel = deps.showPanel(state, act);
            // The native reference places the drag card over the relevant
            // System Settings list. Open that pane for this explicit request.
            act(state.requiredPermission);
            if (controls.observe) observationTimer = setTimeout(() => void observe(), 1800);
          }
          catch (error) { deps.reportError(error); finish(); }
          if (controls.signal.aborted) finish();
        });
      } finally { active = false; }
    },
  };
}

/** Only the live owned gateway may show a panel or provide probe results. */
export function bindComputerUseOnboardingIpc(child: ChildProcess, live: () => boolean, handler?: ComputerUseOnboarding): () => void {
  const guides = new Map<string, AbortController>();
  const checks = new Map<string, { guideId: string; kind: 'check' | 'observe'; finish(status: ComputerUsePermissions): void }>();
  const send = (message: object) => { if (live() && child.connected) { try { child.send(message, () => undefined); } catch {} } };
  const check = (guideId: string, signal: AbortSignal, kind: 'check' | 'observe' = 'check') => new Promise<ComputerUsePermissions>(resolve => {
    if (!live() || signal.aborted) { resolve(unknown()); return; }
    const requestId = randomUUID();
    const finish = (status: ComputerUsePermissions) => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); checks.delete(requestId); resolve(status);
    };
    const cancel = () => finish(unknown());
    const timer = setTimeout(cancel, 45_000);
    checks.set(requestId, { guideId, kind, finish }); signal.addEventListener('abort', cancel, { once: true });
    send({ type: `${PREFIX}${kind}`, requestId, guideId });
  });
  const receive = (raw: any) => {
    if (!live() || !raw || typeof raw !== 'object') return;
    if (raw.type === `${PREFIX}check:result` || raw.type === `${PREFIX}observe:result`) {
      const pending = checks.get(raw.requestId);
      if (pending && pending.guideId === raw.guideId && raw.type === `${PREFIX}${pending.kind}:result`
        && isComputerUsePermissions(raw.status)) pending.finish(raw.status);
      return;
    }
    if (raw.type === `${PREFIX}cancel`) { guides.get(raw.requestId)?.abort(); return; }
    if (!isComputerUseOnboardingRequest(raw)) return;
    if (raw.type === `${PREFIX}prepare`) {
      let target: ComputerUseProbeTarget | null = null;
      try { target = handler?.prepare() ?? null; } catch {}
      send({ type: `${raw.type}:result`, requestId: raw.requestId, target });
      return;
    }
    if (!handler || guides.size) { send({ type: `${raw.type}:result`, requestId: raw.requestId, approved: false }); return; }
    const controller = new AbortController(); guides.set(raw.requestId, controller);
    Promise.resolve().then(() => handler.guide(raw.reason!, raw.helperApp!, {
      signal: controller.signal, canContinue: raw.canContinue === true,
      check: () => check(raw.requestId, controller.signal),
      ...(raw.canObserve ? { observe: () => check(raw.requestId, controller.signal, 'observe') } : {}),
    })).catch(() => false).then(approved => {
      controller.abort(); guides.delete(raw.requestId);
      send({ type: `${raw.type}:result`, requestId: raw.requestId, approved: approved === true });
    });
  };
  const dispose = () => {
    child.removeListener('message', receive); child.removeListener('close', dispose); child.removeListener('disconnect', dispose);
    for (const controller of guides.values()) controller.abort(); guides.clear();
    for (const pending of checks.values()) pending.finish(unknown()); checks.clear();
  };
  child.on('message', receive); child.once('close', dispose); child.once('disconnect', dispose);
  return dispose;
}
