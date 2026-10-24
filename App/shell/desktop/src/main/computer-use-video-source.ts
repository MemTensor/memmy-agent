import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopCapturerSource } from 'electron';

export type WindowOwner = { id: number; pid?: number; owner: string; bundleId: string; title: string };

function normalized(value: string): string { return value.trim().toLocaleLowerCase(); }

export function windowIdFromSource(sourceId: string): number | null {
  const match = /^window:(\d+)(?::|$)/.exec(sourceId);
  return match ? Number(match[1]) : null;
}

/** Match exact bundle/owner first, then the source title when metadata is unavailable. */
export function selectComputerUseWindowSource(
  sources: ReadonlyArray<Pick<DesktopCapturerSource, 'id' | 'name'>>,
  target: string,
  windows: ReadonlyArray<WindowOwner>,
  targetWindowId?: number,
  targetPid?: number,
): Pick<DesktopCapturerSource, 'id' | 'name'> | null {
  const wanted = normalized(target);
  if (!wanted) return null;
  const processName = wanted.endsWith('.exe') ? wanted.slice(0, -4) : wanted;
  const names = processName.startsWith('microsoft ')
    ? [processName, processName.slice('microsoft '.length)] : [processName];
  const windowById = new Map(windows.map(window => [window.id, window]));
  const ownerMatches = (source: Pick<DesktopCapturerSource, 'id' | 'name'>): boolean => {
    const id = windowIdFromSource(source.id);
    const owner = id === null ? undefined : windowById.get(id);
    if (!owner) return false;
    const bundleId = normalized(owner.bundleId);
    const segments = bundleId.split('.');
    // macOS reports localized owner names and document titles. Match the
    // stable bundle product (e.g. com.apple.TextEdit) to the model's app name.
    const product = segments.at(-1) ?? '';
    const vendorProduct = segments.length > 1 ? `${segments.at(-2)} ${product}` : '';
    return bundleId === wanted || normalized(owner.owner) === wanted
      || names.includes(product) || names.includes(vendorProduct);
  };
  if (targetWindowId !== undefined) {
    const exact = sources.find(source => windowIdFromSource(source.id) === targetWindowId);
    if (targetPid !== undefined) {
      // The native observation establishes the exact PID/window tuple. A
      // localized app name or alias cannot overrule that stronger identity.
      return exact && Number.isSafeInteger(targetPid) && targetPid > 0
        && windowById.get(targetWindowId)?.pid === targetPid ? exact : null;
    }
    if (!exact || (windowById.has(targetWindowId) && !ownerMatches(exact))) return null;
    return exact;
  }
  if (targetPid !== undefined) return null;
  const owned = sources.filter(ownerMatches);
  if (owned.length > 0) return owned.length === 1 ? owned[0]! : null;
  const named = sources.filter(source => names.includes(normalized(source.name)));
  if (named.length > 0) return named.length === 1 ? named[0]! : null;
  const titled = sources.filter(source => names.some(name => {
      const title = normalized(source.name);
      return title.endsWith(` - ${name}`) || title.startsWith(`${name} - `);
    }));
  return titled.length === 1 ? titled[0]! : null;
}

/** Read ownership from the embedded or locally staged native metadata helper. */
export function listComputerUseWindows(resourcesPath: string, arch = process.arch): WindowOwner[] {
  const helper = ['tools', 'computer-use', 'mac', 'native', arch, 'list-windows'];
  const binary = [
    join(resourcesPath, 'app.asar.unpacked', 'dist', 'runtime', 'memmy-agent', 'dist', ...helper),
    join(import.meta.dirname, '../runtime/memmy-agent/dist', ...helper),
    join(import.meta.dirname, '../../../../memmy-agent/dist', ...helper),
  ].find(existsSync);
  if (!binary) return [];
  try {
    const rows: unknown = JSON.parse(execFileSync(binary, [], { encoding: 'utf8', timeout: 3000, maxBuffer: 256_000 }));
    if (!Array.isArray(rows)) return [];
    return rows.filter((row): row is WindowOwner => row !== null && typeof row === 'object'
      && Number.isSafeInteger((row as WindowOwner).id)
      && ((row as WindowOwner).pid === undefined || (Number.isSafeInteger((row as WindowOwner).pid) && (row as WindowOwner).pid! > 0))
      && typeof (row as WindowOwner).owner === 'string'
      && typeof (row as WindowOwner).bundleId === 'string'
      && typeof (row as WindowOwner).title === 'string');
  } catch { return []; }
}
