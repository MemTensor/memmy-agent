import { expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listComputerUseWindows, selectComputerUseWindowSource, windowIdFromSource } from '../src/main/computer-use-video-source.js';

it('selects the captured window by owning app rather than a similar document title', () => {
  const sources = [
    { id: 'window:11:0', name: 'Untitled' },
    { id: 'window:12:0', name: 'Untitled' },
  ];
  const owners = [
    { id: 11, owner: 'Notes', bundleId: 'com.apple.Notes', title: 'Untitled' },
    { id: 12, owner: 'TextEdit', bundleId: 'com.apple.TextEdit', title: 'Untitled' },
  ];
  expect(windowIdFromSource(sources[0].id)).toBe(11);
  expect(selectComputerUseWindowSource(sources, 'com.apple.TextEdit', owners)?.id).toBe('window:12:0');
  expect(selectComputerUseWindowSource(sources, 'TextEdit', [
    { ...owners[0], owner: '备忘录', title: '未命名' },
    { ...owners[1], owner: '文本编辑', title: '未命名' },
  ])?.id).toBe('window:12:0');
  expect(selectComputerUseWindowSource(sources, 'Notes', owners)?.id).toBe('window:11:0');
  expect(selectComputerUseWindowSource(sources, 'Missing', owners)).toBeNull();
});

it('uses the window title when native owner metadata is unavailable on Windows', () => {
  const sources = [
    { id: 'window:32:0', name: 'How to use Notepad - Browser' },
    { id: 'window:30:0', name: 'Untitled - Notepad' },
    { id: 'window:31:0', name: 'Calculator' },
    { id: 'window:33:0', name: 'Book1 - Excel' },
  ];
  expect(selectComputerUseWindowSource(sources, 'Notepad', [])?.id).toBe('window:30:0');
  expect(selectComputerUseWindowSource(sources, 'Microsoft Excel', [])?.id).toBe('window:33:0');
  expect(selectComputerUseWindowSource(sources, 'Browser', [])?.id).toBe('window:32:0');
});

it('binds an exact native window and refuses an ambiguous app with two windows', () => {
  const sources = [
    { id: 'window:51:0', name: 'Untitled' },
    { id: 'window:52:0', name: 'Untitled' },
  ];
  const owners = sources.map((source, index) => ({ id: 51 + index,
    owner: '文本编辑', bundleId: 'com.apple.TextEdit', title: source.name }));
  expect(selectComputerUseWindowSource(sources, 'TextEdit', owners)).toBeNull();
  expect(selectComputerUseWindowSource(sources, 'TextEdit', owners, 52)?.id).toBe('window:52:0');
  expect(selectComputerUseWindowSource(sources, 'TextEdit', owners, 53)).toBeNull();
  expect(selectComputerUseWindowSource(sources, 'Notes', owners, 52)).toBeNull();
  expect(selectComputerUseWindowSource([
    { id: 'window:61:0', name: 'One - Notepad' },
    { id: 'window:62:0', name: 'Two - Notepad' },
  ], 'Notepad', [])).toBeNull();
});

it('reads the unpacked native helper from the packaged runtime path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-window-helper-'));
  try {
    const executable = path.join(root, 'app.asar.unpacked', 'dist', 'runtime', 'memmy-agent',
      'dist', 'tools', 'computer-use', 'mac', 'native', 'arm64', 'list-windows');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, '#!/bin/sh\nprintf \'[{"id":123,"owner":"Notes","bundleId":"com.apple.Notes","title":"Memo"}]\\n\'\n');
    fs.chmodSync(executable, 0o755);
    expect(listComputerUseWindows(root, 'arm64')).toEqual([
      { id: 123, owner: 'Notes', bundleId: 'com.apple.Notes', title: 'Memo' },
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
