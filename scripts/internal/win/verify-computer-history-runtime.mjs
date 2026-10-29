#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const windowsHistoryRuntimeIdentity = "MemmyWindowsHistoryRuntimeV1";

/** Static only: no desktop inspection, keys, or Windows executable is started. */
export function verifyWindowsComputerHistoryRuntime(binary, arch = "x64", workerSource) {
  const machines = { x64: 0x8664, arm64: 0xaa64 };
  if (!Object.hasOwn(machines, arch)) throw new Error(`Unsupported Windows History architecture: ${arch}`);
  if (!Buffer.isBuffer(binary) || binary.length < 64 || binary.toString("ascii", 0, 2) !== "MZ") {
    throw new Error("Windows History recorder is not a PE executable");
  }
  const pe = binary.readUInt32LE(0x3c);
  if (pe < 64 || pe > binary.length - 26 || binary.readUInt32LE(pe) !== 0x00004550
      || binary.readUInt16LE(pe + 4) !== machines[arch] || binary.readUInt16LE(pe + 24) !== 0x20b
      || (binary.readUInt16LE(pe + 22) & 0x2000) !== 0) {
    throw new Error(`Windows History recorder must be a ${arch} PE32+ executable`);
  }
  if (!binary.includes(Buffer.from(windowsHistoryRuntimeIdentity))) {
    throw new Error("Windows History recorder has no current native runtime identity");
  }
  if (workerSource !== undefined && (!Buffer.isBuffer(workerSource) || !workerSource.length || !binary.includes(workerSource))) {
    throw new Error("Windows History recorder does not embed the current worker.ps1 source");
  }
  return createHash("sha256").update(binary).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, arch, worker, ...rest] = process.argv.slice(2);
  if (!file || !arch || rest.length) throw new Error("Usage: verify-computer-history-runtime.mjs <helper.exe> <x64|arm64> [worker.ps1]");
  const sha256 = verifyWindowsComputerHistoryRuntime(readFileSync(file), arch, worker ? readFileSync(worker) : undefined);
  console.log(`Verified Windows ${arch} History recorder sha256=${sha256} (static PE, runtime identity${worker ? ", embedded worker" : ""}; no runtime execution)`);
}
