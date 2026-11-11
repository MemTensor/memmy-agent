import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Check the actual staged build, rather than relying on a Host version number.
export async function verifyTeachBrowserHost(root) {
  const capability = 'memmy.browser-event-sessions/v1';
  const contracts = path.join(root, 'App/backend/local-api-contracts/dist/plugin.js');
  const native = path.join(root, 'App/memmy-agent/dist/tools/plugin-host/native-services.js');
  const provider = path.join(root, 'App/memmy-agent/dist/tools/computer-history/browser-event-capture.js');
  const extension = path.join(root, 'App/shell/desktop/extensions/memmy-browser');
  const exists = relative => fs.existsSync(path.join(extension, relative));
  const manifest = exists('manifest.json')
    ? JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')) : null;
  const advertised = fs.existsSync(contracts)
    ? (await import(pathToFileURL(contracts).href)).PLUGIN_HOST_CAPABILITIES : [];
  const checks = {
    browserCapability: advertised.includes(capability),
    providerBuilt: fs.existsSync(provider),
    providerWired: fs.existsSync(native) && fs.readFileSync(native, 'utf8').includes('createBrowserCaptureProvider'),
    recorderIncluded: exists('teaching-recorder.js'),
    pageCollectorIncluded: exists('teaching-page.js'),
    pageCollectorPackaged: manifest?.content_scripts?.some(script => script.js?.includes('teaching-page.js')) === true,
  };
  const artifacts = [contracts, native, provider, path.join(extension, 'manifest.json'),
    path.join(extension, 'background.js'), path.join(extension, 'teaching-recorder.js'),
    path.join(extension, 'teaching-page.js')].filter(file => fs.existsSync(file)).map(file => ({
      file: path.relative(root, file).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    }));
  return { root, capability, extensionVersion: manifest?.version ?? null, artifacts,
    checks, passed: Object.values(checks).every(Boolean) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(import.meta.dirname, '..');
  const result = await verifyTeachBrowserHost(root);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
