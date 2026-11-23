import { describe, expect, it } from 'vitest';
import { createSyncPullRequests } from '../scripts/main-sync/create-prs.mjs';

const sourceSha = 'a'.repeat(40);
const targetSha = 'b'.repeat(40);

function fixture(overrides = {}) {
  const branches = new Map(Object.entries({
    'v1.2.8': { object: { sha: targetSha } },
    'v1.2.9': { object: { sha: targetSha } },
    'v1.3.0': { object: { sha: targetSha } },
    ...overrides.branches,
  }));
  const pulls = new Map(Object.entries(overrides.pulls ?? {}));
  const calls = [];
  let nextPr = 1000;
  const api = {
    ref(path) {
      calls.push(['main', path]);
      if (path !== '/git/ref/heads/main') throw new Error('Unexpected main ref');
      return { object: { sha: sourceSha } };
    },
    refOrNull(path) {
      calls.push(['ref', path]);
      const key = decodeURIComponent(path.split('/git/ref/heads/')[1]);
      return branches.get(key) ?? null;
    },
    createRef(branch, sha) {
      calls.push(['createRef', branch, sha]);
      branches.set(branch, { object: { sha } });
      return { ref: `refs/heads/${branch}` };
    },
    openPulls(branch, target) {
      calls.push(['openPulls', branch, target]);
      return pulls.get(target) ?? [];
    },
    createPull(branch, target, sha, releaseId) {
      calls.push(['createPull', branch, target, sha, releaseId]);
      const pull = { number: nextPr++, head: { ref: branch, sha }, base: { ref: target } };
      pulls.set(target, [pull]);
      return pull;
    },
  };
  return { api, calls };
}

const config = { targets: ['v1.2.7', 'v1.2.8', 'v1.2.9', 'v1.3.0'] };
const request = { kind: 'memmy.main-sync-request', repository: 'MemTensor/memmy-agent', tag: 'v1.2.7', sourceSha, releaseId: 451415117 };

describe('direct main-sync PR producer', () => {
  it('creates one branch and PR for each existing future target and skips the released target', () => {
    const f = fixture();
    const result = createSyncPullRequests({ api: f.api, config, request, log: () => {} });
    expect(result).toEqual([
      { target: 'v1.2.7', action: 'skipped', reason: 'released_target' },
      { target: 'v1.2.8', branch: 'sync/main-to-v1.2.8', action: 'created_pr', prNumber: 1000, branchAction: 'created' },
      { target: 'v1.2.9', branch: 'sync/main-to-v1.2.9', action: 'created_pr', prNumber: 1001, branchAction: 'created' },
      { target: 'v1.3.0', branch: 'sync/main-to-v1.3.0', action: 'created_pr', prNumber: 1002, branchAction: 'created' },
    ]);
    expect(f.calls.filter(call => call[0] === 'createPull')).toHaveLength(3);
    expect(f.calls.filter(call => call[0] === 'createRef')).toHaveLength(3);
  });

  it('reuses an existing PR and never rewrites an existing branch head', () => {
    const f = fixture({
      branches: { 'sync/main-to-v1.2.8': { object: { sha: 'c'.repeat(40) } } },
      pulls: { 'v1.2.9': [{ number: 930 }] },
    });
    const result = createSyncPullRequests({ api: f.api, config, request, log: () => {} });
    expect(result).toContainEqual({ target: 'v1.2.8', branch: 'sync/main-to-v1.2.8', action: 'skipped', reason: 'existing_head_differs', existingSha: 'c'.repeat(40), sourceSha });
    expect(result).toContainEqual({ target: 'v1.2.9', branch: 'sync/main-to-v1.2.9', action: 'reused_pr', prNumber: 930 });
    expect(f.calls.filter(call => call[0] === 'createRef')).toHaveLength(1);
    expect(f.calls.filter(call => call[0] === 'createPull')).toHaveLength(1);
  });

  it('skips a target whose release branch does not exist', () => {
    const f = fixture({ branches: { 'v1.2.9': null } });
    const result = createSyncPullRequests({ api: f.api, config, request, log: () => {} });
    expect(result).toContainEqual({ target: 'v1.2.9', action: 'skipped', reason: 'target_branch_missing' });
  });
});
