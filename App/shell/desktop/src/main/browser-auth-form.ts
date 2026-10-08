import { BrowserWindow } from 'electron';
import type { BrowserAuthRequest } from './browser-auth-request.js';

export type BrowserAuthAnswer = { selected_option?: string; values: Record<string, string> };
export type BrowserAuthFormResult = BrowserAuthAnswer | { status: 'expired' } | null;
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

/** Isolated native window: credentials go only from this transient renderer to desktop main. */
export async function showBrowserAuthForm(parent: BrowserWindow, request: BrowserAuthRequest,
  isCurrent: () => boolean): Promise<BrowserAuthFormResult> {
  if (parent.isDestroyed() || !isCurrent()) return null;
  const window = new BrowserWindow({ parent, modal: true, show: false, width: 480,
    height: Math.min(690, 300 + request.fields.length * 76), minWidth: 420, minHeight: 260,
    title: 'Memmy browser sign-in', backgroundColor: '#fff',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, partition: `browser-auth-${Date.now()}-${Math.random()}` } });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  const fieldHtml = request.fields.map(field => `<label class="field" data-field="${escapeHtml(field.id)}">
    <span>${escapeHtml(field.label)}</span><input name="${escapeHtml(field.id)}"
    type="${escapeHtml(field.type)}" autocomplete="off" maxlength="4096" ${field.required ? 'required' : ''}></label>`).join('');
  const optionHtml = request.options?.map(option => `<option value="${escapeHtml(option.id)}">${escapeHtml(option.label)}</option>`).join('') ?? '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
    <style>body{font:14px system-ui,sans-serif;color:#17212b;padding:24px;margin:0;background:#fff}
    h2{margin:0 0 8px;font-size:20px}p{line-height:1.5;color:#485565}.site{font-weight:600;overflow-wrap:anywhere}
    label.field{display:block;margin:14px 0}label.field span{display:block;margin-bottom:5px}
    input,select{box-sizing:border-box;width:100%;padding:9px;font:inherit;border:1px solid #aaa;border-radius:6px}
    .buttons{display:flex;gap:12px;justify-content:flex-end;margin-top:24px}button{padding:9px 16px;font:inherit}</style></head>
    <body><h2>Sign in to this website</h2><p>Memmy will enter these values only in the current browser tab.
    The assistant will receive only a status.</p><p class="site">${escapeHtml(request.origin)}</p>
    <form id="auth">${request.options ? `<label class="field"><span>Continue with</span><select name="selected_option">${optionHtml}</select></label>` : ''}
    ${fieldHtml}<div class="buttons"><button type="button" id="cancel">Cancel</button>
    <button type="submit">Continue</button></div></form></body></html>`;
  const closed = new Promise<null>(resolve => window.once('closed', () => resolve(null)));
  let expired = false;
  const timer = setTimeout(() => { expired = true; if (!window.isDestroyed()) window.close(); }, 5 * 60_000);
  const currentCheck = setInterval(() => { if (!isCurrent() && !window.isDestroyed()) window.close(); }, 250);
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    if (!isCurrent() || window.isDestroyed()) return null;
    window.show(); window.focus();
    const optionFields = Object.fromEntries((request.options ?? []).map(option =>
      [option.id, option.selector ? [] : option.field_ids ?? request.fields.map(field => field.id)]));
    const answer = window.webContents.executeJavaScript(`new Promise(resolve => {
      const form = document.getElementById('auth');
      const optionFields = ${JSON.stringify(optionFields)};
      const select = form.elements.namedItem('selected_option');
      const update = () => {
        const selected = select ? optionFields[select.value] || [] : null;
        for (const field of form.querySelectorAll('[data-field]')) {
          const visible = !selected || selected.includes(field.dataset.field);
          field.hidden = !visible;
          field.querySelector('input').disabled = !visible;
        }
      };
      if (select) select.addEventListener('change', update);
      update();
      document.getElementById('cancel').addEventListener('click', () => resolve(null), { once: true });
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (!form.reportValidity()) return;
        const data = new FormData(form), values = {};
        for (const [key, value] of data.entries()) if (key !== 'selected_option') values[key] = String(value);
        resolve({ selected_option: data.get('selected_option') || undefined, values });
      }, { once: true });
    })`, true).catch(() => null);
    const result = await Promise.race([answer, closed]);
    if (expired) return { status: 'expired' };
    return isCurrent() && result && typeof result === 'object' ? result as BrowserAuthAnswer : null;
  } finally {
    clearTimeout(timer);
    clearInterval(currentCheck);
    if (!window.isDestroyed()) window.close();
  }
}
