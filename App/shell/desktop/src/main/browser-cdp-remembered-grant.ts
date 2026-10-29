import { browserUsePatternMatches, evaluateBrowserUseSiteRule, parseBrowserUsePattern,
  type BrowserUseDecision, type BrowserUseSiteRule } from '@memmy/local-api-contracts';

type SitePolicyStore = {
  list(): BrowserUseSiteRule[];
  upsert(rule: BrowserUseSiteRule): BrowserUseSiteRule[];
};

/**
 * A dialog grant persists only Debug / CDP for the exact origin shown to the user.
 * A new exact rule outranks broader rules and the remembered access choice, so it
 * starts from the site's current decisions and changes nothing but Debug / CDP.
 */
export function rememberBrowserCdpGrant(store: SitePolicyStore, origin: string,
  rememberedAccess?: 'allow' | 'deny'): boolean {
  const canonical = parseBrowserUsePattern(origin)?.canonical;
  if (!canonical || canonical.includes('*')) return false;
  const rules = store.list();
  // Recheck after the dialog: a concurrent settings denial must win.
  if (evaluateBrowserUseSiteRule(rules, canonical, 'fullCdp') === 'block') return false;
  const existing = rules.find(rule => parseBrowserUsePattern(rule.pattern)?.canonical === canonical);
  const current = (capability: 'access' | 'downloads' | 'uploads'): BrowserUseDecision =>
    evaluateBrowserUseSiteRule(rules, canonical, capability);
  const matched = rules.some(rule => browserUsePatternMatches(rule.pattern, canonical));
  const access: BrowserUseDecision = !matched && rememberedAccess === 'allow' ? 'allow'
    : !matched && rememberedAccess === 'deny' ? 'block' : current('access');
  const rule: BrowserUseSiteRule = existing ?? { pattern: canonical, access,
    downloads: current('downloads'), uploads: current('uploads'), fullCdp: 'allow' };
  const saved = store.upsert({ ...rule, pattern: canonical, fullCdp: 'allow' });
  return evaluateBrowserUseSiteRule(saved, canonical, 'fullCdp') === 'allow';
}
