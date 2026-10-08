import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { BrowserAccessApproval } from '../../../../src/core/agent-runtime/tools/browser-access-approval.js';
import { BrowserUseSitePolicyReader } from '../../../../src/core/agent-runtime/tools/browser-use-site-policy-store.js';
import { BrowserCapabilityApproval } from '../../../../src/core/agent-runtime/tools/browser-capability-approval.js';

it('honors saved website allow and deny decisions and clears them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-access-'));
  try {
    const file = path.join(root, 'access.json');
    const access = new BrowserAccessApproval(file);
    fs.writeFileSync(file, JSON.stringify({ 'https://allow.example': 'allow', 'https://deny.example': 'deny' }));
    expect(await access.authorize('https://allow.example/page', new Set())).toBe(true);
    expect(await access.authorize('https://deny.example/page', new Set(['https://deny.example']))).toBe(false);
    access.clear();
    expect(fs.existsSync(file)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('applies a site matrix before legacy browsing grants and file transfer prompts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-policy-'));
  try {
    const accessPath = path.join(root, 'access.json');
    const policyPath = path.join(root, 'site-policy.json');
    fs.writeFileSync(accessPath, JSON.stringify({ 'https://ask.example': 'allow',
      'https://blocked.example': 'allow' }));
    fs.writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [
      { pattern: 'https://ask.example', access: 'ask', downloads: 'ask', uploads: 'ask', fullCdp: 'block' },
      { pattern: 'https://blocked.example', access: 'block', downloads: 'allow', uploads: 'allow', fullCdp: 'block' },
      { pattern: 'https://allowed.example', access: 'allow', downloads: 'allow', uploads: 'allow', fullCdp: 'block' },
    ] }));
    const reader = new BrowserUseSitePolicyReader(policyPath);
    const browsing = new BrowserAccessApproval(accessPath, reader);
    const transfers = new BrowserCapabilityApproval(reader);
    vi.spyOn(browsing as any, 'requestDecision').mockResolvedValue('deny');
    expect(await browsing.authorize('https://ask.example/', new Set())).toBe(false);
    expect((browsing as any).requestDecision).toHaveBeenCalledOnce();
    expect(await browsing.authorize('https://blocked.example/', new Set(['https://blocked.example']))).toBe(false);
    expect(await browsing.authorize('https://allowed.example/', new Set())).toBe(true);
    expect(await transfers.authorize('upload', 'https://allowed.example/', ['file.txt'])).toBe(true);
    expect(await transfers.authorize('upload', 'https://blocked.example/', ['file.txt'])).toBe(false);
    expect(reader.decision('https://ask.example/', 'downloads')).toBe('ask');
    vi.spyOn(browsing as any, 'requestDecision').mockImplementation(async () => {
      fs.writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [
        { pattern: 'https://ask.example', access: 'block', downloads: 'ask',
          uploads: 'ask', fullCdp: 'block' },
      ] }));
      return 'allow';
    });
    expect(await browsing.authorize('https://ask.example/', new Set())).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
