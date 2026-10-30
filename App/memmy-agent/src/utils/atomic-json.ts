import fs from "node:fs";
import crypto from "node:crypto";

/** Write a durable manifest without importing a recorder or its CLI dependencies. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
