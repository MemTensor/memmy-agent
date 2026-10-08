import { randomUUID } from 'node:crypto';
import { COMPUTER_USE_ONBOARDING_PREFIX as PREFIX, isComputerUseProbeTarget, type ComputerUseGuideReason, type ComputerUseProbeTarget, type ComputerUsePermissions } from '@memmy/local-api-contracts';

type ParentProcess = Pick<NodeJS.Process, 'send' | 'connected' | 'on' | 'removeListener' | 'ppid'>;
/** This bridge is private to the Electron parent. The model cannot select a probe app or settings URL. */
export class DesktopOnboardingClient {
  constructor(private readonly ipc: ParentProcess = process) {}
  private request(action: 'prepare' | 'guide', data: object, signal?: AbortSignal | null): Promise<any> {
    if (!this.ipc.connected || !this.ipc.send || signal?.aborted) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise(resolve => {
      const finish = (reply: any = null) => {
        clearTimeout(timer);
        this.ipc.removeListener('message', receive);
        this.ipc.removeListener('disconnect', cancel);
        signal?.removeEventListener('abort', cancel);
        resolve(reply);
      };
      const cancel = () => finish();
      const receive = (reply: any) => {
        if (reply?.type === `${PREFIX}${action}:result` && reply.requestId === requestId) finish(reply);
      };
      const timer = setTimeout(cancel, 2000);
      this.ipc.on('message', receive);
      this.ipc.on('disconnect', cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.ipc.send!({ type: `${PREFIX}${action}`, requestId, ...data }, error => { if (error) cancel(); }); }
      catch { cancel(); }
    });
  }
  async prepare(signal?: AbortSignal | null): Promise<ComputerUseProbeTarget | null> {
    const reply = await this.request('prepare', {}, signal);
    return isComputerUseProbeTarget(reply?.target) && reply.target.pid === this.ipc.ppid ? reply.target : null;
  }
  async guide(reason: ComputerUseGuideReason, helperApp: string, signal?: AbortSignal | null,
    check?: () => Promise<ComputerUsePermissions>, canContinue = false,
    observe?: (signal?: AbortSignal) => Promise<ComputerUsePermissions>): Promise<boolean> {
    if (!this.ipc.connected || !this.ipc.send || signal?.aborted || !check) return false;
    const requestId = randomUUID();
    return new Promise(resolve => {
      let finished = false;
      let checking: Promise<void> | null = null;
      let observing: Promise<void> | null = null;
      const observationAbort = new AbortController();
      const send = (data: object) => { try { this.ipc.send!(data, error => { if (error) cancel(); }); } catch { cancel(); } };
      const finish = (approved = false) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        observationAbort.abort();
        this.ipc.removeListener('message', receive);
        this.ipc.removeListener('disconnect', cancel);
        signal?.removeEventListener('abort', cancel);
        // Do not let a late doctor relaunch the app agent after guide cleanup.
        void Promise.allSettled([checking, observing]).then(() => resolve(approved && !signal?.aborted));
      };
      const cancel = () => {
        finish();
        if (this.ipc.connected) { try { this.ipc.send!({ type: `${PREFIX}cancel`, requestId }, () => undefined); } catch { /* Ignore cleanup send failures. */ } }
      };
      const receive = (reply: any) => {
        if (reply?.type === `${PREFIX}guide:result` && reply.requestId === requestId) finish(reply.approved === true);
        else if (!finished && reply?.guideId === requestId
          && (reply?.type === `${PREFIX}check` || reply?.type === `${PREFIX}observe`)
          && typeof reply.requestId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(reply.requestId)) {
          const passive = reply.type === `${PREFIX}observe`;
          if ((passive && (observing || !observe)) || (!passive && checking)) return;
          const pending = Promise.resolve(passive ? undefined : observing)
            .then(() => finished ? { accessibility: 'unknown', screenRecording: 'unknown', failure: 'unavailable' } as const
              : passive ? observe!(observationAbort.signal) : check())
            .catch(() => ({ accessibility: 'unknown', screenRecording: 'unknown', failure: 'unavailable' } as const))
            .then(status => { if (!finished) send({ type: `${reply.type}:result`, requestId: reply.requestId, guideId: requestId, status }); })
            .finally(() => { if (passive) observing = null; else checking = null; });
          if (passive) observing = pending; else checking = pending;
        }
      };
      const timer = setTimeout(cancel, 10 * 60_000);
      this.ipc.on('message', receive); this.ipc.on('disconnect', cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      send({ type: `${PREFIX}guide`, requestId, reason, helperApp, canContinue, canObserve: Boolean(observe) });
    });
  }
}
export const desktopOnboardingClient = new DesktopOnboardingClient();
