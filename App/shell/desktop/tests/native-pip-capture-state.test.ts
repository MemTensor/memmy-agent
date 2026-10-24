import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(process.platform !== 'darwin')('native PiP capture lifecycle', () => {
  let temp: string, binary: string;
  beforeAll(() => {
    temp = mkdtempSync(join(tmpdir(), 'memmy-pip-capture-'));
    const source = join(temp, 'capture.cpp');
    binary = join(temp, 'capture');
    writeFileSync(source, `#include "pip-capture-state.h"
#include <cassert>
#include <cstdlib>
#include <thread>
#include <vector>
int main(int argc, char **argv) {
  using namespace memmy_pip;
  assert(argc == 2);
  CaptureState state;
  auto attempt = state.begin(100);
  switch (std::atoi(argv[1])) {
    case 0:
      state.idle(attempt);
      assert(state.timeout(attempt, 102.9) == CaptureTimeout::none);
      assert(state.timeout(attempt, 103) == CaptureTimeout::firstFrame);
      assert(!state.live); // a stream or Idle metadata is not a first image
      break;
    case 1:
      assert(state.decoded(attempt, 101));
      assert(state.pause(attempt, true, 102));
      assert(state.accepts(attempt) && state.suspended && !state.live);
      assert(state.timeout(attempt, 600) == CaptureTimeout::none);
      assert(!state.pause(attempt, true, 103)); // only one unavailable transition
      assert(state.decoded(attempt, 601)); // same stream resumes
      assert(state.live && !state.suspended && state.failures == 0);
      break;
    case 2:
      state.decoded(attempt, 101);
      state.invalidFrame(attempt, 102);
      state.idle(attempt);
      assert(state.timeout(attempt, 900) == CaptureTimeout::none);
      assert(state.live); // unchanged images must not spend retries
      break;
    case 3:
      state.decoded(attempt, 101);
      state.invalidFrame(attempt, 102);
      assert(state.timeout(attempt, 104.9) == CaptureTimeout::none);
      assert(state.timeout(attempt, 105) == CaptureTimeout::invalidFrames);
      state.decoded(attempt, 105);
      assert(state.timeout(attempt, 200) == CaptureTimeout::none);
      break;
    case 4: {
      const int expected[] = {250, 1000, 3000, 15000, 15000, 15000};
      for (int delay : expected) {
        assert(state.fail(attempt, 101) == delay);
        assert(!state.accepts(attempt));
        assert(state.fail(attempt, 102) == -1); // stop + error cannot double retry
        attempt = state.begin(103);
      }
      assert(state.failures == 3 && state.decoded(attempt, 104));
      assert(state.fail(attempt, 110) == 250); // healthy stream resets backoff
      break;
    }
    case 5: {
      const auto old = attempt;
      state.invalidate(); // target/PID/host epoch changed or presentation closed
      assert(!state.decoded(old, 101));
      assert(state.fail(old, 101) == -1);
      attempt = state.begin(102);
      assert(attempt != old && !state.pause(old, true, 103));
      assert(state.decoded(attempt, 103));
      assert(state.fail(old, 104) == -1 && state.live);
      break;
    }
    case 6: {
      CaptureState other;
      const auto otherAttempt = other.begin(100);
      other.decoded(otherAttempt, 101);
      state.fail(attempt, 101);
      state.invalidate();
      assert(other.accepts(otherAttempt) && other.live);
      break;
    }
    case 7: {
      PendingFrame frames;
      std::atomic<int> acquired{0};
      std::vector<std::thread> producers;
      for (int i = 0; i < 16; ++i) producers.emplace_back([&] { if (frames.acquire()) ++acquired; });
      for (auto &producer : producers) producer.join();
      assert(acquired == 1 && !frames.acquire());
      frames.release(); // also released when a stale attempt discards its image
      assert(frames.acquire() && !frames.acquire());
      PendingFrame anotherStream;
      assert(anotherStream.acquire());
      break;
    }
    case 8:
      state.pause(attempt, true, 100.5);
      assert(state.timeout(attempt, 102.9) == CaptureTimeout::none);
      assert(state.timeout(attempt, 103) == CaptureTimeout::firstFrame);
      break;
    case 9:
      state.pause(attempt, false, 102.5);
      assert(state.timeout(attempt, 103) == CaptureTimeout::firstFrame);
      break;
    case 10:
      state.decoded(attempt, 101);
      state.pause(attempt, false, 102);
      assert(state.timeout(attempt, 102.9) == CaptureTimeout::none);
      state.decoded(attempt, 102.9);
      assert(state.timeout(attempt, 200) == CaptureTimeout::none);
      state.pause(attempt, false, 201);
      assert(state.timeout(attempt, 202) == CaptureTimeout::blankFrames);
      assert(state.fail(attempt, 202) == 250);
      break;
    case 11:
      state.decoded(attempt, 101);
      state.pause(attempt, true, 102);
      state.confirmVisibility(attempt, true, 103);
      assert(state.timeout(attempt, 105.9) == CaptureTimeout::none);
      state.decoded(attempt, 105.9);
      assert(state.timeout(attempt, 200) == CaptureTimeout::none);
      break;
    case 12:
      state.decoded(attempt, 101);
      state.pause(attempt, true, 102);
      state.confirmVisibility(attempt, true, 103);
      assert(state.timeout(attempt, 106) == CaptureTimeout::visibleSuspension);
      assert(state.fail(attempt, 106) == 250);
      break;
    case 13:
      state.decoded(attempt, 101);
      state.pause(attempt, true, 102);
      state.confirmVisibility(attempt, true, 103);
      state.confirmVisibility(attempt, false, 105);
      assert(state.timeout(attempt, 600) == CaptureTimeout::none);
      state.confirmVisibility(attempt, true, 601);
      assert(state.timeout(attempt, 604) == CaptureTimeout::visibleSuspension);
      break;
    default: assert(false);
  }
}`);
    execFileSync('xcrun', ['clang++', '-std=c++17', '-I', fileURLToPath(new URL('../native-pip/', import.meta.url)), source, '-o', binary]);
  });
  afterAll(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });
  it.each([
    [0, 'requires a decoded first frame'],
    [1, 'keeps a suspended stream and resumes without tearing it down'],
    [2, 'keeps unchanged frames live'],
    [3, 'recovers persistent invalid frame delivery'],
    [4, 'continues cooled retries for the same window after the fast budget'],
    [5, 'rejects old attempt completions, frames and stop callbacks'],
    [6, 'isolates multiple presentation lifecycles'],
    [7, 'bounds pending frames per stream and releases discarded frames'],
    [8, 'times out suspended capture before the first decoded frame'],
    [9, 'times out blank capture before the first decoded frame'],
    [10, 'allows brief blank output and reconnects persistent blank output'],
    [11, 'allows suspended visible capture to resume during its grace period'],
    [12, 'reconnects persistent suspension only after verified visible input'],
    [13, 'keeps minimized suspension without confusing static frame inactivity'],
  ])('%s: %s', (scenario) => {
    expect(() => execFileSync(binary, [String(scenario)])).not.toThrow();
  });
});
