import { useEffect, useState } from 'react';
import './browser-extensions.css';

export type BrowserExtensionEntry = { id: string; name: string; version: string; directory: string;
  loaded: boolean; needsReapproval: boolean };
type InstallResult = { status: 'cancelled' } | { status: 'installed'; extension: BrowserExtensionEntry };
export type BrowserExtensionActions = {
  list(): Promise<BrowserExtensionEntry[]>;
  install(): Promise<InstallResult>;
  reapprove(id: string): Promise<InstallResult>;
  remove(id: string): Promise<boolean>;
};
export type BrowserExtensionLabels = { title: string; description: string; permissionNotice: string;
  install: string; empty: string; loaded: string; unavailable: string; needsReapproval: string;
  reapprove: string; remove: string; loadFailed: string; actionFailed: string };

/** The native host owns directory selection, manifest review, and confirmation. */
export function BrowserExtensions({ actions, labels }: { actions: BrowserExtensionActions; labels: BrowserExtensionLabels }) {
  const [entries, setEntries] = useState<BrowserExtensionEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void actions.list().then(value => { if (active) { setEntries(value); setError(''); } })
      .catch(() => { if (active) setError(labels.loadFailed); });
    return () => { active = false; };
  }, [actions, labels.loadFailed]);

  async function perform(action: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      setEntries(await actions.list());
      setError('');
    } catch { setError(labels.actionFailed); }
    finally { setBusy(false); }
  }

  return <div className="memmy-browser-settings memmy-browser-extensions">
    <h2>{labels.title}</h2>
    <p>{labels.description}</p>
    <p>{labels.permissionNotice}</p>
    <button type="button" disabled={busy} onClick={() => void perform(() => actions.install())}>{labels.install}</button>
    {entries.length === 0 ? <p>{labels.empty}</p> : null}
    {entries.map(entry => <div className="memmy-browser-settings-row memmy-browser-extensions-entry" key={entry.id}>
      <span className="memmy-browser-extensions-entry__text">
        <span className="memmy-browser-extensions-entry__title"><strong>{entry.name}</strong><small>{entry.version}</small></span>
        <small className="memmy-browser-extensions-entry__path" title={entry.directory}>{entry.directory}</small>
        <small>{entry.loaded ? labels.loaded : labels.unavailable}</small>
        {entry.needsReapproval ? <small className="memmy-browser-extensions-reapproval">{labels.needsReapproval}</small> : null}
      </span>
      <span className="memmy-browser-settings-actions">
        {entry.needsReapproval ? <button type="button" disabled={busy}
          aria-label={`${labels.reapprove}: ${entry.name}`} onClick={() => void perform(() => actions.reapprove(entry.id))}>
          {labels.reapprove}</button> : null}
        <button type="button" disabled={busy} aria-label={`${labels.remove}: ${entry.name}`}
          onClick={() => void perform(async () => {
            if (!await actions.remove(entry.id)) throw new Error('Could not remove extension');
          })}>{labels.remove}</button>
      </span>
    </div>)}
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
