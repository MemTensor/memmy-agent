import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { prepareComputerUseSource } from './prepare-computer-use-source.mjs';

// Developers and release builders compile this helper; installed apps never do.
if (process.platform !== 'darwin') process.exit(0);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const packageRoot = path.resolve(process.argv[2] ?? path.join(root, 'App/memmy-agent/node_modules/open-computer-use'));
const arch = process.argv[3] ?? process.arch;
if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`);
const vendor = path.join(root, 'scripts/vendor/open-computer-use');
const archive = fs.readFileSync(path.join(vendor, 'source-0.3.5.tar.gz'));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
if (sha256(archive) !== '91622ecadb7e9ab4b70056dd5aab02b695672aff9d17d287c603e3087748ebf3') {
  throw new Error('Open Computer Use source checksum mismatch');
}
const patch = fs.readFileSync(path.join(vendor, 'memmy-permissions.patch'));
const manifest = fs.readFileSync(path.join(vendor, 'Package.swift'));
const compiler = execFileSync('xcrun', ['swift', '--version']);
const sourcePreparer = fs.readFileSync(new URL('./prepare-computer-use-source.mjs', import.meta.url));
const fingerprint = sha256(Buffer.concat([archive, patch, manifest, compiler, sourcePreparer, fs.readFileSync(fileURLToPath(import.meta.url)), Buffer.from(arch)]));
const cache = path.join(root, '.tmp/ocu-native', fingerprint);
const app = path.join(packageRoot, 'dist/Open Computer Use.app');
const executable = path.join(app, 'Contents/MacOS/OpenComputerUse');
const marker = path.join(packageRoot, '.memmy-native-build.json');
try {
  const previous = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (previous.fingerprint === fingerprint && previous.binarySha256 === sha256(fs.readFileSync(executable))
      && process.env.MEMMY_OCU_RUN_TESTS !== '1') process.exit(0);
} catch { /* A fresh install or changed binary needs rebuilding. */ }
if (!fs.existsSync(path.join(app, 'Contents/Info.plist'))) throw new Error(`Install open-computer-use@0.3.5 first: ${packageRoot}`);
prepareComputerUseSource({ cache, vendor, buildIdentifier: fingerprint });
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: cache, stdio: 'inherit', ...options });
const env = { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(cache, '.module-cache'), SWIFTPM_MODULECACHE_OVERRIDE: path.join(cache, '.module-cache') };
const buildArgs = ['swift', 'build', '--disable-sandbox', '--cache-path', path.join(cache, '.cache'), '--config-path', path.join(cache, '.config'), '--security-path', path.join(cache, '.security'), '-c', 'release', '--triple', `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macosx14.0`];
if (process.env.MEMMY_OCU_RUN_TESTS === '1') {
  const testBinary = path.join(cache, 'identity-tests');
  run('xcrun', ['swiftc', path.join(cache, 'packages/OpenComputerUseKit/Sources/OpenComputerUseKit/AppAgentIdentity.swift'), path.join(cache, 'Tests/IdentityTests.swift'), '-o', testBinary], { env });
  run(testBinary, [], { env });
  const observationTestBinary = path.join(cache, 'screen-observation-tests');
  run('xcrun', ['swiftc', path.join(cache, 'packages/OpenComputerUseKit/Sources/OpenComputerUseKit/ScreenObservation.swift'), path.join(cache, 'Tests/ScreenObservationTests.swift'), '-o', observationTestBinary], { env });
  run(observationTestBinary, [], { env });
}
// Always stage the regular release product, including after a test build.
run('xcrun', [...buildArgs, '--product', 'OpenComputerUse'], { env });
const binDir = execFileSync('xcrun', [...buildArgs, '--show-bin-path'], { cwd: cache, env, encoding: 'utf8' }).trim();
// Preserve the npm package's icons/resources. Electron signs this nested app
// with the release identity after staging; ad-hoc signing is for local dev.
// Never overwrite the executable inode of a running app: it may keep the old
// image while Settings reads the new on-disk signature during authorization.
const staging = fs.mkdtempSync(path.join(path.dirname(app), '.ocu-build-'));
const stagedApp = path.join(staging, 'Open Computer Use.app');
fs.cpSync(app, stagedApp, { recursive: true });
const stagedExecutable = path.join(stagedApp, 'Contents/MacOS/OpenComputerUse');
fs.cpSync(path.join(binDir, 'OpenComputerUse'), stagedExecutable);
fs.chmodSync(stagedExecutable, 0o755);
const plist = path.join(stagedApp, 'Contents/Info.plist');
for (const [key, value] of Object.entries({ CFBundleIdentifier: 'cn.memtensor.memmy.computeruse', CFBundleName: 'Open Computer Use', CFBundleDisplayName: 'Open Computer Use' })) {
  run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
}
run('/usr/bin/codesign', ['--force', '--sign', '-', stagedApp]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp]);
const backup = path.join(staging, 'previous.app');
fs.renameSync(app, backup);
try {
  fs.renameSync(stagedApp, app);
} catch (error) {
  fs.renameSync(backup, app);
  throw error;
}
fs.rmSync(staging, { recursive: true, force: true });
fs.writeFileSync(marker, JSON.stringify({ fingerprint, binarySha256: sha256(fs.readFileSync(executable)) }) + '\n');
console.log(`Built Open Computer Use (${arch}) at ${app}`);
