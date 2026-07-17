import fs from "node:fs";
import path from "node:path";

export function memoryTemplatePath(): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), "MEMORY.md");
}

export function readMemoryTemplate(): string {
  return fs.readFileSync(memoryTemplatePath(), "utf8");
}
