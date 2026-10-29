import type { Session, WebContents } from 'electron';
import { BrowserSitePermissions, type BrowserSitePermission } from './browser-site-permissions.js';
import type { BrowserTaskSitePermissions } from './browser-task-site-permissions.js';

function originOf(input: string | undefined): string | null {
  try {
    const url = new URL(input ?? '');
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch { return null; }
}

function sitePermission(permission: string, mediaType?: string): BrowserSitePermission | null {
  if (permission === 'geolocation' || permission === 'notifications'
    || permission === 'clipboard-read' || permission === 'idle-detection'
    || permission === 'midi' || permission === 'midiSysex' || permission === 'pointerLock') return permission;
  if (permission === 'deprecated-sync-clipboard-read') return 'clipboard-read';
  if (permission === 'clipboard-sanitized-write') return 'clipboard-write';
  if (permission === 'media') {
    if (mediaType === 'video') return 'camera';
    if (mediaType === 'audio') return 'microphone';
  }
  return null;
}

/**
 * Applies persisted embedded-browser grants, overridden on one tab by a live Agent task choice;
 * ungranted device and host APIs stay denied.
 */
export function attachBrowserWebviewPermissions(browserSession: Session, agentDataDirectory: string,
  taskPermissions: BrowserTaskSitePermissions): () => void {
  const grants = new BrowserSitePermissions(agentDataDirectory);
  const allowed = (contents: WebContents | null, rawOrigin: string | undefined, permission: BrowserSitePermission): boolean => {
    const origin = originOf(rawOrigin);
    const task = origin && contents ? taskPermissions.decision(contents.id, origin, permission) : undefined;
    if (task !== undefined) return task;
    const permissions = origin && grants.list().find(record => record.origin === origin)?.permissions;
    // SysEx can address MIDI hardware more broadly than ordinary note events.
    return Boolean(permissions?.includes(permission)
      && (permission !== 'midiSysex' || permissions.includes('midi')));
  };
  browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const site = sitePermission(permission, details.mediaType);
    if (site) return allowed(contents, details.securityOrigin ?? requestingOrigin, site);
    // Normal page storage remains available; device and host APIs require explicit handling.
    return permission === 'storage-access' || permission === 'top-level-storage-access' || permission === 'fullscreen';
  });
  browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === 'media') {
      const types = ('mediaTypes' in details ? details.mediaTypes : undefined) ?? [];
      callback(types.length > 0 && types.every(type => {
        const site = sitePermission(permission, type);
        return Boolean(site && allowed(contents, 'securityOrigin' in details ? details.securityOrigin : details.requestingUrl, site));
      }));
      return;
    }
    const site = sitePermission(permission);
    callback(site ? allowed(contents, details.requestingUrl, site)
      : permission === 'storage-access' || permission === 'top-level-storage-access' || permission === 'fullscreen');
  });
  return () => {
    browserSession.setPermissionCheckHandler(null);
    browserSession.setPermissionRequestHandler(null);
  };
}
