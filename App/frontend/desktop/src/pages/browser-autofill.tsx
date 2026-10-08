import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from '../i18n/use-translation.js';

type Summary = { available: boolean; credentials: Array<{ id: string; origin: string; username: string }>; contactSaved: boolean };
type Contact = { name: string; email: string; phone: string; address: string };
const EMPTY_CONTACT: Contact = { name: '', email: '', phone: '', address: '' };

function browserOrigin(input: string | null): string | null {
  try {
    const url = new URL(input ?? '');
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch { return null; }
}

export type BrowserAutofillSection = 'passwords' | 'contact';

/** The renderer receives credential metadata and contact presence only; secrets stay in the desktop vault. */
export function BrowserAutofill({ section, origin, sessionKey, tabId = null }: {
  section: BrowserAutofillSection; origin: string | null; sessionKey: string | null; tabId?: number | null;
}) {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [passwordOrigin, setPasswordOrigin] = useState(browserOrigin(origin) ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [contact, setContact] = useState<Contact>(EMPTY_CONTACT);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const load = window.memmy?.getBrowserAutofill;
    if (!load) { setError(t('browser.autofill.loadFailed')); return; }
    void load().then(value => { if (active) { setSummary(value); setError(''); } })
      .catch(() => { if (active) setError(t('browser.autofill.loadFailed')); });
    return () => { active = false; };
  }, [t]);
  useEffect(() => { if (origin && !editingId) setPasswordOrigin(browserOrigin(origin) ?? ''); }, [origin, editingId]);

  async function savePassword(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (!window.memmy?.saveBrowserCredential) throw new Error('Unavailable');
      const site = browserOrigin(passwordOrigin.trim());
      if (!site) throw new Error('Invalid site');
      setSummary(await window.memmy.saveBrowserCredential(site, username.trim(), password));
      setPassword(''); setUsername(''); setEditingId(null); setError('');
    } catch { setError(t('browser.autofill.saveFailed')); }
    finally { setBusy(false); }
  }
  async function saveContact(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (!window.memmy?.saveBrowserContact) throw new Error('Unavailable');
      setSummary(await window.memmy.saveBrowserContact(contact));
      setContact(EMPTY_CONTACT); setError('');
    } catch { setError(t('browser.autofill.saveFailed')); }
    finally { setBusy(false); }
  }
  async function fillCredential(id: string): Promise<void> {
    if (busy || (!sessionKey && !tabId)) return;
    setBusy(true);
    try {
      if (tabId) {
        if (!window.memmy?.fillBrowserWebviewCredential
          || await window.memmy.fillBrowserWebviewCredential(tabId, id) < 1) throw new Error('No matching browser tab');
      } else if (!sessionKey || !window.memmy?.fillBrowserCredential
        || !await window.memmy.fillBrowserCredential(sessionKey, id)) throw new Error('No matching browser tab');
      setError('');
    } catch { setError(t('browser.autofill.fillFailed')); }
    finally { setBusy(false); }
  }
  async function fillContact(): Promise<void> {
    if (busy || (!sessionKey && !tabId)) return;
    setBusy(true);
    try {
      if (!currentOrigin) throw new Error('No matching browser tab');
      if (tabId) {
        if (!window.memmy?.fillBrowserWebviewContact
          || await window.memmy.fillBrowserWebviewContact(tabId) < 1) throw new Error('No matching browser tab');
      } else if (!sessionKey || !window.memmy?.fillBrowserContact
        || !await window.memmy.fillBrowserContact(sessionKey, currentOrigin)) throw new Error('No matching browser tab');
      setError('');
    } catch { setError(t('browser.autofill.fillFailed')); }
    finally { setBusy(false); }
  }
  async function deleteCredential(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (!window.memmy?.deleteBrowserCredential) throw new Error('Unavailable');
      setSummary(await window.memmy.deleteBrowserCredential(id));
      if (editingId === id) { setEditingId(null); setPassword(''); }
      setError('');
    } catch { setError(t('browser.autofill.deleteFailed')); }
    finally { setBusy(false); }
  }
  async function deleteContact(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (!window.memmy?.deleteBrowserContact) throw new Error('Unavailable');
      setSummary(await window.memmy.deleteBrowserContact()); setContact(EMPTY_CONTACT); setError('');
    } catch { setError(t('browser.autofill.deleteFailed')); }
    finally { setBusy(false); }
  }

  const currentOrigin = browserOrigin(origin);
  return <div className="memmy-browser-settings memmy-browser-autofill">
    <h2>{t(section === 'passwords' ? 'browser.autofill.passwords' : 'browser.autofill.contact')}</h2>
    <p>{t(section === 'passwords' ? 'browser.autofill.description' : 'browser.autofill.contactDescription')}</p>
    {summary && !summary.available ? <p role="alert">{t('browser.autofill.encryptionUnavailable')}</p> : null}
    {section === 'passwords' ? <>
      <form onSubmit={event => void savePassword(event)}>
        <label>{t('browser.autofill.site')}<input required type="url" readOnly={editingId !== null} value={passwordOrigin}
          onChange={event => setPasswordOrigin(event.target.value)} placeholder="https://example.com" /></label>
        <label>{t('browser.autofill.username')}<input required autoComplete="off" readOnly={editingId !== null} value={username}
          onChange={event => setUsername(event.target.value)} /></label>
        <label>{t('browser.autofill.password')}<input required type="password" autoComplete="new-password" value={password}
          onChange={event => setPassword(event.target.value)} /></label>
        <button type="submit" disabled={!summary?.available || busy}>{t(editingId
          ? 'browser.autofill.replacePassword' : 'browser.autofill.savePassword')}</button>
        {editingId ? <button type="button" disabled={busy} onClick={() => {
          setEditingId(null); setPassword(''); setUsername(''); setPasswordOrigin(browserOrigin(origin) ?? '');
        }}>{t('browser.autofill.cancelEdit')}</button> : null}
      </form>
      {summary?.credentials.length === 0 ? <p>{t('browser.autofill.passwordsEmpty')}</p> : null}
      {summary?.credentials.map(item => <div className="memmy-browser-settings-row" key={item.id}>
        <span><strong>{item.username}</strong><br /><small>{item.origin}</small></span>
        <span className="memmy-browser-settings-actions">
          <button type="button" disabled={busy} onClick={() => {
            setEditingId(item.id); setPasswordOrigin(item.origin); setUsername(item.username); setPassword(''); setError('');
          }}>{t('browser.autofill.edit')}</button>
          {(sessionKey || tabId) && currentOrigin === item.origin ? <button type="button" disabled={busy}
            onClick={() => void fillCredential(item.id)}>{t('browser.autofill.fill')}</button> : null}
          <button type="button" disabled={busy} onClick={() => void deleteCredential(item.id)}>{t('browser.autofill.delete')}</button>
        </span>
      </div>)}
    </> : <>
      <p>{summary?.contactSaved ? t('browser.autofill.contactSaved') : t('browser.autofill.contactEmpty')}</p>
      <form onSubmit={event => void saveContact(event)}>
        {(['name', 'email', 'phone', 'address'] as const).map(field =>
          <label key={field}>{t(`browser.autofill.${field}` as Parameters<typeof t>[0])}<input
            type={field === 'email' ? 'email' : 'text'} value={contact[field]}
            onChange={event => setContact(current => ({ ...current, [field]: event.target.value }))} /></label>)}
        <button type="submit" disabled={!summary?.available || busy}>{t(summary?.contactSaved
          ? 'browser.autofill.replaceContact' : 'browser.autofill.saveContact')}</button>
        {summary?.contactSaved ? <>{sessionKey || tabId ? <button type="button" disabled={!currentOrigin || busy}
          onClick={() => void fillContact()}>{t('browser.autofill.fillContact')}</button> : null}
          <button type="button" disabled={busy} onClick={() => void deleteContact()}>{t('browser.autofill.deleteContact')}</button></> : null}
      </form>
    </>}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
