#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Static validation only: never starts the Windows executable or its script. */
export function verifyWindowsComputerUseRuntime(binary, arch = 'x64', runtimeSource) {
  const machines = { x64: 0x8664, arm64: 0xaa64 };
  if (!Object.hasOwn(machines, arch)) throw new Error(`Unsupported Windows Computer Use architecture: ${arch}`);
  if (!Buffer.isBuffer(binary) || binary.length < 64 || binary.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('Windows Computer Use helper is not a PE executable');
  }
  const pe = binary.readUInt32LE(0x3c);
  if (pe < 64 || pe > binary.length - 26 || binary.readUInt32LE(pe) !== 0x00004550
      || binary.readUInt16LE(pe + 4) !== machines[arch]
      || binary.readUInt16LE(pe + 24) !== 0x20b
      || (binary.readUInt16LE(pe + 22) & 0x2000) !== 0) {
    throw new Error(`Windows Computer Use helper must be a ${arch} PE32+ executable`);
  }
  if (runtimeSource !== undefined && (!Buffer.isBuffer(runtimeSource) || !runtimeSource.length
      || !binary.includes(runtimeSource))) {
    throw new Error('Windows Computer Use helper does not embed the current runtime.ps1 source');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3) {
    throw new Error('Usage: verify-computer-use-runtime.mjs <helper.exe> <x64|arm64> [runtime.ps1]');
  }
  verifyWindowsComputerUseRuntime(readFileSync(args[0]), args[1], args[2] ? readFileSync(args[2]) : undefined);
  console.log(`Verified Windows ${args[1]} Computer Use helper (static PE${args[2] ? ' and embedded source' : ''} checks; runtime not executed)`);
}
