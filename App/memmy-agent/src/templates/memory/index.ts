import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function memoryTemplatePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "MEMORY.md");
}

export function readMemoryTemplate(): string {
  return fs.readFileSync(memoryTemplatePath(), "utf8");
}
