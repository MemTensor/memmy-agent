// Regression: recover dead owners, serialize contenders, and preserve successor ownership.
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, open, readdir, rm, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { withCodexInstallationLock } = await import(pathToFileURL(join(process.cwd(), "Memory/AgentSourceCore/src/codex-installation.ts")));
if (process.argv[2] === "owner") {
  await withCodexInstallationLock(process.argv[3], async () => {
    process.send("owned");
    await new Promise(() => { setInterval(() => {}, 1000); });
  });
} else if (process.argv[2] === "contender") {
  const root = process.argv[3];
  for (let i = 0; i < 4; i++) {
    await withCodexInstallationLock(root, async () => {
      const marker = join(root, "exclusive-marker");
      const handle = await open(marker, "wx");
      try { await delay(5); await appendFile(join(root, "operations"), `${process.pid}:${i}\n`); }
      finally { await handle.close(); await unlink(marker); }
    });
  }
} else {
  const root = await mkdtemp(join(tmpdir(), "pr769-crash-lock-"));
  let child;
  try {
    child = spawn(process.execPath, [...process.execArgv, import.meta.filename, "owner", root], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    await once(child, "message");
    const closed = once(child, "exit");
    child.kill("SIGKILL"); await closed;
    const lockPath = join(root, ".memmy-install.lock");
    console.log(JSON.stringify({ ownerPid: child.pid, ownerExited: true, lock: await readFile(lockPath, "utf8").catch(() => null) }));
    let ran = false, error;
    const started = Date.now();
    try { await withCodexInstallationLock(root, async () => { ran = true; }); } catch (e) { error = e.message; }
    console.log(JSON.stringify({ ran, elapsedMs: Date.now() - started, error, lockRemains: await stat(lockPath).then(() => true, () => false) }));
    assert.equal(ran, true, "a confirmed dead lock owner must not permanently block installation after restart");
    // Race several recoverers against a second abandoned lock, not merely an empty lock.
    child = spawn(process.execPath, [...process.execArgv, import.meta.filename, "owner", root], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    await once(child, "message");
    const exited = once(child, "exit");
    child.kill("SIGKILL"); await exited;
    const contenders = Array.from({ length: 6 }, () => spawn(process.execPath,
      [...process.execArgv, import.meta.filename, "contender", root], { stdio: ["ignore", "inherit", "inherit"] }));
    const results = await Promise.all(contenders.map(child => once(child, "exit")));
    assert.ok(results.every(([code]) => code === 0), "contenders must never overlap or lose an operation");
    assert.equal((await readFile(join(root, "operations"), "utf8")).trim().split("\n").length, 24);
    assert.ok(!(await readdir(root)).some(name => name.startsWith(".memmy-install")), "all ownership records must be released");
    // Simulate replacement by a new owner; releasing our operation must preserve its token.
    await withCodexInstallationLock(root, async () => {
      await unlink(lockPath);
      await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: "successor" }));
    });
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, "successor");
  } finally {
    child?.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}
