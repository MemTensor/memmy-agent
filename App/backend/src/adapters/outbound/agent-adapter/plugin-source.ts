/** Plugin source module. */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseAgentAdapterPluginManifest } from "./manifest.js";
import type { AgentAdapterPluginManifest, AgentAdapterPluginSource } from "./types/plugin.js";

export const AGENT_ADAPTER_PLUGIN_MANIFEST = "agent-adapter.plugin.json";

export interface AgentAdapterPluginDirectoryEntry {
  name: string;
  isDirectory: boolean;
}

export interface AgentAdapterPluginFileSystem {
  readDirectory(directoryPath: string): Promise<AgentAdapterPluginDirectoryEntry[]>;
  readText(filePath: string): Promise<string>;
}

export interface CreateDirectoryAgentAdapterPluginSourceOptions {
  pluginDirectories: string[];
  fileSystem?: AgentAdapterPluginFileSystem;
}

/** Creates create directory agent adapter plugin source. */
export function createDirectoryAgentAdapterPluginSource(
  options: CreateDirectoryAgentAdapterPluginSourceOptions
): AgentAdapterPluginSource {
  const fileSystem = options.fileSystem ?? nodePluginFileSystem;

  return {
    async loadManifests(): Promise<AgentAdapterPluginManifest[]> {
      const manifestPaths = (
        await Promise.all(
          options.pluginDirectories.map((pluginDirectory) => findManifestPaths(pluginDirectory, fileSystem))
        )
      ).flat();
      const manifests = await Promise.all(
        manifestPaths.map((manifestPath) => readManifest(manifestPath, fileSystem))
      );

      return manifests.filter(isLoadedManifest).sort(compareManifests);
    }
  };
}

/** Creates create in memory agent adapter plugin source. */
export function createInMemoryAgentAdapterPluginSource(
  manifests: AgentAdapterPluginManifest[]
): AgentAdapterPluginSource {
  return {
    async loadManifests() {
      return [...manifests].sort(compareManifests);
    }
  };
}

export const nodePluginFileSystem: AgentAdapterPluginFileSystem = {
  async readDirectory(directoryPath) {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory()
    }));
  },

  async readText(filePath) {
    return readFile(filePath, "utf8");
  }
};

/** Handles find manifest paths. */
async function findManifestPaths(
  pluginDirectory: string,
  fileSystem: AgentAdapterPluginFileSystem
): Promise<string[]> {
  const entries = await readOptionalDirectory(pluginDirectory, fileSystem);

  if (entries === undefined) {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory || entry.name.endsWith(".agent-adapter.json"))
    .map((entry) =>
      entry.isDirectory
        ? join(pluginDirectory, entry.name, AGENT_ADAPTER_PLUGIN_MANIFEST)
        : join(pluginDirectory, entry.name)
    );
}

/** Reads read optional directory. */
async function readOptionalDirectory(
  pluginDirectory: string,
  fileSystem: AgentAdapterPluginFileSystem
): Promise<AgentAdapterPluginDirectoryEntry[] | undefined> {
  try {
    return await fileSystem.readDirectory(pluginDirectory);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

/** Reads read manifest. */
async function readManifest(
  manifestPath: string,
  fileSystem: AgentAdapterPluginFileSystem
): Promise<AgentAdapterPluginManifest | undefined> {
  const text = await readOptionalText(manifestPath, fileSystem);

  if (text === undefined) {
    return undefined;
  }

  const parsed = parseJson(text, manifestPath);
  const manifest = parseAgentAdapterPluginManifest(parsed, manifestPath);

  return {
    ...manifest,
    modulePath: resolve(dirname(manifestPath), manifest.modulePath)
  };
}

/** Reads read optional text. */
async function readOptionalText(
  manifestPath: string,
  fileSystem: AgentAdapterPluginFileSystem
): Promise<string | undefined> {
  try {
    return await fileSystem.readText(manifestPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw error;
  }
}

/** Parses parse json. */
function parseJson(text: string, manifestPath: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse ${manifestPath}: ${(error as Error).message}`);
  }
}

/**
 * Sorts by priority descending and id ascending to keep the plugin load order stable.
 */
function compareManifests(left: AgentAdapterPluginManifest, right: AgentAdapterPluginManifest): number {
  return right.priority - left.priority || left.id.localeCompare(right.id);
}

/**
 * Filters out directory results that are missing a manifest.
 */
function isLoadedManifest(value: AgentAdapterPluginManifest | undefined): value is AgentAdapterPluginManifest {
  return value !== undefined;
}

/**
 * Determines whether a file read error indicates a missing file.
 */
function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
