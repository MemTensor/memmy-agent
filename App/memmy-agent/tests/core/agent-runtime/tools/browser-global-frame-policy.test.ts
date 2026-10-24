import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { BrowserUseSitePolicyReader } from '../../../../src/core/agent-runtime/tools/browser-use-site-policy-store.js';
import { ExternalBrowserPlaywrightRelay, type PlaywrightCommandBridge } from '../../../../src/core/agent-runtime/tools/external-browser-playwright-relay.js';
import type { ExternalBrowserClaim, ExternalBrowserPlaywrightEvent } from '../../../../src/core/agent-runtime/tools/external-browser-bridge.js';

it.each(['website', 'computer'] as const)('applies live %s allow-all to iframe CDP contexts and restores their blocks without restarting the relay', async source => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-global-frame-policy-'));
  const reader = new BrowserUseSitePolicyReader(path.join(directory, 'site-policy.json'), {
    nativeAllowAllFilePath: path.join(directory, 'allow-all-apps.json'),
  });
  const globalPath = source === 'website' ? reader.allowAllFilePath : reader.nativeAllowAllFilePath!;
  fs.writeFileSync(reader.filePath, JSON.stringify({ version: 1, rules: [{ pattern: 'https://frame.example',
    access: 'block', downloads: 'block', uploads: 'block', fullCdp: 'block' }] }));
  const claim: ExternalBrowserClaim = { connectionId: 'fixture', tabId: 1, browser: 'edge',
    title: 'Fixture', url: 'https://page.example/', claimedAt: 1 };
  const frameTree = { frame: { id: 'main-frame', url: claim.url },
    childFrames: [{ frame: { id: 'child-frame', url: 'https://frame.example/private' } }] };
  let leaseId = '';
  let onEvent: ((event: ExternalBrowserPlaywrightEvent) => void) | undefined;
  const command = vi.fn(async (_identity: unknown, name: string, args: Record<string, unknown> = {}) => {
    if (name === 'playwrightStart') {
      leaseId = args.leaseId as string;
      return { targetInfo: { targetId: 'main-target' }, frameTree, documentEpoch: 1, cdpEpoch: 1 };
    }
    if (args.method === 'Page.getFrameTree') return { frameTree };
    return { result: { value: 'frame title' } };
  });
  const bridge: PlaywrightCommandBridge = { command, getClaim: () => claim,
    subscribePlaywright: (_identity, listener) => { onEvent = listener; return () => { onEvent = undefined; }; } };
  const relay = new ExternalBrowserPlaywrightRelay(claim, url => reader.decision(url, 'access') !== 'block');
  try {
    await relay.begin(bridge, 'https://page.example', false, true);
    onEvent!({ leaseId, method: 'Runtime.executionContextCreated', params: {
      context: { id: 17, origin: 'https://frame.example', auxData: { frameId: 'child-frame' } },
    } });
    onEvent!({ leaseId, method: 'Target.attachedToTarget', params: { sessionId: 'child-session',
      targetInfo: { targetId: 'child-frame', parentFrameId: 'main-frame', type: 'iframe', url: 'https://frame.example/private' } } });
    expect(relay.hasBlockedFrames()).toBe(true);
    await expect(relay.send('Runtime.evaluate', { expression: 'document.title', contextId: 17 })).rejects.toThrow(/blocked/);
    await expect(relay.send('DOM.getDocument', { depth: -1, pierce: true })).rejects.toThrow(/blocked/);
    fs.writeFileSync(globalPath, JSON.stringify({ version: 1, enabled: true }));
    expect(relay.hasBlockedFrames()).toBe(false);
    await expect(relay.send('Runtime.evaluate', { expression: 'document.title', contextId: 17 }))
      .resolves.toEqual({ result: { value: 'frame title' } });
    await expect(relay.send('Runtime.evaluate', { expression: 'document.title' }, 'child-session'))
      .resolves.toEqual({ result: { value: 'frame title' } });
    expect((await relay.send('Page.getFrameTree')).frameTree.childFrames).toHaveLength(1);
    fs.writeFileSync(globalPath, JSON.stringify({ version: 1, enabled: false }));
    expect(relay.hasBlockedFrames()).toBe(true);
    await expect(relay.send('Runtime.evaluate', { expression: 'document.title', contextId: 17 })).rejects.toThrow(/blocked/);
    await expect(relay.send('Runtime.evaluate', { expression: 'document.title' }, 'child-session')).rejects.toThrow(/blocked/);
    expect((await relay.send('Page.getFrameTree')).frameTree.childFrames).toHaveLength(0);
  } finally { await relay.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
