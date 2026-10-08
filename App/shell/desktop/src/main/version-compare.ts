type ParsedVersion = {
  core: number[];
  prerelease: Array<number | string> | null;
};

function parseVersion(value: string): ParsedVersion | null {
  const match = value.trim().match(/^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u);
  if (!match) return null;
  const core = (match[1] ?? '').split('.').map(Number);
  const prerelease = match[2]?.split('.').map(identifier => /^\d+$/u.test(identifier) ? Number(identifier) : identifier) ?? null;
  return { core, prerelease };
}

/** Compare release versions using SemVer precedence, including prereleases. */
export function compareVersionSegments(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  if (!parsedLeft || !parsedRight) {
    const leftParts = (left.match(/\d+/gu) ?? []).map(Number);
    const rightParts = (right.match(/\d+/gu) ?? []).map(Number);
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  const coreLength = Math.max(parsedLeft.core.length, parsedRight.core.length);
  for (let index = 0; index < coreLength; index += 1) {
    const diff = (parsedLeft.core[index] ?? 0) - (parsedRight.core[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (parsedLeft.prerelease === null && parsedRight.prerelease === null) return 0;
  if (parsedLeft.prerelease === null) return 1;
  if (parsedRight.prerelease === null) return -1;

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    if (typeof leftIdentifier === 'number' && typeof rightIdentifier === 'number') return leftIdentifier - rightIdentifier;
    if (typeof leftIdentifier === 'number') return -1;
    if (typeof rightIdentifier === 'number') return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

/** Extract the full version, including a prerelease suffix, from a package name. */
export function parseUpdatePackageVersion(fileName: string): string | null {
  const match = fileName.match(/-(\d+(?:\.\d+)*)(-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?-(?:darwin|win32|linux)-/u);
  return match ? `${match[1]}${match[2] ?? ''}` : null;
}
