import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MessageBus } from '../../../src/core/runtime-messages/index.js';
import { WebSocketChannel } from '../../../src/integrations/channels/websocket.js';
import { nativeAppApprovalStore } from '../../../src/tools/computer-use/native-app-approvals.js';

const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const roots: string[] = [];
afterEach(() => {
  if (originalDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('lists only authenticated approvals and revokes them with a bearer-authenticated POST', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-native-app-route-'));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  nativeAppApprovalStore.allow({ platform: 'darwin', appId: 'com.apple.calculator', displayName: 'Calculator' });
  const channel = new WebSocketChannel({ enabled: true, host: '127.0.0.1', port: 0 }, new MessageBus());
  const connection = { remoteAddress: ['127.0.0.1'] };
  const route = '/api/settings/computer-use/apps';
  expect((await channel.dispatchHttp(connection, { path: route, method: 'GET', headers: {} }))?.status).toBe(401);
  channel.apiTokens.set('test', Date.now() / 1000 + 60);
  const headers = { authorization: 'Bearer test' };
  const listed = await channel.dispatchHttp(connection, { path: route, method: 'GET', headers });
  expect(listed?.status).toBe(200);
  expect(listed?.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(String(listed?.body)).apps).toMatchObject([{ appId: 'com.apple.calculator' }]);
  const revoke = `${route}?platform=darwin&app_id=com.apple.calculator`;
  expect((await channel.dispatchHttp(connection, { path: `${revoke}&token=test`, method: 'POST', headers: {} }))?.status).toBe(401);
  expect(nativeAppApprovalStore.isAllowed({ platform: 'darwin', appId: 'com.apple.calculator', displayName: 'Calculator' })).toBe(true);
  const removed = await channel.dispatchHttp(connection, { path: revoke, method: 'POST', headers });
  expect(removed?.status).toBe(200);
  expect(JSON.parse(String(removed?.body)).apps).toEqual([]);
  expect(nativeAppApprovalStore.list()).toEqual([]);
});
