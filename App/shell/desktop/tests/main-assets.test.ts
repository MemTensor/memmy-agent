import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { stageMainAssets } from '../stage-main-assets.mjs';

it('copies the Computer Use loadFile page after TypeScript emits into a clean dist', () => {
  const root = mkdtempSync(join(tmpdir(), 'memmy-desktop-assets-'));
  try {
    mkdirSync(join(root, 'src', 'main'), { recursive: true });
    writeFileSync(join(root, 'src', 'main', 'computer-use-surface.html'), '<video id="live"></video>');
    mkdirSync(join(root, 'build'));
    const icon = readFileSync(new URL('../build/icon.png', import.meta.url));
    writeFileSync(join(root, 'build', 'icon.png'), icon);
    writeFileSync(join(root, 'build', 'MemmyWindowsRuntimeOwnership.ps1'), '# ownership guard');
    stageMainAssets(root);
    expect(readFileSync(join(root, 'dist', 'main', 'MemmyWindowsRuntimeOwnership.ps1'), 'utf8')).toBe('# ownership guard');
    expect(readFileSync(join(root, 'dist', 'main', 'computer-use-surface.html'), 'utf8'))
      .toBe('<video id="live"></video>');
    expect(readFileSync(join(root, 'dist', 'main', 'browser-extension-drag-icon.png'))).toEqual(icon);
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(scripts['build:main']).toContain('tsc -p tsconfig.json && node stage-main-assets.mjs && node native-pip/build.mjs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('builds the native panel for macOS 14 and the menu addon for macOS 12', () => {
  const build = readFileSync(new URL('../native-pip/build.mjs', import.meta.url), 'utf8');
  const menuBuild = build.slice(build.indexOf("execFileSync('xcrun'"), build.indexOf("execFileSync('xcrun'", build.indexOf("execFileSync('xcrun'") + 1));
  const pipBuild = build.slice(build.lastIndexOf("execFileSync('xcrun'"));
  expect(menuBuild).toContain("'-mmacosx-version-min=12.0'");
  expect(pipBuild).toContain("'-mmacosx-version-min=14.0'");
});
