import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MEMMY_COMPUTER_USE_APP, MEMMY_COMPUTER_USE_LEGACY_BUNDLE_ID, bundleManifest, verifyMemmyComputerUse } from './verify-memmy-computer-use.mjs';

const executableRelativePath = 'Contents/MacOS/MemmyComputerUse';
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const defaultSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../App/native-computer-use/dist', MEMMY_COMPUTER_USE_APP);

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

/** Keep one stable development path so macOS grants target Memmy's own helper. */
export function installDevComputerUse({ sourceApp = defaultSource, destinationRoot = path.join(os.homedir(), 'Applications', 'Memmy Development'),
  register = app => run(lsregister, ['-f', app]), running = isRunning, log = message => process.stderr.write(`${message}\n`) } = {}) {
  if (process.platform !== 'darwin') throw new Error('The development Computer Use helper requires macOS');
  const source = path.resolve(sourceApp), destination = path.resolve(destinationRoot, MEMMY_COMPUTER_USE_APP);
  if (source === destination) throw new Error('The source and destination must differ');
  const verify = app => verifyMemmyComputerUse(app, {
    expectedBundleIdentifier: MEMMY_COMPUTER_USE_LEGACY_BUNDLE_ID,
    requireLockSupport: false,
  });
  verify(source);
  const expected = JSON.stringify(bundleManifest(source));
  fs.mkdirSync(destinationRoot, { recursive: true });
  const lock = path.join(destinationRoot, '.ocu-install.lock');
  acquireLock(lock);
  let staging;
  try {
    let identical = false;
    try { verify(destination); identical = JSON.stringify(bundleManifest(destination)) === expected; } catch { /* Repair only this destination. */ }
    const executable = path.join(destination, executableRelativePath);
    if (!identical) {
      if (running(executable)) throw new Error('Memmy Computer Use is running. Quit it and stop dev-start before replacing it.');
      staging = fs.mkdtempSync(path.join(destinationRoot, '.ocu-install-'));
      const staged = path.join(staging, MEMMY_COMPUTER_USE_APP), backup = path.join(staging, 'previous.app');
      fs.cpSync(source, staged, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      verify(staged);
      if (JSON.stringify(bundleManifest(staged)) !== expected) throw new Error('Computer Use copy verification failed');
      if (fs.existsSync(destination)) fs.renameSync(destination, backup);
      try { fs.renameSync(staged, destination); }
      catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, destination); throw error; }
      log(`Installed Memmy Computer Use at ${destination}`);
    }
    register(destination);
    return executable;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    fs.unlinkSync(lock);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${installDevComputerUse({ sourceApp: process.argv[2] ?? defaultSource, destinationRoot: process.argv[3] })}\n`); }
  catch (error) { process.stderr.write(`Computer Use installation failed: ${error.message}\n`); process.exitCode = 1; }
}
