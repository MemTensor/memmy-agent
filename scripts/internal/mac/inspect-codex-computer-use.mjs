#!/usr/bin/env node
// Report component fingerprints from a locally installed Codex Desktop package.
// This deliberately prints no bundled source or binary content.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const appPath = process.argv[2] ?? '/Applications/ChatGPT.app';
const contents = path.join(appPath, 'Contents');
const resources = path.join(contents, 'Resources');
const plist = path.join(contents, 'Info.plist');

function plistValue(key, file = plist) {
  try { return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

function markers(file, names) {
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  return Object.fromEntries(names.map(name => [name, bytes.includes(Buffer.from(name))]));
}

const asarPath = path.join(resources, 'app.asar');
let mainProcess = null;
if (fs.existsSync(asarPath)) {
  const main = asar.listPackage(asarPath).find(file => /^\/?\.vite\/build\/main-[^/]+\.js$/.test(file));
  if (main) {
    const source = asar.extractFile(asarPath, main.replace(/^\//, '')).toString('utf8');
    mainProcess = {
      packageFile: main,
      browserPip: source.includes('upsertBrowserUsePIPContent'),
      browserPipClickHandler: source.includes('setBrowserUsePIPContentClickHandler'),
      toolSurfaceMetadata: source.includes('codex/toolSurface'),
      remotePipHost: source.includes('startRemoteHostedPIPContentHost'),
    };
  }
}

const cuaRoot = path.join(resources, 'cua_node/lib/node_modules/@oai');
const serviceApp = path.join(cuaRoot, 'sky/Codex Computer Use.app');
const service = path.join(serviceApp, 'Contents/MacOS/SkyComputerUseService');
const result = {
  app: { path: appPath, version: plistValue('CFBundleShortVersionString'), bundleId: plistValue('CFBundleIdentifier') },
  unifiedPlugin: fs.existsSync(path.join(resources, 'plugins/openai-bundled/plugins/unified-computer-use/.codex-plugin/plugin.json')),
  browserService: fs.existsSync(path.join(cuaRoot, 'browser-desktop')),
  cuaRuntime: fs.existsSync(path.join(cuaRoot, 'cua-repl')),
  browserHistoryGuidance: fs.existsSync(path.join(cuaRoot, 'browser-desktop/environment-docs/codex-app/api-use-behavior.md'))
    && fs.readFileSync(path.join(cuaRoot, 'browser-desktop/environment-docs/codex-app/api-use-behavior.md'), 'utf8').includes('browser.history()'),
  mainProcess,
  nativeAddon: markers(path.join(resources, 'native/sky.node'), [
    'upsertBrowserUsePIPContent', 'startRemoteHostedPIPContentHost', 'setRemoteHostedPIPContentVideoFrameHandler', 'PIPStackWindow',
  ]),
  macService: {
    bundleId: plistValue('CFBundleIdentifier', path.join(serviceApp, 'Contents/Info.plist')),
    features: markers(service, [
      'ScreenCaptureKit', 'AXUIElement', 'VirtualCursor',
      'SystemFocusStealPreventer', 'FocusRestoreTarget', 'UserInterruptedIntervention',
    ]),
  },
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
