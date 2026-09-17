import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Exercise the compiled Swift stdio proxy with a disposable app-agent socket.
// No real applications are operated and no TCC grants are changed.
const binary = process.env.OCU_TEST_BINARY;
test('native proxy survives helper restart and never replays an uncertain action', {
  skip: process.platform !== 'darwin' || !binary,
  timeout: 20_000,
}, async (t) => {
  const root = fs.mkdtempSync('/private/tmp/ocu-reconnect-');
  const namespace = `fixture-${process.pid}`;
  const digest = createHash('sha256').update(namespace).digest('hex').slice(0, 16);
  const socketPath = path.join(os.tmpdir(), `open-computer-use-agent-${digest}.sock`);
  // Foundation standardizes /private/tmp to /tmp on macOS.
  const app = path.dirname(path.dirname(path.dirname(fs.realpathSync(binary)))).replace(/^\/private\/tmp\//, '/tmp/');
  const buildIdentifier = JSON.parse(fs.readFileSync(path.resolve(app, '../../.memmy-native-build.json'), 'utf8')).fingerprint;
  const sockets = new Set();
  let generation = 1, clickCount = 0, server, child;
  const startServer = async () => {
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      createInterface({ input: socket }).on('line', (line) => {
        const request = JSON.parse(line);
        if (request.kind === 'agentInfo') {
          socket.write(JSON.stringify({ bundleURL: app, buildIdentifier, processStartTime: Date.now() / 1000 + 10 }) + '\n');
          return;
        }
        assert.equal(request.kind, 'mcp');
        const rpc = JSON.parse(request.line);
        if (rpc.params?.name === 'click') {
          clickCount++;
          socket.destroy(); // Action arrived, response was lost. Retrying would duplicate it.
          return;
        }
        socket.write(JSON.stringify({ response: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { generation } }) }) + '\n');
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  };
  const stopServer = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(async () => {
    child?.kill();
    if (server?.listening) await stopServer();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await startServer();
  child = spawn(binary, ['mcp'], { env: { ...process.env, OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: namespace }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const pending = new Map();
  child.on('exit', (code) => { for (const { reject } of pending.values()) reject(new Error(`Native exit ${code}: ${stderr}`)); });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line);
    pending.get(response.id)?.resolve(response);
    pending.delete(response.id);
  });
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const first = await request('initialize');
  assert.equal(first.result?.generation, 1, JSON.stringify(first));
  // The client keeps the old connection open across turns; simulate Quit & Reopen.
  await stopServer();
  generation = 2;
  await startServer();
  assert.equal((await request('tools/list')).result.generation, 2);
  assert.equal(child.exitCode, null);
  const lost = await request('tools/call', { name: 'click', arguments: {} });
  assert.equal(lost.error.code, -32000);
  assert.match(lost.error.message, /not replayed/);
  assert.equal(clickCount, 1);
  assert.equal((await request('tools/list')).result.generation, 2);
  assert.equal(clickCount, 1);
});
