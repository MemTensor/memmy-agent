import { expect, it } from 'vitest';
import { browserExtensionApprovalDialog } from '../src/main/browser-webview-extension-dialog.js';

const details = { directory: '/selected/unpacked', name: 'Example', version: '1.0',
  permissions: ['storage'], hostPermissions: ['https://example.com/*'], optionalPermissions: ['tabs'],
  optionalHostPermissions: ['https://optional.example/*'], contentScriptMatches: ['https://script.example/*'] };

it('shows all declared permissions in a native confirmation with cancel as the default', () => {
  const dialog = browserExtensionApprovalDialog(details, true);
  expect(dialog).toMatchObject({ type: 'warning', defaultId: 0, cancelId: 0,
    buttons: ['取消', '安装扩展'] });
  for (const item of ['/selected/unpacked', 'storage', 'https://example.com/*', 'tabs',
    'https://optional.example/*', 'https://script.example/*']) expect(dialog.detail).toContain(item);
  expect(browserExtensionApprovalDialog(details, false, true)).toMatchObject({
    title: 'Reapprove browser extension', buttons: ['Cancel', 'Reapprove'],
  });
});
