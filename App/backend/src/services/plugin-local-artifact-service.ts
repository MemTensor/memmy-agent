/** Validates plugin-produced local files and exposes opaque local API references. */
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginArtifactRef, PluginPermission } from "@memmy/local-api-contracts";

export interface HostedPluginArtifact {
  path: string;
  name: string;
  mediaType: string;
}

export interface PluginLocalArtifactService {
  host(
    plugin: { id: string; approvedPermissions: PluginPermission[]; config: Record<string, unknown> },
    artifact: PluginArtifactRef,
    context?: PluginArtifactHostContext
  ): Promise<PluginArtifactRef>;
  open(pluginId: string, token: string): Promise<HostedPluginArtifact>;
  revokePlugin(pluginId: string): void;
}

export interface PluginArtifactHostContext {
  conversationId: string;
  taskId?: string;
  callId: string;
}

export interface CreatePluginLocalArtifactServiceOptions {
  /** Host-owned parent directory containing one writable data directory per plugin. */
  pluginDataRoot?: string;
  /** Resolves the workspace currently bound to one Agent conversation. */
  resolveWorkspace?: (conversationId: string) => Promise<string | null>;
}

export function createPluginLocalArtifactService(options: CreatePluginLocalArtifactServiceOptions = {}): PluginLocalArtifactService {
  const artifacts = new Map<string, HostedPluginArtifact & { pluginId: string }>();
  return {
    async host(plugin, artifact, context) {
      let url: URL;
      try {
        url = new URL(artifact.uri);
      } catch {
        throw pluginArtifactError("Plugin artifact URI must be an absolute HTTP(S) or file URI");
      }
      if (url.protocol === "https:" || url.protocol === "http:") return artifact;
      if (url.protocol !== "file:") throw pluginArtifactError(`Unsupported plugin artifact URI protocol: ${url.protocol}`);
      const canHostArtifacts = plugin.approvedPermissions.some((permission) => (
        permission.type === "host-service" && permission.services.includes("artifact-host")
      ));
      if (!canHostArtifacts) throw Object.assign(new Error("Plugin has not been approved to use the artifact Host service"), {
        code: "plugin_permission_denied"
      });

      const requestedPath = fileURLToPath(url);
      if (!isAbsolute(requestedPath)) throw pluginArtifactError("Plugin local artifact path must be absolute");
      const path = await realpath(requestedPath);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw pluginArtifactError("Plugin local artifact must be a regular file");
      const allowed = await approvedFilesystemRoots(plugin, options.pluginDataRoot);
      if (!allowed.some((root) => isWithin(root, path))) {
        throw Object.assign(new Error("Plugin local artifact is outside its approved filesystem paths"), {
          code: "plugin_permission_denied"
        });
      }

      const token = randomUUID();
      artifacts.set(token, { pluginId: plugin.id, path, name: artifact.name, mediaType: artifact.mediaType });
      const base = `/api/v1/plugins/${encodeURIComponent(plugin.id)}/artifacts/${encodeURIComponent(token)}`;
      const publishedPath = context
        ? await publishArtifactToWorkspace(path, plugin.id, artifact.name, context, options.resolveWorkspace)
        : null;
      return {
        ...artifact,
        uri: `${base}/preview`,
        downloadUri: `${base}/download`,
        ...(publishedPath ? { path: publishedPath } : {})
      };
    },

    async open(pluginId, token) {
      const artifact = artifacts.get(token);
      if (!artifact || artifact.pluginId !== pluginId) throw Object.assign(new Error("Plugin artifact not found"), { code: "not_found" });
      const path = await realpath(artifact.path);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw Object.assign(new Error("Plugin artifact is no longer available"), { code: "not_found" });
      return { path, name: artifact.name, mediaType: artifact.mediaType };
    },

    revokePlugin(pluginId) {
      for (const [token, artifact] of artifacts) if (artifact.pluginId === pluginId) artifacts.delete(token);
    }
  };
}

async function publishArtifactToWorkspace(
  sourcePath: string,
  pluginId: string,
  artifactName: string,
  context: PluginArtifactHostContext,
  resolveWorkspace: CreatePluginLocalArtifactServiceOptions["resolveWorkspace"]
): Promise<string | null> {
  if (!resolveWorkspace || pluginId !== "literature-review" || !context.taskId) return null;
  const workspacePath = await resolveWorkspace(context.conversationId);
  if (!workspacePath) return null;
  const workspace = await realpath(workspacePath);
  const relativeName = safeArtifactRelativePath(artifactName);
  const taskDirectory = safePathSegment(context.taskId, "task");
  const parent = await ensureSafeDirectory(workspace, [
    "outputs",
    safePathSegment(pluginId, "plugin"),
    taskDirectory,
    ...relativeName.slice(0, -1)
  ]);
  const target = join(parent, relativeName.at(-1)!);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(sourcePath, temporary, fsConstants.COPYFILE_EXCL);
    try {
      await rename(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      const existing = await lstat(target).catch(() => null);
      if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
        throw pluginArtifactError("Plugin artifact destination is not a regular workspace file");
      }
      await rm(target, { force: true });
      await rename(temporary, target);
    }
    return await realpath(target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function safeArtifactRelativePath(value: string): string[] {
  if (value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
    throw pluginArtifactError("Plugin artifact name is not a safe workspace-relative path");
  }
  const parts = value.split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) {
    throw pluginArtifactError("Plugin artifact name is not a safe workspace-relative path");
  }
  return parts;
}

function safePathSegment(value: string, fallback: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
  return safe && safe !== "." && safe !== ".." ? safe : fallback;
}

async function ensureSafeDirectory(root: string, parts: string[]): Promise<string> {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!existing) {
      await mkdir(current);
    } else if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw pluginArtifactError("Plugin artifact workspace destination contains an unsafe path");
    }
    const canonical = await realpath(current);
    if (!isWithin(root, canonical)) {
      throw pluginArtifactError("Plugin artifact workspace destination escapes the workspace");
    }
  }
  return current;
}

async function approvedFilesystemRoots(
  plugin: { id: string; approvedPermissions: PluginPermission[] },
  pluginDataRoot?: string
): Promise<string[]> {
  const paths = plugin.approvedPermissions.flatMap((permission) => permission.type === "filesystem" ? permission.paths : []);
  const hasPluginData = plugin.approvedPermissions.some((permission) => permission.type === "host-service" && permission.services.includes("plugin-data"));
  if (hasPluginData && pluginDataRoot) paths.push(resolve(pluginDataRoot, plugin.id));
  return Promise.all(paths.map((path) => realpath(path)));
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function pluginArtifactError(message: string): Error {
  return Object.assign(new Error(message), { code: "plugin_invalid" });
}
