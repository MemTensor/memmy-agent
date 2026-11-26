import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect } from "vitest";

/** Probe from another process so a blocked server cannot also delay the test client's deadline. */
export async function probeDuringLongWrite(databasePath: string, base: string) {
  // Observe a held write lock from outside the server before starting the HTTP deadline.
  const child = spawn(process.execPath, ["-e", `
    const db = require("better-sqlite3")(process.argv[1], { timeout: 0 });
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const locked = () => {
      try { db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK"); return false; }
      catch (error) { if (error.code !== "SQLITE_BUSY") throw error; return true; }
    };
    (async () => {
      const base = process.argv[2];
      await fetch(base + "/health");
      const deadline = Date.now() + 15000;
      let heldSince;
      for (;;) {
        if (Date.now() > deadline) throw Error("no sustained migration transaction");
        if (!locked()) {
          heldSince = undefined;
        } else {
          // Opening the worker connection may also take a brief write lock.
          // Only a sustained lock spans the intentionally slow migration.
          heldSince ??= Date.now();
          for (const path of ["/health", "/auth/check"]) {
            const r = await fetch(base + path, { headers: { authorization: "Bearer test" }, signal: AbortSignal.timeout(1000) });
            if (r.status !== 200) throw Error(path + " " + r.status);
          }
          if (Date.now() - heldSince > 1050 && locked()) break;
        }
        await wait(20);
      }
      db.close();
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `, databasePath, base]);
  let errors = "";
  child.stderr.on("data", data => { errors += data; });
  try {
    expect((await once(child, "exit"))[0], errors).toBe(0);
  } finally {
    child.kill();
  }
}
