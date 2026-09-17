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
<key>CFBundleIdentifier</key><string>cn.memtensor.memmy.computeruse</string>
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
  const install = () => installDevComputerUse({ packageRoot, destinationRoot, register: (app) => registrations.push(app), log: (message) => messages.push(message) });
  return { root, source, destination, install, registrations, messages };
}

test('dev installation keeps the display name and gives only the copy a dev identity', macOnly, (t) => {
  const { source, destination, install, registrations } = fixture(t);
  const sourceHash = hash(path.join(source, 'Contents/MacOS/OpenComputerUse'));
  assert.equal(install(), path.join(destination, 'Contents/MacOS/OpenComputerUse'));
  assert.equal(plist(destination, 'CFBundleIdentifier'), 'cn.memtensor.memmy.computeruse.dev');
  assert.equal(plist(destination, 'CFBundleDisplayName'), 'Open Computer Use');
  assert.equal(plist(destination, 'CFBundleName'), 'Open Computer Use');
  assert.match(signingDetails(destination), /^Identifier=cn\.memtensor\.memmy\.computeruse\.dev$/m);
  assert.equal(plist(source, 'CFBundleIdentifier'), 'cn.memtensor.memmy.computeruse');
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

test('source updates replace the installed bundle and record its new signed state', macOnly, (t) => {
  const { source, destination, install, messages } = fixture(t);
  const executable = install();
  assert.doesNotMatch(messages.join('\n'), /tccutil reset/, 'First installation should not suggest resetting an old grant');
  messages.length = 0;
  const before = hash(executable);
  fs.writeFileSync(path.join(source, 'Contents/Resources/fixture.txt'), 'second version');
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleVersion 2', path.join(source, 'Contents/Info.plist')]);
  sign(source);
  install();
  assert.equal(fs.readFileSync(path.join(destination, 'Contents/Resources/fixture.txt'), 'utf8'), 'second version');
  assert.equal(plist(destination, 'CFBundleVersion'), '2');
  assert.notEqual(hash(executable), before);
  const guidance = messages.join('\n');
  assert.match(guidance, /旧 macOS 开发版授权可能失效/);
  const commands = guidance.split('\n').filter((line) => line.startsWith('tccutil '));
  assert.deepEqual(commands, [
    'tccutil reset Accessibility cn.memtensor.memmy.computeruse.dev',
    'tccutil reset ScreenCapture cn.memtensor.memmy.computeruse.dev',
  ]);
  assert.match(guidance, /手动开启两项权限/);
  assert.match(guidance, /不会自动执行/);
  const updated = hash(executable);
  const inode = fs.statSync(executable).ino;
  messages.length = 0;
  install();
  assert.deepEqual(messages, [], 'An unchanged cached build must not repeat signature-change guidance');
  assert.equal(hash(executable), updated);
  assert.equal(fs.statSync(executable).ino, inode);
  verify(destination);
});

test('a source change that preserves the installed designated requirement does not suggest resetting permissions', macOnly, (t) => {
  const { source, destination, install, messages } = fixture(t);
  const executable = install();
  const before = hash(executable);
  const beforeSigning = signingDetails(destination);
  // The installer replaces the source ID with the same .dev ID, so this source
  // update leaves the final signed permission identity unchanged.
  run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier cn.memtensor.memmy.computertwo', path.join(source, 'Contents/Info.plist')]);
  sign(source);
  messages.length = 0;
  install();
  assert.equal(hash(executable), before);
  assert.equal(signingDetails(destination), beforeSigning);
  assert.doesNotMatch(messages.join('\n'), /tccutil reset/);
});

test('an unsigned source change fails without replacing the previous helper', macOnly, (t) => {
  const { source, install } = fixture(t);
  const executable = install();
  const before = hash(executable);
  fs.writeFileSync(path.join(source, 'Contents/Resources/fixture.txt'), 'unsigned change');
  assert.throws(install);
  assert.equal(hash(executable), before);
});
