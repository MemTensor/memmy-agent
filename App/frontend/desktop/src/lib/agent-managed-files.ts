export type AgentManagedFileSource = "agent-generated" | "agent-downloaded";

export interface AgentManagedFile {
  id: string;
  path: string;
  name: string;
  size: string;
  updated: string;
  source: AgentManagedFileSource;
}

export const AGENT_MANAGED_FILES_STORAGE_KEY = "memmy.agentManagedFiles";
export const AGENT_MANAGED_FILES_CHANGED_EVENT = "memmy:agent-managed-files-changed";

export function readAgentManagedFiles(storage?: Storage): AgentManagedFile[] {
  try {
    const parsed = JSON.parse(storage?.getItem(AGENT_MANAGED_FILES_STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AgentManagedFile => (
      typeof item === "object"
      && item != null
      && typeof (item as AgentManagedFile).id === "string"
      && typeof (item as AgentManagedFile).path === "string"
      && typeof (item as AgentManagedFile).name === "string"
      && ((item as AgentManagedFile).source === "agent-generated"
        || (item as AgentManagedFile).source === "agent-downloaded")
    ));
  } catch {
    return [];
  }
}

export function registerAgentManagedFiles(
  files: AgentManagedFile[],
  storage?: Storage,
  eventTarget?: EventTarget
): AgentManagedFile[] {
  const byId = new Map(readAgentManagedFiles(storage).map((file) => [file.id, file]));
  for (const file of files) byId.set(file.id, file);
  const next = [...byId.values()];
  try {
    storage?.setItem(AGENT_MANAGED_FILES_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The in-page event still lets an open file list update for this session.
  }
  eventTarget?.dispatchEvent(new Event(AGENT_MANAGED_FILES_CHANGED_EVENT));
  return next;
}
