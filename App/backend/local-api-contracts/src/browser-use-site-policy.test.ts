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
    expect(evaluateBrowserUseSiteRule([], 'https://example.com/', 'fullCdp')).toBe('block');
  });

  it('rejects duplicate canonical patterns and corrupt documents', () => {
    expect(parseBrowserUseSitePolicyDocument({ version: 1, rules: [rule('https://Example.com'),
      rule('https://example.com')] })).toBeNull();
    expect(parseBrowserUseSitePolicyDocument({ version: 2, rules: [] })).toBeNull();
  });
});
