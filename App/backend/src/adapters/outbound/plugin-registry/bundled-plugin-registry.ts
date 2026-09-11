/** Loads immutable first-party plugin releases from a trusted desktop resource directory. */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { PluginManifestSchema, type PluginManifest } from "@memmy/local-api-contracts";
import type { PluginRegistry, PluginRelease } from "./index.js";

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

export interface BundledPluginRelease {
  id: string;
  version: string;
}

export interface BundledPluginCatalog {
  registry: PluginRegistry;
  releases: BundledPluginRelease[];
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

  const descriptorNames = (await readdir(trustedArtifactRoot))
    .filter((name) => name.endsWith(".release.json"))
    .sort();
  if (descriptorNames.length === 0) {
    throw invalidBundle("Bundled plugin directory has no release descriptors");
  }

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

  return {
    trustedArtifactRoot,
    releases: [...releases.values()].map((release) => ({
      id: release.manifest.id,
      version: release.manifest.version
    })),
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
