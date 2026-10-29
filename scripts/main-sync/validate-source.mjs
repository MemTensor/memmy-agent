import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHubCLI } from './github.mjs';
import { assertSha, positiveInteger, normalizeConfig, requireValue } from './core.mjs';

export function verifyCandidate({ api, config, env }) {
  requireValue(env.GITHUB_REPOSITORY === config.repository && env.GITHUB_REF === 'refs/heads/main', 'Trusted main validation controller required');
  const head = assertSha(env.SYNC_CANDIDATE_SHA), base = assertSha(env.SYNC_BASE_SHA);
  const number = positiveInteger(env.SYNC_PR_NUMBER, 'pull request');
  const key = env.SYNC_VALIDATION_KEY;
  requireValue(typeof key === 'string' && key.length === 64 && /^[a-f0-9]+$/.test(key), 'Invalid validation identity');
  const pr = api.request('GET', '/pulls/' + number);
  requireValue(pr.state === 'open' && pr.head?.sha === head && pr.base?.repo?.full_name === config.repository &&
    config.targets.includes(pr.base?.ref) && pr.head?.ref === 'sync/main-to-' + pr.base.ref, 'Candidate PR changed scope');
  requireValue(typeof pr.head.repo?.full_name === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pr.head.repo.full_name), 'Invalid head repository');
  const ref = api.request('GET', '/git/ref/heads/' + encodeURIComponent(pr.base.ref));
  requireValue(ref.object?.sha === base, 'Target advanced; refresh the sync candidate');
  const comparison = api.request('GET', '/compare/' + base + '...' + head);
  requireValue(comparison.merge_base_commit?.sha === base, 'Candidate has not integrated the current target');
  return { headSha: head, baseSha: base, prNumber: number, validationKey: key, headRepository: pr.head.repo.full_name };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const config = normalizeConfig(JSON.parse(fs.readFileSync(path.join(root, '.github/main-sync.json'), 'utf8')));
    const result = verifyCandidate({ api: new GitHubCLI(config.repository), config, env: process.env });
    for (const [key, value] of Object.entries({ head: result.headSha, base: result.baseSha, pr: result.prNumber,
      validation_key: result.validationKey, head_repository: result.headRepository })) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, key + '=' + value + '\n');
    }
  } catch (error) { console.error('Candidate validation blocked: ' + error.message); process.exitCode = 1; }
}
