import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BROWSER_USE_DEFAULT_DECISION, browserUsePatternMatches, parseBrowserUsePattern,
  type BrowserAllowAllState, type BrowserUseCapability, type BrowserUseDecision, type BrowserUseSiteRule } from '@memmy/local-api-contracts';
import { useTranslation } from '../i18n/use-translation.js';
import './browser-use-site-policies.css';

type RememberedAccess = { origin: string; decision: 'allow' | 'deny' };
const capabilities: BrowserUseCapability[] = ['access', 'downloads', 'uploads'];
const defaultRule = (pattern: string): BrowserUseSiteRule => ({ pattern,
  access: BROWSER_USE_DEFAULT_DECISION, downloads: BROWSER_USE_DEFAULT_DECISION,
  uploads: BROWSER_USE_DEFAULT_DECISION, fullCdp: BROWSER_USE_DEFAULT_DECISION });

function websitePattern(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  if (input.includes('*')) return parseBrowserUsePattern(input)?.canonical ?? null;
  if (input.includes('://') && !/^https?:\/\//i.test(input)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return parseBrowserUsePattern(url.origin)?.canonical ?? null;
  } catch { return null; }
}

export function BrowserUseSitePolicies({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<BrowserUseSiteRule[]>([]);
  const [remembered, setRemembered] = useState<RememberedAccess[]>([]);
  const [pattern, setPattern] = useState('');
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [accessLoaded, setAccessLoaded] = useState(false);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [error, setError] = useState<'error' | 'invalid' | null>(null);
  const [notice, setNotice] = useState(false);
  const [allowAll, setAllowAll] = useState<BrowserAllowAllState | null>(null);
  const [allowAllLoading, setAllowAllLoading] = useState(Boolean(window.memmy?.getBrowserAllowAll));
  const [allowAllError, setAllowAllError] = useState(false);
  const lifecycle = useRef(0);
  const writing = useRef(false);
  const allowAllEpoch = useRef(0);

  useEffect(() => {
    const current = ++lifecycle.current;
    void (async () => {
      const results = await Promise.allSettled([
        window.memmy?.getBrowserUseSitePolicies?.() ?? Promise.reject(new Error('Site permissions unavailable')),
        window.memmy?.getBrowserAccessRules?.() ?? Promise.reject(new Error('Remembered permissions unavailable')),
      ] as const);
      if (current !== lifecycle.current) return;
      const failures: string[] = [];
      if (results[0].status === 'fulfilled') { setRules(results[0].value); setRulesLoaded(true); }
      else failures.push('rules');
      if (results[1].status === 'fulfilled') { setRemembered(results[1].value); setAccessLoaded(true); }
      else failures.push('access');
      setLoadErrors(failures); setLoading(false);
    })();
    return () => { lifecycle.current++; };
  }, []);

  useEffect(() => {
    let live = true;
    const apply = (state: BrowserAllowAllState) => {
      if (!live) return;
      allowAllEpoch.current++;
      setAllowAll(state); setAllowAllLoading(false); setAllowAllError(false);
    };
    const unsubscribe = window.memmy?.onBrowserAllowAllChanged?.(apply);
    const load = () => {
      if (!window.memmy?.getBrowserAllowAll || writing.current) return;
      const epoch = ++allowAllEpoch.current;
      void window.memmy.getBrowserAllowAll().then(state => {
        if (live && epoch === allowAllEpoch.current) apply(state);
      }).catch(() => {
        if (live && epoch === allowAllEpoch.current) { setAllowAllError(true); setAllowAllLoading(false); }
      });
    };
    load();
    window.addEventListener('focus', load);
    return () => { live = false; allowAllEpoch.current++; unsubscribe?.(); window.removeEventListener('focus', load); };
  }, []);

  async function write(work: () => Promise<void>, failure: 'error' | 'invalid' = 'error'): Promise<boolean> {
    if (loading || writing.current) return false;
    const current = lifecycle.current;
    writing.current = true;
    setPending(true); setError(null); setNotice(false);
    try {
      await work();
      return current === lifecycle.current;
    } catch { if (current === lifecycle.current) setError(failure); return false; }
    finally {
      if (current === lifecycle.current) { writing.current = false; setPending(false); }
    }
  }

  async function save(rule: BrowserUseSiteRule): Promise<boolean> {
    if (allowAll?.effective) return false;
    if (!rulesLoaded || !window.memmy?.upsertBrowserUseSitePolicy) { setError('error'); return false; }
    const current = lifecycle.current;
    return write(async () => {
      const next = await window.memmy!.upsertBrowserUseSitePolicy!(rule);
      if (current === lifecycle.current) setRules(next);
    }, 'invalid');
  }

  async function changeRemembered(origin: string, decision: BrowserUseDecision): Promise<void> {
    if (allowAll?.effective) return;
    if (!accessLoaded || !window.memmy?.setBrowserAccessRule) { setError('error'); return; }
    const current = lifecycle.current;
    await write(async () => {
      const next = await window.memmy!.setBrowserAccessRule!(origin, decision === 'block' ? 'deny' : decision);
      if (current === lifecycle.current) { setRemembered(next); setNotice(decision === 'ask'); }
    });
  }

  async function remove(rule: BrowserUseSiteRule): Promise<void> {
    if (allowAll?.effective) return;
    if (!rulesLoaded || !accessLoaded || !window.memmy?.removeBrowserUseSitePolicy) { setError('error'); return; }
    const covered = remembered.filter(entry => browserUsePatternMatches(rule.pattern, entry.origin));
    if (covered.length && !window.memmy?.setBrowserAccessRule) { setError('error'); return; }
    const current = lifecycle.current;
    await write(async () => {
      // Returning a site to the default must not reactivate an older remembered allow.
      for (const entry of covered) {
        const next = await window.memmy!.setBrowserAccessRule!(entry.origin, 'ask');
        if (current === lifecycle.current) setRemembered(next);
      }
      const next = await window.memmy!.removeBrowserUseSitePolicy!(rule.pattern);
      if (current === lifecycle.current) { setRules(next); setNotice(true); }
    });
  }

  async function changeAllowAll(enabled: boolean): Promise<void> {
    if (!allowAll || allowAll.inherited || !window.memmy?.setBrowserAllowAll) return;
    const current = lifecycle.current;
    const epoch = ++allowAllEpoch.current;
    await write(async () => {
      const state = await window.memmy!.setBrowserAllowAll!(enabled);
      if (current === lifecycle.current && epoch === allowAllEpoch.current) {
        setAllowAll(state); setAllowAllError(false);
      }
    });
  }

  function add(event: FormEvent): void {
    event.preventDefault();
    const normalized = websitePattern(pattern);
    if (!normalized) { setError('invalid'); return; }
    // Re-adding a website must preserve its existing permissions, including advanced settings.
    const existing = rules.find(rule => parseBrowserUsePattern(rule.pattern)?.canonical === normalized);
    void save(existing ?? defaultRule(normalized)).then(saved => { if (saved) setPattern(''); });
  }

  function decisions() {
    return <><option value="ask">{t('browser.policy.ask')}</option>
      <option value="allow">{t('browser.policy.allow')}</option>
      <option value="block">{t('browser.policy.block')}</option></>;
  }
  const disabled = loading || pending || allowAllLoading || Boolean(allowAll?.effective);
  return <div className={`memmy-browser-use-policies${embedded ? ' memmy-browser-use-policies--embedded' : ''}`}>
    {!embedded && <h2>{t('browser.policy.title')}</h2>}
    <section className="memmy-browser-use-policies-all">
      <label className="memmy-browser-use-policies-permission">
        <span><strong>{t('browser.policy.allowAll')}</strong><p>{t('browser.policy.allowAllDescription')}</p></span>
        <input type="checkbox" role="switch" aria-label={t('browser.policy.allowAll')} checked={allowAll?.effective ?? false}
          disabled={!allowAll || loading || pending || allowAll.inherited || !window.memmy?.setBrowserAllowAll}
          onChange={event => void changeAllowAll(event.target.checked)} />
      </label>
      {allowAll?.inherited && <p className="memmy-browser-use-policies-inherited">{t('browser.policy.allowAllInherited')}</p>}
      {allowAll?.effective && <p role="status">{t('browser.policy.allowAllOverrides')}</p>}
    </section>
    <p>{t('browser.policy.defaults')}</p>
    {loading && <p role="status">{t('common.loading')}</p>}
    {loadErrors.includes('rules') && <p className="memmy-browser-use-policies-error" role="alert">{t('browser.policy.error')}</p>}
    {loadErrors.includes('access') && <p className="memmy-browser-use-policies-error" role="alert">{t('browser.error.accessRules')}</p>}
    {allowAllError && <p className="memmy-browser-use-policies-error" role="alert">{t('browser.policy.error')}</p>}
    {error && <p className="memmy-browser-use-policies-error" role="alert">{t(`browser.policy.${error}`)}</p>}
    {notice && <p role="status">{t('browser.policy.resetNotice')}</p>}

    {accessLoaded && remembered.length > 0 && <section className="memmy-browser-use-policies-group">
      <h3>{t('browser.policy.remembered')}</h3><p>{t('browser.policy.rememberedDescription')}</p>
      {remembered.map(entry => <div className="memmy-browser-use-policies-card" key={entry.origin}>
        <div className="memmy-browser-use-policies-card__head">
          <strong>{entry.origin}</strong>
          <button type="button" disabled={disabled || !window.memmy?.setBrowserAccessRule}
            onClick={() => void changeRemembered(entry.origin, 'ask')}>{t('browser.policy.revoke')}</button>
        </div>
        {!allowAll?.effective && rules.some(rule => browserUsePatternMatches(rule.pattern, entry.origin)) && <p>{t('browser.policy.overridden')}</p>}
        <label className="memmy-browser-use-policies-permission">
          <span>{t('browser.policy.access')}</span>
          <select aria-label={`${entry.origin} ${t('browser.policy.remembered')} ${t('browser.policy.access')}`}
            value={entry.decision === 'deny' ? 'block' : 'allow'} disabled={disabled || !window.memmy?.setBrowserAccessRule}
            onChange={event => void changeRemembered(entry.origin, event.target.value as BrowserUseDecision)}>{decisions()}</select>
        </label>
      </div>)}
    </section>}

    <section className="memmy-browser-use-policies-group">
      <h3>{t('browser.policy.websites')}</h3>
      <form onSubmit={add} className="memmy-browser-use-policies-add">
        <input aria-label={t('browser.policy.pattern')} value={pattern} onChange={event => setPattern(event.target.value)}
          placeholder="https://example.com" disabled={disabled || !rulesLoaded} />
        <button type="submit" disabled={disabled || !rulesLoaded || !pattern.trim()}>{t('browser.policy.add')}</button>
      </form>
      {rules.map(rule => <section className="memmy-browser-use-policies-card" key={rule.pattern}>
        <div className="memmy-browser-use-policies-card__head">
          <strong title={rule.pattern}>{rule.pattern}</strong>
          <button type="button" onClick={() => void remove(rule)} disabled={disabled || !accessLoaded}>{t('browser.policy.remove')}</button>
        </div>
        {capabilities.map(capability => <label className="memmy-browser-use-policies-permission" key={capability}>
          <span>{t(`browser.policy.${capability}`)}</span>
          <select aria-label={`${rule.pattern} ${t(`browser.policy.${capability}`)}`}
            value={rule[capability]} disabled={disabled || !rulesLoaded}
            onChange={event => void save({ ...rule, [capability]: event.target.value as BrowserUseDecision })}>{decisions()}</select>
        </label>)}
        <details className="memmy-browser-use-policies-advanced">
          <summary>{t('browser.policy.advanced')}</summary>
          <label className="memmy-browser-use-policies-permission">
            <span>{t('browser.policy.fullCdp')}</span>
            <select aria-label={`${rule.pattern} ${t('browser.policy.fullCdp')}`}
              value={rule.fullCdp} disabled={disabled || !rulesLoaded}
              onChange={event => void save({ ...rule, fullCdp: event.target.value as BrowserUseDecision })}>{decisions()}</select>
          </label>
          <p>{t('browser.policy.debugUnavailable')}</p>
        </details>
      </section>)}
      {rulesLoaded && rules.length === 0 && <p>{t('browser.policy.empty')}</p>}
    </section>
  </div>;
}
