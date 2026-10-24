import { describe, expect, it } from 'vitest';
import { compareVersionSegments, parseUpdatePackageVersion } from '../src/main/version-compare.js';

describe('compareVersionSegments', () => {
  it('orders a prerelease below its stable release', () => {
    expect(compareVersionSegments('1.1.9-rc.1', '1.1.9')).toBeLessThan(0);
    expect(compareVersionSegments('1.1.9', '1.1.9-rc.1')).toBeGreaterThan(0);
  });

  it('orders prerelease identifiers according to SemVer', () => {
    expect(compareVersionSegments('1.1.9-rc.2', '1.1.9-rc.10')).toBeLessThan(0);
    expect(compareVersionSegments('1.1.9-alpha', '1.1.9-beta')).toBeLessThan(0);
    expect(compareVersionSegments('1.1.9-1', '1.1.9-alpha')).toBeLessThan(0);
  });

  it('ignores build metadata and preserves ordinary numeric comparisons', () => {
    expect(compareVersionSegments('1.2.3+build.5', '1.2.3+build.8')).toBe(0);
    expect(compareVersionSegments('1.2.4', '1.2.3')).toBeGreaterThan(0);
  });

  it('keeps prerelease metadata when parsing downloaded package names', () => {
    expect(parseUpdatePackageVersion('Memmy-1.1.9-rc.1-darwin-arm64-cn-unsigned.dmg')).toBe('1.1.9-rc.1');
    expect(parseUpdatePackageVersion('Memmy-1.2.0-win32-x64-cn.exe')).toBe('1.2.0');
  });
});
