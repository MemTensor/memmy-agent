import type { ComputerUseProbeTarget, ComputerUsePermissions } from '@memmy/local-api-contracts';
import type { PermissionPreflight } from './mac-permission-preflight.js';
import { MEMMY_COMPUTER_USE_MCP_SERVER } from '../../config/computer-use-server.js';
import { computerUsePermissionError } from './mac-permission-settings.js';
import { desktopOnboardingClient, type DesktopOnboardingClient } from './desktop-onboarding-client.js';

export function permissionFromSelfProbe(result: any, target: ComputerUseProbeTarget, requireScreenshot = false): PermissionPreflight {
  // Only the native error channel can establish a denied permission. Page text cannot.
  const permission = computerUsePermissionError(MEMMY_COMPUTER_USE_MCP_SERVER, result);
  if (permission) {
    return { state: 'missing', permission };
  }
  if (result?.isError || !Array.isArray(result?.content)) return { state: 'unknown', reason: 'probeFailed' };
  const ownApp = `App=${target.app} (pid ${target.pid})`;
  const ownWindow = result.content.find((block: any) => block?.type === 'text')?.text?.split('\n')[0] === ownApp;
  if (!ownWindow) return { state: 'unknown', reason: 'probeFailed' };
  const image = result.content.some((block: any) => {
    if (block?.type !== 'image' || block.mimeType !== 'image/png' || typeof block.data !== 'string' || block.data.length < 44) return false;
    const header = Buffer.from(block.data.slice(0, 44), 'base64');
    return header.length >= 33 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      && header.toString('ascii', 12, 16) === 'IHDR' && header.readUInt32BE(16) > 0 && header.readUInt32BE(20) > 0;
  });
  // The AX tree is usable without an image. Only a screenshot-specific recheck
  // requires the PNG; absence alone does not prove a denied TCC switch.
  return image || !requireScreenshot ? { state: 'granted' } : { state: 'unknown', reason: 'screenCaptureUnavailable' };
}

export async function probeNativePermissions(session: any, signal?: AbortSignal | null,
  desktop: Pick<DesktopOnboardingClient, 'prepare'> = desktopOnboardingClient, requireScreenshot = false): Promise<PermissionPreflight> {
  const target = await desktop.prepare(signal);
  if (!target || signal?.aborted) return { state: 'unknown', reason: 'desktopUnavailable' };
  // The parent supplies its identity only while its window is visible and focused.
  // Never send the user's target app, click, type, or doctor from this check.
  const result = await session.callTool('get_app_state', {
    app: target.app, max_tree_nodes: 1, max_tree_depth: 1,
    ...(requireScreenshot ? { require_screenshot: true } : {}),
  }, 12);
  if (signal?.aborted) return { state: 'unknown', reason: 'desktopUnavailable' };
  return permissionFromSelfProbe(result, target, requireScreenshot);
}

export function permissionSnapshot(status: PermissionPreflight, required: 'accessibility' | 'screenRecording' = 'accessibility'): ComputerUsePermissions {
  if (status.state === 'granted') return {
    accessibility: 'granted', screenRecording: required === 'screenRecording' ? 'granted' : 'unknown',
  };
  if (status.state === 'missing' && status.permission === 'accessibility') return { accessibility: 'required', screenRecording: 'unknown' };
  if (status.state === 'missing' && status.permission === 'screenRecording') return { accessibility: 'granted', screenRecording: 'required' };
  if (status.state === 'unknown' && status.reason === 'screenCaptureUnavailable') return { accessibility: 'granted', screenRecording: 'unknown' };
  return { accessibility: 'unknown', screenRecording: 'unknown', failure: status.state === 'unknown' && status.reason === 'helperPauseFailed' ? 'helperPauseFailed' : 'unavailable' };
}

export async function guideNativePermissions(status: PermissionPreflight, helperApp: string, signal?: AbortSignal | null,
  check?: () => Promise<PermissionPreflight>, canContinue = false,
  observe?: (signal?: AbortSignal) => Promise<PermissionPreflight>): Promise<boolean> {
  if (signal?.aborted || !check) return false;
  const reason = status.state === 'missing' && status.permission === 'accessibility' ? 'accessibility' : 'screenCaptureUnavailable';
  return desktopOnboardingClient.guide(reason, helperApp, signal,
    async () => permissionSnapshot(await check(), reason === 'accessibility' ? 'accessibility' : 'screenRecording'),
    canContinue, observe && (async observerSignal => permissionSnapshot(await observe(observerSignal),
      reason === 'accessibility' ? 'accessibility' : 'screenRecording')));
}
