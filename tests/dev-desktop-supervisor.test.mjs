import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it as test, onTestFinished } from 'vitest';
import { superviseDesktop } from '../scripts/internal/shared/dev-desktop-supervisor.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'memmy-desktop-supervisor-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const restartRequestPath = join(root, 'restart-request.json');
  return {
    root, restartRequestPath,
    request(pid) {
      writeFileSync(restartRequestPath, JSON.stringify({ pid, requestedAt: Date.now() }), { mode: 0o600 });
    },
  };
}

function child(pid, terminal) {
  const process = new EventEmitter();
  process.pid = pid;
  queueMicrotask(() => terminal(process));
  return process;
}

test('ordinary desktop quit returns its exit code without restarting', async () => {
  const state = fixture();
  let launches = 0;
  const code = await superviseDesktop({ ...state,
    launch: () => { launches++; return child(101, process => process.emit('close', 3, null)); },
    onRestart: () => assert.fail('ordinary quit requested a restart'),
  });
  assert.equal(code, 3);
  assert.equal(launches, 1);
});

test('matching restart requests relaunch and update the child callback', async () => {
  const state = fixture();
  const events = [];
  let launches = 0;
  const code = await superviseDesktop({ ...state,
    launch: () => child(201 + launches++, process => {
      if (process.pid === 201) state.request(process.pid);
      process.emit('close', 0, null);
    }),
    onLaunched: process => events.push(`launch:${process.pid}`),
    beforeRestart: ({ child: process }) => {
      assert.equal(existsSync(state.restartRequestPath), false);
      events.push(`ready:${process.pid}`);
    },
    onRestart: ({ child: process, request }) => {
      assert.equal(request.pid, process.pid);
      events.push(`restart:${process.pid}`);
    },
  });
  assert.equal(code, 0);
  assert.equal(launches, 2);
  assert.deepEqual(events, ['launch:201', 'ready:201', 'restart:201', 'launch:202']);
});

test('a marker belonging to an older PID is ignored and retained', async () => {
  const state = fixture();
  state.request(300);
  let launches = 0;
  assert.equal(await superviseDesktop({ ...state,
    launch: () => { launches++; return child(301, process => process.emit('close', 0, null)); },
  }), 0);
  assert.equal(launches, 1);
  assert.equal(JSON.parse(readFileSync(state.restartRequestPath, 'utf8')).pid, 300);
});

test('stopping prevents a requested restart and does not consume the marker', async () => {
  const state = fixture();
  let stopping = false;
  let launches = 0;
  assert.equal(await superviseDesktop({ ...state,
    launch: () => { launches++; return child(401, process => {
      state.request(process.pid);
      stopping = true;
      process.emit('close', 0, null);
    }); },
    isStopping: () => stopping,
    beforeRestart: () => assert.fail('restart should be cancelled'),
  }), 0);
  assert.equal(launches, 1);
  assert.equal(existsSync(state.restartRequestPath), true);
});

test('launch errors return failure instead of looping on a matching marker', async () => {
  const state = fixture();
  let launches = 0;
  assert.equal(await superviseDesktop({ ...state,
    launch: () => { launches++; return child(501, process => {
      state.request(process.pid);
      process.emit('error', new Error('launch failed'));
      process.emit('close', -1, null);
    }); },
  }), 1);
  assert.equal(launches, 1);
  assert.equal(existsSync(state.restartRequestPath), true);
});

test('beforeRestart failure propagates without launching a replacement', async () => {
  const state = fixture();
  let launches = 0;
  await assert.rejects(superviseDesktop({ ...state,
    launch: () => { launches++; return child(601, process => {
      state.request(process.pid);
      process.emit('close', 0, null);
    }); },
    beforeRestart: async () => { throw new Error('runtime ports still occupied'); },
    onRestart: () => assert.fail('failed readiness must not announce restart'),
  }), /runtime ports still occupied/);
  assert.equal(launches, 1);
});

test('stopping during asynchronous readiness prevents the replacement', async () => {
  const state = fixture();
  let stopping = false;
  let launches = 0;
  assert.equal(await superviseDesktop({ ...state,
    launch: () => { launches++; return child(651, process => {
      state.request(process.pid);
      process.emit('close', 0, null);
    }); },
    isStopping: () => stopping,
    beforeRestart: async () => { await Promise.resolve(); stopping = true; },
    onRestart: () => assert.fail('a cancelled restart must not be announced'),
  }), 0);
  assert.equal(launches, 1);
});

test('signal termination returns a nonzero status', async () => {
  const state = fixture();
  assert.equal(await superviseDesktop({ ...state,
    launch: () => child(701, process => process.emit('close', null, 'SIGTERM')),
  }), 143);
});

test('restart marker symlinks are rejected without changing their target', async () => {
  const state = fixture();
  const target = join(state.root, 'other-private-file.json');
  const contents = JSON.stringify({ pid: 801, requestedAt: Date.now() });
  writeFileSync(target, contents, { mode: 0o600 });
  symlinkSync(target, state.restartRequestPath);
  await assert.rejects(superviseDesktop({ ...state,
    launch: () => child(801, process => process.emit('close', 0, null)),
  }), /symbolic link/);
  assert.equal(readFileSync(target, 'utf8'), contents);
  assert.equal(existsSync(state.restartRequestPath), true);
});
