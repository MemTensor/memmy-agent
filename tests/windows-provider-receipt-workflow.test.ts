import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/windows-computer-history-validation.yml', import.meta.url), 'utf8'));
const job = workflow.jobs.validate;
const steps = job.steps as Array<Record<string, any>>;
const expectedSource = '${{ github.event.pull_request.head.sha || github.sha }}';
const step = (id: string) => steps.find((entry) => entry.id === id);

describe('Windows provider receipt workflow', () => {
  it('keeps Windows validation on a read-only repository token', () => {
    expect(job['runs-on']).toBe('windows-2025');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(steps.find((entry) => entry.uses === 'actions/checkout@v4')?.with['persist-credentials']).toBe(false);
  });

  it('checks out the exact source commit for both PR and manual validation', () => {
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(job.env?.EXPECTED_SOURCE_SHA).toBe(expectedSource);
    expect(steps.find((entry) => entry.uses === 'actions/checkout@v4')?.with.ref).toBe(expectedSource);
    expect(workflow.on.pull_request.paths).toContain('App/native-computer-use/**');
  });

  it('requires both Windows Go modules before producing a receipt', () => {
    const history = step('native_history_tests');
    const computerUse = step('native_computer_use_tests');
    expect(history?.run).toContain('Push-Location App/native-computer-history/apps/OpenComputerHistoryWindows');
    expect(computerUse?.run).toContain('Push-Location App/native-computer-use/apps/OpenComputerUseWindows');
    for (const entry of [history, computerUse]) {
      expect(entry?.run).toContain('go test ./...');
      expect(entry?.run).toMatch(/if \(\$LASTEXITCODE -ne 0\).*throw/);
      expect(entry?.['continue-on-error']).not.toBe(true);
    }
  });

  it('emits only after all validation steps succeed and rejects fork receipts', () => {
    const receipt = step('windows_provider_receipt');
    expect(receipt).toBeDefined();
    expect(receipt?.if).toContain('success()');
    expect(receipt?.if).toContain('steps.native_history_tests.outcome');
    expect(receipt?.if).toContain('steps.native_computer_use_tests.outcome');
    expect(receipt?.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(receipt?.if).not.toContain('always()');
    const index = steps.indexOf(receipt!);
    expect(index).toBeGreaterThan(steps.indexOf(step('native_history_tests')!));
    expect(index).toBeGreaterThan(steps.indexOf(step('native_computer_use_tests')!));
    expect(steps.slice(index + 1).every((entry) => !entry.run || entry.name === 'Record validation scope')).toBe(true);
  });

  it('binds receipt contents to the executed Windows checkout and run identity', () => {
    const script = step('windows_provider_receipt')?.run ?? '';
    expect(script).toContain("$env:RUNNER_OS -ne 'Windows'");
    expect(script).toContain('git rev-parse HEAD');
    expect(script).toContain('$head -ne $env:EXPECTED_SOURCE_SHA');
    expect(script).toContain('git diff --quiet');
    expect(script).toContain('git diff --cached --quiet');
    expect(script).toMatch(/provider\s*=\s*'windows'/);
    expect(script).toMatch(/status\s*=\s*'passed'/);
    expect(script).toMatch(/headSha\s*=\s*\$head/);
    for (const key of ['repository', 'workflowRef', 'workflowSha', 'runId', 'runAttempt', 'runnerOS', 'runnerArch']) {
      expect(script).toMatch(new RegExp(key + '\\s*='));
    }
    expect(script).toMatch(/liveCaptureValidated\s*=\s*\$false/);
    expect(script).toMatch(/signedInstallerValidated\s*=\s*\$false/);
  });

  it('uploads an immutable receipt scoped to the source SHA and attempt', () => {
    const upload = steps.find((entry) => entry.name === 'Upload exact-source Windows provider receipt');
    expect(upload?.uses).toBe('actions/upload-artifact@v4');
    expect(upload?.if).toContain('success()');
    expect(upload?.if).toContain('steps.windows_provider_receipt.outcome');
    expect(upload?.with.name).toContain('env.EXPECTED_SOURCE_SHA');
    expect(upload?.with.name).toContain('github.run_attempt');
    expect(upload?.with.path).toBe('windows-provider-receipt.json');
    expect(upload?.with['if-no-files-found']).toBe('error');
    expect(upload?.with.overwrite).not.toBe(true);
  });
});
