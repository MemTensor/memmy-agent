import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

if (process.platform !== 'darwin' || process.env.MEMMY_WINDOWS_CROSS_BUILD === '1') process.exit(0);

const root = resolve(import.meta.dirname, '..');
const targetArch = process.env.MEMMY_DESKTOP_NATIVE_ARCH || process.arch;
if (!['arm64', 'x64'].includes(targetArch)) throw new Error(`Unsupported macOS native PiP architecture: ${targetArch}`);
const clangArch = targetArch === 'x64' ? 'x86_64' : 'arm64';
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const include = join(nodeRoot, 'include', 'node');
if (!existsSync(join(include, 'node_api.h'))) {
  throw new Error(`Node N-API headers are missing: ${include}`);
}
const outputDirectory = join(root, 'dist', 'native');
mkdirSync(outputDirectory, { recursive: true });
execFileSync('xcrun', [
  '--sdk', 'macosx', 'clang++', '-std=c++17', '-fobjc-arc',
  '-mmacosx-version-min=12.0',
  '-arch', clangArch,
  '-x', 'objective-c++', '-bundle', '-undefined', 'dynamic_lookup',
  `-I${include}`, '-framework', 'AppKit', '-framework', 'CoreServices',
  join(root, 'native', 'menu-bar-appearance.mm'), '-o', join(outputDirectory, 'menu-bar-appearance.node'),
], { stdio: 'inherit' });
execFileSync('xcrun', [
  '--sdk', 'macosx', 'clang++', '-std=c++17', '-fobjc-arc', '-fobjc-weak',
  '-mmacosx-version-min=14.0',
  '-arch', clangArch,
  '-x', 'objective-c++', '-bundle', '-undefined', 'dynamic_lookup',
  `-I${include}`, '-framework', 'AppKit', '-framework', 'QuartzCore',
  '-framework', 'ScreenCaptureKit', '-framework', 'CoreMedia', '-framework', 'CoreVideo',
  '-framework', 'CoreImage', '-framework', 'CoreGraphics',
  join(import.meta.dirname, 'memmy-pip.mm'), '-o', join(outputDirectory, 'memmy-pip.node'),
], { stdio: 'inherit' });
