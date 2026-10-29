import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, sep } from 'node:path';
import type { EmbeddedBrowserRequest } from '@memmy/local-api-contracts';
import type { EmbeddedBrowserDriver, ApprovedBrowserUpload } from './embedded-browser-driver.js';

type Driver = Pick<EmbeddedBrowserDriver, 'uploadOrigin' | 'handle'>;

/** Keep the approval, selected tab, and files bound to one webview upload operation. */
export async function runApprovedEmbeddedUpload(request: EmbeddedBrowserRequest, workspace: string,
  driver: Driver, approve: (origin: string, names: string[]) => Promise<boolean>,
  isCurrentChild: () => boolean = () => true, approvalTimeoutMs = 5 * 60_000): Promise<unknown> {
  if (!isCurrentChild()) throw new Error('Browser upload request is no longer active');
  const paths = request.args.paths;
  if (request.command !== 'upload' || !Number.isSafeInteger(request.tabId)
    || !Array.isArray(paths) || paths.length < 1 || paths.length > 20
    || paths.some(file => typeof file !== 'string' || file.length > 4096 || !isAbsolute(file))) {
    throw new Error('Invalid browser upload');
  }
  const root = await realpath(workspace);
  const stamps: ApprovedBrowserUpload['stamps'] = [];
  for (const file of paths as string[]) {
    const info = await lstat(file);
    const real = await realpath(file);
    const inside = relative(root, real);
    if (!info.isFile() || info.isSymbolicLink() || !inside || inside === '..'
      || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new Error('Browser upload file is outside the trusted workspace');
    }
    stamps.push({ path: file, realPath: real, dev: info.dev, ino: info.ino,
      size: info.size, mtimeMs: info.mtimeMs });
  }
  const origin = driver.uploadOrigin(request.tabId!);
  const names = (paths as string[]).map(file =>
    basename(file.replace(/\\/g, '/')).replace(/[\x00-\x1f]/g, '_').slice(0, 120) || 'file');
  const deadline = Date.now() + approvalTimeoutMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timelyApproval = await Promise.race([
    approve(origin, names),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), approvalTimeoutMs); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (!timelyApproval || Date.now() >= deadline || !isCurrentChild()) {
    throw new Error('Browser upload was not approved');
  }
  for (const stamp of stamps) {
    const info = await lstat(stamp.path);
    if (await realpath(stamp.path) !== stamp.realPath || info.dev !== stamp.dev
      || info.ino !== stamp.ino || info.size !== stamp.size || info.mtimeMs !== stamp.mtimeMs) {
      throw new Error('Browser upload file changed after approval');
    }
  }
  if (!isCurrentChild() || driver.uploadOrigin(request.tabId!) !== origin) {
    throw new Error('Browser upload site changed after approval');
  }
  return driver.handle(request, { origin, stamps, isCurrentChild });
}
