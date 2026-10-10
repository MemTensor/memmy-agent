import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** The pinned, unmodified 0.3.5 app agent already exposes agentInfo/terminate.
 * Never use a bundle-ID launch/kill: another installed copy can have that ID.
 */
export function nativeAgentSocketPath(namespace: string, directory = os.tmpdir()): string {
  const hash = createHash('sha256').update(namespace).digest('hex').slice(0, 16);
  return path.join(directory, `open-computer-use-agent-${hash}.sock`);
}

export async function stopOwnedNativeAgent(binary: string, namespace: string, directory = os.tmpdir()): Promise<void> {
  const executable = realpathSync(binary);
  const bundle = path.dirname(path.dirname(path.dirname(executable)));
  if (!executable.endsWith('/Open Computer Use.app/Contents/MacOS/OpenComputerUse') || namespace !== `memmy:${bundle}`) {
    throw new Error('Cannot stop an unowned Computer Use agent');
  }
  await new Promise<void>((resolve, reject) => {
    let connected = false, verified = false, accepted = false, finished = false;
    let buffered = '';
    const socket = net.createConnection(nativeAgentSocketPath(namespace, directory));
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Computer Use did not stop before authorization')), 3000);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      connected = true;
      socket.write(JSON.stringify({ kind: 'agentInfo' }) + '\n');
    });
    socket.on('data', chunk => {
      buffered += chunk;
      if (buffered.length > 8192) { finish(new Error('Unexpected Computer Use lifecycle response')); return; }
      let end: number;
      while (!finished && (end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        try {
          const reply = JSON.parse(line);
          if (!verified) {
            if (reply.bundleIdentifier !== 'com.ifuryst.opencomputeruse'
              || realpathSync(reply.bundleURL) !== bundle || realpathSync(reply.executableURL) !== executable) {
              throw new Error('Computer Use agent identity does not match this installation');
            }
            verified = true;
            socket.write(JSON.stringify({ kind: 'terminate' }) + '\n');
          } else if (reply.ok === true) accepted = true;
          else throw new Error('Computer Use refused to stop');
        } catch (error) { finish(error instanceof Error ? error : new Error('Invalid Computer Use agent identity')); }
      }
    });
    socket.on('error', error => {
      if (!connected && ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) finish();
      else finish(error);
    });
    // Acknowledgement alone is insufficient: wait until the native process has
    // closed its connection, before giving the user a route to change permissions.
    socket.on('close', () => finish(accepted ? undefined : new Error('Computer Use exited without a verified shutdown')));
  });
}
