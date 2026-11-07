import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

async function diagnosticExcerpt(file) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { size } = await handle.stat();
    const { bytesRead } = await handle.read(buffer, 0, size > buffer.length ? 4096 : buffer.length, 0);
    const prefix = buffer.toString("utf8", 0, bytesRead);
    if (size <= buffer.length) return prefix;
    const tail = await handle.read(buffer, 0, 4096, size - 4096);
    return `${prefix}\n[earlier diagnostics omitted]\n${buffer.toString("utf8", 0, tail.bytesRead)}`;
  } finally { await handle.close(); }
}

// File-backed stdio also works in Windows AppContainer with Electron's libuv,
// whose child-process pipes use an unsupported global named-pipe namespace.
export async function runProcess(command, args, { cwd, env, input = "", timeout = 120000, maxOutput = 8 * 1024 * 1024, children }) {
  const directory = await fs.mkdtemp(path.join(cwd, ".office-process-"));
  const handles = [];
  let child, timer, monitor, failure;
  const files = ["input", "output", "errors"].map(name => path.join(directory, name));
  const trace = message => { if (process.env.MEMMY_OFFICE_TRACE === "1") console.error(`Office process ${path.basename(command)}: ${message}`); };
  try {
    await fs.writeFile(files[0], input, { flag: "wx" });
    for (const [index, file] of files.entries()) handles.push(await fs.open(file, index === 0 ? "r" : "wx"));
    trace("starting");
    child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: handles.map(handle => handle.fd) });
    child.once("spawn", () => trace("running"));
    children?.add(child);
    const stop = message => { failure ??= new Error(message); child.kill("SIGKILL"); };
    const exit = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    timer = setTimeout(() => stop("Office process timed out"), timeout);
    monitor = setInterval(() => {
      void Promise.all(handles.slice(1).map(handle => handle.stat())).then(stats => {
        if (stats.some(info => info.size > maxOutput)) stop("Tool output exceeded limit");
      }).catch(() => {}); // Handles can close after the process exits.
    }, 100);
    const result = await exit;
    trace(`exited ${result.code ?? result.signal}`);
    if (failure) {
      const diagnostic = await diagnosticExcerpt(files[2]);
      failure.message = `${path.basename(command)}: ${failure.message}${diagnostic ? `: ${diagnostic}` : ""}`;
      throw failure;
    }
    const sizes = await Promise.all(handles.slice(1).map(handle => handle.stat()));
    if (sizes.some(info => info.size > maxOutput)) throw new Error("Tool output exceeded limit");
    return { ...result, stdout: await fs.readFile(files[1], "utf8"), stderr: await diagnosticExcerpt(files[2]) };
  } finally {
    clearTimeout(timer); clearInterval(monitor);
    if (child) children?.delete(child);
    await Promise.all(handles.map(handle => handle.close()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
