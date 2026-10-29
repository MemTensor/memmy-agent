import { describe, expect, it } from 'vitest';
import { browserUsePatternMatches, evaluateBrowserUseSiteRule,
  parseBrowserUsePattern, parseBrowserUseSitePolicyDocument, type BrowserUseSiteRule } from './browser-use-site-policy.js';

const rule = (pattern: string, values: Partial<BrowserUseSiteRule> = {}): BrowserUseSiteRule => ({
  pattern, access: 'ask', downloads: 'ask', uploads: 'ask', fullCdp: 'block', ...values,
});

describe('browser use site policy', () => {
  it('matches origin patterns by scheme, port, apex and subdomains', () => {
    expect(parseBrowserUsePattern('https://*.Example.com')?.canonical).toBe('https://*.example.com');
    expect(browserUsePatternMatches('https://*.example.com', 'https://a.example.com/form')).toBe(true);
    expect(browserUsePatternMatches('https://*.example.com', 'https://example.com/form')).toBe(false);
    expect(browserUsePatternMatches('https://**.example.com', 'https://example.com/form')).toBe(true);
    expect(browserUsePatternMatches('https://**.example.com', 'https://a.example.com/form')).toBe(true);
    expect(browserUsePatternMatches('https://*.example.com', 'http://a.example.com/form')).toBe(false);
    expect(browserUsePatternMatches('https://*.example.com:8443', 'https://a.example.com/form')).toBe(false);
    expect(browserUsePatternMatches('https://*.example.com:8443', 'https://a.example.com:8443/form')).toBe(true);
    expect(parseBrowserUsePattern('https://*.example.com/path')).toBeNull();
    expect(parseBrowserUsePattern('https://user@example.com')).toBeNull();
    expect(parseBrowserUsePattern('https://*.example.com ')).toBeNull();
  });

  it('gives block priority across matches and prevents browsing block from allowing transfer', () => {
    const rules = [rule('https://**.example.com', { uploads: 'allow' }),
      rule('https://private.example.com', { uploads: 'block' })];
    expect(evaluateBrowserUseSiteRule(rules, 'https://private.example.com/', 'uploads')).toBe('block');
    expect(evaluateBrowserUseSiteRule(rules, 'https://public.example.com/', 'uploads')).toBe('allow');
    expect(evaluateBrowserUseSiteRule([rule('https://example.com', { access: 'block', uploads: 'allow' })],
      'https://example.com/', 'uploads')).toBe('block');
  });

  it('asks for every capability on a site without a rule and honors explicit allow or block', () => {
    for (const capability of ['access', 'downloads', 'uploads', 'fullCdp'] as const) {
      expect(evaluateBrowserUseSiteRule([], 'https://example.com/', capability)).toBe('ask');
    }
    const rules = [rule('https://example.com', { access: 'allow', fullCdp: 'allow' })];
    expect(evaluateBrowserUseSiteRule(rules, 'https://example.com/', 'fullCdp')).toBe('allow');
    expect(evaluateBrowserUseSiteRule(rules, 'https://other.example/', 'fullCdp')).toBe('ask');
    expect(evaluateBrowserUseSiteRule([rule('https://example.com', { access: 'block', fullCdp: 'allow' })],
      'https://example.com/', 'fullCdp')).toBe('block');
  });

  it('rejects duplicate canonical patterns and corrupt documents', () => {
    expect(parseBrowserUseSitePolicyDocument({ version: 1, rules: [rule('https://Example.com'),
      rule('https://example.com')] })).toBeNull();
    expect(parseBrowserUseSitePolicyDocument({ version: 2, rules: [] })).toBeNull();
  });

  it.each(['access', 'downloads', 'uploads', 'fullCdp'] as const)('rejects non-string persisted %s decisions', capability => {
    for (const value of [['block'], ['ask'], ['allow'], null, undefined, true, 1, { toString: 'block' }]) {
      expect(parseBrowserUseSitePolicyDocument({ version: 1,
        rules: [{ ...rule('https://example.com'), [capability]: value }] })).toBeNull();
    }
  });

  it('retains valid schema 1 allow and block rules when the unconfigured default changes', () => {
    const document = { version: 1, rules: [
      rule('https://allowed.example', { access: 'allow', fullCdp: 'allow' }),
      rule('https://blocked.example', { access: 'block', uploads: 'allow', fullCdp: 'allow' }),
    ] };
    const before = JSON.stringify(document);
    const parsed = parseBrowserUseSitePolicyDocument(document);
    expect(parsed).toEqual(document.rules);
    expect(JSON.stringify(document)).toBe(before);
    expect(evaluateBrowserUseSiteRule(parsed!, 'https://allowed.example/', 'fullCdp')).toBe('allow');
    expect(evaluateBrowserUseSiteRule(parsed!, 'https://blocked.example/', 'fullCdp')).toBe('block');
    expect(evaluateBrowserUseSiteRule(parsed!, 'https://blocked.example/', 'uploads')).toBe('block');
    expect(evaluateBrowserUseSiteRule(parsed!, 'https://unconfigured.example/', 'fullCdp')).toBe('ask');
  });
});
