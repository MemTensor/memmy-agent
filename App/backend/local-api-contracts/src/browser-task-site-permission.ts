export const BROWSER_TASK_SITE_PERMISSIONS = ['camera', 'microphone'] as const;
export type BrowserTaskSitePermission = typeof BROWSER_TASK_SITE_PERMISSIONS[number];
export type BrowserTaskSitePermissionRequest = {
  origin: string;
  permission: BrowserTaskSitePermission;
  allow: boolean;
};

export function parseBrowserTaskSitePermission(value: unknown): BrowserTaskSitePermissionRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.origin !== 'string' || input.origin.length > 320
    || !BROWSER_TASK_SITE_PERMISSIONS.includes(input.permission as BrowserTaskSitePermission)
    || typeof input.allow !== 'boolean') return null;
  try {
    const url = new URL(input.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== input.origin) return null;
  } catch { return null; }
  return { origin: input.origin, permission: input.permission as BrowserTaskSitePermission, allow: input.allow };
}
