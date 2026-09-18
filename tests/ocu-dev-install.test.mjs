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
  const source = path.join(packageRoot, 'dist/Open Computer Use.app');
  fs.mkdirSync(path.join(source, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(source, 'Contents/Resources'));
  // A real Mach-O fixture enables codesign verification without launching any app.
  fs.copyFileSync('/usr/bin/true', path.join(source, 'Contents/MacOS/OpenComputerUse'));
  fs.writeFileSync(path.join(source, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.ifuryst.opencomputeruse</string>
<key>CFBundleName</key><string>Open Computer Use</string>
<key>CFBundleDisplayName</key><string>Open Computer Use</string>
<key>CFBundleExecutable</key><string>OpenComputerUse</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>`);
  fs.writeFileSync(path.join(source, 'Contents/Resources/fixture.txt'), 'first version');
  sign(source);
  const destinationRoot = path.join(root, 'installed apps');
  const destination = path.join(destinationRoot, 'Open Computer Use.app');
  const registrations = [];
  const messages = [];
  const install = (overrides = {}) => installDevComputerUse({ packageRoot, destinationRoot, running: () => false, register: (app) => registrations.push(app), log: (message) => messages.push(message), ...overrides });
  return { root, source, destination, install, registrations, messages };
}

test('dev installation preserves the original display name, identity and signature', macOnly, (t) => {
  const { source, destination, install, registrations } = fixture(t);
  const sourceHash = hash(path.join(source, 'Contents/MacOS/OpenComputerUse'));
  assert.equal(install(), path.join(destination, 'Contents/MacOS/OpenComputerUse'));
  assert.equal(plist(destination, 'CFBundleIdentifier'), 'com.ifuryst.opencomputeruse');
  assert.equal(plist(destination, 'CFBundleDisplayName'), 'Open Computer Use');
  assert.equal(plist(destination, 'CFBundleName'), 'Open Computer Use');
  assert.match(signingDetails(destination), /^Identifier=com\.ifuryst\.opencomputeruse$/m);
  assert.equal(plist(source, 'CFBundleIdentifier'), 'com.ifuryst.opencomputeruse');
  assert.equal(hash(path.join(source, 'Contents/MacOS/OpenComputerUse')), sourceHash);
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
  install();
  assert.equal(hash(path.join(source, 'Contents/MacOS/OpenComputerUse')), hash(path.join(destination, 'Contents/MacOS/OpenComputerUse')));
  assert.equal(plist(destination, 'CFBundleIdentifier'), 'com.ifuryst.opencomputeruse');
  assert.doesNotMatch(messages.join('\n'), /tccutil|reset/);
  verify(destination);
});

test('refuses a patched source identity instead of silently resigning it', macOnly, (t) => {
  const { source, install } = fixture(t);
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier cn.memtensor.memmy.computeruse.dev', path.join(source, 'Contents/Info.plist')]);
  sign(source);
  assert.throws(install, /official/);
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
