export type BrowserUseCapability = 'access' | 'downloads' | 'uploads' | 'fullCdp';
export type BrowserUseDecision = 'block' | 'ask' | 'allow';
export type BrowserUseSiteRule = { pattern: string } & Record<BrowserUseCapability, BrowserUseDecision>;

type ParsedPattern = { canonical: string; protocol: string; host: string;
  port: string; kind: 'exact' | 'subdomains' | 'apex-and-subdomains' };

/** A conservative subset of the Codex origin pattern grammar. */
export function parseBrowserUsePattern(value: string): ParsedPattern | null {
  if (typeof value !== 'string' || value.length > 320 || value !== value.trim() || /\s/.test(value)
    || !/^https?:\/\//.test(value)) return null;
  const authority = value.slice(value.indexOf('://') + 3);
  if (!authority || /[/?#@\\]/.test(authority)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) return null;
    const rawHost = url.hostname.replace(/%2a/gi, '*').toLowerCase().replace(/\.$/, '');
    const kind = rawHost.startsWith('**.') ? 'apex-and-subdomains'
      : rawHost.startsWith('*.') ? 'subdomains' : 'exact';
    const host = kind === 'apex-and-subdomains' ? rawHost.slice(3)
      : kind === 'subdomains' ? rawHost.slice(2) : rawHost;
    if (!host || /[\[\]{}\\]/.test(host) || (host.includes('*') && /[^\x00-\x7f]/.test(host))) return null;
    if (host.split('.').some(label => !label)) return null;
    const canonicalHost = kind === 'apex-and-subdomains' ? `**.${host}`
      : kind === 'subdomains' ? `*.${host}` : host;
    return { canonical: `${url.protocol}//${canonicalHost}${url.port ? `:${url.port}` : ''}`,
      protocol: url.protocol, host, port: url.port, kind };
  } catch { return null; }
}

function hostGlob(pattern: string, host: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(host);
}

export function browserUsePatternMatches(pattern: string, pageUrl: string): boolean {
  const parsed = parseBrowserUsePattern(pattern);
  if (!parsed) return false;
  try {
    const page = new URL(pageUrl);
    if (page.protocol !== parsed.protocol || page.port !== parsed.port) return false;
    const host = page.hostname.toLowerCase().replace(/\.$/, '');
    if (parsed.kind === 'exact') return hostGlob(parsed.host, host);
    const subdomain = host.endsWith(`.${parsed.host}`) && host.length > parsed.host.length + 1;
    return parsed.kind === 'subdomains' ? subdomain : host === parsed.host || subdomain;
  } catch { return false; }
}

export function isBrowserUseSiteRule(value: unknown): value is BrowserUseSiteRule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  return typeof rule.pattern === 'string' && parseBrowserUsePattern(rule.pattern) !== null
    && (['access', 'downloads', 'uploads', 'fullCdp'] as const)
      .every(key => ['block', 'ask', 'allow'].includes(String(rule[key])));
}

export function evaluateBrowserUseSiteRule(rules: readonly BrowserUseSiteRule[], pageUrl: string,
  capability: BrowserUseCapability): BrowserUseDecision {
  if (capability !== 'access' && evaluateBrowserUseSiteRule(rules, pageUrl, 'access') === 'block') return 'block';
  let result: BrowserUseDecision = capability === 'fullCdp' ? 'block' : 'ask';
  let matched = false;
  for (const rule of rules) {
    if (!browserUsePatternMatches(rule.pattern, pageUrl)) continue;
    if (rule[capability] === 'block') return 'block';
    result = rule[capability];
    matched = true;
  }
  return matched ? result : capability === 'fullCdp' ? 'block' : 'ask';
}

export function parseBrowserUseSitePolicyDocument(raw: unknown): BrowserUseSiteRule[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const document = raw as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.rules) || document.rules.length > 200
    || !document.rules.every(isBrowserUseSiteRule)) return null;
  const rules = document.rules as BrowserUseSiteRule[];
  const canonical = rules.map(rule => parseBrowserUsePattern(rule.pattern)!.canonical);
  return new Set(canonical).size === canonical.length ? rules : null;
}
