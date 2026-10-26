import { execFileSync } from 'node:child_process';
import { constants, accessSync, realpathSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const AGENT_MARKER = '__memmy-computer-use-app-agent';
const SOCKET_NAME = /^memmy-computer-use-agent(?:-[a-f0-9]{16})?\.sock$/;
const BUNDLE_IDS = new Set(['cn.memtensor.memmy', 'cn.memtensor.memmy.computeruse', 'cn.memtensor.memmy.computeruse.dev']);
const PROCESS_QUERY_TIMEOUT_MS = 1_000;
const AGENT_STOP_TIMEOUT_MS = 1_000;

interface AgentProcess {
  pid: number;
  socketPath: string;
}

function resolveAgentBinary(packaged: boolean, resourcesPath: string, developmentBinary?: string): string | null {
  if (process.platform !== 'darwin') return null;
  const candidate = packaged
    ? join(resourcesPath, 'app.asar.unpacked/dist/runtime/memmy-agent/dist/native-computer-use/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse')
    : developmentBinary;
  if (!candidate || !isAbsolute(candidate) || basename(candidate) !== 'MemmyComputerUse') return null;
  try {
    accessSync(candidate, constants.X_OK);
    const binary = realpathSync(candidate);
    if (basename(binary) !== 'MemmyComputerUse' || basename(dirname(binary)) !== 'MacOS'
      || basename(dirname(dirname(binary))) !== 'Contents') return null;
    const app = dirname(dirname(dirname(binary)));
    return ['Memmy Computer Use.app', 'Memmy Computer Use (Dev).app'].includes(basename(app)) ? binary : null;
  } catch { return null; }
}

/** LaunchServices owns these processes, so killing the gateway's process tree cannot collect them. */
function listAgentProcesses(binary: string): AgentProcess[] {
  const output = execFileSync('/bin/ps', ['-ww', '-axo', 'pid=,command='], {
    encoding: 'utf8', timeout: PROCESS_QUERY_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
  });
  const marker = ` ${AGENT_MARKER} `;
  const temporaryDirectory = realpathSync(tmpdir());
  const agents: AgentProcess[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const command = match[2]!;
    const markerOffset = command.indexOf(marker);
    if (markerOffset <= 0) continue;
    const executable = command.slice(0, markerOffset);
    if (!isAbsolute(executable)) continue;
    const pid = Number(match[1]);
    const socketPath = command.slice(markerOffset + marker.length);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || !isAbsolute(socketPath)
      || !SOCKET_NAME.test(basename(socketPath)) || resolve(socketPath) !== socketPath) continue;
    try {
      // LaunchServices/ps may preserve an alias such as /tmp versus /private/tmp.
      if (realpathSync(executable) !== binary || realpathSync(dirname(socketPath)) !== temporaryDirectory) continue;
      agents.push({ pid, socketPath });
    } catch { /* A removed or foreign temporary directory is not owned by this app. */ }
  }
  return agents;
}

function stopVerifiedAgent(binary: string, agent: AgentProcess): Promise<void> {
  const bundle = dirname(dirname(dirname(binary)));
  return new Promise((resolveStop, rejectStop) => {
    let connected = false;
    let verified = false;
    let accepted = false;
    let finished = false;
    let buffered = '';
    const socket = net.createConnection(agent.socketPath);
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectStop(error); else resolveStop();
    };
    const timer = setTimeout(() => finish(new Error('Native Computer Use agent shutdown timed out')), AGENT_STOP_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      connected = true;
      socket.write(JSON.stringify({ kind: 'agentInfo' }) + '\n');
    });
    socket.on('data', chunk => {
      buffered += chunk;
      if (buffered.length > 8192) { finish(new Error('Unexpected native agent lifecycle response')); return; }
      let end: number;
      while (!finished && (end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        try {
          const reply = JSON.parse(line);
          if (!verified) {
            if (!BUNDLE_IDS.has(reply.bundleIdentifier)
              || realpathSync(reply.bundleURL) !== bundle || realpathSync(reply.executableURL) !== binary) {
              throw new Error('Native agent identity does not match this Memmy installation');
            }
            verified = true;
            socket.write(JSON.stringify({ kind: 'terminate' }) + '\n');
          } else if (reply.ok === true) accepted = true;
          else throw new Error('Native agent refused shutdown');
        } catch (error) { finish(error instanceof Error ? error : new Error('Invalid native agent identity')); }
      }
    });
    socket.on('error', error => {
      if (!connected && ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) finish();
      else finish(error);
    });
    socket.on('close', () => finish(accepted ? undefined : new Error('Native agent closed without confirming shutdown')));
  });
}

/** Whole-app shutdown collects base, legacy and task agents belonging to this installation. */
export async function stopComputerUseAgentForPermissionRestart(
  packaged: boolean,
  resourcesPath: string,
  developmentBinary?: string,
): Promise<void> {
  const binary = resolveAgentBinary(packaged, resourcesPath, developmentBinary);
  if (!binary) return;
  const results = await Promise.allSettled(listAgentProcesses(binary).map(agent => stopVerifiedAgent(binary, agent)));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length > 0) {
    throw new AggregateError(failures.map(result => result.reason), 'Some native Computer Use agents did not complete shutdown');
  }
}

/** The quit deadline cannot await sockets. Recheck the actual executable before a final signal. */
export function stopComputerUseAgentsOnExitSync(
  packaged: boolean,
  resourcesPath: string,
  developmentBinary?: string,
): void {
  const binary = resolveAgentBinary(packaged, resourcesPath, developmentBinary);
  if (!binary) return;
  try {
    const agents = listAgentProcesses(binary);
    if (agents.length === 0) return;
    // One bounded query keeps the quit deadline independent of the number of tasks.
    // argv alone can be stale or misleading; verify each PID's actual mapped executable.
    let files: string;
    try {
      files = execFileSync('/usr/sbin/lsof', ['-a', '-p', agents.map(agent => agent.pid).join(','), '-d', 'txt', '-Fn'], {
        encoding: 'utf8', timeout: PROCESS_QUERY_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      // Some candidates may exit during the query. lsof still returns valid records for the survivors.
      const partial = error as { status?: unknown; stdout?: unknown };
      if (partial.status !== 1 || typeof partial.stdout !== 'string') throw error;
      files = partial.stdout;
    }
    const candidates = new Set(agents.map(agent => agent.pid));
    const verified = new Set<number>();
    let pid = 0;
    for (const line of files.split('\n')) {
      if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
      if (!candidates.has(pid) || !line.startsWith('n')) continue;
      try {
        if (realpathSync(line.slice(1)) === binary) verified.add(pid);
      } catch { /* An executable that cannot be resolved is not verified. */ }
    }
    for (const target of verified) {
      try { process.kill(target, 'SIGKILL'); } catch { /* Already exited. */ }
    }
  } catch (error) {
    console.warn('Could not inspect native Computer Use agents during exit:', error instanceof Error ? error.message : String(error));
  }
}
