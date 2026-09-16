/** Loads immutable first-party plugin releases from a trusted desktop resource directory. */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { PluginManifestSchema, type PluginManifest } from "@memmy/local-api-contracts";
import type { PluginRegistry, PluginRelease } from "./index.js";

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const BUNDLED_PLUGIN_STATE_FILE = "bundled-plugins-state.json";
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface BundledPluginRelease {
  id: string;
  version: string;
}

export interface BundledPluginCatalog {
  registry: PluginRegistry;
  releases: BundledPluginRelease[];
  /** Plugin IDs owned by the bundle policy, including intentionally omitted releases. */
  managedPluginIds: string[];
  trustedArtifactRoot: string;
}

interface ReleaseDescriptor {
  manifest: PluginManifest;
  artifact: {
    file: string;
    sha256: string;
  };
}

/** Reads and verifies every `*.release.json` descriptor in a bundled resource directory. */
export async function loadBundledPluginCatalog(directory: string): Promise<BundledPluginCatalog> {
  const requestedRoot = resolve(directory);
  const rootInfo = await lstat(requestedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw invalidBundle("Bundled plugin root must be a regular directory");
  }
  const trustedArtifactRoot = await realpath(requestedRoot);

  const resourceNames = await readdir(trustedArtifactRoot);
  const descriptorNames = resourceNames
    .filter((name) => name.endsWith(".release.json"))
    .sort();
  const declaredManagedPluginIds = resourceNames.includes(BUNDLED_PLUGIN_STATE_FILE)
    ? await readManagedPluginIds(trustedArtifactRoot)
    : null;

  const releases = new Map<string, PluginRelease>();
  for (const descriptorName of descriptorNames) {
    if (basename(descriptorName) !== descriptorName) {
      throw invalidBundle(`Invalid bundled plugin descriptor path: ${descriptorName}`);
    }
    const descriptorPath = resolve(trustedArtifactRoot, descriptorName);
    await assertRegularChild(trustedArtifactRoot, descriptorPath, "descriptor");
    const descriptor = parseDescriptor(JSON.parse(await readFile(descriptorPath, "utf8")) as unknown);
    if (releases.has(descriptor.manifest.id)) {
      throw invalidBundle(`Duplicate bundled plugin id: ${descriptor.manifest.id}`);
    }

    const artifactPath = resolve(trustedArtifactRoot, descriptor.artifact.file);
    const artifactInfo = await assertRegularChild(trustedArtifactRoot, artifactPath, "artifact");
    if (artifactInfo.size > MAX_ARCHIVE_BYTES) {
      throw invalidBundle(`Bundled plugin artifact exceeds size limit: ${descriptor.manifest.id}`);
    }
    const bytes = await readFile(artifactPath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== descriptor.artifact.sha256) {
      throw invalidBundle(`Bundled plugin SHA-256 mismatch: ${descriptor.manifest.id}`);
    }

    releases.set(descriptor.manifest.id, {
      manifest: descriptor.manifest,
      artifact: {
        localPath: artifactPath,
        sha256: digest
      }
    });
  }

  const bundledReleases = [...releases.values()].map((release) => ({
    id: release.manifest.id,
    version: release.manifest.version
  }));
  if (
    declaredManagedPluginIds
    && bundledReleases.some((release) => !declaredManagedPluginIds.includes(release.id))
  ) {
    throw invalidBundle("Bundled plugin release is missing from managed plugin state");
  }
  return {
    trustedArtifactRoot,
    releases: bundledReleases,
    managedPluginIds: declaredManagedPluginIds ?? bundledReleases.map((release) => release.id),
    registry: {
      async resolve(pluginId, version) {
        const release = releases.get(pluginId);
        if (!release || (version && release.manifest.version !== version)) {
          throw Object.assign(
            new Error(`Plugin release not found: ${pluginId}${version ? `@${version}` : ""}`),
            { code: "not_found" as const }
          );
        }
        return structuredClone(release);
      }
    }
  };
}

async function readManagedPluginIds(root: string): Promise<string[]> {
  const path = resolve(root, BUNDLED_PLUGIN_STATE_FILE);
  await assertRegularChild(root, path, "state");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw invalidBundle("Invalid bundled plugin state");
  }
  if (!value || typeof value !== "object") throw invalidBundle("Invalid bundled plugin state");
  const candidate = value as { schemaVersion?: unknown; managedPluginIds?: unknown };
  if (
    candidate.schemaVersion !== 1
    || !Array.isArray(candidate.managedPluginIds)
    || candidate.managedPluginIds.some((id) => typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id))
    || new Set(candidate.managedPluginIds).size !== candidate.managedPluginIds.length
  ) {
    throw invalidBundle("Invalid bundled plugin state");
  }
  return [...candidate.managedPluginIds].sort();
}

function parseDescriptor(value: unknown): ReleaseDescriptor {
  if (!value || typeof value !== "object") throw invalidBundle("Invalid bundled plugin release descriptor");
  const candidate = value as { manifest?: unknown; artifact?: unknown };
  const manifest = PluginManifestSchema.parse(candidate.manifest);
  if (!candidate.artifact || typeof candidate.artifact !== "object") {
    throw invalidBundle(`Bundled plugin artifact is missing: ${manifest.id}`);
  }
  const artifact = candidate.artifact as { file?: unknown; sha256?: unknown };
  if (
    typeof artifact.file !== "string"
    || !artifact.file
    || basename(artifact.file) !== artifact.file
    || isAbsolute(artifact.file)
  ) {
    throw invalidBundle(`Invalid bundled plugin artifact filename: ${manifest.id}`);
  }
  if (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    throw invalidBundle(`Invalid bundled plugin SHA-256: ${manifest.id}`);
  }
  return {
    manifest,
    artifact: {
      file: artifact.file,
      sha256: artifact.sha256.toLowerCase()
    }
  };
}

async function assertRegularChild(
  root: string,
  path: string,
  kind: string
): Promise<Awaited<ReturnType<typeof lstat>>> {
  assertDescendant(root, path);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) {
    throw invalidBundle(`Bundled plugin ${kind} must be a regular file`);
  }
  return info;
}

function assertDescendant(parent: string, child: string): void {
  const path = relative(resolve(parent), resolve(child));
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw invalidBundle("Bundled plugin path escapes the resource root");
  }
}

function invalidBundle(message: string): Error {
  return Object.assign(new Error(message), { code: "plugin_invalid" as const });
}
