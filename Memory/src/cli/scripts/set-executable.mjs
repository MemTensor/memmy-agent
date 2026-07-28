import { chmod } from "node:fs/promises";
import { resolve } from "node:path";

const target = process.argv[2];
if (!target) {
  throw new Error("Missing executable path");
}

if (process.platform !== "win32") {
  await chmod(resolve(target), 0o755);
}
