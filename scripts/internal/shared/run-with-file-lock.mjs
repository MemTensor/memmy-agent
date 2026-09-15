import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import lockfile from "proper-lockfile";

const [lockPathArgument, command, ...commandArguments] = process.argv.slice(2);

if (!lockPathArgument || !command) {
  console.error(
    "Usage: run-with-file-lock.mjs <lock-path> <command> [arguments...]",
  );
  process.exit(2);
}

const lockPath = resolve(lockPathArgument);
mkdirSync(dirname(lockPath), { recursive: true });

let release;
try {
  release = await lockfile.lock(lockPath, {
    realpath: false,
    retries: 0,
    stale: 120_000,
    update: 30_000,
  });
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(
    `Another Memmy Windows package build is using the shared dist/runtime, dist/native, or release/win-unpacked directories. Wait for it to finish before packaging. ${detail}`,
  );
  process.exit(3);
}

const ownerToken = randomBytes(32).toString("base64url");
const ownerPid = String(process.pid);
const ownerFilePath = `${lockPath}.owner-${ownerPid}-${ownerToken}`;
let ownerFileCreated = false;

try {
  const staleOwnerPrefix = `${basename(lockPath)}.owner-`;
  for (const entry of readdirSync(dirname(lockPath))) {
    if (entry.startsWith(staleOwnerPrefix)) {
      rmSync(resolve(dirname(lockPath), entry), { force: true });
    }
  }
  writeFileSync(ownerFilePath, `${ownerPid}\n${ownerToken}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  ownerFileCreated = true;
  const child = spawn(command, commandArguments, {
    env: {
      ...process.env,
      MEMMY_WINDOWS_BUILD_LOCK_HELD: "1",
      MEMMY_WINDOWS_BUILD_LOCK_TOKEN: ownerToken,
      MEMMY_WINDOWS_BUILD_LOCK_OWNER_PID: ownerPid,
      MEMMY_WINDOWS_BUILD_LOCK_OWNER_FILE: ownerFilePath.replaceAll("\\", "/"),
    },
    stdio: "inherit",
  });
  const forwardedSignals = ["SIGINT", "SIGTERM"];
  const signalHandlers = new Map(
    forwardedSignals.map((signal) => [signal, () => child.kill(signal)]),
  );
  for (const [signal, handler] of signalHandlers) {
    process.on(signal, handler);
  }
  const result = await new Promise((resolveResult, rejectResult) => {
    child.once("error", rejectResult);
    child.once("exit", (status, signal) => resolveResult({ status, signal }));
  }).finally(() => {
    for (const [signal, handler] of signalHandlers) {
      process.off(signal, handler);
    }
  });
  if (result.signal) {
    console.error(`Locked Windows build process ended from ${result.signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
} finally {
  if (ownerFileCreated) {
    rmSync(ownerFilePath, { force: true });
  }
  await release();
}
