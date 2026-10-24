import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  stopComputerUseAgentForPermissionRestart,
  stopComputerUseAgentsOnExitSync,
} from '../src/main/computer-use-agent-restart.js';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn(), temporaryDirectory: '' }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFileSync: mocks.execFileSync,
}));
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  const tmpdir = () => mocks.temporaryDirectory || original.tmpdir();
  return { ...original, tmpdir, default: { ...original.default, tmpdir } };
});

const hostPlatform = process.platform;
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
const cleanups: Array<() => void | Promise<void>> = [];
let processRows: string[] = [];
let textFiles: Map<number, string | Error>;
let kill: ReturnType<typeof vi.spyOn>;

function asPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function fixture(development = false) {
  // A separate short socket directory keeps fixtures below macOS's Unix socket
  // path limit and prevents discovery or connection to any real Memmy agent.
  const root = realpathSync(mkdtempSync('/tmp/memmy-quit-'));
  mocks.temporaryDirectory = root;
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, 'Applications with spaces/Memmy.app/Contents/Resources');
  const bundle = development ? path.join(root, 'Memmy Computer Use (Dev).app')
    : path.join(resources, 'app.asar.unpacked/dist/runtime/memmy-agent/dist/native-computer-use/Memmy Computer Use.app');
  const binary = path.join(bundle, 'Contents/MacOS/MemmyComputerUse');
  mkdirSync(path.dirname(binary), { recursive: true });
  writeFileSync(binary, 'test fixture; never execute');
  chmodSync(binary, 0o755);
  const socket = (hash?: string) => path.join(root, `memmy-computer-use-agent${hash ? `-${hash}` : ''}.sock`);
  const info = { bundleIdentifier: 'cn.memtensor.memmy', bundleURL: bundle, executableURL: binary };
  return { root, resources, bundle, binary, socket, info };
}

type Fixture = ReturnType<typeof fixture>;
type Request = { kind: string };
function row(f: Fixture, pid: number, socket: string, binary = f.binary): string {
  return `${pid} ${binary} __memmy-computer-use-app-agent ${socket}`;
}

async function agent(socketPath: string, respond: (request: Request, socket: net.Socket) => void) {
  const requests: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffered = '';
    socket.on('data', data => {
      buffered += data;
      let end: number;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffered.slice(0, end)) as Request;
        buffered = buffered.slice(end + 1);
        requests.push(request.kind);
        respond(request, socket);
      }
    });
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  server.listen(socketPath);
  await once(server, 'listening');
  return { requests, sockets };
}

function shutdownReply(f: Fixture, request: Request, socket: net.Socket): void {
  if (request.kind === 'agentInfo') socket.write(`${JSON.stringify(f.info)}\n`);
  else if (request.kind === 'terminate') socket.end('{"ok":true}\n');
}

describe.skipIf(hostPlatform === 'win32')('Computer Use cleanup for a complete desktop exit', () => {
  beforeEach(() => {
    asPlatform('darwin');
    processRows = [];
    textFiles = new Map();
    mocks.execFileSync.mockReset();
    mocks.execFileSync.mockImplementation((file: string, args: string[]) => {
      if (file === '/bin/ps') return `${processRows.join('\n')}\n`;
      if (file === '/usr/sbin/lsof') {
        return args[args.indexOf('-p') + 1]!.split(',').map(value => {
          const result = textFiles.get(Number(value));
          if (result instanceof Error) throw result;
          return result ?? '';
        }).join('');
      }
      throw new Error(`Unexpected subprocess: ${file}`);
    });
    // Every signal is intercepted: fixture PIDs never identify real processes.
    kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    mocks.temporaryDirectory = '';
    Object.defineProperty(process, 'platform', platformDescriptor);
    vi.restoreAllMocks();
  });

  it('stops task, base and legacy agents belonging to this installation', async () => {
    const f = fixture();
    const sockets = [f.socket('a'.repeat(16)), f.socket('b'.repeat(16)), f.socket('c'.repeat(16)), f.socket()];
    const agents = await Promise.all(sockets.map(socket => agent(socket, (request, connection) => shutdownReply(f, request, connection))));
    processRows = sockets.map((socket, index) => row(f, 900_001 + index, socket));

    await stopComputerUseAgentForPermissionRestart(true, f.resources);

    for (const native of agents) expect(native.requests).toEqual(['agentInfo', 'terminate']);
    expect(kill).not.toHaveBeenCalled();
    expect(mocks.execFileSync).toHaveBeenCalledWith('/bin/ps', ['-ww', '-axo', 'pid=,command='],
      expect.objectContaining({ encoding: 'utf8', timeout: 1000 }));
  });

  it('waits for the verified helper to close after acknowledging terminate', async () => {
    const f = fixture();
    const socketPath = f.socket('a'.repeat(16));
    let close!: () => void;
    const native = await agent(socketPath, (request, socket) => {
      if (request.kind === 'agentInfo') socket.write(`${JSON.stringify(f.info)}\n`);
      else { socket.write('{"ok":true}\n'); close = () => socket.end(); }
    });
    processRows = [row(f, 900_001, socketPath)];
    let finished = false;
    const stopping = stopComputerUseAgentForPermissionRestart(true, f.resources).then(() => { finished = true; });
    await vi.waitFor(() => expect(close).toBeTypeOf('function'));
    expect(native.requests).toEqual(['agentInfo', 'terminate']);
    expect(finished).toBe(false);
    close();
    await stopping;
    expect(finished).toBe(true);
  });

  it('collects this installation when ps and lsof report a legitimate executable path alias', async () => {
    const f = fixture();
    const aliasBundle = path.join(f.root, 'Linked helper.app');
    symlinkSync(f.bundle, aliasBundle, 'dir');
    const aliasBinary = path.join(aliasBundle, 'Contents/MacOS/MemmyComputerUse');
    const socketPath = f.socket('a'.repeat(16));
    const native = await agent(socketPath, (request, socket) => shutdownReply(f, request, socket));
    processRows = [row(f, 900_001, socketPath, aliasBinary)];
    textFiles.set(900_001, `p900001\nn${aliasBinary}\n`);

    await stopComputerUseAgentForPermissionRestart(true, f.resources);
    stopComputerUseAgentsOnExitSync(true, f.resources);

    expect(native.requests).toEqual(['agentInfo', 'terminate']);
    expect(kill).toHaveBeenCalledExactlyOnceWith(900_001, 'SIGKILL');
  });

  it.each(['cn.memtensor.memmy.computeruse', 'cn.memtensor.memmy.computeruse.dev'])('accepts the upgrade-compatible helper identity %s', async bundleIdentifier => {
    const f = fixture();
    f.info.bundleIdentifier = bundleIdentifier;
    const socketPath = f.socket('a'.repeat(16));
    const native = await agent(socketPath, (request, socket) => shutdownReply(f, request, socket));
    processRows = [row(f, 900_001, socketPath)];
    await stopComputerUseAgentForPermissionRestart(true, f.resources);
    expect(native.requests).toEqual(['agentInfo', 'terminate']);
  });

  it.each(['bundleIdentifier', 'bundleURL', 'executableURL'] as const)('does not send terminate when %s identifies another installation', async field => {
    const f = fixture();
    const socketPath = f.socket('a'.repeat(16));
    const native = await agent(socketPath, (_request, socket) => socket.end(`${JSON.stringify({ ...f.info, [field]: '/another/Memmy.app' })}\n`));
    processRows = [row(f, 900_001, socketPath)];
    await expect(stopComputerUseAgentForPermissionRestart(true, f.resources)).rejects.toThrow();
    expect(native.requests).toEqual(['agentInfo']);
    expect(kill).not.toHaveBeenCalled();
  });

  it('rejects other copies, ambiguous command lines and sockets outside the current temporary directory', async () => {
    const f = fixture();
    const socketPath = f.socket('a'.repeat(16));
    const native = await agent(socketPath, (request, socket) => shutdownReply(f, request, socket));
    processRows = [
      row(f, 900_001, socketPath, `/other${f.binary}`),
      `900002 /bin/sh -c ${f.binary} __memmy-computer-use-app-agent ${socketPath}`,
      `900003 ${f.binary} __memmy-computer-use-app-agent ${socketPath} --extra`,
      `900004 ${f.binary} __memmy-computer-use-app-agent ${socketPath} ${socketPath}`,
      `900005 ${f.binary} __memmy-computer-use-app-agentX ${socketPath}`,
      row(f, 900_006, path.join(f.root, 'nested', path.basename(socketPath))),
      row(f, 900_007, path.join('/other', path.basename(socketPath))),
      row(f, 900_008, f.socket('A'.repeat(16))),
      row(f, 900_009, f.socket('a'.repeat(15))),
      row(f, 900_010, path.join(f.root, 'unrelated.sock')),
      row(f, 0, socketPath),
      row(f, -1, socketPath),
      `${f.binary} __memmy-computer-use-app-agent ${socketPath}`,
    ];
    await stopComputerUseAgentForPermissionRestart(true, f.resources);
    stopComputerUseAgentsOnExitSync(true, f.resources);
    expect(native.requests).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    expect(mocks.execFileSync.mock.calls.filter(([file]) => file === '/usr/sbin/lsof')).toEqual([]);
  });

  it('never terminates an existing different installation even when a command line claims our executable', async () => {
    const f = fixture();
    const otherBundle = path.join(f.root, 'Another installation/Memmy Computer Use.app');
    const otherBinary = path.join(otherBundle, 'Contents/MacOS/MemmyComputerUse');
    mkdirSync(path.dirname(otherBinary), { recursive: true });
    writeFileSync(otherBinary, 'another test installation; never execute');
    chmodSync(otherBinary, 0o755);
    const socketPath = f.socket('d'.repeat(16));
    const native = await agent(socketPath, (_request, socket) => socket.end(`${JSON.stringify({
      ...f.info, bundleURL: otherBundle, executableURL: otherBinary,
    })}\n`));
    processRows = [row(f, 900_001, socketPath, otherBinary), row(f, 900_002, socketPath)];
    textFiles.set(900_002, `p900002\nn${otherBinary}\n`);

    await expect(stopComputerUseAgentForPermissionRestart(true, f.resources)).rejects.toThrow();
    stopComputerUseAgentsOnExitSync(true, f.resources);

    expect(native.requests).toEqual(['agentInfo']);
    expect(kill).not.toHaveBeenCalled();
  });

  it('tolerates an already removed socket and safely rejects a stale non-socket file', async () => {
    const f = fixture();
    const stale = f.socket('b'.repeat(16));
    writeFileSync(stale, 'stale socket fixture');
    processRows = [row(f, 900_001, f.socket('a'.repeat(16)))];
    await expect(stopComputerUseAgentForPermissionRestart(true, f.resources)).resolves.toBeUndefined();
    processRows = [row(f, 900_002, stale)];
    await expect(stopComputerUseAgentForPermissionRestart(true, f.resources)).rejects.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });

  it('bounds an unresponsive helper and uses executable-verified synchronous exit cleanup', async () => {
    const f = fixture();
    const socketPath = f.socket('a'.repeat(16));
    const native = await agent(socketPath, () => {});
    processRows = [row(f, 900_001, socketPath)];
    textFiles.set(900_001, `p900001\nn${f.binary}\n`);
    const began = Date.now();
    await expect(stopComputerUseAgentForPermissionRestart(true, f.resources)).rejects.toThrow();
    expect(Date.now() - began).toBeLessThan(2500);
    expect(native.requests).toEqual(['agentInfo']);
    expect(kill).not.toHaveBeenCalled();

    stopComputerUseAgentsOnExitSync(true, f.resources);

    expect(mocks.execFileSync).toHaveBeenCalledWith('/usr/sbin/lsof', ['-a', '-p', '900001', '-d', 'txt', '-Fn'],
      expect.objectContaining({ encoding: 'utf8' }));
    expect(kill).toHaveBeenCalledExactlyOnceWith(900_001, 'SIGKILL');
  });

  it('bounds a terminate acknowledgement whose connection never closes', async () => {
    const f = fixture();
    const socketPath = f.socket('a'.repeat(16));
    const native = await agent(socketPath, (request, socket) => socket.write(`${JSON.stringify(request.kind === 'agentInfo' ? f.info : { ok: true })}\n`));
    processRows = [row(f, 900_001, socketPath)];
    const began = Date.now();
    await expect(stopComputerUseAgentForPermissionRestart(true, f.resources)).rejects.toThrow();
    expect(Date.now() - began).toBeLessThan(2500);
    expect(native.requests).toEqual(['agentInfo', 'terminate']);
  });

  it.each(['{not json}\n', `${'x'.repeat(9000)}\n`])('does not terminate a helper sending an invalid identity response', async response => {
    const f = fixture();
    const socketPath = f.socket('a'.repeat(16));
    const native = await agent(socketPath, (_request, socket) => socket.end(response));
    processRows = [row(f, 900_001, socketPath)];
    await expect(stopComputerUseAgentForPermissionRestart(true, f.resources)).rejects.toThrow();
    expect(native.requests).toEqual(['agentInfo']);
  });

  it('rechecks executable text before signalling and skips changed or unavailable processes', () => {
    const f = fixture();
    processRows = [1, 2, 3, 4].map(index => row(f, 900_000 + index, f.socket(index.toString().repeat(16))));
    textFiles.set(900_001, `p900001\nn${f.binary}\n`);
    textFiles.set(900_002, `p900002\nn${f.binary}.another-copy\n`);
    textFiles.set(900_003, '');
    textFiles.set(900_004, `p900004\nn/other/MemmyComputerUse\n`);
    stopComputerUseAgentsOnExitSync(true, f.resources);
    expect(kill).toHaveBeenCalledExactlyOnceWith(900_001, 'SIGKILL');
  });

  it('cleans every verified process and can safely run again after they exit', () => {
    const f = fixture();
    processRows = [row(f, 900_001, f.socket('a'.repeat(16))), row(f, 900_002, f.socket())];
    for (const pid of [900_001, 900_002]) textFiles.set(pid, `p${pid}\nn${f.binary}\n`);
    kill.mockImplementation((pid: number) => { processRows = processRows.filter(line => !line.startsWith(`${pid} `)); return true; });
    stopComputerUseAgentsOnExitSync(true, f.resources);
    stopComputerUseAgentsOnExitSync(true, f.resources);
    expect(kill.mock.calls).toEqual([[900_001, 'SIGKILL'], [900_002, 'SIGKILL']]);
  });

  it('continues cleaning sibling helpers when signalling one fails', () => {
    const f = fixture();
    processRows = [row(f, 900_001, f.socket('a'.repeat(16))), row(f, 900_002, f.socket('b'.repeat(16)))];
    for (const pid of [900_001, 900_002]) textFiles.set(pid, `p${pid}\nn${f.binary}\n`);
    kill.mockImplementation((pid: number) => { if (pid === 900_001) throw new Error('ESRCH'); return true; });
    expect(() => stopComputerUseAgentsOnExitSync(true, f.resources)).not.toThrow();
    expect(kill).toHaveBeenCalledWith(900_002, 'SIGKILL');
  });

  it('uses verified partial lsof output when one queried process has already exited', () => {
    const f = fixture();
    processRows = [row(f, 900_001, f.socket('a'.repeat(16))), row(f, 900_002, f.socket('b'.repeat(16)))];
    mocks.execFileSync.mockImplementation((file: string) => {
      if (file === '/bin/ps') return `${processRows.join('\n')}\n`;
      throw Object.assign(new Error('one process has exited'), { status: 1, stdout: `p900001\nn${f.binary}\n` });
    });

    expect(() => stopComputerUseAgentsOnExitSync(true, f.resources)).not.toThrow();

    expect(kill).toHaveBeenCalledExactlyOnceWith(900_001, 'SIGKILL');
  });

  it.each(['other-status', 'buffer-output', 'no-status', 'timed-out'] as const)('does not use failed lsof output with %s', failure => {
    const f = fixture();
    processRows = [row(f, 900_001, f.socket('a'.repeat(16)))];
    const stdout = `p900001\nn${f.binary}\n`;
    mocks.execFileSync.mockImplementation((file: string) => {
      if (file === '/bin/ps') return `${processRows.join('\n')}\n`;
      throw Object.assign(new Error('lsof failed'), {
        status: failure === 'other-status' ? 2 : failure === 'no-status' ? undefined : failure === 'timed-out' ? null : 1,
        code: failure === 'timed-out' ? 'ETIMEDOUT' : undefined,
        signal: failure === 'timed-out' ? 'SIGTERM' : undefined,
        stdout: failure === 'buffer-output' ? Buffer.from(stdout) : stdout,
      });
    });

    expect(() => stopComputerUseAgentsOnExitSync(true, f.resources)).not.toThrow();

    expect(kill).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('supports a development helper only when it belongs to the expected app bundle', async () => {
    const f = fixture(true);
    const socketPath = f.socket('a'.repeat(16));
    const native = await agent(socketPath, (request, socket) => shutdownReply(f, request, socket));
    processRows = [row(f, 900_001, socketPath)];
    await stopComputerUseAgentForPermissionRestart(false, '', f.binary);
    expect(native.requests).toEqual(['agentInfo', 'terminate']);

    mocks.execFileSync.mockClear();
    const unrelated = path.join(f.root, 'Other.app/Contents/MacOS/MemmyComputerUse');
    mkdirSync(path.dirname(unrelated), { recursive: true });
    writeFileSync(unrelated, 'fixture'); chmodSync(unrelated, 0o755);
    await stopComputerUseAgentForPermissionRestart(false, '', unrelated);
    stopComputerUseAgentsOnExitSync(false, '', unrelated);
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('does not inspect processes when the binary is missing, relative or non-executable', async () => {
    const f = fixture();
    chmodSync(f.binary, 0o644);
    for (const binary of [undefined, 'relative/MemmyComputerUse', path.join(f.root, 'missing'), f.binary]) {
      await stopComputerUseAgentForPermissionRestart(false, '', binary);
      stopComputerUseAgentsOnExitSync(false, '', binary);
    }
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
  });

  it('contains process enumeration failures during both exit paths', async () => {
    const f = fixture();
    mocks.execFileSync.mockImplementation(() => { throw new Error('ps unavailable'); });
    await expect(stopComputerUseAgentForPermissionRestart(true, f.resources)).rejects.toThrow('ps unavailable');
    expect(() => stopComputerUseAgentsOnExitSync(true, f.resources)).not.toThrow();
    expect(kill).not.toHaveBeenCalled();
  });

  it.each(['win32', 'linux'] as const)('does not enumerate, connect or signal on %s', async platform => {
    const f = fixture();
    const socketPath = f.socket('a'.repeat(16));
    const native = await agent(socketPath, (request, socket) => shutdownReply(f, request, socket));
    processRows = [row(f, 900_001, socketPath)];
    asPlatform(platform);
    await stopComputerUseAgentForPermissionRestart(true, f.resources);
    stopComputerUseAgentsOnExitSync(true, f.resources);
    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(native.requests).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });
});
