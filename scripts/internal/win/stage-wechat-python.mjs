#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyWindowsComputerUseRuntime } from './verify-computer-use-runtime.mjs';

const require = createRequire(new URL('../../../App/memmy-agent/package.json', import.meta.url));
const JSZip = require('jszip');
export const WINDOWS_WECHAT_PYTHON_VERSION = '3.13.16';
// Official Python release file and checksum, verified 2026-10-09:
// https://www.python.org/downloads/release/python-31316/
export const WINDOWS_WECHAT_PYTHON_SHA256 = '97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297';
export const WINDOWS_WECHAT_PYTHON_URL = `https://www.python.org/ftp/python/${WINDOWS_WECHAT_PYTHON_VERSION}/python-${WINDOWS_WECHAT_PYTHON_VERSION}-embed-amd64.zip`;
const REQUIRED_FILES = [
  'python.exe', 'python313.dll', 'python313.zip', 'python313._pth', 'LICENSE.txt',
  '_ctypes.pyd', '_sqlite3.pyd', '_hashlib.pyd', 'sqlite3.dll',
  'libcrypto-3.dll', 'libffi-8.dll', 'vcruntime140.dll', 'vcruntime140_1.dll',
];
const IMMUTABLE_FILES = ['python313.zip', 'python313._pth', 'LICENSE.txt'];
const WINDOWS_DIRECTORY_REPLACE_RETRIES = 5;

async function replaceDirectoryWithRetry(staging, destination) {
  let lastError;
  for (let attempt = 1; attempt <= WINDOWS_DIRECTORY_REPLACE_RETRIES; attempt += 1) {
    try {
      await rm(destination, { recursive: true, force: true });
      await rename(staging, destination);
      return;
    } catch (error) {
      lastError = error;
      const retryable = ['EACCES', 'EBUSY', 'EPERM'].includes(error?.code);
      if (!retryable || attempt === WINDOWS_DIRECTORY_REPLACE_RETRIES) throw error;
      await sleep(attempt * 500);
    }
  }
  throw lastError;
}

export function verifyPinnedWindowsPythonArchive(bytes) {
  if (createHash('sha256').update(bytes).digest('hex') !== WINDOWS_WECHAT_PYTHON_SHA256) {
    throw new Error('Windows WeChat Python archive does not match the pinned official SHA-256');
  }
}

/** Static checks are also usable on a macOS/Linux packaging host. */
export function verifyWindowsWeChatPythonDirectory(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'runtime.json'), 'utf8'));
  if (manifest.version !== WINDOWS_WECHAT_PYTHON_VERSION || manifest.arch !== 'x64'
      || manifest.archiveSha256 !== WINDOWS_WECHAT_PYTHON_SHA256) {
    throw new Error('Windows WeChat Python runtime metadata does not match the pinned release');
  }
  for (const name of REQUIRED_FILES) {
    if (!lstatSync(join(directory, name)).isFile()) throw new Error(`Missing Windows WeChat Python file: ${name}`);
  }
  for (const name of IMMUTABLE_FILES) {
    const digest = createHash('sha256').update(readFileSync(join(directory, name))).digest('hex');
    if (manifest.files?.[name] !== digest) throw new Error(`Windows WeChat Python resource changed: ${name}`);
  }
  verifyWindowsComputerUseRuntime(readFileSync(join(directory, 'python.exe')), 'x64');
  const paths = readFileSync(join(directory, 'python313._pth'), 'utf8').split(/\r?\n/u)
    .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (paths.join('\n') !== 'python313.zip\n.') throw new Error('Windows WeChat Python must use isolated module paths');
  for (const name of REQUIRED_FILES.filter(name => name.endsWith('.dll') || name.endsWith('.pyd'))) {
    const bytes = readFileSync(join(directory, name));
    if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error(`Invalid Python native file: ${name}`);
    const pe = bytes.readUInt32LE(0x3c);
    if (pe < 64 || pe > bytes.length - 26 || bytes.readUInt32LE(pe) !== 0x4550
        || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 24) !== 0x20b
        || !(bytes.readUInt16LE(pe + 22) & 0x2000)) throw new Error(`Python native file must be an x64 DLL: ${name}`);
  }
}

async function readPinnedArchive(archivePath, cacheDirectory) {
  if (archivePath) return readFile(resolve(archivePath));
  await mkdir(cacheDirectory, { recursive: true });
  const cached = join(cacheDirectory, `python-${WINDOWS_WECHAT_PYTHON_VERSION}-embed-amd64.zip`);
  if (existsSync(cached)) return readFile(cached);
  const response = await fetch(WINDOWS_WECHAT_PYTHON_URL, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Downloading official Windows Python failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyPinnedWindowsPythonArchive(bytes);
  const temporary = `${cached}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, cached);
  } finally { await rm(temporary, { force: true }); }
  return bytes;
}

export async function stageWindowsWeChatPython({ destination, archivePath,
  cacheDirectory = fileURLToPath(new URL('../../../.tmp/package-downloads', import.meta.url)) }) {
  const bytes = await readPinnedArchive(archivePath, cacheDirectory);
  verifyPinnedWindowsPythonArchive(bytes);
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
  await mkdir(dirname(destination), { recursive: true });
  const staging = await mkdtemp(`${destination}.staging-`);
  try {
    for (const entry of Object.values(archive.files)) {
      if (entry.dir) continue;
      // The official embed distribution is flat. No extra files or paths may escape staging.
      if (!/^[A-Za-z0-9_.-]+$/u.test(entry.name) || entry.name === '.' || entry.name === '..'
          || (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name)) {
        throw new Error('Unexpected path in Windows Python archive');
      }
      await writeFile(join(staging, entry.name), await entry.async('nodebuffer'));
    }
    await writeFile(join(staging, 'runtime.json'), `${JSON.stringify({
      version: WINDOWS_WECHAT_PYTHON_VERSION, arch: 'x64',
      archiveSha256: WINDOWS_WECHAT_PYTHON_SHA256, source: WINDOWS_WECHAT_PYTHON_URL,
      files: Object.fromEntries(IMMUTABLE_FILES.map(name => [name,
        createHash('sha256').update(readFileSync(join(staging, name))).digest('hex')])),
    }, null, 2)}\n`);
    verifyWindowsWeChatPythonDirectory(staging);
    await replaceDirectoryWithRetry(staging, destination);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, destination, archivePath] = process.argv.slice(2);
  if (!destination || !['stage', 'verify'].includes(mode) || process.argv.length > 5) {
    throw new Error('Usage: stage-wechat-python.mjs <stage|verify> <python-directory> [pinned-archive.zip]');
  }
  if (mode === 'stage') await stageWindowsWeChatPython({ destination: resolve(destination), archivePath });
  else verifyWindowsWeChatPythonDirectory(resolve(destination));
  console.log(`Verified Windows WeChat Python ${WINDOWS_WECHAT_PYTHON_VERSION} x64 (static package checks)`);
}
