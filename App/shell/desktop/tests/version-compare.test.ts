import { describe, expect, it } from 'vitest';
import { compareVersionSegments, parseUpdatePackageVersion } from '../src/main/version-compare.js';

describe('compareVersionSegments', () => {
  it.each([
    ['1.2.4', '1.2.401'],
    ['1.2.401', '1.2.402'],
    ['1.2.402', '1.2.5'],
    ['1.2.5', '1.2.6'],
    ['1.2.6', '1.3.0'],
    ['1.2.10', '1.2.9'],
    ['1.10.0', '1.9.9'],
    ['1.1.9', '1.1.9-rc.1'],
    ['1.1.9-rc.10', '1.1.9-rc.2'],
    ['1.1.9-alpha', '1.1.9-beta'],
    ['1.2.3+build.5', '1.2.3+build.8'],
  ])('orders %s before %s by character', (older, newer) => {
    expect(compareVersionSegments(older, newer)).toBe(-1);
    expect(compareVersionSegments(newer, older)).toBe(1);
  });

  it('only returns equality for identical identifiers', () => {
    expect(compareVersionSegments('1.2.401', '1.2.401')).toBe(0);
  });

  it('keeps prerelease metadata when parsing downloaded package names', () => {
    expect(parseUpdatePackageVersion('Memmy-1.1.9-rc.1-darwin-arm64-cn-unsigned.dmg')).toBe('1.1.9-rc.1');
    expect(parseUpdatePackageVersion('Memmy-1.2.0-win32-x64-cn.exe')).toBe('1.2.0');
  });
});
