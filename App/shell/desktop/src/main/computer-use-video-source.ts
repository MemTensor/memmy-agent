import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopCapturerSource } from 'electron';

export type WindowOwner = { id: number; owner: string; bundleId: string; title: string };

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
    if (!exact || (windowById.has(targetWindowId) && !ownerMatches(exact))) return null;
    return exact;
  }
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

/** Packaged metadata helper; source-title matching remains available in development. */
export function listComputerUseWindows(resourcesPath: string, arch = process.arch): WindowOwner[] {
  const binary = join(resourcesPath, 'app.asar.unpacked', 'dist', 'runtime', 'memmy-agent',
    'dist', 'tools', 'computer-use', 'mac', 'native', arch, 'list-windows');
  if (!existsSync(binary)) return [];
  try {
    const rows: unknown = JSON.parse(execFileSync(binary, [], { encoding: 'utf8', timeout: 3000, maxBuffer: 256_000 }));
    if (!Array.isArray(rows)) return [];
    return rows.filter((row): row is WindowOwner => row !== null && typeof row === 'object'
      && Number.isSafeInteger((row as WindowOwner).id)
      && typeof (row as WindowOwner).owner === 'string'
      && typeof (row as WindowOwner).bundleId === 'string'
      && typeof (row as WindowOwner).title === 'string');
  } catch { return []; }
}
