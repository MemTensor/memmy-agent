import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

export const MEMMY_COMPUTER_USE_APP = 'Memmy Computer Use.app';
export const MEMMY_COMPUTER_USE_BUNDLE_ID = 'cn.memtensor.memmy';
export const MEMMY_COMPUTER_USE_LEGACY_BUNDLE_ID = 'cn.memtensor.memmy.computeruse';
const plistValue = (plist, key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function verifyMemmyComputerUse(app, {
  expectedBundleIdentifier = MEMMY_COMPUTER_USE_BUNDLE_ID,
  requireLockSupport = true,
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
  if (requireLockSupport) {
    const lockSupport = path.join(app, 'Contents/SharedSupport');
    const plugin = path.join(lockSupport, 'MemmyLockScreenAuthorizationPlugin.bundle');
    if (plistValue(path.join(plugin, 'Contents/Info.plist'), 'CFBundleIdentifier')
        !== 'cn.memtensor.memmy.computeruse.authorization-plugin') throw new Error('Computer Use lock plugin identity mismatch');
    for (const name of ['policy-tool', 'lock-installer', 'lock-guardian', 'authorize-install.applescript']) {
      if (!fs.statSync(path.join(lockSupport, name)).isFile()) throw new Error(`Computer Use ${name} missing`);
    }
    const installerSignature = spawnSync('/usr/bin/codesign', ['-dv', path.join(lockSupport, 'lock-installer')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (installerSignature.status !== 0 || !installerSignature.stderr.split(/\r?\n/)
      .includes('Identifier=cn.memtensor.memmy.computeruse.lock-installer')) {
      throw new Error('Computer Use lock installer identity mismatch');
    }
    const guardianSignature = spawnSync('/usr/bin/codesign', ['-dv', path.join(lockSupport, 'lock-guardian')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (guardianSignature.status !== 0 || !guardianSignature.stderr.split(/\r?\n/)
      .includes('Identifier=cn.memtensor.memmy.computeruse.guardian')) {
      throw new Error('Computer Use lock guardian identity mismatch');
    }
  }
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
