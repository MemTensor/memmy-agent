import { desktopCapturer, type DesktopCapturerSource } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';

type Source = Pick<DesktopCapturerSource, 'id' | 'name' | 'thumbnail'>;
// A maximized window is wider than its monitor by the resize border.
const MAX_CAPTURE_DIMENSION = 8192;
// The first reply includes PowerShell startup and compilation, which take
// seconds on slow or emulated Windows; later replies take milliseconds.
const OWNER_REPLY_TIMEOUT_MS = 15_000;
const OWNER_HOST_IDLE_MS = 30_000;
const OWNER_HOST_SCRIPT = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MemmyWindowPid { [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId); }'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { $rows = @(foreach ($handle in $line.Split(',')) { $windowPid = [uint32]0; [void][MemmyWindowPid]::GetWindowThreadProcessId([IntPtr]::new([long]$handle), [ref]$windowPid); [pscustomobject]@{ handle = [string]$handle; processId = [int]$windowPid } }) }
  catch { $rows = @() }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $rows -Compress))
}`;

type OwnerHost = { child: ChildProcess; buffer: string; reply: ((line: string | null) => void) | null;
  idle: ReturnType<typeof setTimeout> | null };
let ownerHost: OwnerHost | null = null;
let ownerQueue: Promise<unknown> = Promise.resolve();

function retireOwnerHost(host: OwnerHost): void {
  if (ownerHost === host) ownerHost = null;
  if (host.idle) clearTimeout(host.idle);
  host.child.kill();
}

function startOwnerHost(): OwnerHost {
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(OWNER_HOST_SCRIPT, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const host: OwnerHost = { child, buffer: '', reply: null, idle: null };
  const answer = (line: string | null) => { const reply = host.reply; host.reply = null; reply?.(line); };
  const stopped = () => { if (ownerHost === host) ownerHost = null; if (host.idle) clearTimeout(host.idle); answer(null); };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    host.buffer += chunk;
    for (let end = host.buffer.indexOf('\n'); end >= 0; end = host.buffer.indexOf('\n')) {
      const line = host.buffer.slice(0, end).trim();
      host.buffer = host.buffer.slice(end + 1);
      answer(line);
    }
  });
  child.stdin?.on('error', stopped);
  child.once('error', stopped);
  child.once('exit', stopped);
  return host;
}

/** One request at a time keeps each JSON line paired with the handles that produced it. */
function queryWindowOwners(handles: string[]): Promise<string | null> {
  const ask = () => new Promise<string | null>(resolve => {
    const host = ownerHost ??= startOwnerHost();
    if (host.idle) clearTimeout(host.idle);
    const timer = setTimeout(() => { host.reply = null; retireOwnerHost(host); resolve(null); }, OWNER_REPLY_TIMEOUT_MS);
    host.reply = line => {
      clearTimeout(timer);
      if (ownerHost === host) {
        host.idle = setTimeout(() => retireOwnerHost(host), OWNER_HOST_IDLE_MS);
        host.idle.unref?.();
      }
      resolve(line);
    };
    host.child.stdin?.write(`${handles.join(',')}\n`);
  });
  const reply = ownerQueue.then(ask, ask);
  ownerQueue = reply;
  return reply;
}

/** Map Electron window source handles to owning PIDs, only when running on Windows. */
export async function windowsSourceOwners(sources: ReadonlyArray<Pick<Source, 'id'>>): Promise<Map<string, number>> {
  if (process.platform !== 'win32') return new Map();
  const handles = sources.slice(0, 256).map(source => /^window:(\d+)(?::|$)/.exec(source.id)?.[1]).filter((id): id is string => Boolean(id));
  if (!handles.length) return new Map();
  try {
    const reply = await queryWindowOwners(handles);
    const rows: unknown = reply === null ? null : JSON.parse(reply);
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

/** Capture the exact owned HWND; a missing binding must never select another window by title. */
export async function captureComputerUseWindow(target: string, width: number, height: number,
  options: { pid?: number; targetWindowId?: number; getSources?: typeof desktopCapturer.getSources;
    owners?: (sources: ReadonlyArray<Pick<Source, 'id'>>) => Promise<Map<string, number>> } = {}): Promise<string | null> {
  if (!target || target.length > 256 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 1 || height < 1 || width > MAX_CAPTURE_DIMENSION || height > MAX_CAPTURE_DIMENSION
      || !Number.isSafeInteger(options.pid) || options.pid! < 1
      || !Number.isSafeInteger(options.targetWindowId) || options.targetWindowId! < 1) return null;
  const sources: Source[] = await (options.getSources ?? (input => desktopCapturer.getSources(input)))({ types: ['window'], thumbnailSize: { width, height }, fetchWindowIcons: false });
  // Titles such as "Untitled - Notepad" can occur in multiple processes.
  // A wrong window is worse than an unavailable frame.
  const owners = await (options.owners ?? windowsSourceOwners)(sources);
  const matches = sources.filter(source => owners.get(source.id) === options.pid
    && /^window:(\d+)(?::|$)/.exec(source.id)?.[1] === String(options.targetWindowId));
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
  capture?: (target: string, width: number, height: number, options: { pid?: number; targetWindowId?: number }) => Promise<string | null>): () => void {
  const receive = (raw: any) => {
    if (!live() || raw?.type !== 'memmy:computer-use-window-capture:request') return;
    if (typeof raw.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.requestId)
        || typeof raw.target !== 'string' || raw.target.length < 1 || raw.target.length > 256
        || !Number.isSafeInteger(raw.width) || !Number.isSafeInteger(raw.height)
        || raw.width < 1 || raw.height < 1 || raw.width > MAX_CAPTURE_DIMENSION || raw.height > MAX_CAPTURE_DIMENSION
        || !Number.isSafeInteger(raw.pid) || raw.pid < 1
        || !Number.isSafeInteger(raw.targetWindowId) || raw.targetWindowId < 1) return;
    void Promise.resolve().then(() => (capture ?? captureComputerUseWindow)(raw.target, raw.width, raw.height, { pid: raw.pid, targetWindowId: raw.targetWindowId }))
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
