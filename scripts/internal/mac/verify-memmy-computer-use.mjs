import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const MEMMY_COMPUTER_USE_APP = 'Memmy Computer Use.app';
export const MEMMY_COMPUTER_USE_BUNDLE_ID = 'cn.memtensor.memmy';
export const MEMMY_COMPUTER_USE_LEGACY_BUNDLE_ID = 'cn.memtensor.memmy.computeruse';
const plistValue = (plist, key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function verifyNoLockScreenSupport(app) {
  for (const name of ['MemmyLockScreenAuthorizationPlugin.bundle', 'policy-tool',
    'lock-installer', 'lock-guardian', 'authorize-install.applescript']) {
    if (fs.existsSync(path.join(app, 'Contents/SharedSupport', name))) {
      throw new Error(`Retired Computer Use lock-screen resource remains: ${name}`);
    }
  }
}

export function verifyMemmyComputerUse(app, {
  expectedBundleIdentifier = MEMMY_COMPUTER_USE_BUNDLE_ID,
} = {}) {
  if (path.basename(app) !== MEMMY_COMPUTER_USE_APP) throw new Error('Unexpected Computer Use app path');
  const plist = path.join(app, 'Contents/Info.plist');
  const expectedBundleName = expectedBundleIdentifier === MEMMY_COMPUTER_USE_BUNDLE_ID ? 'Memmy' : 'Memmy Computer Use';
  for (const [key, expected] of Object.entries({
    CFBundleIdentifier: expectedBundleIdentifier,
    CFBundleName: expectedBundleName,
    CFBundleDisplayName: expectedBundleName,
    CFBundleIconFile: 'MemmyComputerUse.icns',
    CFBundleExecutable: 'MemmyComputerUse',
  })) {
    if (plistValue(plist, key) !== expected) throw new Error(`Unexpected Computer Use ${key}`);
  }
  if (!fs.statSync(path.join(app, 'Contents/Resources/MemmyComputerUse.icns')).isFile()) throw new Error('Computer Use icon missing');
  verifyNoLockScreenSupport(app);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
}

export function bundleManifest(app) {
  const files = {};
  const walk = (relative = '') => {
    for (const name of fs.readdirSync(path.join(app, relative)).sort()) {
      const key = path.join(relative, name), file = path.join(app, key), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) files[key] = { link: fs.readlinkSync(file) };
      else if (stat.isDirectory()) walk(key);
      else files[key] = { mode: stat.mode & 0o777, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
    }
  };
  walk();
  return files;
}
