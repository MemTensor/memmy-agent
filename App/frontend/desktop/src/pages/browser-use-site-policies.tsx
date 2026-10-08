import { useEffect, useState, type FormEvent } from 'react';
import type { BrowserUseCapability, BrowserUseDecision, BrowserUseSiteRule } from '@memmy/local-api-contracts';
import { useTranslation } from '../i18n/use-translation.js';
import './browser-use-site-policies.css';

const capabilities: BrowserUseCapability[] = ['access', 'downloads', 'uploads', 'fullCdp'];
const defaultRule = (pattern: string): BrowserUseSiteRule => ({ pattern,
  access: 'ask', downloads: 'ask', uploads: 'ask', fullCdp: 'block' });

export function BrowserUseSitePolicies() {
  const { t } = useTranslation();
  const [rules, setRules] = useState<BrowserUseSiteRule[]>([]);
  const [pattern, setPattern] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void window.memmy?.getBrowserUseSitePolicies?.().then(value => {
      if (active) setRules(value);
    }).catch(() => { if (active) setError(t('browser.policy.error')); });
    return () => { active = false; };
  }, [t]);

  async function save(rule: BrowserUseSiteRule): Promise<boolean> {
    if (!window.memmy?.upsertBrowserUseSitePolicy) { setError(t('browser.policy.error')); return false; }
    setPending(true); setError('');
    try { setRules(await window.memmy.upsertBrowserUseSitePolicy(rule)); return true; }
    catch { setError(t('browser.policy.invalid')); return false; }
    finally { setPending(false); }
  }

  async function remove(value: string): Promise<void> {
    if (!window.memmy?.removeBrowserUseSitePolicy) { setError(t('browser.policy.error')); return; }
    setPending(true); setError('');
    try { setRules(await window.memmy.removeBrowserUseSitePolicy(value)); }
    catch { setError(t('browser.policy.error')); }
    finally { setPending(false); }
  }

  function add(event: FormEvent) {
    event.preventDefault();
    if (!pattern.trim()) return;
    void save(defaultRule(pattern)).then(saved => { if (saved) setPattern(''); });
  }

  return <div className="memmy-browser-settings memmy-browser-use-policies">
    <h2>{t('browser.policy.title')}</h2>
    <p>{t('browser.policy.description')}</p>
    <p>{t('browser.policy.defaults')}</p>
    <form onSubmit={add} className="memmy-browser-use-policies-add">
      <input aria-label={t('browser.policy.pattern')} value={pattern} onChange={event => setPattern(event.target.value)}
        placeholder="https://*.example.com" disabled={pending} />
      <button type="submit" disabled={pending || !pattern.trim()}>{t('browser.policy.add')}</button>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    {rules.length ? <div className="memmy-browser-use-policies-list">{rules.map(rule => <section className="memmy-browser-use-policies-card" key={rule.pattern}>
      <div className="memmy-browser-use-policies-card__head">
        <strong title={rule.pattern}>{rule.pattern}</strong>
        <button type="button" onClick={() => void remove(rule.pattern)} disabled={pending}>{t('browser.policy.remove')}</button>
      </div>
      <div className="memmy-browser-use-policies-card__grid">
        {capabilities.map(capability => <label key={capability}>
          <span>{t(`browser.policy.${capability}`)}</span>
          <select aria-label={`${rule.pattern} ${t(`browser.policy.${capability}`)}`}
            value={rule[capability]} disabled={pending}
            onChange={event => void save({ ...rule, [capability]: event.target.value as BrowserUseDecision })}>
            <option value="block">{t('browser.policy.block')}</option>
            <option value="ask">{t('browser.policy.ask')}</option>
            <option value="allow">{t('browser.policy.allow')}</option>
          </select>
        </label>)}
      </div>
    </section>)}</div> : <p>{t('browser.policy.empty')}</p>}
    <p>{t('browser.policy.debugUnavailable')}</p>
  </div>;
}
