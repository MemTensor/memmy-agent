import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { COMPUTER_USE_ONBOARDING_PREFIX as PREFIX, isComputerUseOnboardingRequest, isComputerUsePermissions,
  type ComputerUseGuideReason, type ComputerUseProbeTarget, type ComputerUsePermissions } from '@memmy/local-api-contracts';

export type PermissionPanelAction = 'accessibility' | 'screenRecording' | 'recheck' | 'continue' | 'later' | 'copyPath' | 'returned';
export type PermissionPanelState = {
  permissions: ComputerUsePermissions; helperApp: string; busy: boolean; canContinue: boolean; message: string;
};
export type PermissionPanel = { update(state: PermissionPanelState): void; close(): void };
export type GuideControls = { check(): Promise<ComputerUsePermissions>; signal: AbortSignal; canContinue: boolean };
export type ComputerUseOnboarding = {
  prepare(): ComputerUseProbeTarget | null;
  guide(reason: ComputerUseGuideReason, helperApp: string, controls: GuideControls): Promise<boolean>;
};
const unknown = (): ComputerUsePermissions => ({ accessibility: 'unknown', screenRecording: 'unknown', failure: 'unavailable' });
const ready = (status: ComputerUsePermissions) => !status.failure && status.accessibility === 'granted' && status.screenRecording === 'granted';

/** One host-owned panel, both permission links, and explicit task continuation. */
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
          const state: PermissionPanelState = {
            helperApp, busy: false, canContinue: controls.canContinue, message: '',
            permissions: reason === 'accessibility'
              ? { accessibility: 'required', screenRecording: 'unknown' }
              : { accessibility: 'granted', screenRecording: 'unknown' },
          };
          const finish = (approved = false) => {
            if (closed) return;
            closed = true;
            controls.signal.removeEventListener('abort', cancel);
            panel?.close(); resolve(approved);
          };
          const cancel = () => finish();
          const update = () => { if (!closed) panel?.update({ ...state, permissions: { ...state.permissions } }); };
          const check = async (continueAfter = false) => {
            if (closed || state.busy) return;
            state.busy = true; state.message = ''; update();
            try { state.permissions = await controls.check(); }
            catch { state.permissions = unknown(); }
            if (closed) return;
            state.busy = false;
            state.message = state.permissions.failure === 'helperPauseFailed'
              ? '辅助程序未能暂停，请稍后重试。'
              : state.permissions.failure ? '暂时无法检测，请返回此窗口后重试。'
              : ready(state.permissions) ? (controls.canContinue ? '权限已就绪，可以继续任务。' : '权限已就绪。')
              : '开启权限后，点击“重新检测”。';
            update();
            if (continueAfter && ready(state.permissions)) finish(true);
          };
          const act = (action: PermissionPanelAction) => {
            if (closed) return;
            if (action === 'later') { finish(); return; }
            if (state.busy) return;
            if (action === 'copyPath') { deps.copyPath(helperApp); return; }
            // Memmy's probe of the native helper takes a screenshot. That can
            // request access, so focus changes must never
            // trigger it: returning from a system prompt otherwise opens another.
            if (action === 'returned') return;
            if (action === 'recheck') { void check(); return; }
            if (action === 'continue') { if (ready(state.permissions)) void check(true); return; }
            if (!['accessibility', 'screenRecording'].includes(action) || state.permissions.failure === 'helperPauseFailed') return;
            const pane = action === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture';
            // No helper is running here. Opening one link does not close the panel.
            void deps.openSettings(`x-apple.systempreferences:com.apple.preference.security?${pane}`).catch(error => {
              deps.reportError(error); state.message = '系统设置未能打开，请重试。'; update();
            });
          };
          controls.signal.addEventListener('abort', cancel, { once: true });
          try { panel = deps.showPanel(state, act); }
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
  const checks = new Map<string, { guideId: string; finish(status: ComputerUsePermissions): void }>();
  const send = (message: object) => { if (live() && child.connected) { try { child.send(message, () => undefined); } catch {} } };
  const check = (guideId: string, signal: AbortSignal) => new Promise<ComputerUsePermissions>(resolve => {
    if (!live() || signal.aborted) { resolve(unknown()); return; }
    const requestId = randomUUID();
    const finish = (status: ComputerUsePermissions) => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel); checks.delete(requestId); resolve(status);
    };
    const cancel = () => finish(unknown());
    const timer = setTimeout(cancel, 45_000);
    checks.set(requestId, { guideId, finish }); signal.addEventListener('abort', cancel, { once: true });
    send({ type: `${PREFIX}check`, requestId, guideId });
  });
  const receive = (raw: any) => {
    if (!live() || !raw || typeof raw !== 'object') return;
    if (raw.type === `${PREFIX}check:result`) {
      const pending = checks.get(raw.requestId);
      if (pending && pending.guideId === raw.guideId && isComputerUsePermissions(raw.status)) pending.finish(raw.status);
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
