import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'darwin')('stops only a detached stream with sequential bounded retries and ignores duplicate completions', () => {
  const temp = mkdtempSync(join(tmpdir(), 'memmy-pip-capture-stop-'));
  try {
    const source = join(temp, 'stop.cpp'), binary = join(temp, 'stop');
    writeFileSync(source, `#include "pip-capture-stop.h"
#include <cassert>
#include <functional>
#include <vector>
using namespace memmy_pip;
struct Stream { unsigned calls = 0; std::vector<std::function<void(bool)>> completions; };
struct Job {
  Stream *const retired;
  CaptureStopState policy;
  unsigned scheduledRetries = 0;
  void stop() {
    auto attempt = policy.begin();
    if (!attempt) return;
    ++retired->calls;
    retired->completions.push_back([this, attempt](bool failed) {
      if (policy.complete(attempt, failed) == CaptureStopResult::retry) ++scheduledRetries;
    });
  }
};
int main() {
  Stream oldStream, newStream;
  Stream *activeStream = &oldStream;
  Job job{activeStream};
  activeStream = &newStream; // rebind/close cannot redirect a retired job
  job.stop();
  job.stop();
  assert(oldStream.calls == 1 && newStream.calls == 0 && job.policy.pending);
  assert(job.scheduledRetries == 0); // pending, however long, authorizes no retry
  oldStream.completions[0](true);
  assert(job.scheduledRetries == 1 && job.policy.retryDelayMs() == 250);
  oldStream.completions[0](true); // duplicate completion before retry
  assert(job.scheduledRetries == 1);
  job.stop();
  assert(oldStream.calls == 2 && job.policy.pending);
  oldStream.completions[0](false); // stale success cannot stop the new attempt
  oldStream.completions[0](true); // stale failure cannot schedule another retry
  assert(job.policy.pending && !job.policy.terminal && job.scheduledRetries == 1);
  oldStream.completions[1](true);
  assert(job.scheduledRetries == 2 && job.policy.retryDelayMs() == 500);
  job.stop();
  oldStream.completions[2](true);
  assert(job.policy.terminal && !job.policy.pending && job.scheduledRetries == 2);
  job.stop();
  oldStream.completions[2](true);
  assert(oldStream.calls == 3 && newStream.calls == 0 && job.scheduledRetries == 2);
  Stream successStream;
  Job success{&successStream};
  success.stop();
  successStream.completions[0](false);
  success.stop();
  successStream.completions[0](true);
  assert(success.policy.terminal && !success.policy.pending);
  assert(successStream.calls == 1 && success.scheduledRetries == 0);
  CaptureStopState independent;
  assert(independent.complete(1, true) == CaptureStopResult::ignored);
  assert(independent.begin() == 1); // another stream's policy remains independent
}`);
    execFileSync('xcrun', ['clang++', '-std=c++17', '-I', fileURLToPath(new URL('../native-pip/', import.meta.url)), source, '-o', binary]);
    expect(() => execFileSync(binary)).not.toThrow();
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
