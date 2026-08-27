import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function templatesDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function readTemplate(name: string): string {
  return fs.readFileSync(path.join(templatesDir(), name), "utf8");
}
