import { spawn, type ChildProcess } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';

export type WindowFrame = { x: number; y: number; width: number; height: number };

/** The child gateway can supply a drag path, but cannot choose an executable. */
export function trustedComputerUseWindowWatcher(helperApp: string, packaged: boolean,
  resourcesPath: string, developmentBinary?: string): string | null {
  const binary = packaged
    ? join(resourcesPath, 'app.asar.unpacked/dist/runtime/memmy-agent/dist/native-computer-use/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse')
    // Dev-start normally supplies the installed helper through the env var,
    // but a source/dev run may only have the owned app path from the managed
    // MCP command.  Derive the binary inside that same, known bundle so the
    // Settings follower is not silently disabled in that mode.
    : developmentBinary ?? (['Memmy Computer Use.app', 'Memmy Computer Use (Dev).app'].includes(basename(helperApp))
      ? join(helperApp, 'Contents/MacOS/MemmyComputerUse') : null);
  if (!binary || !binary.startsWith('/') || resolve(dirname(dirname(dirname(binary)))) !== resolve(helperApp)) return null;
  return binary;
}

export function parseSystemSettingsWindowFrame(line: string): WindowFrame | null {
  if (line === 'null') return null;
  try {
    const frame = JSON.parse(line);
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)
      || Object.keys(frame).sort().join(',') !== 'height,width,x,y') return null;
    if (!['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(frame[key]) && Math.abs(frame[key]) < 100_000)
      || frame.width < 500 || frame.height < 400) return null;
    return frame as WindowFrame;
  } catch { return null; }
}

/** A single short-lived native process streams bounds as System Settings moves. */
export function watchSystemSettingsWindow(binary: string, onFrame: (frame: WindowFrame | null) => void,
  start: typeof spawn = spawn): () => void {
  let child: ChildProcess;
  try { child = start(binary, ['settings-window', '--watch'], { stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return () => undefined; }
  if (!child.stdout) { child.kill('SIGTERM'); return () => undefined; }
  const output = child.stdout;
  let pending = '', closed = false;
  const data = (chunk: Buffer) => {
    if (closed) return;
    pending += chunk.toString('utf8');
    if (pending.length > 4096) { pending = ''; return; }
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
      if (line === 'null' || line.startsWith('{')) onFrame(parseSystemSettingsWindowFrame(line));
    }
  };
  output.on('data', data);
  child.on('error', () => undefined);
  return () => {
    if (closed) return;
    closed = true;
    output.removeListener('data', data);
    child.kill('SIGTERM');
  };
}

export function permissionPanelBounds(settings: WindowFrame, workArea: WindowFrame): WindowFrame {
  const width = 545, height = 114;
  const x = Math.max(workArea.x + 6,
    Math.min(settings.x + settings.width - width - 6, workArea.x + workArea.width - width - 6));
  const y = Math.max(workArea.y + 6,
    Math.min(settings.y + settings.height - height - 7, workArea.y + workArea.height - height - 6));
  return { x, y, width, height };
}
