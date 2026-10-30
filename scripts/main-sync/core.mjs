import { createHash } from 'node:crypto';

export function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
export function assertSha(value) {
  requireValue(typeof value === 'string' && value.length === 40 && /^[a-f0-9]{40}$/.test(value), 'Expected a complete lowercase commit SHA');
  return value;
}
export function positiveInteger(value, name = 'identifier') {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  requireValue(Number.isSafeInteger(number) && number > 0, 'Invalid ' + name);
  return number;
}
export function normalizeConfig(input) {
  requireValue(input?.schemaVersion === 1 && input.repository === 'MemTensor/memmy-agent', 'Unexpected main-sync configuration');
  requireValue(Array.isArray(input.targets) && input.targets.length > 0 && input.targets.length <= 10, 'Expected an active target allowlist');
  for (const target of input.targets) requireValue(typeof target === 'string' && target.length <= 100 && /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(target), 'Invalid maintained target');
  requireValue(new Set(input.targets).size === input.targets.length, 'Duplicate maintained target');
  for (const [name, fallback, maximum] of [['maxRounds',6,12],['maxNoProgress',2,4],['maxDurationMinutes',180,360]]) {
    const value=input[name] ?? fallback;
    requireValue(Number.isSafeInteger(value) && value > 0 && value <= maximum, 'Invalid ' + name);
  }
  return { schemaVersion:1,repository:input.repository,targets:[...input.targets],
    maxRounds:input.maxRounds ?? 6,maxNoProgress:input.maxNoProgress ?? 2,maxDurationMinutes:input.maxDurationMinutes ?? 180 };
}
export function validateRelease(release, { releaseId, sourceSha, tagSha, expectedAssets, allowPublished = false }) {
  positiveInteger(releaseId, 'release id'); assertSha(sourceSha);
  requireValue(release?.id === Number(releaseId), 'Release id changed');
  requireValue((release.draft === true || (allowPublished && release.draft === false)) && release.prerelease !== true, 'A stable release is required');
  requireValue(typeof release.tag_name === 'string' && /^v\d+\.\d+\.\d+$/.test(release.tag_name), 'Unsupported release tag');
  requireValue(Number.isFinite(Date.parse(release.created_at)), 'Missing release creation time');
  if (tagSha !== undefined) requireValue(assertSha(tagSha) === sourceSha, 'Tag points to another source');
  else requireValue(release.draft === true && release.target_commitish === sourceSha, 'Release source is ambiguous');
  requireValue(Array.isArray(release.assets) && release.assets.length > 0, 'Release assets are incomplete');
  const names=new Set();
  for (const asset of release.assets) {
    requireValue(typeof asset.name === 'string' && !names.has(asset.name), 'Invalid or duplicate asset');
    names.add(asset.name);
    requireValue(asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0, 'Asset upload is incomplete');
  }
  if (expectedAssets) {
    requireValue(expectedAssets.length === release.assets.length, 'Asset set changed');
    for (const expected of expectedAssets) {
      const actual=release.assets.find(item=>item.name === expected.name);
      requireValue(actual && actual.size === expected.size, 'Missing asset or size mismatch: ' + expected.name);
      if (actual.digest) requireValue(actual.digest === 'sha256:' + expected.sha256, 'Asset digest mismatch: ' + expected.name);
    }
  }
  return { releaseId:release.id,sourceSha,tag:release.tag_name,releaseCreatedAt:release.created_at };
}
export function digest(value) { return createHash('sha256').update(value).digest('hex'); }
