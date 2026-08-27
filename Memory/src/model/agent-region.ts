import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type MemoryAgentRegion = "cn" | "intl";

interface DesktopEditionManifest {
  edition?: unknown;
  accountChannel?: unknown;
}

export interface ResolveMemoryAgentRegionOptions {
  env?: NodeJS.ProcessEnv;
  manifestPath?: string;
}

export function packagedDesktopEditionManifestPath(
  modelDirectory = import.meta.dirname
): string {
  return resolve(modelDirectory, "../../../../main/desktop-edition.json");
}

export function resolveMemoryAgentRegion(
  sourceProvider: string | null | undefined,
  options: ResolveMemoryAgentRegionOptions = {}
): MemoryAgentRegion | undefined {
  if (sourceProvider !== "memmy_account") return undefined;

  const manifest = readDesktopEditionManifest(
    options.manifestPath ?? packagedDesktopEditionManifestPath()
  );
  const manifestRegion = regionFromIdentity(manifest?.edition, manifest?.accountChannel);
  if (manifestRegion) return manifestRegion;

  const env = options.env ?? process.env;
  return regionFromIdentity(env.MEMMY_APP_EDITION, env.MEMMY_ACCOUNT_CHANNEL) ?? "cn";
}

function readDesktopEditionManifest(path: string): DesktopEditionManifest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function regionFromIdentity(
  edition: unknown,
  accountChannel: unknown
): MemoryAgentRegion | undefined {
  if (edition === "intl") return "intl";
  if (edition === "cn") return "cn";
  if (accountChannel === "email") return "intl";
  if (accountChannel === "phone") return "cn";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
