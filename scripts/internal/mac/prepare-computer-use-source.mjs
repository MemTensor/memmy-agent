import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Recreate patched sources while preserving Swift's compiler/build caches. */
export function prepareComputerUseSource({ cache, vendor, buildIdentifier }) {
  fs.mkdirSync(cache, { recursive: true });
  // tar overwrites upstream files but leaves files added by the previous patch.
  // Those leftovers make patch treat file additions as reverse deletions.
  for (const directory of ['apps', 'packages', 'Tests']) {
    fs.rmSync(path.join(cache, directory), { recursive: true, force: true });
  }
  const run = (command, args) => execFileSync(command, args, { cwd: cache, stdio: 'inherit' });
  run('/usr/bin/tar', ['-xzf', path.join(vendor, 'source-0.3.5.tar.gz')]);
  run('/usr/bin/patch', ['-p1', '--batch', '--forward', '-i', path.join(vendor, 'memmy-permissions.patch')]);
  fs.copyFileSync(path.join(vendor, 'Package.swift'), path.join(cache, 'Package.swift'));
  fs.cpSync(path.join(vendor, 'Tests'), path.join(cache, 'Tests'), { recursive: true });
  fs.writeFileSync(path.join(cache, 'apps/OpenComputerUse/Sources/OpenComputerUse/MemmyNativeBuild.swift'),
    `enum MemmyNativeBuild { static let identifier = ${JSON.stringify(buildIdentifier)} }\n`);
}
