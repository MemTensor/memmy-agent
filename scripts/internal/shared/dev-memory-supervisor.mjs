#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";

const RESTART_DELAY_MS = 500;
const FORCE_STOP_DELAY_MS = 2_000;
let stopping = false;
let child = null;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    stopChild(false);
    const forceTimer = setTimeout(() => stopChild(true), FORCE_STOP_DELAY_MS);
    forceTimer.unref();
  });
}

while (!stopping) {
  child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "memory:dev"], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: process.env,
    stdio: "inherit"
  });

  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child = null;

  if (stopping) break;
  const reason = "error" in result
    ? result.error.message
    : result.signal ? `signal ${result.signal}` : `code ${result.code ?? "unknown"}`;
  process.stderr.write(`[memmy] Memory dev process stopped (${reason}); restarting\n`);
  await delay(RESTART_DELAY_MS);
}

function stopChild(force) {
  const pid = child?.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", [...(force ? ["/F"] : []), "/T", "/PID", String(pid)], { stdio: "ignore" });
    } else {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    // The process tree may already have exited.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
