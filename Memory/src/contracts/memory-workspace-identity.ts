/** Shared L3 World Model workspace identity contract. */
import { z } from "zod";
import { sha256Hex } from "./memory-canonical-json.js";

const MAX_WORKSPACE_URI_BYTES = 4096;
const LOCAL_HOST_NAMES = new Set(["", "localhost"]);

export const L3WorldModelProtocolVersionSchema = z.literal(2);
export type L3WorldModelProtocolVersion = z.infer<typeof L3WorldModelProtocolVersionSchema>;

export const L3WorldModelTransitionSchema = z.enum(["allow_legacy_rollover", "resume_only"]);
export type L3WorldModelTransition = z.infer<typeof L3WorldModelTransitionSchema>;

export const WorkspaceHostIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type WorkspaceHostId = z.infer<typeof WorkspaceHostIdSchema>;

export const WorkspaceUriSchema = z.string().min(1).superRefine((value, context) => {
  try {
    const normalized = normalizeWorkspaceUri(value);
    if (normalized !== value) {
      context.addIssue({
        code: "custom",
        message: "workspaceUri must already be canonical"
      });
    }
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "invalid workspaceUri"
    });
  }
});
export type WorkspaceUri = z.infer<typeof WorkspaceUriSchema>;

export const WorkspaceIdentityFieldsSchema = z.object({
  workspaceUri: WorkspaceUriSchema.optional(),
  workspaceHostId: WorkspaceHostIdSchema.optional()
}).strict().superRefine((value, context) => {
  if (!value.workspaceUri) {
    if (value.workspaceHostId) {
      context.addIssue({
        code: "custom",
        path: ["workspaceHostId"],
        message: "workspaceHostId requires workspaceUri"
      });
    }
    return;
  }
  const local = isLocalWorkspaceUri(value.workspaceUri);
  if (local && !value.workspaceHostId) {
    context.addIssue({
      code: "custom",
      path: ["workspaceHostId"],
      message: "local workspaceUri requires workspaceHostId"
    });
  }
  if (!local && value.workspaceHostId) {
    context.addIssue({
      code: "custom",
      path: ["workspaceHostId"],
      message: "non-local workspaceUri must not include workspaceHostId"
    });
  }
});
export type WorkspaceIdentityFields = z.infer<typeof WorkspaceIdentityFieldsSchema>;

/** Canonicalizes an absolute workspace URI without touching the file system. */
export function normalizeWorkspaceUri(input: string): string {
  if (!input || input.trim() !== input) throw new TypeError("workspaceUri must be a non-empty trimmed string");
  if (new TextEncoder().encode(input).byteLength > MAX_WORKSPACE_URI_BYTES) {
    throw new TypeError(`workspaceUri exceeds ${MAX_WORKSPACE_URI_BYTES} UTF-8 bytes`);
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError("workspaceUri must be an absolute URI");
  }
  if (!url.protocol || url.protocol === ":") throw new TypeError("workspaceUri must include a URI scheme");
  if (url.username || url.password) throw new TypeError("workspaceUri must not contain credentials");
  if (url.search || url.hash) throw new TypeError("workspaceUri must not contain query or fragment components");

  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if (url.protocol === "file:") {
    if (url.port) throw new TypeError("file workspaceUri must not contain a port");
    if (url.hostname === "localhost") url.hostname = "";
    if (isLocalFileSystemRoot(url)) throw new TypeError("workspaceUri must not identify a file-system root");
  } else if (!url.hostname) {
    throw new TypeError("non-file workspaceUri must contain a stable authority");
  }

  const normalized = url.toString();
  if (new TextEncoder().encode(normalized).byteLength > MAX_WORKSPACE_URI_BYTES) {
    throw new TypeError(`workspaceUri exceeds ${MAX_WORKSPACE_URI_BYTES} UTF-8 bytes`);
  }
  return normalized;
}

export function isLocalWorkspaceUri(workspaceUri: string): boolean {
  const url = new URL(workspaceUri);
  return url.protocol === "file:" && LOCAL_HOST_NAMES.has(url.hostname.toLowerCase());
}

export function deriveWorkspaceHostId(installationId: string): WorkspaceHostId {
  if (!installationId.trim()) throw new TypeError("installationId must be non-empty");
  return sha256Hex(`memmy-workspace-host-v1\0${installationId}`);
}

export const MEMORY_WORKSPACE_IDENTITY_FIXTURES = {
  installationId: "fixture-installation-id",
  workspaceHostId: "759efce6a4f73550d751ec7d7d0321b11d83c8d9bb7869332bb6fb9a61ffc82d",
  localUri: "file:///workspace/project",
  remoteUri: "ssh://example.test/workspace/project"
} as const;

function isLocalFileSystemRoot(url: URL): boolean {
  if (!LOCAL_HOST_NAMES.has(url.hostname.toLowerCase())) return false;
  const pathname = decodeURIComponent(url.pathname);
  return pathname === "/" || /^\/[A-Za-z]:\/?$/.test(pathname);
}
