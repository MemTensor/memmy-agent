import { lstatSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Revoke the retired feature's local consent without changing app permissions
 * or macOS authorization policy. System components require separate removal. */
export function retireLockedMacConsent(userDataDirectory: string): void {
  const directory = join(userDataDirectory, 'computer-use');
  const parent = lstatSync(directory, { throwIfNoEntry: false });
  if (!parent?.isDirectory() || parent.isSymbolicLink()) return;
  const filePath = join(directory, 'locked-mac-consent.json');
  const file = lstatSync(filePath, { throwIfNoEntry: false });
  if (!file?.isFile() || file.isSymbolicLink()) return;
  try { unlinkSync(filePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
