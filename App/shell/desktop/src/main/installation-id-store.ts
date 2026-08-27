import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const INSTALLATION_ID_FILENAME = "installation-id";

export function resolveInstallationIdPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  const memmyHome = (env.MEMMY_HOME?.trim() || join(home, ".memmy")).replace(/^~(?=$|[/\\])/, home);
  return join(memmyHome, INSTALLATION_ID_FILENAME);
}

export function getOrCreateInstallationId(options: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  existsSyncImpl?: typeof existsSync;
  readFileSyncImpl?: (path: string, encoding: "utf8") => string;
  mkdirSyncImpl?: typeof mkdirSync;
  writeFileSyncImpl?: typeof writeFileSync;
  createId?: () => string;
} = {}): string {
  const filePath = resolveInstallationIdPath(options.env, options.home);
  const exists = options.existsSyncImpl ?? existsSync;
  const read = options.readFileSyncImpl ?? readFileSync;
  const mkdir = options.mkdirSyncImpl ?? mkdirSync;
  const write = options.writeFileSyncImpl ?? writeFileSync;

  if (exists(filePath)) {
    const persisted = read(filePath, "utf8").trim();
    if (persisted) return persisted;
  }

  const installationId = (options.createId ?? randomUUID)();
  mkdir(dirname(filePath), { recursive: true });
  write(filePath, `${installationId}\n`, "utf8");
  return installationId;
}
