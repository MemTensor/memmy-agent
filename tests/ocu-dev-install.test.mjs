import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { installDevComputerUse } from '../scripts/internal/mac/install-dev-computer-use.mjs';

const macOnly = { skip: process.platform !== 'darwin' };
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const plist = (app, key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents/Info.plist')]).trim();
const sign = (app) => run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
const verify = (app) => run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
const signingDetails = (app) => {
  const result = spawnSync('/usr/bin/codesign', ['-d', '--verbose=4', '-r-', app], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stderr;
};

function fixture(t) {
  const root = fs.mkdtempSync('/private/tmp/ocu-dev-install-test-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'source package');
  const source = path.join(packageRoot, 'dist/Memmy Computer Use.app');
  fs.mkdirSync(path.join(source, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(source, 'Contents/Resources'));
  // A real Mach-O fixture enables codesign verification without launching any app.
  fs.copyFileSync('/usr/bin/true', path.join(source, 'Contents/MacOS/MemmyComputerUse'));
  fs.writeFileSync(path.join(source, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>cn.memtensor.memmy.computeruse</string>
<key>CFBundleName</key><string>Memmy Computer Use</string>
<key>CFBundleDisplayName</key><string>Memmy Computer Use</string>
<key>CFBundleIconFile</key><string>MemmyComputerUse.icns</string>
<key>CFBundleExecutable</key><string>MemmyComputerUse</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>`);
  fs.writeFileSync(path.join(source, 'Contents/Resources/fixture.txt'), 'first version');
  fs.copyFileSync(path.join(import.meta.dirname, '../App/shell/desktop/build/icon.icns'), path.join(source, 'Contents/Resources/MemmyComputerUse.icns'));
  sign(source);
  const destinationRoot = path.join(root, 'installed apps');
  const destination = path.join(destinationRoot, 'Memmy Computer Use.app');
  const registrations = [];
  const messages = [];
  const install = (overrides = {}) => installDevComputerUse({ sourceApp: source, destinationRoot, running: () => false, register: (app) => registrations.push(app), log: (message) => messages.push(message), ...overrides });
  return { root, source, destination, install, registrations, messages };
}

test('dev installation brands the system permission identity without changing the native executable', macOnly, (t) => {
  const { source, destination, install, registrations } = fixture(t);
  const sourceHash = hash(path.join(source, 'Contents/MacOS/MemmyComputerUse'));
  assert.equal(install(), path.join(destination, 'Contents/MacOS/MemmyComputerUse'));
  assert.equal(plist(destination, 'CFBundleIdentifier'), 'cn.memtensor.memmy.computeruse');
  assert.equal(plist(destination, 'CFBundleDisplayName'), 'Memmy Computer Use');
  assert.equal(plist(destination, 'CFBundleName'), 'Memmy Computer Use');
  assert.equal(plist(destination, 'CFBundleIconFile'), 'MemmyComputerUse.icns');
  assert.match(signingDetails(destination), /^Identifier=cn\.memtensor\.memmy\.computeruse$/m);
  assert.equal(plist(source, 'CFBundleIdentifier'), 'cn.memtensor.memmy.computeruse');
  assert.equal(hash(path.join(source, 'Contents/MacOS/MemmyComputerUse')), sourceHash);
  assert.deepEqual(registrations, [destination]);
  verify(destination);
});

test('an unchanged rerun preserves the signed binary and its inode', macOnly, (t) => {
  const { install, registrations, destination } = fixture(t);
  const executable = install();
  const before = hash(executable);
  const inode = fs.statSync(executable).ino;
  const requirement = signingDetails(destination);
  assert.equal(install(), executable);
  assert.equal(hash(executable), before);
  assert.equal(fs.statSync(executable).ino, inode);
  assert.equal(signingDetails(destination), requirement);
  assert.deepEqual(registrations, [destination, destination]);
});

test('a tampered resource is repaired even when executable and saved marker are unchanged', macOnly, (t) => {
  const { destination, install } = fixture(t);
  const executable = install();
  const binaryHash = hash(executable);
  const resource = path.join(destination, 'Contents/Resources/fixture.txt');
  fs.writeFileSync(resource, 'tampered');
  assert.throws(() => verify(destination));
  assert.equal(hash(executable), binaryHash);
  install();
  assert.equal(fs.readFileSync(resource, 'utf8'), 'first version');
  verify(destination);
});

test('a valid but changed destination bundle does not pass the marker cache', macOnly, (t) => {
  const { destination, install } = fixture(t);
  const executable = install();
  const before = hash(executable);
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleVersion 999', path.join(destination, 'Contents/Info.plist')]);
  sign(destination);
  verify(destination);
  install();
  assert.equal(plist(destination, 'CFBundleVersion'), '1');
  assert.equal(hash(executable), before);
  verify(destination);
});

test('source updates preserve the published identity and signed contents', macOnly, (t) => {
  const { source, destination, install, messages } = fixture(t);
  install();
  fs.writeFileSync(path.join(source, 'Contents/Resources/fixture.txt'), 'second version');
  sign(source);
  const signedSourceHash = hash(path.join(source, 'Contents/MacOS/MemmyComputerUse'));
  install();
  // Re-signing changes the Mach-O signature bytes, not the upstream source.
  assert.equal(hash(path.join(source, 'Contents/MacOS/MemmyComputerUse')), signedSourceHash);
  assert.equal(fs.readFileSync(path.join(destination, 'Contents/Resources/fixture.txt'), 'utf8'), 'second version');
  assert.equal(plist(destination, 'CFBundleIdentifier'), 'cn.memtensor.memmy.computeruse');
  assert.doesNotMatch(messages.join('\n'), /tccutil|reset/);
  verify(destination);
});

test('refuses a patched source identity', macOnly, (t) => {
  const { source, install } = fixture(t);
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier com.other.helper', path.join(source, 'Contents/Info.plist')]);
  sign(source);
  assert.throws(install, /CFBundleIdentifier/);
});

test('an unsigned source change fails without replacing the previous helper', macOnly, (t) => {
  const { source, install } = fixture(t);
  const executable = install();
  const before = hash(executable);
  fs.writeFileSync(path.join(source, 'Contents/Resources/fixture.txt'), 'unsigned change');
  assert.throws(install);
  assert.equal(hash(executable), before);
});

test('never replaces a running development helper', macOnly, (t) => {
  const { source, destination, install } = fixture(t);
  install();
  fs.writeFileSync(path.join(source, 'Contents/Resources/fixture.txt'), 'new published version');
  sign(source);
  assert.throws(() => install({ running: () => true }), /running/);
  assert.equal(fs.readFileSync(path.join(destination, 'Contents/Resources/fixture.txt'), 'utf8'), 'first version');
  install();
  assert.equal(fs.readFileSync(path.join(destination, 'Contents/Resources/fixture.txt'), 'utf8'), 'new published version');
});

test('rejects a concurrent installation without removing its lock', macOnly, (t) => {
  const { destination, install } = fixture(t);
  install();
  const lock = path.join(path.dirname(destination), '.ocu-install.lock');
  fs.writeFileSync(lock, String(process.pid));
  assert.throws(install, /installation is in progress/);
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
});
