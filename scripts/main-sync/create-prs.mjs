import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repository = 'MemTensor/memmy-agent';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function sha(value, name) {
  requireValue(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value), `Invalid ${name}`);
  return value;
}

function targetRef(value) {
  requireValue(typeof value === 'string' && /^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(value), 'Invalid target branch');
  return value;
}

function redact(value) {
  let text = String(value ?? '');
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    if (process.env[key]) text = text.split(process.env[key]).join('[REDACTED]');
  }
  return text.replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[REDACTED]')
    .replace(/[\r\n\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 800);
}

function runGh(args, input) {
  const result = spawnSync('gh', args, {
    cwd: root,
    env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' },
    encoding: 'utf8',
    input,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = redact(result.stderr || result.stdout || '');
    throw new Error(`GitHub API failed (${result.status}): ${detail}`);
  }
  const output = String(result.stdout || '').trim();
  return output ? JSON.parse(output) : null;
}

function readConfig() {
  const config = JSON.parse(fs.readFileSync(path.join(root, '.github/main-sync.json'), 'utf8'));
  requireValue(config?.schemaVersion === 1 && config.repository === repository, 'Unexpected main-sync configuration');
  requireValue(Array.isArray(config.targets) && config.targets.length > 0, 'No main-sync targets configured');
  return config;
}

function readRequest() {
  const requestPath = process.env.MAIN_SYNC_REQUEST_PATH;
  requireValue(requestPath && path.isAbsolute(requestPath), 'MAIN_SYNC_REQUEST_PATH is required');
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  requireValue(request?.kind === 'memmy.main-sync-request' && request.repository === repository, 'Invalid main-sync request');
  requireValue(/^v\d+\.\d+\.\d+$/.test(request.tag), 'Invalid release tag in request');
  requireValue(Number.isSafeInteger(request.releaseId) && request.releaseId > 0, 'Invalid release id in request');
  sha(request.sourceSha, 'request source SHA');
  return request;
}

function ref(apiPath) {
  return runGh(['api', `repos/${repository}${apiPath}`]);
}

function refOrNull(apiPath) {
  const result = spawnSync('gh', ['api', `repos/${repository}${apiPath}`], {
    cwd: root,
    env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && /404/.test(String(result.stderr || result.stdout))) return null;
  if (result.status !== 0) throw new Error(`GitHub API failed (${result.status})`);
  return JSON.parse(String(result.stdout));
}

function createRef(branch, sourceSha) {
  return runGh(['api', '--method', 'POST', `repos/${repository}/git/refs`,
    '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sourceSha}`]);
}

function openPulls(branch, target) {
  const query = new URLSearchParams({ state: 'open', head: `${repository.split('/')[0]}:${branch}`, base: target, per_page: '20' });
  return runGh(['api', `repos/${repository}/pulls?${query.toString()}`]);
}

function createPull(branch, target, sourceSha, releaseId) {
  const title = `Sync main into ${target}`;
  const body = [
    `Synchronize release #${releaseId} main snapshot \`${sourceSha}\` into \`${target}\`.`,
    '',
    'This PR is created directly by the trusted main-sync Action. Cloud CodingAgent may resolve conflicts and validation failures after the PR exists.',
    'Maintainer review and merge remain required.',
  ].join('\n');
  return runGh(['api', '--method', 'POST', `repos/${repository}/pulls`,
    '-f', `title=${title}`, '-f', `head=${branch}`, '-f', `base=${target}`, '-f', `body=${body}`, '-F', 'draft=true']);
}

export function createSyncPullRequests({ api = { ref, refOrNull, createRef, openPulls, createPull }, config = readConfig(), request = readRequest(), log = console.log } = {}) {
  const sourceSha = sha(api.ref('/git/ref/heads/main').object?.sha, 'current main SHA');
  const releaseTag = targetRef(request.tag);
  const results = [];
  for (const rawTarget of config.targets) {
    const target = targetRef(rawTarget);
    if (target === releaseTag) {
      results.push({ target, action: 'skipped', reason: 'released_target' });
      continue;
    }
    const targetBranch = api.refOrNull(`/git/ref/heads/${encodeURIComponent(target)}`);
    if (!targetBranch) {
      results.push({ target, action: 'skipped', reason: 'target_branch_missing' });
      continue;
    }
    const branch = `sync/main-to-${target}`;
    const pulls = api.openPulls(branch, target);
    if (pulls.length > 0) {
      results.push({ target, branch, action: 'reused_pr', prNumber: pulls[0].number });
      continue;
    }
    const existingBranch = api.refOrNull(`/git/ref/heads/${encodeURIComponent(branch)}`);
    let branchAction = 'reused';
    if (!existingBranch) {
      try {
        api.createRef(branch, sourceSha);
        branchAction = 'created';
      } catch (error) {
        const racedBranch = api.refOrNull(`/git/ref/heads/${encodeURIComponent(branch)}`);
        if (!racedBranch || sha(racedBranch.object?.sha, `${branch} head SHA`) !== sourceSha) throw error;
        branchAction = 'reused_after_race';
      }
    } else {
      const existingSha = sha(existingBranch.object?.sha, `${branch} head SHA`);
      if (existingSha !== sourceSha) {
        results.push({ target, branch, action: 'skipped', reason: 'existing_head_differs', existingSha, sourceSha });
        continue;
      }
    }
    const pull = api.createPull(branch, target, sourceSha, request.releaseId);
    results.push({ target, branch, action: 'created_pr', prNumber: pull.number, branchAction });
    log(`main-sync ${target}: ${branchAction}, PR #${pull.number}`);
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const results = createSyncPullRequests();
    process.stdout.write(JSON.stringify({ sourceSha: sha(ref('/git/ref/heads/main').object?.sha, 'current main SHA'), results }) + '\n');
  } catch (error) {
    console.error(`Direct main-sync PR creation blocked: ${error.message}`);
    process.exitCode = 1;
  }
}
