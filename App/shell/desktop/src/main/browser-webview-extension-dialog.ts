import type { MessageBoxOptions } from 'electron';
import type { BrowserExtensionInstallDetails } from './browser-webview-extensions.js';

/** Native approval text shows every declared site and script match; cancel is the default. */
export function browserExtensionApprovalDialog(details: BrowserExtensionInstallDetails,
  chinese: boolean, reapproval = false): MessageBoxOptions {
  const list = (label: string, values: string[]) => `${label}: ${values.length ? values.join(', ') : chinese ? '无' : 'None'}`;
  return {
    type: 'warning', noLink: true, defaultId: 0, cancelId: 0,
    title: chinese ? reapproval ? '重新批准浏览器扩展' : '安装浏览器扩展'
      : reapproval ? 'Reapprove browser extension' : 'Install browser extension',
    message: `${details.name} (${details.version})`,
    detail: [
      chinese ? '扩展只在 Memmy 内置浏览器运行，可在获准网站读取或修改内容。请核对来源和权限。'
        : 'This extension runs only in Memmy’s built-in browser. It can read or change content on permitted sites. Review its source and permissions.',
      list(chinese ? '来源目录' : 'Selected folder', [details.directory]),
      list(chinese ? '权限' : 'Permissions', details.permissions),
      list(chinese ? '访问的网站' : 'Site access', details.hostPermissions),
      list(chinese ? '可选权限' : 'Optional permissions', details.optionalPermissions),
      list(chinese ? '可选网站访问' : 'Optional site access', details.optionalHostPermissions),
      list(chinese ? '内容脚本匹配网站' : 'Content script sites', details.contentScriptMatches),
    ].join('\n'),
    buttons: chinese ? ['取消', reapproval ? '重新批准' : '安装扩展']
      : ['Cancel', reapproval ? 'Reapprove' : 'Install extension'],
  };
}
