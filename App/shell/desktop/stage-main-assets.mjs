import { copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// TypeScript emits the main/preload code, but it does not copy loadFile assets.
export function stageMainAssets(root = import.meta.dirname) {
  const main = join(root, 'dist', 'main');
  mkdirSync(main, { recursive: true });
  copyFileSync(join(root, 'src', 'main', 'computer-use-surface.html'),
    join(main, 'computer-use-surface.html'));
  copyFileSync(join(root, 'build', 'MemmyWindowsRuntimeOwnership.ps1'), join(main, 'MemmyWindowsRuntimeOwnership.ps1'));
  copyFileSync(join(root, 'build', 'icon.png'), join(main, 'browser-extension-drag-icon.png'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) stageMainAssets();
