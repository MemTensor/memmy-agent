import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Modal } from '../components/modal.js';
import { useTranslation } from '../i18n/use-translation.js';
import { BrowserUseSitePolicies } from './browser-use-site-policies.js';
import styles from './browser-agent-settings.module.css';

type DownloadSettings = { directory: string | null; askBeforeDownload: boolean };

export function BrowserAgentSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<DownloadSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'load' | 'save' | null>(null);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const manageButton = useRef<HTMLButtonElement>(null);
  const lifecycle = useRef(0);
  const writing = useRef(false);

  useEffect(() => {
    const current = ++lifecycle.current;
    const read = window.memmy?.getBrowserDownloadSettings;
    void (async () => {
      try {
        if (!read) throw new Error('Download settings unavailable');
        const value = await read();
        if (current === lifecycle.current) { setSettings(value); setError(null); }
      } catch {
        if (current === lifecycle.current) setError('load');
      } finally {
        if (current === lifecycle.current) setLoading(false);
      }
    })();
    return () => { lifecycle.current++; };
  }, []);

  async function update(action: (() => Promise<DownloadSettings>) | undefined): Promise<void> {
    if (loading || !settings || writing.current || !action) return;
    const current = lifecycle.current;
    writing.current = true;
    setBusy(true); setError(null);
    try {
      const value = await action();
      if (current === lifecycle.current) setSettings(value);
    } catch {
      if (current === lifecycle.current) setError('save');
    } finally {
      if (current === lifecycle.current) { writing.current = false; setBusy(false); }
    }
  }

  const disabled = loading || busy || !settings;
  function closePermissions(): void {
    setPermissionsOpen(false);
    manageButton.current?.focus();
  }
  return <section className={styles.section}>
    <div className="memmy-browser-settings-row">
      <span>{t('browser.policy.title')}<small>{t('browser.policy.description')}</small></span>
      <button ref={manageButton} type="button" onClick={() => setPermissionsOpen(true)}>
        {t('browser.settings.manage')}
      </button>
    </div>
    <div>
      <div className="memmy-browser-settings-row">
        <span>
          {t('browser.settings.downloadLocation')}
          {settings ? <small title={settings.directory ?? undefined}>
            {settings.directory ?? t('browser.settings.defaultLocation')}
          </small> : null}
        </span>
        <span className="memmy-browser-settings-actions">
          <button type="button" disabled={disabled || !window.memmy?.chooseBrowserDownloadDirectory}
            onClick={() => void update(window.memmy?.chooseBrowserDownloadDirectory)}>
            {t('browser.settings.changeLocation')}
          </button>
          {settings?.directory ? <button type="button"
            disabled={disabled || !window.memmy?.resetBrowserDownloadDirectory}
            onClick={() => void update(window.memmy?.resetBrowserDownloadDirectory)}>
            {t('browser.settings.resetLocation')}
          </button> : null}
        </span>
      </div>
      <label>
        <span>{t('browser.settings.askBeforeDownload')}</span>
        <input type="checkbox" role="switch"
          aria-label={t('browser.settings.askBeforeDownload')} checked={settings?.askBeforeDownload ?? false}
          disabled={disabled || !window.memmy?.setBrowserAskBeforeDownload}
          onChange={event => {
            const enabled = event.target.checked;
            const write = window.memmy?.setBrowserAskBeforeDownload;
            void update(write ? () => write(enabled) : undefined);
          }} />
      </label>
      {error ? <p className={styles.error} role="alert">{t(error === 'load'
        ? 'browser.error.downloadLocation' : 'browser.error.setDownloadLocation')}</p> : null}
    </div>
    {permissionsOpen && createPortal(<Modal open title={t('browser.policy.title')}
      className="memmy-browser-permissions-dialog" bodyClassName={styles.dialogBody}
      closeLabel={t('common.close')} closeContent={<X size={16} aria-hidden="true" />}
      onClose={closePermissions} style={{ width: 640, maxWidth: 'calc(100vw - 32px)' }}>
      <BrowserUseSitePolicies embedded />
    </Modal>, document.body)}
  </section>;
}
