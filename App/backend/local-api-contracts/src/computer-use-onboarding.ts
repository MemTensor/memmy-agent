export const COMPUTER_USE_ONBOARDING_PREFIX = 'memmy:computer-use-onboarding:';
export type ComputerUseGuideReason = 'accessibility' | 'screenCaptureUnavailable';
export type ComputerUseProbeTarget = { app: string; pid: number };
export type ComputerUsePermissionState = 'granted' | 'required' | 'unknown';
export type ComputerUsePermissions = {
  accessibility: ComputerUsePermissionState;
  screenRecording: ComputerUsePermissionState;
  failure?: 'unavailable' | 'helperPauseFailed';
};
export function isComputerUsePermissions(value: any): value is ComputerUsePermissions {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['accessibility', 'screenRecording', 'failure'].includes(key))
    && ['granted', 'required', 'unknown'].includes(value.accessibility)
    && ['granted', 'required', 'unknown'].includes(value.screenRecording)
    && (value.failure === undefined || ['unavailable', 'helperPauseFailed'].includes(value.failure));
}
export type ComputerUseOnboardingRequest = {
  type: 'memmy:computer-use-onboarding:prepare' | 'memmy:computer-use-onboarding:guide';
  requestId: string;
  reason?: ComputerUseGuideReason;
  helperApp?: string;
  canContinue?: boolean;
};
export function isComputerUseGuideReason(value: unknown): value is ComputerUseGuideReason {
  return value === 'accessibility' || value === 'screenCaptureUnavailable';
}
export function isComputerUseOnboardingRequest(value: any): value is ComputerUseOnboardingRequest {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.requestId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value.requestId)
    && Object.keys(value).every(key => ['type', 'requestId', 'reason', 'helperApp', 'canContinue'].includes(key))
    && ((value.type === `${COMPUTER_USE_ONBOARDING_PREFIX}prepare` && value.reason === undefined && value.helperApp === undefined && value.canContinue === undefined)
      || (value.type === `${COMPUTER_USE_ONBOARDING_PREFIX}guide` && isComputerUseGuideReason(value.reason)
        && (value.canContinue === undefined || typeof value.canContinue === 'boolean')
        && typeof value.helperApp === 'string' && value.helperApp.startsWith('/') && value.helperApp.endsWith('/Open Computer Use.app')
        && value.helperApp.length <= 4096 && !/[\r\n\0]/.test(value.helperApp)));
}
export function isComputerUseProbeTarget(value: any): value is ComputerUseProbeTarget {
  return !!value && typeof value === 'object' && typeof value.app === 'string'
    && /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(value.app) && value.app.length <= 200
    && Number.isSafeInteger(value.pid) && value.pid > 0;
}
