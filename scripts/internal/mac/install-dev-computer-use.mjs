import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const appName = 'Open Computer Use.app';
const developmentBundleId = 'cn.memtensor.memmy.computeruse.dev';
const executableRelativePath = 'Contents/MacOS/OpenComputerUse';
const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const fingerprintFiles = [executableRelativePath, 'Contents/Info.plist', 'Contents/_CodeSignature/CodeResources'];

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function verifyBundle(app) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
}

function adHocDesignatedRequirement(app) {
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=2', '--requirements', '-', app], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) return null;
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/^Signature=adhoc$/m.test(output)) return null;
  return output.match(/^(?:# )?designated => (.+)$/m)?.[1] ?? null;
}

function fingerprintBundle(app) {
  return Object.fromEntries(fingerprintFiles.map((relativePath) => [relativePath,
    createHash('sha256').update(fs.readFileSync(path.join(app, relativePath))).digest('hex')]));
}

function readPlist(app, key) {
  return run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents/Info.plist')]).trim();
}

function registerBundle(app) {
  const output = run(lsregister, ['-f', app]);
  if (output.trim()) process.stderr.write(output);
}

/** Dev helpers live outside temporary checkouts so macOS can resolve their TCC identity.
 * The release bundle remains untouched. Only this installed copy receives a dev ID.
 * register is injectable so fixture tests need not alter LaunchServices or TCC.
 */
export function installDevComputerUse({
  packageRoot,
  destinationRoot = path.join(os.homedir(), 'Applications', 'Memmy Development'),
  register = registerBundle,
  log = (message) => process.stderr.write(`${message}\n`),
}) {
  if (process.platform !== 'darwin') throw new Error('The development Computer Use helper requires macOS');
  const source = path.resolve(packageRoot, 'dist', appName);
  const destination = path.resolve(destinationRoot, appName);
  const executable = path.join(destination, executableRelativePath);
  const marker = path.join(path.dirname(destination), '.memmy-computer-use-dev-install.json');
  if (source === destination) throw new Error('The development helper destination must differ from its package source');

  verifyBundle(source);
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    if (readPlist(source, key) !== 'Open Computer Use') throw new Error(`Unexpected Computer Use source ${key}`);
  }
  const sourceFingerprint = fingerprintBundle(source);
  let current = false;
  let previousRequirement = null;
  try {
    const previous = JSON.parse(fs.readFileSync(marker, 'utf8'));
    verifyBundle(destination);
    const validPreviousInstall = previous.version === 1
      && readPlist(destination, 'CFBundleIdentifier') === developmentBundleId
      && JSON.stringify(previous.destination) === JSON.stringify(fingerprintBundle(destination));
    const sameSource = JSON.stringify(previous.source) === JSON.stringify(sourceFingerprint);
    current = validPreviousInstall && sameSource;
    if (validPreviousInstall && !sameSource) previousRequirement = adHocDesignatedRequirement(destination);
  } catch { /* A missing, changed or invalid bundle must be installed again. */ }
  if (current) {
    register(destination);
    return executable;
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), '.ocu-install-'));
  const stagedApp = path.join(staging, appName);
  const backup = path.join(staging, 'previous.app');
  let permissionIdentityChanged = false;
  try {
    fs.cpSync(source, stagedApp, { recursive: true });
    run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier ${developmentBundleId}`, path.join(stagedApp, 'Contents/Info.plist')]);
    run('/usr/bin/codesign', ['--force', '--sign', '-', stagedApp]);
    verifyBundle(stagedApp);
    const destinationFingerprint = fingerprintBundle(stagedApp);
    const nextRequirement = previousRequirement ? adHocDesignatedRequirement(stagedApp) : null;
    permissionIdentityChanged = Boolean(previousRequirement && nextRequirement && previousRequirement !== nextRequirement);
    // Rename complete bundles; never modify the executable inode of a running helper.
    if (fs.existsSync(destination)) fs.renameSync(destination, backup);
    try {
      fs.renameSync(stagedApp, destination);
    } catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, destination);
      throw error;
    }
    const stagedMarker = path.join(staging, 'install.json');
    fs.writeFileSync(stagedMarker, `${JSON.stringify({ version: 1, source: sourceFingerprint, destination: destinationFingerprint })}\n`);
    fs.renameSync(stagedMarker, marker);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  register(destination);
  log(`Installed development Computer Use helper at ${destination}`);
  if (permissionIdentityChanged) {
    log(`Open Computer Use 的开发版签名已改变，旧 macOS 开发版授权可能失效。
如果已开启权限仍反复出现授权窗口，请先退出 Open Computer Use，再手动执行仅针对开发版的两条命令：
tccutil reset Accessibility ${developmentBundleId}
tccutil reset ScreenCapture ${developmentBundleId}
随后重新启动开发环境，在系统设置中手动开启两项权限，按提示重启辅助程序，再发送新消息。这些重置命令不会自动执行。`);
  }
  return executable;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const packageRoot = process.argv[2] ?? path.join(root, 'App/memmy-agent/node_modules/open-computer-use');
    const executable = installDevComputerUse({ packageRoot, destinationRoot: process.argv[3] });
    process.stdout.write(`${executable}\n`);
  } catch (error) {
    process.stderr.write(`Computer Use development installation failed: ${error.message}\n`);
    if (error.stderr) process.stderr.write(String(error.stderr));
    process.exitCode = 1;
  }
}
