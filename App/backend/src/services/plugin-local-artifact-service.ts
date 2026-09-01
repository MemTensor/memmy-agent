/** Validates plugin-produced local files and exposes opaque local API references. */
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginArtifactRef, PluginPermission } from "@memmy/local-api-contracts";

export interface HostedPluginArtifact {
  path: string;
  name: string;
  mediaType: string;
}

export interface PluginLocalArtifactService {
  host(plugin: { id: string; approvedPermissions: PluginPermission[]; config: Record<string, unknown> }, artifact: PluginArtifactRef): Promise<PluginArtifactRef>;
  open(pluginId: string, token: string): Promise<HostedPluginArtifact>;
  revokePlugin(pluginId: string): void;
}

export function createPluginLocalArtifactService(): PluginLocalArtifactService {
  const artifacts = new Map<string, HostedPluginArtifact & { pluginId: string }>();
  return {
    async host(plugin, artifact) {
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
      const allowed = await approvedFilesystemRoots(plugin);
      if (!allowed.some((root) => isWithin(root, path))) {
        throw Object.assign(new Error("Plugin local artifact is outside its approved filesystem paths"), {
          code: "plugin_permission_denied"
        });
      }

      const token = randomUUID();
      artifacts.set(token, { pluginId: plugin.id, path, name: artifact.name, mediaType: artifact.mediaType });
      const base = `/api/v1/plugins/${encodeURIComponent(plugin.id)}/artifacts/${encodeURIComponent(token)}`;
      return { ...artifact, uri: `${base}/preview`, downloadUri: `${base}/download` };
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

async function approvedFilesystemRoots(plugin: { approvedPermissions: PluginPermission[]; config: Record<string, unknown> }): Promise<string[]> {
  const paths = plugin.approvedPermissions.flatMap((permission) => permission.type === "filesystem" ? permission.paths : []);
  const hasPluginData = plugin.approvedPermissions.some((permission) => permission.type === "host-service" && permission.services.includes("plugin-data"));
  if (hasPluginData && typeof plugin.config.taskRoot === "string" && isAbsolute(plugin.config.taskRoot)) paths.push(plugin.config.taskRoot);
  return Promise.all(paths.map((path) => realpath(path)));
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function pluginArtifactError(message: string): Error {
  return Object.assign(new Error(message), { code: "plugin_invalid" });
}
