import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { nativeAgentSocketPath, stopOwnedNativeAgent } from '../../../src/tools/computer-use/native-agent-lifecycle.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ocu-life-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'Open Computer Use.app');
  const binary = path.join(bundle, 'Contents/MacOS/OpenComputerUse');
  mkdirSync(path.dirname(binary), { recursive: true }); writeFileSync(binary, 'fixture');
  // Keep the Unix socket path short on macOS.
  const directory = '/tmp';
  const namespace = `memmy:${bundle}`;
  return { bundle, binary, namespace, directory };
}
async function agent(f: ReturnType<typeof fixture>, respond: (request: any, socket: net.Socket) => void) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', data => {
      buffer += data; let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        respond(JSON.parse(line), socket);
      }
    });
  });
  server.listen(nativeAgentSocketPath(f.namespace, f.directory)); await once(server, 'listening');
  cleanups.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
}
const info = (f: ReturnType<typeof fixture>) => ({ bundleIdentifier: 'com.ifuryst.opencomputeruse', bundleURL: f.bundle, executableURL: f.binary });

it('matches the native namespace hash and never falls back to the shared socket', () => {
  expect(nativeAgentSocketPath('memmy:/Users/yicheng/Applications/Memmy Development/Open Computer Use.app', '/tmp')).toBe('/tmp/open-computer-use-agent-8f6a862c735ba596.sock');
});
it('verifies both paths, requests native termination, and waits for closure rather than just an ack', async () => {
  const f = fixture(); const requests: string[] = []; let close!: () => void;
  await agent(f, (request, socket) => {
    requests.push(request.kind);
    if (request.kind === 'agentInfo') socket.write(JSON.stringify(info(f)) + '\n');
    else { socket.write('{"ok":true}\n'); close = () => socket.end(); }
  });
  let stopped = false;
  const stopping = stopOwnedNativeAgent(f.binary, f.namespace, f.directory).then(() => { stopped = true; });
  await vi.waitFor(() => expect(close).toBeTypeOf('function'));
  expect(requests).toEqual(['agentInfo', 'terminate']); expect(stopped).toBe(false);
  close(); await stopping; expect(stopped).toBe(true);
});
it.each(['bundleURL', 'executableURL', 'bundleIdentifier'])('never terminates another installation when %s differs', async field => {
  const f = fixture(); const requests: string[] = [];
  await agent(f, (request, socket) => { requests.push(request.kind); socket.end(JSON.stringify({ ...info(f), [field]: f.directory }) + '\n'); });
  await expect(stopOwnedNativeAgent(f.binary, f.namespace, f.directory)).rejects.toThrow();
  expect(requests).toEqual(['agentInfo']);
});
it('accepts an already stopped private agent but rejects unowned namespaces', async () => {
  const f = fixture(); await expect(stopOwnedNativeAgent(f.binary, f.namespace, f.directory)).resolves.toBeUndefined();
  await expect(stopOwnedNativeAgent(f.binary, 'default', f.directory)).rejects.toThrow('unowned');
});
it('does not treat a refused shutdown as readiness for Settings', async () => {
  const f = fixture();
  await agent(f, (request, socket) => socket.write(JSON.stringify(request.kind === 'agentInfo' ? info(f) : { error: 'busy' }) + '\n'));
  await expect(stopOwnedNativeAgent(f.binary, f.namespace, f.directory)).rejects.toThrow('refused');
});
