import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse } from "node:path";
import { pathToFileURL } from "node:url";
import {
  deriveWorkspaceHostId,
  type WorkspaceHostId,
  type WorkspaceUri
} from "@memmy/local-api-contracts";

export async function normalizeWorkspaceRoot(value: string): Promise<string | null> {
  if (!value || !isAbsolute(value)) return null;
  try {
    const canonical = await realpath(value);
    const details = await lstat(canonical);
    if (!details.isDirectory()) return null;
    if (canonical === parse(canonical).root || canonical === await realpath(homedir())) return null;
    return canonical;
  } catch {
    return null;
  }
}

export function workspaceUriFromRoot(root: string): WorkspaceUri {
  return pathToFileURL(root).href as WorkspaceUri;
}

export function workspaceHostIdFromInstallationId(installationId: string): WorkspaceHostId {
  return deriveWorkspaceHostId(installationId);
}
