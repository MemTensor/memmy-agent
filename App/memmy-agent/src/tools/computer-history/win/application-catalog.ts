import { execFile } from "node:child_process";
import { z } from "zod";
import { parseNativePolicy, pathKey } from "./policy.js";

const schema = z.object({ protocol: z.literal("memmy.windows.computer-history"), version: z.literal(1),
  platform: z.literal("windows"), kind: z.literal("application.catalog"),
  applications: z.array(z.object({ executable: z.string(), name: z.string().min(1).max(256)
    .refine((name) => [...name].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)) }).strict()).max(512) }).strict();
export interface CatalogApplication { executable: string; name: string }

// Display metadata only. A catalog entry never supplies a PID, processStart or capture rule.
export function parseApplicationCatalog(input: unknown): CatalogApplication[] {
  try {
    const { applications } = schema.parse(input);
    const seen = new Set<string>();
    for (const entry of applications) {
      parseNativePolicy({ version: 1, applications: [{ executable: entry.executable, pid: 1 }] });
      const key = pathKey(entry.executable);
      if (seen.has(key)) throw new Error();
      seen.add(key);
    }
    return applications;
  } catch { throw new Error("windows_catalog_invalid"); }
}

export async function discoverApplicationCatalog(binary: string): Promise<CatalogApplication[]> {
  const output = await new Promise<Buffer>((resolve, reject) => execFile(binary, ["catalog"],
    { encoding: "buffer", timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true },
    (error, stdout) => error ? reject(new Error("windows_catalog_failed")) : resolve(stdout)));
  try { return parseApplicationCatalog(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(output))); }
  catch { throw new Error("windows_catalog_invalid"); }
}
