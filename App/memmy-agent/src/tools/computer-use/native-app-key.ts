const CHROME = /^(?:com\.google\.chrome(?:\.(?:beta|dev|canary))?|google chrome(?: (?:beta|dev|canary))?|chrome(?:\.exe)?)$/i;
const EDGE = /^(?:com\.microsoft\.edgemac(?:\.(?:beta|dev|canary))?|microsoft edge(?: (?:beta|dev|canary))?|msedge(?:\.exe)?|edge)$/i;

export function browserAppKey(browser: 'chrome' | 'edge'): string {
  return `browser:${browser}`;
}

/** A connected Chrome/Edge tab and that browser's native windows share one key. */
export function nativeAppKey(app: { platform: string; appId: string; displayName: string } | null,
  target: string, platform: string = process.platform): string {
  const names = [app?.appId, app?.displayName, target].map(value => String(value ?? '').trim()).filter(Boolean);
  if (names.some(name => CHROME.test(name))) return browserAppKey('chrome');
  if (names.some(name => EDGE.test(name))) return browserAppKey('edge');
  return `app:${app?.platform ?? platform}:${(app?.appId ?? target).trim().toLowerCase()}`.slice(0, 256);
}
