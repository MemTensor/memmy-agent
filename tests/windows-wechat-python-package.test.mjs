import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AsarPackager } from 'app-builder-lib/out/asar/asarUtil.js';
import { FileMatcher } from 'app-builder-lib/out/fileMatcher.js';
import { parse } from 'yaml';
import { afterEach, expect, it } from 'vitest';
import { stageWindowsWeChatPython, verifyPinnedWindowsPythonArchive, verifyWindowsWeChatPythonDirectory,
  WINDOWS_WECHAT_PYTHON_SHA256, WINDOWS_WECHAT_PYTHON_VERSION } from '../scripts/internal/win/stage-wechat-python.mjs';
import { windowsPEFixture } from './fixtures/windows-pe-fixture.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const prefix = 'dist/runtime/memmy-agent/dist/tools/computer-history';
function root() { const value = mkdtempSync(join(tmpdir(), 'wechat-python-package-')); roots.push(value); return value; }
function runtime(directory) {
  mkdirSync(directory, { recursive: true });
  const dll = windowsPEFixture(); dll.writeUInt16LE(0x2022, 0x96);
  for (const name of ['python313.dll', '_ctypes.pyd', '_sqlite3.pyd', '_hashlib.pyd', 'sqlite3.dll',
    'libcrypto-3.dll', 'libffi-8.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) writeFileSync(join(directory, name), dll);
  writeFileSync(join(directory, 'python.exe'), windowsPEFixture());
  writeFileSync(join(directory, 'python313._pth'), 'python313.zip\r\n.\r\n#import site\r\n');
  writeFileSync(join(directory, 'python313.zip'), 'stdlib fixture');
  writeFileSync(join(directory, 'LICENSE.txt'), 'Python license fixture');
  writeFileSync(join(directory, 'runtime.json'), JSON.stringify({ version: WINDOWS_WECHAT_PYTHON_VERSION,
    arch: 'x64', archiveSha256: WINDOWS_WECHAT_PYTHON_SHA256,
    files: Object.fromEntries(['python313.zip', 'python313._pth', 'LICENSE.txt'].map(name =>
      [name, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')])),
  }));
}

it('rejects an untrusted archive before replacing an existing staged interpreter', async () => {
  const directory = root();
  const destination = join(directory, 'python');
  runtime(destination);
  const archivePath = join(directory, 'wrong.zip'); writeFileSync(archivePath, 'wrong archive');
  expect(() => verifyPinnedWindowsPythonArchive(Buffer.from('wrong archive'))).toThrow(/pinned official SHA-256/);
  await expect(stageWindowsWeChatPython({ destination, archivePath })).rejects.toThrow(/pinned official SHA-256/);
  expect(() => verifyWindowsWeChatPythonDirectory(destination)).not.toThrow();
});

it('rejects a corrupted stdlib and a foreign-architecture dependency before packaging', () => {
  const directory = join(root(), 'python'); runtime(directory);
  writeFileSync(join(directory, 'python313.zip'), 'truncated');
  expect(() => verifyWindowsWeChatPythonDirectory(directory)).toThrow(/resource changed/);
  runtime(directory);
  const dll = windowsPEFixture(0xaa64); dll.writeUInt16LE(0x2022, 0x96);
  writeFileSync(join(directory, '_ctypes.pyd'), dll);
  expect(() => verifyWindowsWeChatPythonDirectory(directory)).toThrow(/x64 DLL/);
});

it.each(['electron-builder.win.yml', 'electron-builder.win.unsigned.yml'])(
  '%s unpacks the interpreter, message reader and its sibling identity helper into physical paths', async filename => {
    const config = parse(readFileSync(new URL(`../App/shell/desktop/${filename}`, import.meta.url), 'utf8'));
    const directory = root(); const source = join(directory, 'source'); const staged = join(directory, 'staged');
    const runtimeRelative = `${prefix}/win/python`; runtime(join(source, runtimeRelative));
    const readerRelative = `${prefix}/mac/wechat/read_messages.py`;
    const reader = readFileSync(new URL('../App/memmy-agent/src/tools/computer-history/mac/wechat/read_messages.py', import.meta.url));
    mkdirSync(dirname(join(source, readerRelative)), { recursive: true }); writeFileSync(join(source, readerRelative), reader);
    const identityRelative = `${prefix}/wechat_identity.py`;
    const identity = readFileSync(new URL('../App/memmy-agent/src/tools/computer-history/wechat_identity.py', import.meta.url));
    writeFileSync(join(source, identityRelative), identity);
    const siblingHelpers = ['weixin_keys.py', 'private_files.py'].map(name => {
      const relative = `${prefix}/win/${name}`;
      const bytes = readFileSync(new URL(`../App/memmy-agent/src/tools/computer-history/win/${name}`, import.meta.url));
      writeFileSync(join(source, relative), bytes);
      return { relative, bytes };
    });
    const include = new FileMatcher(source, staged, value => value, config.files).createFilter();
    const names = ['python.exe', 'python313.dll', 'python313.zip', 'python313._pth', '_ctypes.pyd', '_sqlite3.pyd',
      '_hashlib.pyd', 'sqlite3.dll', 'libcrypto-3.dll', 'libffi-8.dll', 'vcruntime140.dll', 'vcruntime140_1.dll',
      'LICENSE.txt', 'runtime.json'].map(name => `${runtimeRelative}/${name}`);
    const files = [...names, readerRelative, identityRelative, ...siblingHelpers.map(helper => helper.relative)].map(relative => {
      const from = join(source, relative); expect(include(from, lstatSync(from)), relative).toBe(true);
      const to = join(staged, relative); mkdirSync(dirname(to), { recursive: true }); cpSync(from, to); return to;
    });
    await new AsarPackager({ info: { getWorkspaceRoot: async () => directory } }, {
      defaultDestination: staged, resourcePath: directory, options: { smartUnpack: false },
      unpackPattern: new FileMatcher(staged, directory, value => value, config.asarUnpack).createFilter(),
    }).pack([{ src: staged, destination: staged, files, metadata: new Map(files.map(file => [file, lstatSync(file)])) }]);
    const unpacked = join(directory, 'app.asar.unpacked');
    expect(() => verifyWindowsWeChatPythonDirectory(join(unpacked, runtimeRelative))).not.toThrow();
    expect(readFileSync(join(unpacked, readerRelative))).toEqual(reader);
    expect(readFileSync(join(unpacked, identityRelative))).toEqual(identity);
    for (const helper of siblingHelpers) expect(readFileSync(join(unpacked, helper.relative))).toEqual(helper.bytes);
  });
