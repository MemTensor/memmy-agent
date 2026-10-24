#!/usr/bin/env node
/**
 * Executes packaged renderer JavaScript in a Node-only, in-memory DOM test.
 * No browser, Electron process, installation, network, or user profile is used.
 * Deliberately rejected runtime IPC must produce a visible startup error; this
 * checks React initialization, and is not GUI or real-user runtime acceptance.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import asar from '@electron/asar';
import { Window } from 'happy-dom';

const PROBE_ERROR = 'Memmy renderer bootstrap probe: runtime IPC disabled';
const BASE_URL = 'http://127.0.0.1:18970/';

export async function verifyRendererBootstrap({ asarPath, rendererDirectory, platform = 'darwin' }) {
  if (typeof vm.SourceTextModule !== 'function') {
    throw new Error('Renderer bootstrap verification requires Node --experimental-vm-modules.');
  }
  if (Boolean(asarPath) === Boolean(rendererDirectory)) {
    throw new Error('Provide exactly one of --asar or --renderer-dir.');
  }
  if (!['darwin', 'win32'].includes(platform)) throw new Error('Platform must be darwin or win32.');
  const archive = asarPath && resolve(asarPath);
  const rootDirectory = rendererDirectory && resolve(rendererDirectory);
  const readAsset = (pathname) => {
    const decoded = decodeURIComponent(pathname);
    const assetPath = decoded.replace(/^\/+/, '');
    if (!assetPath || assetPath.split('/').some(segment => segment === '..')) {
      throw new Error(`Invalid renderer asset path: ${pathname}`);
    }
    if (archive) return asar.extractFile(archive, join('dist', 'renderer', ...assetPath.split('/'))).toString('utf8');
    const absolutePath = resolve(rootDirectory, assetPath);
    const insidePath = relative(rootDirectory, absolutePath);
    if (isAbsolute(insidePath) || insidePath === '..' || insidePath.startsWith(`..${sep}`)) {
      throw new Error(`Renderer asset escapes its root: ${pathname}`);
    }
    return readFileSync(absolutePath, 'utf8');
  };
  const fatalErrors = [];
  const blockedIo = [];
  let runtimeConfigRequests = 0;
  const formatError = error => String(error?.stack ?? error?.message ?? error).slice(0, 5000);
  const recordFatal = error => fatalErrors.push(formatError(error));
  const window = new Window({
    url: BASE_URL,
    settings: {
      enableJavaScriptEvaluation: false,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      enableImageFileLoading: false,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
        disableFallbackToSetURL: true
      }
    }
  });
  try {
    window.document.write(readAsset('/index.html'));
    const root = window.document.getElementById('root');
    if (!root) throw new Error('Packaged renderer index.html has no #root.');
    const entrySources = [...window.document.querySelectorAll('script[type="module"][src]')]
      .map(script => new URL(script.getAttribute('src'), BASE_URL));
    if (entrySources.length !== 1) throw new Error('Expected exactly one renderer module entrypoint.');
    const entryUrl = entrySources[0];
    if (entryUrl.origin !== new URL(BASE_URL).origin) throw new Error('Renderer entrypoint must be local.');

    window.console = Object.fromEntries(['log', 'info', 'warn', 'debug', 'error'].map(level => [
      level, (...args) => { if (level === 'error') recordFatal(args.map(formatError).join(' ')); }
    ]));
    window.reportError = recordFatal;
    window.addEventListener('error', event => {
      recordFatal(event.error ?? event.message);
      event.preventDefault();
    });
    window.addEventListener('unhandledrejection', event => {
      recordFatal(event.reason);
      event.preventDefault();
    });
    window.__electronLog = { sendToMain(message) {
      if (message?.cmd === 'errorHandler') recordFatal(message.error);
      else if (message?.level === 'error') recordFatal(message.data?.map(formatError).join(' '));
    } };
    const blockIo = kind => {
      blockedIo.push(kind);
      throw new Error(`Renderer bootstrap probe forbids ${kind}.`);
    };
    window.fetch = async () => blockIo('fetch');
    window.open = () => blockIo('window.open');
    window.navigator.sendBeacon = () => blockIo('sendBeacon');
    for (const kind of ['XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker']) {
      window[kind] = class { constructor() { blockIo(kind); } };
    }
    window.memmy = {
      platform,
      osRelease: platform === 'darwin' ? '27.0' : '10.0.26100',
      getInstallationId: async () => 'memmy-renderer-bootstrap-probe',
      getAppInfo: async () => ({ version: 'probe', appEnv: 'prod', appEdition: 'cn' }),
      getRuntimeConfig: async () => {
        runtimeConfigRequests++;
        throw new Error(PROBE_ERROR);
      },
      getMainWindowFullScreen: async () => false,
      isMainWindowFullScreen: async () => false,
      onMainWindowFullScreenChanged: () => () => {},
      sendAnalyticsClientId: () => {},
      notifyRendererReady: () => {}
    };

    const context = vm.createContext(window);
    const modules = new Map();
    const localModuleUrl = (specifier, referringUrl) => {
      const url = new URL(specifier, referringUrl);
      if (url.origin !== new URL(BASE_URL).origin) {
        throw new Error(`Only packaged local module imports are allowed: ${specifier}`);
      }
      return url;
    };
    const loadModule = (url) => {
      if (modules.has(url.href)) return modules.get(url.href);
      const module = new vm.SourceTextModule(readAsset(url.pathname), {
        context,
        identifier: url.href,
        initializeImportMeta(meta) { meta.url = url.href; },
        importModuleDynamically: async (specifier, referringModule) => {
          const imported = loadModule(localModuleUrl(specifier, referringModule.identifier));
          if (imported.status === 'unlinked') await imported.link(linker);
          if (imported.status === 'linked') await imported.evaluate({ timeout: 10_000 });
          return imported;
        }
      });
      modules.set(url.href, module);
      return module;
    };
    const linker = (specifier, referringModule) => loadModule(localModuleUrl(specifier, referringModule.identifier));
    const entry = loadModule(entryUrl);
    await entry.link(linker);
    await entry.evaluate({ timeout: 10_000 });
    // React schedules its first render and effect after module evaluation.
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
      if (fatalErrors.length || (runtimeConfigRequests > 0 && root.textContent.includes(PROBE_ERROR))) break;
    }
    // Drain deferred logger reports before deciding whether the bootstrap passed.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    const bootstrapErrorScreenReached = root.textContent.includes(PROBE_ERROR);
    const rootBytes = Buffer.byteLength(root.innerHTML);
    const ok = fatalErrors.length === 0 && blockedIo.length === 0 && runtimeConfigRequests > 0
      && rootBytes > 0 && bootstrapErrorScreenReached;
    return {
      ok,
      platform,
      input: archive ?? rootDirectory,
      entry: entryUrl.pathname,
      modulesEvaluated: modules.size,
      runtimeConfigRequests,
      bootstrapErrorScreenReached,
      rootBytes,
      fatalErrors,
      blockedIo,
      acceptance: 'Node-only renderer bootstrap; real installation, IPC, GUI and upgrade remain untested.'
    };
  } finally {
    await window.happyDOM.abort();
  }
}

function readArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${key}.`);
    if (key === '--asar') options.asarPath = value;
    else if (key === '--renderer-dir') options.rendererDirectory = value;
    else if (key === '--platform') options.platform = value;
    else throw new Error(`Unknown argument: ${key}.`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Keep the CLI callable with ordinary `node`; only its isolated worker needs
  // Node's module-VM flag. The subprocess is Node, never Electron or a browser.
  if (typeof vm.SourceTextModule !== 'function') {
    const worker = spawnSync(process.execPath, [
      '--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)
    ], { stdio: 'inherit', timeout: 30_000 });
    if (worker.error) {
      console.error(worker.error.message);
      process.exitCode = 1;
    } else process.exitCode = worker.status ?? 1;
  } else {
    try {
      const result = await verifyRendererBootstrap(readArguments(process.argv.slice(2)));
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
      process.exitCode = 1;
    }
  }
}
