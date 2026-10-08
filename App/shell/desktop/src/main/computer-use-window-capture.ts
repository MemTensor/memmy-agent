import { desktopCapturer, type DesktopCapturerSource } from 'electron';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { selectComputerUseWindowSource } from './computer-use-video-source.js';

type Source = Pick<DesktopCapturerSource, 'id' | 'name' | 'thumbnail'>;
const execFileAsync = promisify(execFile);

/** Map Electron window source handles to owning PIDs, only when running on Windows. */
export async function windowsSourceOwners(sources: ReadonlyArray<Pick<Source, 'id'>>): Promise<Map<string, number>> {
  if (process.platform !== 'win32') return new Map();
  const handles = sources.slice(0, 256).map(source => /^window:(\d+)(?::|$)/.exec(source.id)?.[1]).filter((id): id is string => Boolean(id));
  if (!handles.length) return new Map();
  const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MemmyWindowPid { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId); }'
$ids = @(${handles.join(',')})
$rows = foreach ($handle in $ids) { $windowPid = [uint32]0; [void][MemmyWindowPid]::GetWindowThreadProcessId([IntPtr]::new([long]$handle), [ref]$windowPid); [pscustomobject]@{ handle = [string]$handle; processId = [int]$windowPid } }
ConvertTo-Json -InputObject @($rows) -Compress`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeout: 3000, maxBuffer: 64_000, windowsHide: true });
    const rows: unknown = JSON.parse(stdout.trim());
    if (!Array.isArray(rows)) return new Map();
    const byHandle = new Map(rows.filter((row: any) => row && typeof row.handle === 'string'
      && Number.isSafeInteger(row.processId) && row.processId > 0)
      .map((row: any) => [row.handle, row.processId] as [string, number]));
    return new Map(sources.flatMap(source => {
      const handle = /^window:(\d+)(?::|$)/.exec(source.id)?.[1];
      const pid = handle ? byHandle.get(handle) : undefined;
      return pid ? [[source.id, pid] as [string, number]] : [];
    }));
  } catch { return new Map(); }
}

/** Capture the window itself: the Windows native helper's CopyFromScreen frame can contain an occluding app. */
export async function captureComputerUseWindow(target: string, width: number, height: number,
  options: { pid?: number; getSources?: typeof desktopCapturer.getSources;
    owners?: (sources: ReadonlyArray<Pick<Source, 'id'>>) => Promise<Map<string, number>> } = {}): Promise<string | null> {
  if (!target || target.length > 256 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 1 || height < 1 || width > 4096 || height > 4096) return null;
  const sources: Source[] = await (options.getSources ?? (input => desktopCapturer.getSources(input)))({ types: ['window'], thumbnailSize: { width, height }, fetchWindowIcons: false });
  // Titles such as "Untitled - Notepad" can occur in multiple processes.
  // A wrong window is worse than an unavailable frame.
  const owners = Number.isSafeInteger(options.pid) && options.pid! > 0
    ? await (options.owners ?? windowsSourceOwners)(sources) : new Map<string, number>();
  let matches = owners.size ? sources.filter(source => owners.get(source.id) === options.pid) : [];
  if (matches.length > 1) matches = matches.filter(source => selectComputerUseWindowSource([source], target, []) !== null);
  if (!matches.length && !owners.size) matches = sources.filter(source => selectComputerUseWindowSource([source], target, []) !== null);
  if (matches.length !== 1) return null;
  const frame = matches[0]!.thumbnail;
  if (frame.isEmpty()) return null;
  const png = frame.resize({ width, height, quality: 'best' }).toPNG();
  if (png.length < 33 || png.length > 6_000_000
      || png.toString('hex', 0, 8) !== '89504e470d0a1a0a'
      || png.toString('ascii', 12, 16) !== 'IHDR'
      || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) return null;
  return png.toString('base64');
}

/** Only requests from the currently owned Agent child can ask Electron to capture a window. */
export function bindComputerUseWindowCaptureIpc(child: ChildProcess, live: () => boolean,
  capture?: (target: string, width: number, height: number, options: { pid?: number }) => Promise<string | null>): () => void {
  const receive = (raw: any) => {
    if (!live() || raw?.type !== 'memmy:computer-use-window-capture:request') return;
    if (typeof raw.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.requestId)
        || typeof raw.target !== 'string' || raw.target.length < 1 || raw.target.length > 256
        || !Number.isSafeInteger(raw.width) || !Number.isSafeInteger(raw.height)
        || raw.width < 1 || raw.height < 1 || raw.width > 4096 || raw.height > 4096
        || (raw.pid !== undefined && (!Number.isSafeInteger(raw.pid) || raw.pid < 1))) return;
    void Promise.resolve().then(() => capture?.(raw.target, raw.width, raw.height, { pid: raw.pid }))
      .catch(() => null).then(pngBase64 => {
        if (!live() || !child.connected) return;
        try { child.send({ type: 'memmy:computer-use-window-capture:response',
          requestId: raw.requestId, pngBase64: pngBase64 ?? null }, () => undefined); } catch { /* Child exited. */ }
      });
  };
  const dispose = () => {
    child.removeListener('message', receive);
    child.removeListener('close', dispose);
    child.removeListener('disconnect', dispose);
  };
  child.on('message', receive);
  child.once('close', dispose);
  child.once('disconnect', dispose);
  return dispose;
}
