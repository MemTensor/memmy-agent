#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { verifyOssObjectIntegrity } from "./internal/shared/oss-object-integrity.mjs";

const [headersPath, filePath, ...extra] = process.argv.slice(2);
if (!headersPath || !filePath || extra.length > 0) {
  console.error(
    "Usage: node scripts/verify-oss-object-integrity.mjs <head-response-file> <downloaded-file>",
  );
  process.exit(2);
}

try {
  const headers = await readFile(headersPath, "utf8");
  const result = await verifyOssObjectIntegrity(headers, filePath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
