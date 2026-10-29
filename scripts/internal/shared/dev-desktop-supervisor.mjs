import fs from 'node:fs';
import path from 'node:path';
import { constants as osConstants } from 'node:os';

function observeExit(child) {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const close = (code, signal) => resolve({ code, signal });
  const error = () => resolve({ error: true });
  child.once('close', close);
  child.once('error', error);
  return {
    promise,
    dispose() { child.removeListener('close', close); child.removeListener('error', error); },
  };
}

function exitCode(result) {
  if (result.error) return 1;
  if (result.signal) return 128 + (osConstants.signals[result.signal] || 1);
  return result.code || 0;
}

/** Read only the caller's private marker, never follow a link or remove another path. */
function consumeRestartRequest(file, pid) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Restart request must be a regular file, not a symbolic link');
  if ((typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077))
    throw new Error('Restart request must be private to the current user');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let request;
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('Restart request changed while being read');
    if (opened.size > 4096) return null;
    try { request = JSON.parse(fs.readFileSync(descriptor, 'utf8')); } catch { return null; }
  } finally { fs.closeSync(descriptor); }
  if (!Number.isSafeInteger(pid) || pid <= 0 || request?.pid !== pid) return null;
  const current = fs.lstatSync(file, { throwIfNoEntry: false });
  if (current?.isSymbolicLink()) throw new Error('Restart request cannot be a symbolic link');
  if (!current || current.dev !== stat.dev || current.ino !== stat.ino) return null;
  fs.unlinkSync(file);
  return request;
}

/** Supervise Electron restarts while its caller continues to own the renderer. */
export async function superviseDesktop({ launch, restartRequestPath, onLaunched = () => {},
  beforeRestart = async () => {}, isStopping = () => false, onRestart = () => {} }) {
  if (typeof restartRequestPath !== 'string' || !path.isAbsolute(restartRequestPath))
    throw new Error('Restart request path must name an absolute private file');
  const parent = fs.lstatSync(path.dirname(restartRequestPath));
  if (parent.isSymbolicLink() || !parent.isDirectory() || (parent.mode & 0o077)
    || (typeof process.getuid === 'function' && parent.uid !== process.getuid()))
    throw new Error('Restart request directory must be private to the current user, not a symbolic link');
  let code = 0;
  for (;;) {
    if (isStopping()) return code;
    const child = launch();
    const observer = observeExit(child);
    let result;
    try {
      await onLaunched(child);
      result = await observer.promise;
    } finally { observer.dispose(); }
    code = exitCode(result);
    if (result.error || isStopping()) return code;
    const request = consumeRestartRequest(restartRequestPath, child.pid);
    if (!request) return code;
    await beforeRestart({ child, request });
    if (isStopping()) return code;
    await onRestart({ child, request });
  }
}
