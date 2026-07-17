import fs from "node:fs";
import path from "node:path";

export function templatesDir(): string {
  return path.dirname(new URL(import.meta.url).pathname);
}

export function readTemplate(name: string): string {
  return fs.readFileSync(path.join(templatesDir(), name), "utf8");
}
