import { describe, expect, it } from 'vitest';
import { BrowserCdpEventBuffer } from '../src/main/browser-cdp-event-buffer.js';

describe('tab-scoped CDP event buffer', () => {
  it('starts at the current cursor and pages matching events without crossing buffers', () => {
    const buffer = new BrowserCdpEventBuffer();
    buffer.record('Runtime.consoleAPICalled', { type: 'log' }, { tabId: 1 });
    expect(buffer.read({})).toEqual({ cursor: 1, events: [], hasMore: false, truncated: false });
    buffer.record('Network.requestWillBeSent', { request: { url: 'https://example.test/' } }, { tabId: 1 });
    buffer.record('Runtime.consoleAPICalled', { type: 'warn' }, { tabId: 1 });
    expect(buffer.read({ afterSequence: 1, limit: 1 })).toMatchObject({ cursor: 2, hasMore: true,
      events: [{ sequence: 2, method: 'Network.requestWillBeSent' }] });
    expect(buffer.read({ afterSequence: 2, methods: ['Runtime.consoleAPICalled'] })).toMatchObject({
      cursor: 3, hasMore: false, events: [{ sequence: 3, method: 'Runtime.consoleAPICalled' }] });
  });
  it('bounds event parameters and reports evicted history', () => {
    const buffer = new BrowserCdpEventBuffer();
    for (let index = 0; index < 501; index++) buffer.record('Runtime.consoleAPICalled',
      { text: 'x'.repeat(20_000) }, { tabId: 1 });
    const result = buffer.read({ afterSequence: 0, limit: 1 });
    expect(result.truncated).toBe(true);
    expect(result.events[0]).toMatchObject({ sequence: 2, method: 'Runtime.consoleAPICalled' });
    expect(result.events[0]).not.toHaveProperty('params');
  });

  it('filters child sessions and waits for a future matching event', async () => {
    const buffer = new BrowserCdpEventBuffer();
    const pending = buffer.wait({ target: { targetId: 'child-1' }, timeoutMs: 500 }, () => true);
    buffer.record('Runtime.consoleAPICalled', { type: 'log' }, { tabId: 1, sessionId: 's2', targetId: 'child-2' });
    buffer.record('Runtime.consoleAPICalled', { type: 'warn' }, { tabId: 1, sessionId: 's1', targetId: 'child-1' });
    expect(await pending).toMatchObject({ cursor: 2,
      events: [{ source: { tabId: 1, sessionId: 's1', targetId: 'child-1' } }] });
    expect(buffer.read({ afterSequence: 0, target: { sessionId: 's2' } }).events).toHaveLength(1);
    expect((await buffer.wait({ timeoutMs: 0 }, () => true)).events).toHaveLength(0);
    expect((await buffer.wait({ timeoutMs: 5 }, () => true)).events).toHaveLength(0);
    await expect(buffer.wait({ afterSequence: 2, timeoutMs: 500 }, () => false)).rejects.toThrow(/approved/);
  });
});
