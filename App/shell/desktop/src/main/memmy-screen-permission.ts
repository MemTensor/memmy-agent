import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { ComputerUsePermissions } from '@memmy/local-api-contracts';
import type { HelperScreenShot } from './desktop-screen-capture.js';

const execFileAsync = promisify(execFile);
const packagedBinary = (resourcesPath: string) => join(
  resourcesPath,
  'app.asar.unpacked/dist/runtime/memmy-agent/dist/native-computer-use/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse',
);

/** The helper executable whose permission covers both seeing the screen and operating apps. */
export async function resolveComputerUseBinary(packaged: boolean, resourcesPath: string, developmentBinary?: string): Promise<string | null> {
  const candidate = packaged ? packagedBinary(resourcesPath) : developmentBinary;
  if (!candidate || !isAbsolute(candidate) || basename(candidate) !== 'MemmyComputerUse') return null;
  try {
    await access(candidate, constants.X_OK);
    return await realpath(candidate);
  } catch { return null; }
}

export function computerUseApp(binary: string): string | null {
  const app = dirname(dirname(dirname(binary)));
  return ['Memmy Computer Use.app', 'Memmy Computer Use (Dev).app'].includes(basename(app)) ? app : null;
}

/** Keep every desktop invocation on the same app-scoped native agent socket. */
export function computerUseAgentEnvironment(binary: string): NodeJS.ProcessEnv {
  const app = computerUseApp(binary);
  return app
    ? { ...process.env, OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: `memmy:${app}` }
    : process.env;
}

export function memmyPermissionSnapshot(stdout: string): ComputerUsePermissions & { inputMonitoring: 'granted' | 'required' | 'unknown' } {
  const line = stdout.trim().split('\n').find(item => item.startsWith('{'));
  const flag = (value: unknown) => value === true ? 'granted' as const : value === false ? 'required' as const : 'unknown' as const;
  try {
    const value = line ? JSON.parse(line) as { accessibility?: unknown; inputMonitoring?: unknown; screenRecording?: unknown } : null;
    if (!value || typeof value !== 'object') throw new Error('missing');
    return {
      accessibility: flag(value.accessibility),
      screenRecording: flag(value.screenRecording),
      inputMonitoring: flag(value.inputMonitoring),
    };
  } catch {
    return { accessibility: 'unknown', screenRecording: 'unknown', inputMonitoring: 'unknown', failure: 'unavailable' };
  }
}

export function permissionsFromDoctor(stdout: string): ComputerUsePermissions {
  const match = stdout.match(/accessibility=(granted|missing), screenRecording=(granted|missing)/);
  if (!match) return { accessibility: 'unknown', screenRecording: 'unknown', failure: 'unavailable' };
  return {
    accessibility: match[1] === 'granted' ? 'granted' : 'required',
    screenRecording: match[2] === 'granted' ? 'granted' : 'required',
  };
}

export function parseHelperScreenCapture(stdout: string): HelperScreenShot | null {
  const line = stdout.trim().split('\n').find(item => item.startsWith('{'));
  if (!line) return null;
  try {
    const value = JSON.parse(line) as { ok?: boolean; code?: string; pngBase64?: string; width?: number; height?: number; displayId?: string };
    if (value.ok === true && typeof value.pngBase64 === 'string' && typeof value.displayId === 'string'
      && Number.isInteger(value.width) && Number.isInteger(value.height)) {
      return { ok: true, png: Buffer.from(value.pngBase64, 'base64'), width: value.width!, height: value.height!, displayId: value.displayId };
    }
    if (value.ok === false && (value.code === 'permission_required' || value.code === 'capture_failed')) return { ok: false, code: value.code };
    return null;
  } catch { return null; }
}

export async function runHelperCommand(binary: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(binary, args, {
      timeout: 12_000, maxBuffer: 4 * 1024 * 1024, signal, windowsHide: true,
      env: computerUseAgentEnvironment(binary),
    });
    return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
  } catch (error) {
    const failed = error as { stdout?: string | Buffer; stderr?: string | Buffer };
    const text = (value: string | Buffer | undefined) => typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '';
    return { stdout: text(failed.stdout), stderr: text(failed.stderr) };
  }
}

/** A fresh helper process picks up a permission granted while an older helper was running. */
export async function captureMemmyScreen(binary: string | null, displayId: string | undefined, signal: AbortSignal | undefined, deps: {
  run(binary: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }>;
  stopAgent(): Promise<void>;
}): Promise<HelperScreenShot> {
  if (!binary) return { ok: false, code: 'unavailable' };
  const args = displayId ? ['capture-screen', '--display', displayId] : ['capture-screen'];
  const once = async () => {
    const result = await deps.run(binary, args, signal);
    return parseHelperScreenCapture(result.stdout) ?? (result.stderr.includes('Unknown command')
      ? { ok: false as const, code: 'unavailable' as const }
      : { ok: false as const, code: 'capture_failed' as const });
  };
  let shot = await once();
  if (!shot.ok && shot.code === 'permission_required') {
    await deps.stopAgent();
    shot = await once();
  }
  return shot;
}
