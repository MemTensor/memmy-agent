import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/windows-computer-history-validation.yml', import.meta.url), 'utf8'));
const job = workflow.jobs.validate;
const steps = job.steps as Array<Record<string, any>>;
const step = (id: string) => steps.find((entry) => entry.id === id);
const sha = 'a'.repeat(40), eventSha = 'b'.repeat(40);
const repo = 'MemTensor/memmy-agent';
const direct = `${repo}/.github/workflows/windows-computer-history-validation.yml@refs/heads/main`;
const memoryFixtureFiles = ['Memory/tests/storage/panel-cache-isolation.test.ts',
  'Memory/tests/service/read-model/panel-stats-migration.test.ts'];

function memoryFixtureReport() {
  return { numTotalTests: 10, numPassedTests: 10, numPendingTests: 0,
    testResults: memoryFixtureFiles.map((file, index) => ({
      name: `C:\\runner\\repo\\${file.replaceAll('/', '\\')}`, status: 'passed',
      assertionResults: Array.from({ length: index === 0 ? 7 : 3 }, () => ({ status: 'passed' })),
    })) };
}

function validateMemoryFixtureReport(report: unknown, raw?: string) {
  const script = String(step('history-contracts')?.run ?? '')
    .match(/# Validate portable Memory fixture reports\.\r?\n@'\r?\n([\s\S]*?)\r?\n'@ \| node/);
  if (!script) throw new Error('Missing portable Memory fixture report guard');
  runInNewContext(script[1]!, { process: { env: { MEMMY_WINDOWS_MEMORY_PANEL_RESULTS: '/fixture-report.json' } },
    require: (name: string) => {
      if (name !== 'node:fs') throw new Error(`Unexpected guard module ${name}`);
      return { readFileSync: (file: string) => {
        if (file !== '/fixture-report.json') throw new Error('Unexpected fixture report path');
        return raw ?? JSON.stringify(report);
      } };
    } });
}

function sourceOutput(overrides: Record<string, string> = {}) {
  let output = '';
  const env = { INPUT_SOURCE_SHA: '', INPUT_SOURCE_REPOSITORY: '', EVENT_NAME: 'pull_request', EVENT_SHA: eventSha,
    PR_HEAD_SHA: sha, PR_HEAD_REPOSITORY: repo, SOURCE_REPOSITORY: repo,
    CONTROLLER_WORKFLOW_REF: direct, CONTROLLER_WORKFLOW_SHA: eventSha, GITHUB_OUTPUT: '/output', ...overrides };
  runInNewContext(step('source')!.run, { process: { env }, require: (name: string) => {
    if (name !== 'node:fs') throw new Error(`Unexpected module ${name}`);
    return { appendFileSync: (_: string, value: string) => { output += value; } };
  } });
  return Object.fromEntries(output.trim().split('\n').map(line => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
}

describe('Windows provider receipt workflow', () => {
  it('uses a read-only token, exact checkout and an explicit PR path filter', () => {
    expect(job['runs-on']).toBe('windows-2025');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.on.pull_request.paths).toContain('App/native-computer-use/**');
    expect(workflow.on.pull_request.paths).toContain('tests/windows-provider-receipt-workflow.test.ts');

    expect(workflow.on.pull_request.paths).toContain('App/shell/desktop/src/main/windows-launch-at-login.ts');
    expect(workflow.on.pull_request.paths).toContain('App/shell/desktop/tests/windows-launch-at-login*.test.ts');


    expect(workflow.on.pull_request.paths).toEqual(expect.arrayContaining([
      'App/memmy-agent/src/core/session/webui-title.ts',
      'App/memmy-agent/src/integrations/channels/websocket.ts',
      'App/memmy-agent/src/entrypoints/cli/commands.ts',
      'App/memmy-agent/tests/core/session/webui-title.test.ts',
      'App/memmy-agent/tests/integrations/channels/websocket-envelope-media.test.ts',
      'App/memmy-agent/tests/integrations/channels/websocket-media-route.test.ts',
    ]));

    expect(steps.find(entry => entry.uses === 'actions/checkout@v4')?.with).toMatchObject({
      repository: '${{ steps.source.outputs.repository }}', ref: '${{ steps.source.outputs.sha }}',
      'persist-credentials': false,
    });
  });
  it('binds a same-repository PR to its actual head and a manual run to its selected SHA', () => {
    expect(sourceOutput()).toMatchObject({ sha, repository: repo, mode: 'pull_request', receipt_allowed: 'true' });
    expect(sourceOutput({ EVENT_NAME: 'workflow_dispatch' })).toMatchObject({
      sha: eventSha, repository: repo, mode: 'workflow_dispatch', receipt_allowed: 'true',
    });
  });
  it('denies a direct fork receipt but allows a trusted reusable fork', () => {
    expect(sourceOutput({ PR_HEAD_REPOSITORY: 'Fixture/memmy-agent' })).toMatchObject({
      sha, repository: 'Fixture/memmy-agent', mode: 'pull_request', receipt_allowed: 'false',
    });
    expect(sourceOutput({ INPUT_SOURCE_SHA: sha, INPUT_SOURCE_REPOSITORY: 'Fixture/memmy-agent',
      CONTROLLER_WORKFLOW_REF: `${repo}/.github/workflows/main-sync-validation.yml@refs/heads/main` }))
      .toMatchObject({ sha, repository: 'Fixture/memmy-agent', mode: 'workflow_call', receipt_allowed: 'true' });
    expect(() => sourceOutput({ INPUT_SOURCE_SHA: sha,
      CONTROLLER_WORKFLOW_REF: `${repo}/.github/workflows/main-sync-validation.yml@refs/heads/other` })).toThrow();
    expect(step('provider-receipt')?.if).toBe("${{ success() && steps.source.outputs.receipt_allowed == 'true' }}");
  });
  it('requires both native Go modules and vet before producing either receipt', () => {
    const history = step('native-go'), computerUse = step('computer-use-go');
    expect(history?.run).toContain('Push-Location App/native-computer-history/apps/OpenComputerHistoryWindows');
    expect(history?.run).toContain('go vet -unsafeptr=false ./...');
    expect(computerUse?.run).toContain('Push-Location App/native-computer-use/apps/OpenComputerUseWindows');
    expect(computerUse?.run).toContain('go vet ./...');
    for (const entry of [history, computerUse]) {
      expect(entry?.run).toContain('go test ./...');
      expect(entry?.run).toMatch(/if \(\$LASTEXITCODE -ne 0\).*throw/);
      expect(entry?.['continue-on-error']).not.toBe(true);
    }
    expect(steps.indexOf(step('provider-receipt')!)).toBeGreaterThan(steps.indexOf(history!));
    expect(steps.indexOf(step('provider-receipt')!)).toBeGreaterThan(steps.indexOf(computerUse!));
  });



  it('runs saved-recording title and media regressions with all existing Windows History contracts', () => {
    const contracts = step('history-contracts')!;
    const script = contracts.run as string;
    const testArray = script.match(/\$tests\s*=\s*@\(([\s\S]*?)\n\s*\)/);
    expect(testArray).not.toBeNull();
    const selected = [...(testArray?.[1] ?? '').matchAll(/^\s*'([^']+)'\s*$/gm)]
      .map(match => match[1]);
    expect(selected).toEqual(expect.arrayContaining([
      'App/memmy-agent/tests/tools/computer-history/win/application-icon.test.ts',
      'App/memmy-agent/tests/tools/computer-history/win/win11.test.ts',
      'App/memmy-agent/tests/tools/computer-history/platform.test.ts',
      'App/memmy-agent/tests/tools/computer-history/mac/summary-writer.test.ts',
      'App/memmy-agent/tests/tools/computer-history/browser-privacy.test.ts',
      'App/memmy-agent/tests/tools/computer-history/browser-semantic-history.test.ts',
      'App/memmy-agent/tests/tools/computer-history/browser-history-bridge.test.ts',
      'App/memmy-agent/tests/tools/computer-history/win/native-event-adapter.test.ts',
      'App/memmy-agent/tests/tools/computer-history/win/native-recording-privacy.test.ts',
      'App/memmy-agent/tests/tools/computer-history/win/browser-authority-publisher.test.ts',
      'App/memmy-agent/tests/core/session/webui-title.test.ts',
      'App/memmy-agent/tests/integrations/channels/websocket-envelope-media.test.ts',
      'App/memmy-agent/tests/integrations/channels/websocket-media-route.test.ts',
    ]));
    expect(new Set(selected).size).toBe(selected.length);
    const afterArray = script.slice((testArray?.index ?? 0) + (testArray?.[0].length ?? 0));
    expect(afterArray).not.toMatch(/^\s*\$tests\s*=/m);
    expect(afterArray).toMatch(/foreach \(\$test in \$tests\)/);
    expect(afterArray).toContain('Test-Path -LiteralPath $test -PathType Leaf');
    expect(afterArray).toMatch(/^\s*node node_modules\/vitest\/vitest\.mjs run @tests\s*\n\s*if \(\$LASTEXITCODE -ne 0\) \{ throw 'History platform contracts failed' \}/m);
    expect(contracts.if).toBeUndefined();
    expect(contracts['continue-on-error']).toBeUndefined();
    expect(steps.indexOf(contracts)).toBeLessThan(steps.indexOf(step('provider-receipt')!));
  });

  it('binds both receipt formats to all checks, exact source, clean index and provider identity', () => {
    const script = step('provider-receipt')?.run ?? '';
    for (const value of ['RECEIPT_ALLOWED', 'results[id]?.outcome', 'results[id]?.conclusion',
      "['rev-parse', 'HEAD']", "['diff', '--exit-code']", "['diff', '--cached', '--exit-code']",
      "os.platform() !== 'win32'", 'PROVIDER_RUN_ID', 'PROVIDER_RUN_ATTEMPT',
      'CONTROLLER_WORKFLOW_REF', 'CONTROLLER_WORKFLOW_SHA', 'runnerOS', 'runnerArch', 'windowsBuild',
      'workflowRef', 'workflowSha', 'nativeModules', 'liveCaptureValidated: false', 'signedInstallerValidated: false']) {
      expect(script).toContain(value);
    }
  });

  it('executes Windows Electron startup integration without accepting skipped tests before issuing a receipt', () => {
    const contracts = step('history-contracts');
    expect(contracts?.run).toContain('App/shell/desktop/tests/windows-launch-at-login.test.ts');
    expect(contracts?.run).toContain('App/shell/desktop/tests/windows-launch-at-login-electron.test.ts');
    expect(contracts?.run).toContain('$loginReport.numTotalTests -lt 1');
    expect(contracts?.run).toContain('$loginReport.numPendingTests -ne 0');
    expect(contracts?.run).toContain('$loginReport.numPassedTests -ne $loginReport.numTotalTests');
    expect(contracts?.['continue-on-error']).not.toBe(true);
    expect(step('provider-receipt')?.run).toContain("'history-contracts'");
  });
  it('builds shared contracts and executes both portable Memory fixture files in the required step', () => {
    const contracts = step('history-contracts');
    for (const file of memoryFixtureFiles) {
      expect(contracts?.run).toContain(file);
      expect(workflow.on.pull_request.paths).toContain(file);
    }
    expect(workflow.on.pull_request.paths).toContain('Memory/tests/fixtures/panel-cache-fixture.ts');
    const build = String(contracts?.run).indexOf('npm run build -w @memmy/agent-source-core');
    const execute = String(contracts?.run).indexOf('run @memoryPanelFiles --reporter=default --reporter=json');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(execute).toBeGreaterThan(build);
    expect(contracts?.run).toContain("if ($LASTEXITCODE -ne 0) { throw 'Windows Memory fixture regression failed' }");
    expect(contracts?.run).toContain("if ($LASTEXITCODE -ne 0) { throw 'Windows Memory fixture report validation failed' }");
    expect(contracts?.if).toBeUndefined();
    expect(contracts?.['continue-on-error']).not.toBe(true);
    expect(() => validateMemoryFixtureReport(memoryFixtureReport())).not.toThrow();
    const relative = memoryFixtureReport();
    relative.testResults.forEach((file, index) => { file.name = memoryFixtureFiles[index]!; });
    expect(() => validateMemoryFixtureReport(relative)).not.toThrow();
  });
  it.each(['no-files', 'missing-file', 'duplicate-file', 'wrong-file', 'failed-file', 'empty-file',
    'skipped-assertion', 'pending', 'failed-total', 'empty-total', 'mismatched-total'])(
    'rejects incomplete or inconsistent Memory fixture reports: %s', kind => {
      const report = memoryFixtureReport();
      if (kind === 'no-files') report.testResults = [];
      if (kind === 'missing-file') report.testResults.pop();
      if (kind === 'duplicate-file') report.testResults[1]!.name = report.testResults[0]!.name;
      if (kind === 'wrong-file') report.testResults[1]!.name = '/checkout/another.test.ts';
      if (kind === 'failed-file') report.testResults[1]!.status = 'failed';
      if (kind === 'empty-file') {
        report.testResults[1]!.assertionResults = [];
        report.testResults[0]!.assertionResults = Array.from({ length: 10 }, () => ({ status: 'passed' }));
      }
      if (kind === 'skipped-assertion') report.testResults[1]!.assertionResults[0]!.status = 'pending';
      if (kind === 'pending') report.numPendingTests = 1;
      if (kind === 'failed-total') report.numPassedTests = 9;
      if (kind === 'empty-total') report.numTotalTests = report.numPassedTests = 0;
      if (kind === 'mismatched-total') report.testResults[0]!.assertionResults.pop();
      expect(() => validateMemoryFixtureReport(report)).toThrow();
    });
  it('rejects malformed Memory fixture JSON without echoing the report body', () => {
    expect(() => validateMemoryFixtureReport(undefined, 'invalid-fixture-body')).toThrow('Cannot read valid Windows Memory fixture report');
  });
  it('uploads immutable canonical and explicitly named legacy artifacts only after the producer succeeds', () => {
    const uploads = steps.filter(entry => entry.uses === 'actions/upload-artifact@v4');
    expect(uploads).toHaveLength(2);
    for (const entry of uploads) {
      expect(entry.if).toContain("steps.provider-receipt.outcome == 'success'");
      expect(entry.with['if-no-files-found']).toBe('error');
      expect(entry.with.overwrite).not.toBe(true);
    }
    expect(uploads[0]!.with.name).toBe('${{ steps.provider-receipt.outputs.artifact_name }}');
    expect(uploads[1]!.with.name).toBe('${{ steps.provider-receipt.outputs.legacy_artifact_name }}');
    expect(uploads[1]!.with.path).toContain('windows-provider-receipt.json');
  });
});
