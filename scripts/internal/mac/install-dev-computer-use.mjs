import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appName = 'Open Computer Use.app';
const executableRelativePath = 'Contents/MacOS/OpenComputerUse';
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

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
export function verifyOfficialBundle(app) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const plist = path.join(app, 'Contents/Info.plist');
  for (const [key, expected] of Object.entries({ CFBundleIdentifier: 'com.ifuryst.opencomputeruse', CFBundleName: 'Open Computer Use', CFBundleDisplayName: 'Open Computer Use' })) {
    if (run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]).trim() !== expected) {
      throw new Error('Expected the official Open Computer Use npm bundle. Reinstall with npm ci in App/memmy-agent; do not rebuild or patch the native app.');
    }
  }
}
function isRunning(executable) {
  return run('/bin/ps', ['-axo', 'command=']).split('\n').some(line => line.trim() === executable || line.trim().startsWith(`${executable} `));
}
function acquireLock(lock) {
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Another Computer Use installation is in progress');
    try { process.kill(pid, 0); }
    catch (probe) {
      if (probe.code === 'ESRCH') { fs.unlinkSync(lock); fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 }); return; }
    }
    throw new Error('Another Computer Use installation is in progress');
  }
}
/** Copy the published app unchanged; never change its TCC identity or signature. */
export function installDevComputerUse({ packageRoot, destinationRoot = path.join(os.homedir(), 'Applications', 'Memmy Development'), register = app => run(lsregister, ['-f', app]), running = isRunning, log = message => process.stderr.write(`${message}\n`) }) {
  if (process.platform !== 'darwin') throw new Error('The development Computer Use helper requires macOS');
  const source = path.resolve(packageRoot, 'dist', appName), destination = path.resolve(destinationRoot, appName);
  if (source === destination) throw new Error('The source and destination must differ');
  verifyOfficialBundle(source);
  const expected = JSON.stringify(bundleManifest(source));
  fs.mkdirSync(destinationRoot, { recursive: true });
  const lock = path.join(destinationRoot, '.ocu-install.lock');
  acquireLock(lock);
  let staging;
  try {
    let identical = false;
    try { verifyOfficialBundle(destination); identical = JSON.stringify(bundleManifest(destination)) === expected; } catch { /* Install/repair only this destination. */ }
    const executable = path.join(destination, executableRelativePath);
    if (!identical) {
      if (running(executable)) throw new Error('Open Computer Use is running from the development installation. Quit that helper and stop dev-start before replacing it, then start again.');
      staging = fs.mkdtempSync(path.join(destinationRoot, '.ocu-install-'));
      const staged = path.join(staging, appName), backup = path.join(staging, 'previous.app');
      fs.cpSync(source, staged, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      verifyOfficialBundle(staged);
      if (JSON.stringify(bundleManifest(staged)) !== expected) throw new Error('Computer Use copy verification failed');
      if (fs.existsSync(destination)) fs.renameSync(destination, backup);
      try { fs.renameSync(staged, destination); }
      catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, destination); throw error; }
      log(`Installed official Open Computer Use at ${destination}`);
    }
    register(destination);
    return executable;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    fs.unlinkSync(lock);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    process.stdout.write(`${installDevComputerUse({ packageRoot: process.argv[2] ?? path.join(root, 'App/memmy-agent/node_modules/open-computer-use'), destinationRoot: process.argv[3] })}\n`);
  } catch (error) { process.stderr.write(`Computer Use installation failed: ${error.message}\n`); process.exitCode = 1; }
}
