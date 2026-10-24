import { readFileSync, mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { installedExternalBrowsers, probeExternalBrowserInstallation, MEMMY_BROWSER_EXTENSION_ID } from '../src/main/installed-external-browsers.js';

const manifest = JSON.parse(readFileSync(new URL('../extensions/memmy-browser/manifest.json', import.meta.url), 'utf8'));
const extensionPath = '/Applications/Memmy.app/Contents/Resources/browser-extension';
const chromeRoot = '/fixture/Library/Application Support/Google/Chrome';
const edgeRoot = '/fixture/Library/Application Support/Microsoft Edge';

function io(entries: Record<string, unknown>, existing = new Set<string>()) {
  const stored = new Map(Object.entries(entries).map(([path, value]) => [path, JSON.stringify(value)]));
  return {
    fileExists: (path: string) => existing.has(path) || [...stored.keys()].some(file =>
      file === path || file.startsWith(path + (path.includes('\\') ? '\\' : '/'))),
    readFile: (path: string) => {
      const value = stored.get(path);
      if (value === undefined) throw new Error(`missing fixture ${path}`);
      return value;
    },
  };
}

function prefs(record: unknown) {
  return { extensions: { settings: record === null ? {} : { [MEMMY_BROWSER_EXTENSION_ID]: record } } };
}
function enabled(extra: Record<string, unknown> = {}) {
  return { location: 4, path: extensionPath, disable_reasons: [], ...extra };
}
function mac(entries: Record<string, unknown>) {
  return installedExternalBrowsers({ platform: 'darwin', home: '/fixture', ...io(entries) });
}
function chromeRecord(record: unknown, extra: Record<string, unknown> = {}) {
  return {
    [join(chromeRoot, 'Default', 'Secure Preferences')]: prefs(record),
    [join(extensionPath, 'manifest.json')]: manifest,
    ...extra,
  };
}

describe('installed external browsers', () => {
  it('recognizes validated unpacked manifests without an obsolete state field or live worker', () => {
    expect(mac({
      [join(chromeRoot, 'Local State')]: { profile: { info_cache: { Default: {} } } },
      [join(chromeRoot, 'Default', 'Secure Preferences')]: prefs(enabled()),
      [join(edgeRoot, 'Local State')]: { profile: { info_cache: { 'Profile 2': {} } } },
      [join(edgeRoot, 'Profile 2', 'Secure Preferences')]: prefs(enabled({ state: 1 })),
      [join(extensionPath, 'manifest.json')]: manifest,
    })).toEqual(['chrome', 'edge']);
  });

  it.each([{}, [], 'removed', { state: 1 }, { path: extensionPath }, enabled({ path: '' }),
    enabled({ path: 42 }), enabled({ path: '/missing/extension' }), enabled({ path: 'relative/unpacked' }),
    enabled({ location: '4' }), enabled({ location: 0 }), enabled({ state: '1' }),
    enabled({ state: 2 }), enabled({ disable_reasons: '0' }), enabled({ disable_reasons: null }),
  ])('rejects empty, malformed or missing installation metadata: %j', record => {
    expect(mac(chromeRecord(record))).toEqual([]);
  });

  it('falls back from an empty Secure Preferences residue to a complete ordinary record', () => {
    expect(mac(chromeRecord({}, {
      [join(chromeRoot, 'Default', 'Preferences')]: prefs(enabled()),
    }))).toEqual(['chrome']);
  });

  it.each([{ state: 0 }, { disable_reasons: [1024] }, { disable_reasons: 4 },
    { disable_reasons: ['permissions_increase'] },
  ])('never overrides an explicit secure disable with ordinary enabled preferences: %j', disabled => {
    expect(mac(chromeRecord(disabled, {
      [join(chromeRoot, 'Default', 'Preferences')]: prefs(enabled()),
    }))).toEqual([]);
  });

  it('uses ordinary Preferences when no secure record exists', () => {
    expect(mac({
      [join(chromeRoot, 'Default', 'Preferences')]: prefs(enabled({ disable_reasons: 0 })),
      [join(extensionPath, 'manifest.json')]: manifest,
    })).toEqual(['chrome']);
  });

  it('requires the actual unpacked manifest and its expected extension identity', () => {
    expect(mac({ [join(chromeRoot, 'Default', 'Preferences')]: prefs(enabled()) })).toEqual([]);
    for (const invalidManifest of [{}, { ...manifest, key: undefined }, { ...manifest, key: 'YWJj' },
      { ...manifest, manifest_version: '3' }, { ...manifest, version: 'broken' }]) {
      expect(mac(chromeRecord(enabled(), { [join(extensionPath, 'manifest.json')]: invalidManifest }))).toEqual([]);
    }
  });

  it('resolves relative packed paths under the selected profile Extensions directory', () => {
    const relative = `${MEMMY_BROWSER_EXTENSION_ID}/1.0.0_0`;
    const packedManifest = { ...manifest }; delete packedManifest.key;
    expect(mac(chromeRecord({ location: 1, path: relative, disable_reasons: [] }, {
      [join(chromeRoot, 'Default', 'Extensions', relative, 'manifest.json')]: packedManifest,
    }))).toEqual(['chrome']);
    for (const path of ['../outside', `${MEMMY_BROWSER_EXTENSION_ID}/../outside`, 'other-id/1.0.0_0']) {
      expect(mac(chromeRecord({ location: 1, path }))).toEqual([]);
    }
  });

  it('rejects a mismatched manifest key even under the expected packed folder', () => {
    const relative = `${MEMMY_BROWSER_EXTENSION_ID}/1.0.0_0`;
    expect(mac(chromeRecord({ location: 1, path: relative }, {
      [join(chromeRoot, 'Default', 'Extensions', relative, 'manifest.json')]: { ...manifest, key: 'YWJj' },
    }))).toEqual([]);
  });

  it('reads Windows profiles, validates the payload and ignores unsafe profile names', () => {
    const local = 'C:\\Users\\fixture\\AppData\\Local';
    const root = win32.join(local, 'Google', 'Chrome', 'User Data');
    const path = 'C:\\Program Files\\Memmy\\resources\\browser-extension';
    expect(installedExternalBrowsers({ platform: 'win32', env: { LOCALAPPDATA: local }, ...io({
      [win32.join(root, 'Local State')]: { profile: { info_cache: { Default: {}, 'Profile 3': {}, '../Outside': {} } } },
      [win32.join(root, 'Default', 'Secure Preferences')]: prefs({}),
      [win32.join(root, 'Profile 3', 'Preferences')]: prefs(enabled({ path })),
      [win32.join(path, 'manifest.json')]: manifest,
    }) })).toEqual(['chrome']);
  });

  it('resolves Windows packed path separators without reading a relative working-directory path', () => {
    const local = 'C:\\Users\\fixture\\AppData\\Local';
    const root = win32.join(local, 'Microsoft', 'Edge', 'User Data');
    const relative = `${MEMMY_BROWSER_EXTENSION_ID}\\1.0.0_0`;
    expect(installedExternalBrowsers({ platform: 'win32', env: { LOCALAPPDATA: local }, ...io({
      [win32.join(root, 'Default', 'Preferences')]: prefs({ location: 1, path: relative }),
      [win32.join(root, 'Default', 'Extensions', relative, 'manifest.json')]: manifest,
    }) })).toEqual(['edge']);
  });

  it('does not call a browser installed when manifest reading fails', () => {
    const files = io(chromeRecord(enabled()));
    expect(installedExternalBrowsers({ platform: 'darwin', home: '/fixture', ...files,
      readFile: path => { if (path.endsWith('manifest.json')) throw new Error('unavailable'); return files.readFile(path); },
    })).toEqual([]);
  });
});

describe('external browser installation facts for recovery', () => {
  it.each([undefined, '/fixture/xdg'])('retains Linux installation detection with config root %s', config => {
    const root = join(config ?? '/fixture/.config', 'google-chrome');
    const edge = join(config ?? '/fixture/.config', 'microsoft-edge');
    const localState = { profile: { info_cache: { Default: {} } } };
    for (const disabled of [false, true]) {
      const files = io({
        [join(root, 'Local State')]: localState,
        [join(root, 'Default', 'Secure Preferences')]: prefs(enabled({ disable_reasons: disabled ? [1024] : [] })),
        [join(edge, 'Local State')]: localState,
        [join(edge, 'Default', 'Preferences')]: prefs(null),
        [join(extensionPath, 'manifest.json')]: manifest,
      });
      const options = { platform: 'linux' as const, home: '/fixture', env: config ? { XDG_CONFIG_HOME: config } : {}, ...files };
      expect(probeExternalBrowserInstallation(options)).toEqual({
        chrome: { installed: true, enabled: !disabled }, edge: { installed: false, enabled: false },
      });
      expect(probeExternalBrowserInstallation({ ...options, readFile: path => {
        if (path.startsWith(root)) throw Object.assign(new Error('Access denied'), { code: 'EACCES' });
        return files.readFile(path);
      } })).toEqual({ chrome: { installed: null, enabled: null }, edge: { installed: false, enabled: false } });
    }
  });

  it.each(['darwin', 'win32'] as const)('separates valid disabled installation from absence on %s', platform => {
    const local = 'C:\\Users\\fixture\\AppData\\Local';
    const paths = platform === 'win32' ? win32 : { join };
    const root = platform === 'win32' ? win32.join(local, 'Google', 'Chrome', 'User Data') : chromeRoot;
    const payload = platform === 'win32' ? 'C:\\Memmy\\browser-extension' : extensionPath;
    const metadata = {
      [paths.join(root, 'Local State')]: { profile: { info_cache: { Default: {} } } },
      [paths.join(root, 'Default', 'Secure Preferences')]: prefs(enabled({ path: payload, disable_reasons: [1024] })),
      [paths.join(payload, 'manifest.json')]: manifest,
    };
    const facts = probeExternalBrowserInstallation({ platform, home: '/fixture', env: { LOCALAPPDATA: local }, ...io(metadata) });
    expect(facts).toEqual({ chrome: { installed: true, enabled: false }, edge: { installed: false, enabled: false } });
    expect(JSON.stringify(facts)).not.toContain(payload);
    expect(installedExternalBrowsers({ platform, home: '/fixture', env: { LOCALAPPDATA: local }, ...io(metadata) })).toEqual([]);
  });

  it('reports a clean profile with no extension as absent and a valid payload as installed', () => {
    const metadata = chromeRecord(enabled(), {
      [join(chromeRoot, 'Local State')]: { profile: { info_cache: { Default: {} } } },
      [join(edgeRoot, 'Local State')]: { profile: { info_cache: { Default: {} } } },
      [join(edgeRoot, 'Default', 'Preferences')]: prefs(null),
    });
    expect(probeExternalBrowserInstallation({ platform: 'darwin', home: '/fixture', ...io(metadata) }))
      .toEqual({ chrome: { installed: true, enabled: true }, edge: { installed: false, enabled: false } });
  });

  it.each(['Preferences', 'Local State', 'manifest.json'])('preserves failed or malformed %s reads as unknown', suffix => {
    const metadata = chromeRecord(enabled(), {
      [join(chromeRoot, 'Local State')]: { profile: { info_cache: { Default: {} } } },
    });
    const files = io(metadata);
    for (const fail of [() => { throw new Error('unreadable'); }, () => '{malformed']) {
      const facts = probeExternalBrowserInstallation({ platform: 'darwin', home: '/fixture', ...files,
        readFile: path => path.endsWith(suffix) ? fail() : files.readFile(path),
      });
      expect(facts.chrome).toEqual({ installed: null, enabled: null });
    }
  });

  it('does not treat incomplete metadata or an inaccessible profile root as missing installation', () => {
    expect(probeExternalBrowserInstallation({ platform: 'darwin', home: '/fixture', ...io({
      [join(chromeRoot, 'Default', 'Secure Preferences')]: prefs({ state: 1 }),
    }) }).chrome).toEqual({ installed: null, enabled: null });
    expect(probeExternalBrowserInstallation({ platform: 'darwin', home: '/fixture',
      fileExists: () => { throw new Error('permission denied'); },
    })).toEqual({ chrome: { installed: null, enabled: null }, edge: { installed: null, enabled: null } });
    expect(probeExternalBrowserInstallation({ platform: 'win32', env: {} }).chrome)
      .toEqual({ installed: null, enabled: null });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('preserves real permission errors from the default filesystem probe as unknown', () => {
    const directory = mkdtempSync(join(tmpdir(), 'memmy-browser-probe-denied-'));
    try {
      chmodSync(directory, 0);
      expect(probeExternalBrowserInstallation({ platform: 'darwin', home: join(directory, 'unreadable') }))
        .toEqual({ chrome: { installed: null, enabled: null }, edge: { installed: null, enabled: null } });
    } finally { chmodSync(directory, 0o700); rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves a positive installation when another profile is unreadable without guessing enablement', () => {
    const files = io(chromeRecord(enabled({ state: 0 }), {
      [join(chromeRoot, 'Local State')]: { profile: { info_cache: { Default: {}, 'Profile 2': {} } } },
      [join(chromeRoot, 'Profile 2', 'Preferences')]: prefs(null),
    }));
    const facts = probeExternalBrowserInstallation({ platform: 'darwin', home: '/fixture', ...files,
      readFile: path => { if (path.includes('Profile 2')) throw new Error('busy'); return files.readFile(path); },
    });
    expect(facts.chrome).toEqual({ installed: true, enabled: null });
  });
});
