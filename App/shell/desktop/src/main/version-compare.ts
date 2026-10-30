/** Compare complete release identifiers in character order, so 1.2.401 precedes 1.2.5. */
export function compareVersionSegments(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Extract the full version, including a prerelease suffix, from a package name. */
export function parseUpdatePackageVersion(fileName: string): string | null {
  const match = fileName.match(/-(\d+(?:\.\d+)*)(-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?-(?:darwin|win32|linux)-/u);
  return match ? `${match[1]}${match[2] ?? ''}` : null;
}
